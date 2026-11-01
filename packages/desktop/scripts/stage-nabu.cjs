'use strict';
/**
 * Put the Code editor (Nabu) runtime the desktop app runs into packages/desktop/nabu-runtime
 * (copied into the app by electron-builder as extraResources; main.cjs looks for
 * Resources/nabu-runtime).
 *
 * The Nabu checkout is a development tree (several GB). Only what the editor server and
 * its built-in extensions need at run time is copied:
 *   nabu/                       the runtime entry (runtime.json, dpro/editor-runtime.mjs)
 *   editor/out, product.json, package.json, resources
 *   editor/node_modules         production dependencies only (npm ls --omit=dev), plus the
 *                               server's own packages from remote/node_modules
 *   editor/remote/node_modules  (the runtime checks for it)
 *   editor/extensions           without the extensions Girru does not use (DROPPED) and with
 *                               each extension's production dependencies only. The telemetry
 *                               packages nearly every extension carries (~100 MB each, loaded with
 *                               require) are kept once in extensions/node_modules, where Node finds
 *                               them; other packages stay put, as some extensions open them by path.
 * Nothing is downloaded. Files are cloned (APFS) where the system can, else copied.
 *
 * Usage: node scripts/stage-nabu.cjs [--nabu <nabu-code checkout>] [--out <dir>]
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Built-in extensions left out: assistants and accounts Girru has its own of, and the editor's own test extensions. */
const DROPPED = new Set(['copilot', 'github', 'github-authentication', 'microsoft-authentication', 'vscode-api-tests', 'vscode-colorize-tests', 'vscode-colorize-perf-tests', 'vscode-test-resolver', 'mermaid-markdown-features']);
/** Packages kept once for all extensions (same version only). */
const SHARED = /^(@vscode\/extension-telemetry|@microsoft\/|@nevware21\/)/;
const EDITOR_PARTS = ['out', 'product.json', 'package.json', 'resources', 'LICENSE.txt', 'ThirdPartyNotices.txt'];

function parseArgs(argv) {
  const here = path.resolve(__dirname, '..');
  const options = { nabu: path.resolve(here, '..', '..', '..', 'nabu-code'), out: path.join(here, 'nabu-runtime') };
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--nabu': 'nabu', '--out': 'out' }[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    options[key] = path.resolve(argv[i + 1]);
  }
  return options;
}

const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE }); };

/** Top-level production packages of a package folder, as paths relative to it (node_modules/<name>). */
function productionPackages(dir, run = execFileSync, platform = process.platform) {
  let out = '';
  // npm is a .cmd script on Windows; execFile cannot run it directly. The
  // shell command is constant: the checkout path is passed only through cwd.
  const command = platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = platform === 'win32' ? ['/d', '/s', '/c', 'npm ls --omit=dev --all --parseable'] : ['ls', '--omit=dev', '--all', '--parseable'];
  try { out = run(command, args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (error) {
    // npm ls can report an incomplete dependency tree while returning useful
    // paths. A launch failure must never silently produce an empty runtime.
    if (!Number.isInteger(error.status) || !error.stdout?.trim()) throw new Error('Cannot list editor runtime dependencies', { cause: error });
    out = String(error.stdout);
  }
  const found = new Set(); const real = fs.realpathSync(dir); // npm prints real paths (/private/var for /var)
  for (const line of out.split('\n')) {
    const rel = path.relative(real, line.trim()).split(path.sep).join('/');
    const match = rel.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)$/);
    if (match) found.add(`node_modules/${match[1]}`);
  }
  return [...found];
}

const versionOf = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return null; } };

function packageNames(modules) {
  const names = [];
  for (const name of fs.existsSync(modules) ? fs.readdirSync(modules) : []) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) for (const sub of fs.readdirSync(path.join(modules, name))) names.push(`${name}/${sub}`);
    else names.push(name);
  }
  return names;
}

/** Keep one copy of the shared packages that several extensions carry at the same version. */
function shareCommon(extensionsDir, extensions) {
  const shared = path.join(extensionsDir, 'node_modules');
  for (const ext of extensions) {
    const modules = path.join(extensionsDir, ext, 'node_modules');
    for (const name of packageNames(modules).filter(n => SHARED.test(n))) {
      const own = path.join(modules, name); const common = path.join(shared, name);
      if (!fs.existsSync(common)) { fs.mkdirSync(path.dirname(common), { recursive: true }); fs.renameSync(own, common); }
      else if (versionOf(common) === versionOf(own)) fs.rmSync(own, { recursive: true, force: true });
    }
  }
}

function stage({ nabu, out }) {
  const editor = path.join(nabu, 'editor');
  const runtime = JSON.parse(fs.readFileSync(path.join(nabu, 'nabu', 'runtime.json'), 'utf8'));
  if (runtime.protocolVersion !== 1 || runtime.entry !== 'dpro/editor-runtime.mjs' || !fs.statSync(path.join(nabu, 'nabu', runtime.entry)).isFile()) throw new Error('Nabu runtime entry not found');
  for (const part of [...EDITOR_PARTS, 'remote/node_modules']) if (!fs.existsSync(path.join(editor, part))) throw new Error(`Nabu editor is not built: ${part} is missing`);
  fs.rmSync(out, { recursive: true, force: true });

  copy(path.join(nabu, 'nabu', 'runtime.json'), path.join(out, 'nabu', 'runtime.json'));
  copy(path.join(nabu, 'nabu', runtime.entry), path.join(out, 'nabu', runtime.entry));
  for (const part of EDITOR_PARTS) copy(path.join(editor, part), path.join(out, 'editor', part));
  copy(path.join(editor, 'remote', 'node_modules'), path.join(out, 'editor', 'remote', 'node_modules'));
  copy(path.join(editor, 'remote', 'package.json'), path.join(out, 'editor', 'remote', 'package.json'));

  for (const rel of productionPackages(editor)) copy(path.join(editor, rel), path.join(out, 'editor', rel));
  const modules = path.join(out, 'editor', 'node_modules');
  for (const name of packageNames(path.join(editor, 'remote', 'node_modules'))) {
    // The host is bundled Node, so server packages take precedence over Electron-targeted packages.
    fs.rmSync(path.join(modules, name), { recursive: true, force: true });
    copy(path.join(editor, 'remote', 'node_modules', name), path.join(modules, name));
  }

  const extensionsFrom = path.join(editor, 'extensions'); const extensionsTo = path.join(out, 'editor', 'extensions');
  const kept = [];
  for (const entry of fs.readdirSync(extensionsFrom, { withFileTypes: true })) {
    if (DROPPED.has(entry.name) || entry.name.startsWith('.')) continue;
    const from = path.join(extensionsFrom, entry.name); const to = path.join(extensionsTo, entry.name);
    if (!entry.isDirectory() || entry.name === 'node_modules') { copy(from, to); continue; }
    fs.mkdirSync(to, { recursive: true });
    for (const item of fs.readdirSync(from)) if (item !== 'node_modules') copy(path.join(from, item), path.join(to, item));
    if (fs.existsSync(path.join(from, 'node_modules'))) for (const rel of productionPackages(from)) copy(path.join(from, rel), path.join(to, rel));
    kept.push(entry.name);
  }
  shareCommon(extensionsTo, kept);
  return { out, extensions: kept.length };
}

if (require.main === module) {
  try { const { out, extensions } = stage(parseArgs(process.argv.slice(2))); console.log(`Nabu runtime staged in ${out} (${extensions} extensions)`); }
  catch (error) { console.error(`Stage failed: ${error.message}`); process.exit(1); }
}

module.exports = { stage, DROPPED, shareCommon, productionPackages };
