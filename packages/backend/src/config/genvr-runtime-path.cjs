'use strict';
// Shared by the backend and the desktop bridge; it never opens workspace databases.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const PIN = Object.freeze({ version: '0.3.0-preview.22', archiveSha256: 'c8307a9d15cb89e26ab79fc129d177825ab768a987c0db0ef9543f00d18c0324', entrySha256: '3deb372f59c024eb37528c6d6cd9af95381749161977c6c93feba54097344d90', size: 181646087 });
const DIR = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?-[a-f0-9]{8}$/;

function regular(root, relative) {
  let file = root;
  const base = fs.lstatSync(root);
  if (!base.isDirectory() || base.isSymbolicLink()) throw Error('Invalid runtime folder');
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..' || /[\\:]/.test(part)) throw Error('Invalid runtime path');
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink()) throw Error('Runtime links are not allowed');
  }
  if (!fs.statSync(file).isFile()) throw Error('Runtime file unavailable');
  return file;
}
function bytes(root, relative, max) {
  const file = regular(root, relative), fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) throw Error('Runtime file too large');
    const data = Buffer.alloc(st.size + 1); let used = 0;
    while (used < data.length) { const n = fs.readSync(fd, data, used, data.length - used, null); if (!n) break; used += n; }
    if (used > st.size) throw Error('Runtime file changed');
    return data.subarray(0, used);
  } finally { fs.closeSync(fd); }
}
const json = (root, relative, max) => JSON.parse(bytes(root, relative, max).toString('utf8'));

/** Only the reviewed SDK version is compatible with this bridge and its pinned MCP entry. */
function completeGenvrRuntime(root, pin = PIN) {
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return null;
    root = fs.realpathSync(root);
    const manifest = json(root, 'manifest.json', 4 * 1024 * 1024), pkg = json(root, 'package/package.json', 65536);
    if (manifest.package !== '3d-world-sdk' || manifest.version !== pin.version || manifest.archiveSha256 !== pin.archiveSha256 || pkg.name !== '3d-world-sdk' || pkg.version !== pin.version || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) return null;
    const entries = Object.entries(manifest.files);
    if (!entries.length || entries.length > 50000 || entries.some(([name, hash]) => !name || name.startsWith('/') || /[\\:\0]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..') || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) return null;
    for (const name of ['dist/studio.js', 'dist/studio.css', 'live-studio-bridge.mjs', 'local-voice.mjs', 'LICENSE']) regular(root, `package/${name}`);
    if (createHash('sha256').update(bytes(root, 'package/dist/mcp.js', 16 * 1024 * 1024)).digest('hex') !== pin.entrySha256) return null;
    return { root, packageDir: path.join(root, 'package'), version: pin.version, manifest };
  } catch { return null; }
}

function installedGenvrRuntime(runtimesDir, pin = PIN) {
  if (typeof runtimesDir !== 'string' || !path.isAbsolute(runtimesDir)) return null;
  try {
    const base = path.join(runtimesDir, 'genvr'), current = json(base, 'current.json', 4096);
    if (typeof current.dir !== 'string' || !DIR.test(current.dir) || current.version !== pin.version || !current.dir.startsWith(`${pin.version}-`) || current.sha256 !== pin.archiveSha256) return null;
    const runtime = completeGenvrRuntime(path.join(base, current.dir), pin);
    return runtime ? { ...runtime, source: 'installed', dir: current.dir, installedAt: typeof current.installedAt === 'string' ? current.installedAt : '' } : null;
  } catch { return null; }
}
/** @param {{runtimesDir?: string, bundledRoot?: string, pin?: typeof PIN}} [options] */
function resolveGenvrRuntime({ runtimesDir, bundledRoot, pin = PIN } = {}) {
  const installed = installedGenvrRuntime(runtimesDir, pin);
  if (installed) return installed;
  const bundled = bundledRoot ? completeGenvrRuntime(bundledRoot, pin) : null;
  return bundled ? { ...bundled, source: 'bundled' } : null;
}

module.exports = { PIN, completeGenvrRuntime, installedGenvrRuntime, resolveGenvrRuntime };
