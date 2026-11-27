// BACKUP-02 slice 1: the backup archive is packed into ONE blob, encrypted with
// the existing key manager (AES-256-GCM), and decrypts back to the exact same
// files. The blob is ciphertext only; tampering and unsafe paths fail closed.
// Throwaway data dir + keys DB; no network.
// Run: node --import tsx --test test/backup-archive.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash, createCipheriv } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// The module's AAD binding (kept in step with backup-archive.ts): identity bound into the GCM tag.
const aadFor = (id, createdAt) => Buffer.from(`GIRRUAR1\n1\n${id}\naes-256-gcm\n${createdAt}`, 'utf8');

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-archive-'));
const data = join(dir, '.data');
mkdirSync(data, { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = data;
process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString('base64'); // throwaway, test only
process.env.NODE_ENV = 'test';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {}; console.log = quiet; console.info = quiet; console.warn = quiet;

const { KeyManager } = await import(join(backendDir, 'src/encryption/key-manager.ts'));
const A = await import(join(backendDir, 'src/services/backup-archive.ts'));

/** A key manager on its own throwaway keys DB. */
async function freshKeyManager(name) {
  const km = new KeyManager();
  await km.initialize(join(data, name, 'keys.db'));
  return km;
}

/** Build a believable backup folder: nested files, a gzip'd store, a plain secret. */
function makeBackupDir(root) {
  mkdirSync(join(root, 'data', 'agents', 'g-lead'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  const marker = 'TOP-SECRET-MEMORY-abc123';
  writeFileSync(join(root, 'data', 'agent-player.db'), gzipSync(Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from(marker), randomBytes(2048)])));
  writeFileSync(join(root, 'data', 'agents', 'g-lead', 'rules.md'), `be kind\n${marker}\n`);
  writeFileSync(join(root, 'config', '.env'), 'JWT_SECRET=throwaway\n');
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version: 1, id: '20261127-120000-manual' }));
  return marker;
}

/** Every file under a folder as posix-rel path → bytes. */
function snapshot(root) {
  const out = new Map();
  const visit = (rel) => {
    for (const n of readdirSync(join(root, rel || '.'))) {
      const r = rel ? `${rel}/${n}` : n;
      const st = statSync(join(root, r));
      if (st.isDirectory()) visit(r); else out.set(r, readFileSync(join(root, r)));
    }
  };
  visit('');
  return out;
}

after(() => rmSync(dir, { recursive: true, force: true }));

test('round-trip: encrypt to one blob, decrypt to the exact same files', async () => {
  const km = await freshKeyManager('km1');
  const src = join(dir, 'backup-a');
  const marker = makeBackupDir(src);
  const before = snapshot(src);

  const blob = join(dir, 'out', 'a.gbk');
  const meta = await A.encryptBackupArchive('20261127-120000-manual', src, blob, km);
  assert.ok(existsSync(blob), 'the blob is written');
  assert.ok(existsSync(blob + '.meta.json'), 'the sidecar is written');
  assert.equal(meta.algorithm, 'aes-256-gcm');
  assert.ok(typeof meta.keyId === 'string' && meta.keyId.length > 0);
  assert.equal(statSync(blob).mode & 0o777, 0o600, 'owner-only');

  // The provider sees only ciphertext: no plaintext marker, no readable paths.
  const cipher = readFileSync(blob);
  assert.ok(!cipher.includes(Buffer.from(marker)), 'no plaintext memory in the blob');
  assert.ok(!cipher.includes(Buffer.from('agent-player.db')), 'no plaintext file names in the blob');
  assert.ok(!cipher.includes(Buffer.from('JWT_SECRET')), 'no plaintext secret in the blob');
  // The sidecar carries no key material, only public crypto parameters.
  const sidecar = readFileSync(blob + '.meta.json', 'utf8');
  assert.ok(!/MASTER_ENCRYPTION_KEY|BEGIN|[A-Za-z0-9+/]{120,}/.test(sidecar.replace(/"(iv|authTag|originalSha256|cipherSha256)":"[^"]*"/g, '')), 'sidecar has no stray key-like blobs');

  const dest = join(dir, 'restore-a');
  await A.decryptBackupArchive(blob, A.readArchiveMeta(blob + '.meta.json'), dest, km);
  const after2 = snapshot(dest);
  assert.deepEqual([...after2.keys()].sort(), [...before.keys()].sort(), 'same files');
  for (const [p, bytes] of before) assert.deepEqual(after2.get(p), bytes, `bytes match: ${p}`);
});

test('a changed blob on disk is refused (ciphertext hash)', async () => {
  const km = await freshKeyManager('km2');
  const src = join(dir, 'backup-b'); makeBackupDir(src);
  const blob = join(dir, 'out-b', 'b.gbk');
  await A.encryptBackupArchive('20261127-120001-manual', src, blob, km);
  const bytes = readFileSync(blob); bytes[bytes.length - 20] ^= 0xff; writeFileSync(blob, bytes);
  await assert.rejects(() => A.decryptBackupArchive(blob, A.readArchiveMeta(blob + '.meta.json'), join(dir, 'restore-b'), km), /changed|trusted/i);
});

test('a tampered ciphertext with a matching hash still fails the GCM tag', async () => {
  const km = await freshKeyManager('km3');
  const src = join(dir, 'backup-c'); makeBackupDir(src);
  const blob = join(dir, 'out-c', 'c.gbk');
  await A.encryptBackupArchive('20261127-120002-manual', src, blob, km);
  // Flip a byte, then rewrite the sidecar's cipher hash so the cheap check passes;
  // only the authenticated GCM tag can catch this now.
  const bytes = readFileSync(blob); bytes[100] ^= 0x01; writeFileSync(blob, bytes);
  const meta = A.readArchiveMeta(blob + '.meta.json');
  meta.cipherSha256 = createHash('sha256').update(bytes).digest('hex');
  await assert.rejects(() => A.decryptBackupArchive(blob, meta, join(dir, 'restore-c'), km), /.*/);
});

test('a blob whose header hides a path escape is refused', async () => {
  const km = await freshKeyManager('km4');
  const { keyId, key } = await km.getCurrentKey();
  // Hand-craft a plaintext archive with an unsafe entry, then gzip + encrypt it
  // exactly like the real packer, with a matching sidecar.
  const payload = Buffer.from('owned\n');
  const header = Buffer.from(JSON.stringify({ v: 1, id: 'x', entries: [{ p: '../escape.txt', n: payload.length }] }), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
  const archive = Buffer.concat([Buffer.from('GIRRUAR1', 'latin1'), len, header, payload]);
  const gz = gzipSync(archive);
  const iv = randomBytes(12);
  const createdAt = new Date().toISOString();
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aadFor('x', createdAt)); // otherwise valid: only the unsafe path should reject
  const ct = Buffer.concat([c.update(gz), c.final()]);
  const blob = join(dir, 'evil', 'e.gbk'); mkdirSync(join(dir, 'evil'), { recursive: true });
  writeFileSync(blob, ct);
  const meta = { v: 1, id: 'x', algorithm: 'aes-256-gcm', keyId, iv: iv.toString('base64'), authTag: c.getAuthTag().toString('base64'), gzip: true, originalSize: archive.length, originalSha256: createHash('sha256').update(archive).digest('hex'), cipherSize: ct.length, cipherSha256: createHash('sha256').update(ct).digest('hex'), createdAt };
  await assert.rejects(() => A.decryptBackupArchive(blob, meta, join(dir, 'restore-e'), km), /unsafe/);
  assert.ok(!existsSync(join(dir, 'escape.txt')), 'nothing written outside the destination');
});

test('a blob that decompresses to far more than it claims is refused (no disk-fill)', async () => {
  const km = await freshKeyManager('km7');
  const { keyId, key } = await km.getCurrentKey();
  const payload = Buffer.from('small\n');
  const header = Buffer.from(JSON.stringify({ v: 1, id: 'x', entries: [{ p: 'ok.txt', n: payload.length }] }), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
  const framed = Buffer.concat([Buffer.from('GIRRUAR1', 'latin1'), len, header, payload]);
  // The honest archive is `framed`; append 8 MB of zeros that gunzip will emit but
  // the header does not account for. originalSize claims only the honest length.
  const plaintext = Buffer.concat([framed, Buffer.alloc(8 * 1024 * 1024)]);
  const gz = gzipSync(plaintext);
  const iv = randomBytes(12);
  const createdAt = new Date().toISOString();
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aadFor('x', createdAt)); // otherwise valid: only the size cap should reject
  const ct = Buffer.concat([c.update(gz), c.final()]);
  const blob = join(dir, 'bomb', 'b.gbk'); mkdirSync(join(dir, 'bomb'), { recursive: true });
  writeFileSync(blob, ct);
  const meta = { v: 1, id: 'x', algorithm: 'aes-256-gcm', keyId, iv: iv.toString('base64'), authTag: c.getAuthTag().toString('base64'), gzip: true, originalSize: framed.length, originalSha256: createHash('sha256').update(framed).digest('hex'), cipherSize: ct.length, cipherSha256: createHash('sha256').update(ct).digest('hex'), createdAt };
  await assert.rejects(() => A.decryptBackupArchive(blob, meta, join(dir, 'restore-bomb'), km), /larger than it claims|more data than it carries/);
});

test('one backup\'s blob cannot wear another\'s description (AAD + id binding)', async () => {
  const km = await freshKeyManager('km10');
  const src = join(dir, 'backup-i'); makeBackupDir(src);
  const blob = join(dir, 'out-i', 'i.gbk');
  await A.encryptBackupArchive('20261127-120006-manual', src, blob, km);
  const meta = A.readArchiveMeta(blob + '.meta.json');
  // Change the id the sidecar claims: the AAD no longer matches, so the GCM tag fails.
  const swapped = { ...meta, id: '20260101-000000-manual' };
  await assert.rejects(() => A.decryptBackupArchive(blob, swapped, join(dir, 'restore-i1'), km), /.*/);
  // Change the createdAt the sidecar claims: same AAD mismatch.
  const retimed = { ...meta, createdAt: '2000-01-01T00:00:00.000Z' };
  await assert.rejects(() => A.decryptBackupArchive(blob, retimed, join(dir, 'restore-i2'), km), /.*/);
  // The caller can also pin the expected id up front.
  await assert.rejects(() => A.decryptBackupArchive(blob, meta, join(dir, 'restore-i3'), km, 'some-other-id'), /not the backup that was asked for/);
  // The honest trio still restores, including with the matching expected id.
  await A.decryptBackupArchive(blob, meta, join(dir, 'restore-i4'), km, meta.id);
  assert.ok(existsSync(join(dir, 'restore-i4', 'manifest.json')));
});

test('a failed decrypt leaves no destination folder (staging is promoted only when verified)', async () => {
  const km = await freshKeyManager('km8');
  const src = join(dir, 'backup-g'); makeBackupDir(src);
  const blob = join(dir, 'out-g', 'g.gbk');
  await A.encryptBackupArchive('20261127-120004-manual', src, blob, km);
  const bytes = readFileSync(blob); bytes[50] ^= 0x7f; writeFileSync(blob, bytes); // corrupts ciphertext
  const dest = join(dir, 'restore-g');
  await assert.rejects(() => A.decryptBackupArchive(blob, A.readArchiveMeta(blob + '.meta.json'), dest, km), /.*/);
  assert.ok(!existsSync(dest), 'nothing is promoted on failure');
  assert.ok(!readdirSync(join(dir)).some((n) => n.startsWith('.restoring-')), 'no staging folder left behind');
});

test('a sidecar with a short IV or tag is refused', async () => {
  const km = await freshKeyManager('km9');
  const src = join(dir, 'backup-h'); makeBackupDir(src);
  const blob = join(dir, 'out-h', 'h.gbk');
  await A.encryptBackupArchive('20261127-120005-manual', src, blob, km);
  const base = A.readArchiveMeta(blob + '.meta.json');
  const shortTag = { ...base, authTag: Buffer.alloc(8).toString('base64') };
  const shortIv = { ...base, iv: Buffer.alloc(8).toString('base64') };
  await assert.rejects(() => A.decryptBackupArchive(blob, shortTag, join(dir, 'restore-h1'), km), /not valid/);
  await assert.rejects(() => A.decryptBackupArchive(blob, shortIv, join(dir, 'restore-h2'), km), /not valid/);
});

test('the wrong key cannot read the blob', async () => {
  const km = await freshKeyManager('km5');
  const other = await freshKeyManager('km6'); // its own keys DB: it never saw km5's data key
  const src = join(dir, 'backup-f'); makeBackupDir(src);
  const blob = join(dir, 'out-f', 'f.gbk');
  await A.encryptBackupArchive('20261127-120003-manual', src, blob, km);
  await assert.rejects(() => A.decryptBackupArchive(blob, A.readArchiveMeta(blob + '.meta.json'), join(dir, 'restore-f'), other), /.*/);
});
