'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bundleProblems, codeRuntimeState, CODE_FILES } = require('../scripts/check-bundle-inputs.cjs');
const { requireGenVR } = require('../scripts/stage-payload.cjs');

const pin = { VERSION: '9.9.9-test', SHA256: 'a'.repeat(64) };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('an installer build stops without GenVR; Code is optional but never half-staged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-bundle-inputs-'));
  try {
    const problems = bundleProblems(root, pin);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no GenVR SDK/);
    assert.equal(codeRuntimeState(root), 'none');

    write(path.join(root, 'payload', 'core-ui', 'vendor', 'genvr', 'manifest.json'), JSON.stringify({ version: '0.0.1', archiveSha256: pin.SHA256 }));
    assert.match(bundleProblems(root, pin)[0], /not the pinned 9\.9\.9-test/);
    write(path.join(root, 'payload', 'core-ui', 'vendor', 'genvr', 'manifest.json'), JSON.stringify({ version: pin.VERSION, archiveSha256: pin.SHA256 }));
    // D-CODE-STORE: a release builds without nabu-runtime (Girru installs Code from the Store).
    assert.deepEqual(bundleProblems(root, pin), []);
    fs.mkdirSync(path.join(root, 'nabu-runtime'));
    assert.deepEqual(bundleProblems(root, pin), []);

    write(path.join(root, 'nabu-runtime', CODE_FILES[0]), JSON.stringify({ protocolVersion: 1, entry: 'dpro/editor-runtime.mjs' }));
    assert.match(bundleProblems(root, pin)[0], /only partly staged/);
    for (const name of CODE_FILES) write(path.join(root, 'nabu-runtime', name), name === 'nabu/runtime.json' ? JSON.stringify({ protocolVersion: 2, entry: 'dpro/editor-runtime.mjs' }) : 'x');
    assert.match(bundleProblems(root, pin)[0], /not protocol 1/);
    write(path.join(root, 'nabu-runtime', 'nabu', 'runtime.json'), JSON.stringify({ protocolVersion: 1, entry: 'dpro/editor-runtime.mjs' }));
    assert.deepEqual(bundleProblems(root, pin), []);
    assert.equal(codeRuntimeState(root), 'ready');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('staging refuses to build the payload without the pinned GenVR SDK', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-genvr-stage-'));
  try {
    const { VERSION, SHA256 } = require('../../core-ui/scripts/prepare-genvr.cjs');
    write(path.join(root, 'scripts', 'prepare-genvr.cjs'), `module.exports=${JSON.stringify({ VERSION, SHA256 })};`);
    assert.throws(() => requireGenVR(root), /GenVR SDK .* is not prepared/);
    write(path.join(root, 'vendor', 'genvr', 'manifest.json'), JSON.stringify({ version: VERSION, archiveSha256: 'b'.repeat(64) }));
    assert.throws(() => requireGenVR(root), /is not prepared/);
    write(path.join(root, 'vendor', 'genvr', 'manifest.json'), JSON.stringify({ version: VERSION, archiveSha256: SHA256 }));
    assert.equal(requireGenVR(root), path.join(root, 'vendor', 'genvr'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
