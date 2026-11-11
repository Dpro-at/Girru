'use strict';
/**
 * Runs before every installer build (npm "predist:*"). electron-builder skips a
 * missing extraResources folder without a word. GenVR and Code are Store apps;
 * the core builds without their runtimes. An optional developer copy must be
 * complete if it is staged.
 *
 * The Code editor (Nabu) is a Store app (D-CODE-STORE): a release builds without
 * nabu-runtime/ and Girru installs Code from the Girru Store. A developer may still
 * stage it with `npm run stage:code`; then it must be complete, because a broken
 * copy in the app would win over the Store copy.
 *
 * Usage: node scripts/check-bundle-inputs.cjs [desktop package folder]
 */
const fs = require('node:fs');
const path = require('node:path');

/** Files the Code editor (Nabu) needs at run time; scripts/verify-code.cjs checks the same ones after the build. */
const CODE_FILES = ['nabu/runtime.json', 'nabu/dpro/editor-runtime.mjs', 'editor/out/server-main.js', 'editor/product.json'];

/** 'none' when nothing is staged, 'ready' when a complete protocol-1 runtime is, else the reason it is broken. */
function codeRuntimeState(desktop = path.resolve(__dirname, '..')) {
  const runtime = path.join(desktop, 'nabu-runtime');
  let entries;
  try { entries = fs.readdirSync(runtime).filter(name => name !== '.DS_Store' && name !== '.gitkeep'); } catch { return 'none'; }
  if (!entries.length) return 'none';
  const missing = CODE_FILES.filter(name => { try { return !fs.statSync(path.join(runtime, name)).isFile(); } catch { return true; } });
  if (missing.length) return `nabu-runtime is only partly staged (${missing[0]} missing): run npm run stage:code again, or delete nabu-runtime/ to build without Code`;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(runtime, 'nabu', 'runtime.json'), 'utf8'));
    if (r.protocolVersion !== 1 || r.entry !== 'dpro/editor-runtime.mjs') return 'nabu-runtime/nabu/runtime.json is not protocol 1: run npm run stage:code again';
  } catch { return 'nabu-runtime/nabu/runtime.json cannot be read: run npm run stage:code again'; }
  return 'ready';
}

/** Problems with the staged inputs, as short reasons (empty = ready). */
function bundleProblems(desktop = path.resolve(__dirname, '..'), pin = require('../../core-ui/scripts/prepare-genvr.cjs')) {
  const problems = [];
  if (!fs.existsSync(path.join(desktop, '..', 'identity', 'src', 'google.cjs'))) problems.push('shared Google identity verifier is missing from the source resource mapping');
  if (!fs.existsSync(path.join(desktop, '..', 'identity', 'src', 'memory-native-proof.cjs'))) problems.push('shared memory proof codec is missing from the source resource mapping');
  if (!fs.existsSync(path.join(desktop, '..', 'identity', 'src', 'memory-native-owner-wire.cjs'))) problems.push('shared native owner codec is missing from the source resource mapping');
  const { VERSION, SHA256 } = pin;
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(desktop, 'payload', 'core-ui', 'vendor', 'genvr', 'manifest.json'), 'utf8')); } catch { /* not staged */ }
  if (!manifest && fs.existsSync(path.join(desktop, 'payload', 'core-ui', 'vendor', 'genvr'))) problems.push('payload GenVR SDK is only partly staged');
  else if (manifest && (manifest.version !== VERSION || manifest.archiveSha256 !== SHA256)) problems.push(`payload GenVR SDK is not the pinned ${VERSION}: prepare it again, then run npm run stage`);
  const code = codeRuntimeState(desktop);
  if (code !== 'none' && code !== 'ready') problems.push(code);
  return problems;
}

if (require.main === module) {
  const desktop = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const problems = bundleProblems(desktop);
  if (problems.length) { for (const p of problems) console.error(`Build stopped: ${p}`); process.exitCode = 1; }
  else console.log(codeRuntimeState(desktop) === 'ready'
    ? 'Bundle inputs ready: core payload, optional bundled Code runtime'
    : 'Bundle inputs ready: GenVR and Code are supplied by the Store');
}

module.exports = { bundleProblems, codeRuntimeState, CODE_FILES };
