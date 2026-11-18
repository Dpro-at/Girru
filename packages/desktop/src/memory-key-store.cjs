'use strict';
/** ENC-01 internal host key custody. Not connected to startup or renderer IPC. */
const fs = require('node:fs');
const path = require('node:path');
const {randomBytes, randomUUID} = require('node:crypto');
const MAX_FILE = 16 * 1024;
class MemoryKeyStoreError extends Error {
  constructor(code) { super(code); this.name = 'MemoryKeyStoreError'; this.code = code; }
}
const fail = code => { throw new MemoryKeyStoreError(code); };
function safeBase64(value, max) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('key_unavailable');
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value) fail('key_unavailable');
  return result;
}
/** Pass Electron safeStorage from the trusted main process; never pass a renderer-supplied provider. */
function createMemoryMasterKeyStore({directory, protector, platform = process.platform}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !protector) fail('invalid_key_store');
  const file = path.join(directory, 'memory-master-key.json');
  function available() {
    try {
      if (!protector.isEncryptionAvailable()) fail('protected_storage_unavailable');
      // Electron's basic_text fallback is not OS-protected storage.
      if (platform === 'linux' && (!protector.getSelectedStorageBackend || !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(protector.getSelectedStorageBackend()))) fail('protected_storage_unavailable');
    } catch { fail('protected_storage_unavailable'); }
  }
  function base(create) {
    if (create) fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    const st = fs.lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) fail('invalid_key_store');
  }
  function read() {
    let fd;
    try {
      available(); base(false);
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const st = fs.fstatSync(fd), entry = fs.lstatSync(file);
      if (!st.isFile() || entry.isSymbolicLink() || st.dev !== entry.dev || st.ino !== entry.ino || st.size < 1 || st.size > MAX_FILE) fail('key_unavailable');
      const buffer = Buffer.alloc(st.size + 1); let used = 0;
      while (used < buffer.length) { const n = fs.readSync(fd, buffer, used, buffer.length - used, used); if (!n) break; used += n; }
      if (used !== st.size) fail('key_unavailable');
      const record = JSON.parse(buffer.subarray(0, used).toString('utf8'));
      if (!record || Object.keys(record).sort().join(',') !== 'protectedKey,v' || record.v !== 1) fail('key_unavailable');
      const cipher = safeBase64(record.protectedKey, MAX_FILE);
      const encoded = protector.decryptString(cipher);
      const key = safeBase64(encoded, 44);
      if (key.length !== 32) { key.fill(0); fail('key_unavailable'); }
      return key; // Caller owns this buffer and must wipe it after use.
    } catch (error) {
      if (error instanceof MemoryKeyStoreError) throw error;
      if (error?.code === 'ENOENT') fail('key_missing');
      fail('key_unavailable');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function persist(recovered) {
    let temporary, secret;
    try {
      available(); base(true);
      // Explicit creation only. Never replace a key after a decrypt/read failure.
      if (fs.existsSync(file)) fail('key_already_exists');
      secret = recovered ? Buffer.from(recovered) : randomBytes(32);
      const protectedKey = protector.encryptString(secret.toString('base64'));
      if (!Buffer.isBuffer(protectedKey) || !protectedKey.length || protectedKey.length > 8192) fail('protected_storage_unavailable');
      const body = JSON.stringify({v: 1, protectedKey: protectedKey.toString('base64')});
      temporary = path.join(directory, `.memory-key-${randomUUID()}.tmp`);
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // Atomic no-replace publication: concurrent creators cannot overwrite an existing key.
      fs.linkSync(temporary, file);
      return Buffer.from(secret);
    } catch (error) {
      if (error instanceof MemoryKeyStoreError) throw error;
      if (error?.code === 'EEXIST') fail('key_already_exists');
      fail('key_unavailable');
    } finally {
      secret?.fill(0);
      if (temporary) { try { fs.unlinkSync(temporary); } catch { /* A failed cleanup never replaces the original key. */ } }
    }
  }
  function create() { return persist(null); }
  // Only enroll after authenticated recovery and verification on a separate data copy.
  function enrollRecovered(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) fail('key_unavailable');
    return persist(key);
  }
  return {create, read, enrollRecovered};
}
module.exports = {createMemoryMasterKeyStore, MemoryKeyStoreError};
