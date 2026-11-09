'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto');
const {createMemoryMasterKeyStore} = require('../src/memory-key-store.cjs');
function fixture(t, overrides = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'girru-protected-key-'))), wrappingKey = crypto.randomBytes(32);
  t.after(() => { wrappingKey.fill(0); fs.rmSync(directory, {recursive: true, force: true}); });
  const protector = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(text) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv); const out = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]); },
    decryptString(bytes) { const d = crypto.createDecipheriv('aes-256-gcm', wrappingKey, bytes.subarray(0, 12)); d.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString('utf8'); },
    ...overrides,
  };
  return {directory, protector, file: path.join(directory, 'memory-master-key.json'), store: createMemoryMasterKeyStore({directory, protector, platform: 'linux'})};
}
test('protected key survives process-store recreation; only ciphertext persists', t => {
  const x = fixture(t), key = x.store.create();
  try {
    const disk = fs.readFileSync(x.file, 'utf8'); assert.ok(!disk.includes(key.toString('base64')));
    const again = createMemoryMasterKeyStore({directory: x.directory, protector: x.protector, platform: 'linux'}).read();
    try { assert.deepEqual(again, key); } finally { again.fill(0); }
    if (process.platform !== 'win32') assert.equal(fs.statSync(x.file).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(x.directory).filter(n => n.endsWith('.tmp')).length, 0);
  } finally { key.fill(0); }
});
test('missing key stays missing and never initializes during read', t => {
  const x = fixture(t); assert.throws(() => x.store.read(), {code: 'key_missing'}); assert.ok(!fs.existsSync(x.file));
});
test('unavailable or basic-text storage fails closed before writing', t => {
  for (const overrides of [{isEncryptionAvailable: () => false}, {getSelectedStorageBackend: () => 'basic_text'}, {getSelectedStorageBackend: undefined}, {getSelectedStorageBackend: () => undefined}, {getSelectedStorageBackend: () => ''}]) {
    const x = fixture(t, overrides); assert.throws(() => x.store.create(), {code: 'protected_storage_unavailable'}); assert.ok(!fs.existsSync(x.file));
  }
});
test('locked, damaged or replaced records are not silently recreated', t => {
  const x = fixture(t), key = x.store.create(); key.fill(0);
  const original = fs.readFileSync(x.file);
  assert.throws(() => x.store.create(), {code: 'key_already_exists'}); assert.deepEqual(fs.readFileSync(x.file), original);
  x.protector.decryptString = () => { throw Error('provider secret diagnostic'); };
  assert.throws(() => x.store.read(), error => error.code === 'key_unavailable' && !error.message.includes('provider secret'));
  assert.deepEqual(fs.readFileSync(x.file), original);
  fs.writeFileSync(x.file, '{"v":99,"protectedKey":"AAAA"}');
  assert.throws(() => x.store.read(), {code: 'key_unavailable'}); assert.throws(() => x.store.create(), {code: 'key_already_exists'});
});
test('linked records are refused without reading the linked contents', {skip: process.platform === 'win32'}, t => {
  const x = fixture(t), other = path.join(x.directory, 'other'); fs.writeFileSync(other, 'not key material'); fs.symlinkSync(other, x.file);
  assert.throws(() => x.store.read(), {code: 'key_unavailable'}); assert.throws(() => x.store.create(), {code: 'key_already_exists'});
  assert.equal(fs.readFileSync(other, 'utf8'), 'not key material');
});

test('explicit recovered-key enrollment preserves the caller buffer and never replaces existing storage', t => {
  const x = fixture(t), recovered = crypto.randomBytes(32), original = Buffer.from(recovered);
  const returned = x.store.enrollRecovered(recovered);
  try {
    assert.deepEqual(recovered, original); assert.deepEqual(returned, original);
    const read = x.store.read(); try { assert.deepEqual(read, original); } finally { read.fill(0); }
    assert.ok(!fs.readFileSync(x.file, 'utf8').includes(original.toString('base64')));
    assert.throws(() => x.store.enrollRecovered(recovered), {code: 'key_already_exists'});
  } finally { returned.fill(0); recovered.fill(0); original.fill(0); }
});
test('recovery enrollment refuses malformed key material before writing', t => {
  const x = fixture(t);
  for (const bad of [null, 'not-a-key', Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)]) assert.throws(() => x.store.enrollRecovered(bad), {code: 'key_unavailable'});
  assert.ok(!fs.existsSync(x.file));
});
