'use strict';
/**
 * Where the bundled pieces are.
 *
 * Packaged app: <resources>/payload/{node/node[.exe], backend, core-ui}, made
 * by scripts/stage-payload.cjs and copied in by electron-builder.
 * From source (`npm start` in this package): the repository's own
 * packages/backend and packages/core-ui, and the Node found on PATH (or
 * DPRO_DESKTOP_NODE).
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const TSX_LOADER = ['node_modules', 'tsx', 'dist', 'loader.mjs'];

function findOnPath(name, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE').split(';') : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try { if (fs.statSync(file).isFile()) return file; } catch { /* next */ }
    }
  }
  return null;
}

function resolvePayload({ packaged, resourcesPath, env = process.env }) {
  if (packaged) {
    const root = path.join(resourcesPath, 'payload');
    return {
      node: path.join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
      backendDir: path.join(root, 'backend'),
      coreUiDir: path.join(root, 'core-ui'),
    };
  }
  const packages = path.resolve(__dirname, '..', '..');
  return {
    node: env.DPRO_DESKTOP_NODE || findOnPath('node', env),
    backendDir: path.join(packages, 'backend'),
    coreUiDir: path.join(packages, 'core-ui'),
  };
}

/** Packaged JavaScript needs no loader; source development retains its tsx entry. */
function backendArgs(backendDir) {
  const compiled = path.join(backendDir, 'src', 'api', 'server.js');
  if (!fs.existsSync(path.join(backendDir, 'src', 'api', 'server.ts')) && fs.existsSync(compiled)) return [compiled];
  const loader = path.join(backendDir, ...TSX_LOADER);
  return ['--import', pathToFileURL(loader).href, path.join(backendDir, 'src', 'api', 'server.ts')];
}

/** Missing pieces, as short reasons (empty = ready). */
function checkPayload(payload) {
  const problems = [];
  if (!payload.node || !fs.existsSync(payload.node)) problems.push('Node runtime not found');
  if (fs.existsSync(path.join(payload.backendDir, 'src', 'api', 'server.ts'))) {
    if (!fs.existsSync(path.join(payload.backendDir, ...TSX_LOADER))) problems.push('backend modules not installed');
  } else if (!fs.existsSync(path.join(payload.backendDir, 'src', 'api', 'server.js'))) problems.push('backend not found');
  if (!fs.existsSync(path.join(payload.coreUiDir, 'dist', 'candidate.json'))) problems.push('app UI not built');
  return problems;
}

module.exports = { resolvePayload, backendArgs, checkPayload, findOnPath };
