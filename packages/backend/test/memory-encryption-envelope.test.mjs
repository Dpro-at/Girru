import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealMemoryText, openMemoryText, createMemoryDataKey, unlockMemoryDataKey, MemoryCipherError, MAX_MEMORY_PLAINTEXT_BYTES, createMemoryRecoveryRecord, recoverMemoryMasterKey } from '../src/memory/encryption/envelope.ts';
import { encryptAES256GCM, decryptAES256GCM } from '../src/encryption/crypto-utils.ts';
const context = { ownerId: 'owner-a', memberId: 'member-a', recordId: 'memory-a', field: 'content' };
const key = randomBytes(32), keyId = 'key-a';
const expectInvalid = fn => assert.throws(fn, MemoryCipherError);
test('existing AES-GCM callers remain compatible without additional authenticated data', () => {
  const value = encryptAES256GCM('existing vault trial', key, keyId);
  assert.equal(decryptAES256GCM(value, key).toString(), 'existing vault trial');
});
test('UTF-8 and empty memory round-trip; random nonces prevent identical stored ciphertext', () => {
  for (const text of ['', 'Synthetic English memory', 'ذاكرة تجريبية — قرار قديم', '🧪\nline two']) {
    const first = sealMemoryText(text, key, keyId, context), second = sealMemoryText(text, key, keyId, context);
    assert.notEqual(first, second);
    assert.equal(openMemoryText(first, key, keyId, context), text);
    assert.equal(openMemoryText(second, key, keyId, context), text);
  }
});
test('same key cannot decrypt ciphertext swapped between owners, members, records or fields', () => {
  const raw = sealMemoryText('scope trial', key, keyId, context);
  for (const field of ['ownerId', 'memberId', 'recordId', 'field']) expectInvalid(() => openMemoryText(raw, key, keyId, { ...context, [field]: 'other' }));
  expectInvalid(() => openMemoryText(raw, randomBytes(32), keyId, context));
  expectInvalid(() => openMemoryText(raw, key, 'other-key', context));
});
test('ciphertext, nonce, tag, key id and format tampering fail closed, with no plaintext fallback', () => {
  const raw = sealMemoryText('do not return on error', key, keyId, context);
  for (const field of ['n', 't', 'c']) {
    const e = JSON.parse(raw), bytes = Buffer.from(e[field], 'base64'); bytes[0] ^= 1; e[field] = bytes.toString('base64');
    expectInvalid(() => openMemoryText(JSON.stringify(e), key, keyId, context));
  }
  for (const malformed of ['plain memory', '{}', 'null', '[]', raw.replace('"v":1', '"v":2'), JSON.stringify({ ...JSON.parse(raw), algorithm: 'aes-256-cbc' }), JSON.stringify({ ...JSON.parse(raw), n: 'bad' })]) {
    expectInvalid(() => openMemoryText(malformed, key, keyId, context));
  }
});
test('member data keys are independent and only wrapped records are persisted', () => {
  const master = randomBytes(32), a = createMemoryDataKey(master, 'owner-a', 'member-a'), b = createMemoryDataKey(master, 'owner-a', 'member-b');
  const ak = unlockMemoryDataKey(a, master, 'owner-a', 'member-a'), bk = unlockMemoryDataKey(b, master, 'owner-a', 'member-b');
  try {
    assert.notEqual(a.id, b.id); assert.notDeepEqual(ak, bk);
    assert.deepEqual(Object.keys(a).sort(), ['id', 'wrapped']);
    expectInvalid(() => unlockMemoryDataKey(a, master, 'owner-a', 'member-b'));
    expectInvalid(() => unlockMemoryDataKey(a, master, 'owner-b', 'member-a'));
    expectInvalid(() => unlockMemoryDataKey(a, randomBytes(32), 'owner-a', 'member-a'));
    expectInvalid(() => openMemoryText(a.wrapped, master, a.id, { ownerId: 'owner-a', memberId: 'member-a', recordId: a.id, field: 'wrapped-data-key' }));
    const sentinel = 'ENC01_SYNTHETIC_DISK_SENTINEL_20261106', raw = sealMemoryText(sentinel, ak, a.id, context);
    const dir = mkdtempSync(join(tmpdir(), 'girru-encrypted-envelope-'));
    try {
      const file = join(dir, 'ciphertext.json'); writeFileSync(file, JSON.stringify({ key: a, memory: raw }));
      const disk = readFileSync(file); assert.ok(!disk.includes(Buffer.from(sentinel))); assert.ok(!disk.includes(Buffer.from(ak.toString('base64'))));
      assert.equal(openMemoryText(JSON.parse(disk).memory, ak, a.id, context), sentinel);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally { ak.fill(0); bk.fill(0); master.fill(0); }
});
test('size, identity and key constraints reject invalid inputs before returning plaintext', () => {
  const max = 'x'.repeat(MAX_MEMORY_PLAINTEXT_BYTES), raw = sealMemoryText(max, key, keyId, context);
  assert.equal(openMemoryText(raw, key, keyId, context).length, max.length);
  expectInvalid(() => sealMemoryText(max + 'x', key, keyId, context));
  expectInvalid(() => sealMemoryText('text', Buffer.alloc(31), keyId, context));
  expectInvalid(() => sealMemoryText('\ud800', key, keyId, context));
  expectInvalid(() => unlockMemoryDataKey(null, key, 'owner-a', 'member-a'));
  expectInvalid(() => createMemoryDataKey(Buffer.alloc(31), 'owner-a', 'member-a'));
  expectInvalid(() => sealMemoryText('text', key, keyId, { ...context, ownerId: '' }));
  expectInvalid(() => sealMemoryText('text', key, keyId, { ...context, field: 'content\u0000other' }));
  expectInvalid(() => openMemoryText('x'.repeat(MAX_MEMORY_PLAINTEXT_BYTES * 2), key, keyId, context));
});

test('recovery restores the exact master and member data keys on a synthetic copied record', () => {
  const master = randomBytes(32), recovery = createMemoryRecoveryRecord(master, context.ownerId);
  const dataRecord = createMemoryDataKey(master, context.ownerId, context.memberId);
  const originalKey = unlockMemoryDataKey(dataRecord, master, context.ownerId, context.memberId);
  const ciphertext = sealMemoryText('RECOVERY_SYNTHETIC_MEMORY', originalKey, dataRecord.id, context);
  const copy = JSON.parse(JSON.stringify({ recovery: recovery.record, dataRecord, ciphertext }));
  assert.ok(!JSON.stringify(copy).includes(recovery.recoveryCode));
  assert.ok(!JSON.stringify(copy).includes(master.toString('base64')));
  assert.ok(!JSON.stringify(copy).includes('RECOVERY_SYNTHETIC_MEMORY'));
  const restored = recoverMemoryMasterKey(copy.recovery, recovery.recoveryCode, context.ownerId);
  const restoredData = unlockMemoryDataKey(copy.dataRecord, restored, context.ownerId, context.memberId);
  try {
    assert.deepEqual(restored, master); assert.deepEqual(restoredData, originalKey);
    assert.equal(openMemoryText(copy.ciphertext, restoredData, copy.dataRecord.id, context), 'RECOVERY_SYNTHETIC_MEMORY');
  } finally { master.fill(0); originalKey.fill(0); restored.fill(0); restoredData.fill(0); }
});
test('recovery fails closed for wrong codes, owner, record id, purpose or malformed input', () => {
  const master = randomBytes(32), a = createMemoryRecoveryRecord(master, context.ownerId), b = createMemoryRecoveryRecord(master, context.ownerId);
  try {
    expectInvalid(() => recoverMemoryMasterKey(a.record, b.recoveryCode, context.ownerId));
    expectInvalid(() => recoverMemoryMasterKey(a.record, a.recoveryCode, 'other-owner'));
    expectInvalid(() => recoverMemoryMasterKey({ ...a.record, id: 'other-record' }, a.recoveryCode, context.ownerId));
    for (const code of ['', a.recoveryCode + '=', a.recoveryCode + ' ', 'girru-recovery-v2.' + a.recoveryCode.split('.')[1], 'x'.repeat(100000)]) {
      expectInvalid(() => recoverMemoryMasterKey(a.record, code, context.ownerId));
    }
    expectInvalid(() => recoverMemoryMasterKey(null, a.recoveryCode, context.ownerId));
    const rawKey = Buffer.from(a.recoveryCode.split('.')[1], 'base64url');
    try { expectInvalid(() => unlockMemoryDataKey(a.record, rawKey, context.ownerId, context.ownerId)); } finally { rawKey.fill(0); }
  } finally { master.fill(0); }
});
test('recovery codes are independent; creating a new record does not falsely revoke an older exported record', () => {
  const master = randomBytes(32), a = createMemoryRecoveryRecord(master, context.ownerId), b = createMemoryRecoveryRecord(master, context.ownerId);
  assert.notEqual(a.recoveryCode, b.recoveryCode); assert.notEqual(a.record.id, b.record.id);
  const older = recoverMemoryMasterKey(a.record, a.recoveryCode, context.ownerId);
  try { assert.deepEqual(older, master); } finally { older.fill(0); master.fill(0); }
});
