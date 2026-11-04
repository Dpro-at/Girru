'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { compatibleRuntime } = require('./nabu-editor.cjs');

/** The folder names the backend gives a Store-installed Code runtime: <version>-<8 hex>. */
const DIR_NAME = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?-[a-f0-9]{8}$/;

/**
 * CODE-STORE-01: the Code editor runtime this app can open. A developer build may carry it
 * inside the app (Resources/nabu-runtime); a release gets it from the Girru Store, which
 * the backend unpacks into <runtimesDir>/code/<version>-<tag> and names in current.json.
 * Only a real folder directly inside <runtimesDir>/code counts: no links anywhere on the way.
 */
function resolveCodeRuntime({ bundled, runtimesDir }) {
  if (bundled && compatibleRuntime(bundled)) return { root: bundled, source: 'bundled' };
  if (!runtimesDir || !path.isAbsolute(runtimesDir)) return null;
  try {
    const codeDir = path.join(runtimesDir, 'code');
    for (const at of [runtimesDir, codeDir]) { const info = fs.lstatSync(at); if (!info.isDirectory() || info.isSymbolicLink()) return null; }
    const file = path.join(codeDir, 'current.json');
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return null;
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof current.dir !== 'string' || !DIR_NAME.test(current.dir) || typeof current.version !== 'string' || !current.dir.startsWith(current.version + '-')) return null;
    const root = path.join(codeDir, current.dir);
    const dir = fs.lstatSync(root);
    if (!dir.isDirectory() || dir.isSymbolicLink()) return null;
    for (const part of ['nabu', path.join('nabu', 'dpro'), path.join('nabu', 'dpro', 'editor-runtime.mjs')]) if (fs.lstatSync(path.join(root, part)).isSymbolicLink()) return null;
    return compatibleRuntime(root) ? { root, source: 'store', version: current.version } : null;
  } catch { return null; }
}

module.exports = { resolveCodeRuntime, DIR_NAME };
