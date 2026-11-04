'use strict';
/**
 * CODE-STORE-01: pack a staged Code runtime (npm run stage:code → nabu-runtime/) into the
 * archive the Girru Store lists for one platform. The nabu-code release pipeline runs this,
 * so the format is Girru's own and matches the backend's reader (services/code-runtime.ts):
 *
 *   - a gzip'd ustar archive whose root IS the runtime root (nabu/, editor/ …)
 *   - plain files and folders only: links inside node_modules/.bin are left out (Girru never
 *     runs them); a link to a file inside the runtime (a versioned library such as
 *     libx.dylib -> libx.1.dylib) is stored as a copy of that file; any other link stops the pack
 *   - nabu/runtime.json gains "version", so Girru can check it got the version it asked for
 *   - <name>.tar.gz plus <name>.json with its size and SHA-256 (for the Store's index)
 *
 * Usage: node scripts/pack-code-runtime.cjs --runtime <dir> --version <x.y.z> --platform <darwin-arm64|darwin-x64|win32-x64|linux-x64> --out <dir>
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { CODE_FILES } = require('./check-bundle-inputs.cjs');

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'];
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;

function header(name, size, type, mode) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const padding = size => Buffer.alloc((512 - (size % 512)) % 512);
/** A pax record "<len> path=<name>\n", where <len> counts itself. */
function paxPath(name) {
  const rest = ` path=${name}\n`, n = Buffer.byteLength(rest);
  let len = n + 1; while (String(len).length + n !== len) len = String(len).length + n;
  return Buffer.from(`${len}${rest}`);
}

/** Every entry under root, folders first, sorted; links in .bin folders are skipped, links to a file inside root become copies, any other link throws. */
function entries(root) {
  const out = [], skipped = [], copied = [];
  const walk = rel => {
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) {
        if (path.basename(rel) === '.bin') { skipped.push(r); continue; }
        let target = null;
        try { target = fs.realpathSync(path.join(root, ...r.split('/'))); } catch { /* broken link */ }
        const inside = target && target.startsWith(root + path.sep) && fs.statSync(target).isFile();
        if (!inside) throw Error(`Code runtime has a link that is not a file inside it: ${r}`);
        out.push({ rel: r, dir: false, from: target }); copied.push(r); continue;
      }
      if (d.isDirectory()) { out.push({ rel: r, dir: true }); walk(r); }
      else if (d.isFile()) out.push({ rel: r, dir: false });
      else throw Error(`Code runtime has a special file: ${r}`);
    }
  };
  walk('');
  return { list: out, skipped, copied };
}

async function packCodeRuntime({ runtime, version, platform, out }) {
  if (!VERSION.test(version || '')) throw Error('--version must look like 1.2.3');
  if (!PLATFORMS.includes(platform)) throw Error(`--platform must be one of ${PLATFORMS.join(', ')}`);
  const root = fs.realpathSync(runtime);
  for (const name of CODE_FILES) if (!fs.statSync(path.join(root, name)).isFile()) throw Error(`Code runtime is incomplete: ${name}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'nabu', 'runtime.json'), 'utf8'));
  if (manifest.protocolVersion !== 1 || manifest.entry !== 'dpro/editor-runtime.mjs') throw Error('Code runtime is not protocol 1');
  const runtimeJson = Buffer.from(JSON.stringify({ ...manifest, version }, null, 2) + '\n');
  const { list, skipped, copied } = entries(root);
  fs.mkdirSync(out, { recursive: true });
  const name = `girru-code-${version}-${platform}.tar.gz`;
  const file = path.join(out, name);
  const sink = fs.createWriteStream(file, { flags: 'wx' });
  const gz = zlib.createGzip({ level: 9 });
  const hash = crypto.createHash('sha256');
  let size = 0;
  gz.on('data', chunk => { hash.update(chunk); size += chunk.length; });
  gz.pipe(sink);
  const write = async buf => { if (!gz.write(buf)) await once(gz, 'drain'); };
  const entryHeader = async (rel, bytes, type, mode) => {
    let short = rel;
    if (Buffer.byteLength(rel) > 99 || /[^\x20-\x7e]/.test(rel)) {
      const rec = paxPath(rel);
      await write(header('PaxHeader', rec.length, 'x', 0o644)); await write(rec); await write(padding(rec.length));
      short = rel.replace(/[^\x20-\x7e]/g, '_').slice(-90);
    }
    await write(header(short, bytes, type, mode));
  };
  for (const e of list) {
    if (e.dir) { await entryHeader(`${e.rel}/`, 0, '5', 0o755); continue; }
    const full = e.from || path.join(root, ...e.rel.split('/'));
    const mode = fs.statSync(full).mode & 0o111 ? 0o755 : 0o644;
    if (e.rel === 'nabu/runtime.json') { await entryHeader(e.rel, runtimeJson.length, '0', 0o644); await write(runtimeJson); await write(padding(runtimeJson.length)); continue; }
    const bytes = fs.statSync(full).size;
    await entryHeader(e.rel, bytes, '0', mode);
    let seen = 0;
    for await (const chunk of fs.createReadStream(full)) { seen += chunk.length; await write(chunk); }
    if (seen !== bytes) throw Error(`File changed while packing: ${e.rel}`);
    await write(padding(bytes));
  }
  await write(Buffer.alloc(1024));
  gz.end();
  await once(sink, 'close');
  const sha256 = hash.digest('hex');
  const info = { name, platform, version, size, sha256, files: list.filter(e => !e.dir).length, skippedLinks: skipped.length, copiedLinks: copied.length };
  fs.writeFileSync(path.join(out, name.replace(/\.tar\.gz$/, '.json')), JSON.stringify(info, null, 2) + '\n');
  return info;
}

if (require.main === module) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  packCodeRuntime({ runtime: args.runtime, version: args.version, platform: args.platform, out: args.out })
    .then(info => console.log(`${info.name}  ${info.size} bytes  sha256 ${info.sha256}  (${info.files} files, ${info.skippedLinks} .bin links left out, ${info.copiedLinks} file links stored as copies)`))
    .catch(error => { console.error(`Pack stopped: ${error.message}`); process.exitCode = 1; });
}

module.exports = { packCodeRuntime, PLATFORMS };
