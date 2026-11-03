'use strict';
/**
 * Runs before every installer build (npm "predist:*"). electron-builder skips a
 * missing extraResources folder without a word, so an app could ship without
 * GenVR or without the Code editor and only fail on the owner's computer.
 * This stops the build instead and names what to stage.
 *
 * Usage: node scripts/check-bundle-inputs.cjs [desktop package folder]
 */
const fs = require('node:fs');
const path = require('node:path');

/** Files the Code editor (Nabu) needs at run time; scripts/verify-code.cjs checks the same ones after the build. */
const CODE_FILES = ['nabu/runtime.json', 'nabu/dpro/editor-runtime.mjs', 'editor/out/server-main.js', 'editor/product.json'];

/** Problems with the staged inputs, as short reasons (empty = ready). */
function bundleProblems(desktop = path.resolve(__dirname, '..'), pin = require('../../core-ui/scripts/prepare-genvr.cjs')) {
  const problems = [];
  const { VERSION, SHA256 } = pin;
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(desktop, 'payload', 'core-ui', 'vendor', 'genvr', 'manifest.json'), 'utf8')); } catch { /* not staged */ }
  if (!manifest) problems.push('payload has no GenVR SDK: prepare core-ui/vendor/genvr, then run npm run stage');
  else if (manifest.version !== VERSION || manifest.archiveSha256 !== SHA256) problems.push(`payload GenVR SDK is not the pinned ${VERSION}: prepare it again, then run npm run stage`);
  const runtime = path.join(desktop, 'nabu-runtime');
  const missing = CODE_FILES.filter(name => { try { return !fs.statSync(path.join(runtime, name)).isFile(); } catch { return true; } });
  if (missing.length) problems.push(`nabu-runtime has no Code editor (${missing[0]} missing): run npm run stage:code`);
  else {
    try { const r = JSON.parse(fs.readFileSync(path.join(runtime, 'nabu', 'runtime.json'), 'utf8')); if (r.protocolVersion !== 1 || r.entry !== 'dpro/editor-runtime.mjs') problems.push('nabu-runtime/nabu/runtime.json is not protocol 1: run npm run stage:code again'); }
    catch { problems.push('nabu-runtime/nabu/runtime.json cannot be read: run npm run stage:code again'); }
  }
  return problems;
}

if (require.main === module) {
  const problems = bundleProblems(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  if (problems.length) { for (const p of problems) console.error(`Build stopped: ${p}`); process.exitCode = 1; }
  else console.log('Bundle inputs ready: payload with GenVR SDK, Code editor runtime');
}

module.exports = { bundleProblems, CODE_FILES };
