/**
 * Off-site backup archive (BACKUP-02, slice 1): pack a finished local backup
 * folder into ONE encrypted blob so it can be sent off the computer while the
 * provider only ever sees ciphertext (server-relay-only; design D2 "off-site
 * always encrypted, no opt-out").
 *
 *  - The blob is our own tiny archive format (no new packages): a magic, a
 *    length-prefixed JSON header listing every file and its byte length, then
 *    the files' bytes in order. It is gzip'd, then encrypted with AES-256-GCM
 *    using a data key from the EXISTING key manager (`getKeyManager`), the same
 *    key custody the credential vault uses. The key never leaves the computer.
 *  - A small sidecar (`<blob>.meta.json`) travels next to the blob. It holds the
 *    key id, IV and GCM tag and the plaintext/ciphertext SHA-256 — none of which
 *    is secret. The actual data key stays wrapped in the key manager, so the
 *    sidecar plus the blob are still zero-knowledge to the destination.
 *  - Decrypt verifies the ciphertext hash first (cheap truncation/corruption
 *    check), then the GCM tag (authenticity), then the plaintext hash after
 *    unpacking (the restored bytes are exactly what was saved). Any mismatch
 *    fails closed and writes nothing usable.
 *
 * This is the building block destination adapters (slice 3) upload; it does not
 * itself touch the network or the off-site places.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { createUnprotectedReadStream, assertMemoryFilesystemAccess } from '../memory/encryption/protected-filesystem.js';
import { getKeyManager, KeyManager } from '../encryption/key-manager.js';

/** Magic for our archive format; the version follows so an older reader refuses a newer blob. */
const MAGIC = Buffer.from('GIRRUAR1', 'latin1');
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A header larger than this is treated as a corrupt/hostile blob. */
const MAX_HEADER = 16 * 1024 * 1024;

export class ArchiveError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

interface ArchiveEntry { p: string; n: number }
interface ArchiveHeader { v: 1; id: string; entries: ArchiveEntry[] }

/** What travels next to the blob. Nothing here is secret; the data key stays in the key manager. */
export interface ArchiveMeta {
  v: 1;
  id: string;
  algorithm: typeof ALGO;
  keyId: string;
  iv: string;
  authTag: string;
  gzip: true;
  originalSize: number;
  originalSha256: string;
  cipherSize: number;
  cipherSha256: string;
  createdAt: string;
}

const posix = (rel: string) => rel.split(path.sep).join('/');
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

/** Every regular file under `dir` (no symlinks), relative posix path + size, sorted for a stable blob. */
function listFiles(dir: string): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  const visit = (rel: string) => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const name of fs.readdirSync(abs)) {
      const r = rel ? path.join(rel, name) : name;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isDirectory()) visit(r);
      else if (st.isFile()) out.push({ p: posix(r), n: st.size });
      // symlinks and anything else are skipped: a backup blob carries bytes, not links.
    }
  };
  visit('');
  return out.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
}

/** The archive as a stream: magic, header length, header JSON, then each file's bytes in header order. */
function packStream(dir: string, header: ArchiveHeader): Readable {
  async function* gen(): AsyncGenerator<Buffer> {
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    yield MAGIC;
    yield u32(json.length);
    yield json;
    for (const e of header.entries) {
      const file = path.join(dir, ...e.p.split('/'));
      const stream = createUnprotectedReadStream(file);
      let seen = 0;
      for await (const chunk of stream) { seen += (chunk as Buffer).length; yield chunk as Buffer; }
      // The header promised exactly e.n bytes; a file that changed under us would desync the blob.
      if (seen !== e.n) throw new ArchiveError('changed', `A file changed while packing: ${e.p}`);
    }
  }
  return Readable.from(gen());
}

const hashTap = (hash: ReturnType<typeof createHash>) =>
  new Transform({ transform(chunk, _enc, cb) { hash.update(chunk as Buffer); cb(null, chunk); } });

/**
 * Additional authenticated data: binds the ciphertext to this exact backup's
 * identity (version, id, algorithm, time). A blob paired with a sidecar that
 * names a different backup fails the GCM tag, so one backup's blob cannot be
 * substituted for another even under the same key.
 */
const aadFor = (id: string, createdAt: string) => Buffer.from(`GIRRUAR1\n1\n${id}\n${ALGO}\n${createdAt}`, 'utf8');

/**
 * Pack the local backup folder `dir` into the encrypted blob at `outFile` and
 * write `<outFile>.meta.json` beside it. The key manager must be initialized.
 */
export async function encryptBackupArchive(id: string, dir: string, outFile: string, km: KeyManager = getKeyManager()): Promise<ArchiveMeta> {
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new ArchiveError('not_a_backup', 'The backup folder is missing');
  const header: ArchiveHeader = { v: 1, id, entries: listFiles(dir) };

  const { keyId, key } = await km.getCurrentKey();
  const createdAt = new Date().toISOString();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadFor(id, createdAt));
  const plainHash = createHash('sha256');
  const cipherHash = createHash('sha256');
  let originalSize = 0;
  const countPlain = new Transform({ transform(chunk, _e, cb) { originalSize += (chunk as Buffer).length; cb(null, chunk); } });

  fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
  await pipeline(
    packStream(dir, header),
    countPlain, hashTap(plainHash),
    createGzip({ level: 6 }),
    cipher, hashTap(cipherHash),
    fs.createWriteStream(outFile, { mode: 0o600 }),
  );

  const meta: ArchiveMeta = {
    v: 1, id, algorithm: ALGO, keyId,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    gzip: true,
    originalSize, originalSha256: plainHash.digest('hex'),
    cipherSize: fs.statSync(outFile).size, cipherSha256: cipherHash.digest('hex'),
    createdAt,
  };
  const tmp = `${outFile}.meta.json.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, `${outFile}.meta.json`);
  return meta;
}

function validMeta(m: unknown): m is ArchiveMeta {
  const o = m as Partial<ArchiveMeta> | null;
  if (!o || o.v !== 1 || o.algorithm !== ALGO || typeof o.keyId !== 'string'
    || typeof o.id !== 'string' || typeof o.createdAt !== 'string'
    || typeof o.iv !== 'string' || typeof o.authTag !== 'string'
    || typeof o.originalSha256 !== 'string' || typeof o.cipherSha256 !== 'string'
    || !Number.isInteger(o.originalSize) || (o.originalSize as number) < 0) return false;
  // The IV and GCM tag must be exactly the right size; a short tag weakens the check.
  const ivLen = Buffer.from(o.iv, 'base64').length;
  const tagLen = Buffer.from(o.authTag, 'base64').length;
  return ivLen === IV_BYTES && tagLen === TAG_BYTES;
}

/** Read and validate the sidecar written by encryptBackupArchive. */
export function readArchiveMeta(metaFile: string): ArchiveMeta {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { throw new ArchiveError('bad_meta', 'The backup description is missing or unreadable'); }
  if (!validMeta(parsed)) throw new ArchiveError('bad_meta', 'The backup description is not valid');
  return parsed;
}

const inside = (child: string, parent: string) => { const r = path.relative(parent, child); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };

/** Write one entry's bytes safely under destDir, refusing any path that escapes it. */
function entryTarget(destDir: string, rel: string): string {
  if (path.isAbsolute(rel) || rel.split('/').some((s) => s === '..' || s === '')) throw new ArchiveError('bad_entry', 'The backup holds an unsafe path');
  const target = path.join(destDir, ...rel.split('/'));
  if (!inside(target, destDir)) throw new ArchiveError('bad_entry', 'The backup holds an unsafe path');
  return target;
}

/**
 * Consume the decrypted archive stream and write every file under destDir.
 * `maxBytes` caps the total decrypted/decompressed output (meta.originalSize):
 * a correct blob produces exactly that many bytes, so anything beyond it is a
 * decompression bomb or a lying header and is refused before more is written.
 */
async function unpack(src: AsyncIterable<Buffer>, destDir: string, maxBytes: number, requireId: string): Promise<void> {
  let buf = Buffer.alloc(0);
  let consumed = 0;
  const chunks = src[Symbol.asyncIterator]();
  const pull = async (): Promise<boolean> => {
    const { value, done } = await chunks.next();
    if (done) return false;
    consumed += (value as Buffer).length;
    if (consumed > maxBytes) throw new ArchiveError('too_large', 'The backup is larger than it claims and was refused');
    buf = Buffer.concat([buf, value as Buffer]);
    return true;
  };
  const need = async (n: number) => { while (buf.length < n) { if (!(await pull())) throw new ArchiveError('truncated', 'The backup ended early'); } };
  // On any failure, finish reading the source so the decrypt pipeline ends
  // naturally (which also runs decipher.final() and checks the GCM tag) instead
  // of being torn down mid-stream.
  const drain = async () => { try { while (true) { const { done } = await chunks.next(); if (done) break; } } catch { /* a later stage may error while draining; the first error wins */ } };
  try {
    await unpackInner();
  } catch (err) { await drain(); throw err; }

  async function unpackInner(): Promise<void> {
  await need(MAGIC.length + 4);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new ArchiveError('bad_format', 'Not a Girru backup archive');
  const headerLen = buf.readUInt32BE(MAGIC.length);
  if (headerLen <= 0 || headerLen > MAX_HEADER) throw new ArchiveError('bad_format', 'The backup header is not valid');
  await need(MAGIC.length + 4 + headerLen);
  let header: ArchiveHeader;
  try { header = JSON.parse(buf.subarray(MAGIC.length + 4, MAGIC.length + 4 + headerLen).toString('utf8')); } catch { throw new ArchiveError('bad_format', 'The backup header is not valid'); }
  if (!header || header.v !== 1 || !Array.isArray(header.entries)) throw new ArchiveError('bad_format', 'The backup header is not valid');
  // The header's own id must match the sidecar's (and the caller's) id, so a blob
  // cannot be paired with a description from a different backup.
  if (header.id !== requireId) throw new ArchiveError('wrong_backup', 'The backup contents do not match their description');
  // The whole plaintext is magic + length + header + every file's bytes. Require the
  // declared sizes to add up to exactly the promised total, so no entry can over-claim.
  let declared = MAGIC.length + 4 + headerLen;
  for (const e of header.entries) {
    if (!e || !Number.isInteger(e.n) || e.n < 0) throw new ArchiveError('bad_entry', 'The backup holds a bad entry');
    declared += e.n;
    if (declared > maxBytes) throw new ArchiveError('too_large', 'The backup claims more data than it carries');
  }
  if (declared !== maxBytes) throw new ArchiveError('bad_format', 'The backup size does not match its description');
  buf = buf.subarray(MAGIC.length + 4 + headerLen);

  for (const e of header.entries) {
    if (!e || typeof e.p !== 'string' || !Number.isInteger(e.n) || e.n < 0) throw new ArchiveError('bad_entry', 'The backup holds a bad entry');
    const target = entryTarget(destDir, e.p);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const out = fs.createWriteStream(target, { mode: 0o600 });
    try {
      let left = e.n;
      while (left > 0) {
        if (buf.length === 0 && !(await pull())) throw new ArchiveError('truncated', 'The backup ended early');
        const take = Math.min(left, buf.length);
        await new Promise<void>((res, rej) => out.write(buf.subarray(0, take), (err) => (err ? rej(err) : res())));
        buf = buf.subarray(take);
        left -= take;
      }
    } finally { await new Promise<void>((res) => out.end(res)); }
  }

  // Drain the rest so the decrypt pipeline ends naturally (that is what runs
  // decipher.final() and verifies the GCM tag). A correct blob has nothing left.
  if (buf.length > 0) throw new ArchiveError('bad_format', 'The backup has unexpected trailing data');
  while (await pull()) if (buf.length > 0) throw new ArchiveError('bad_format', 'The backup has unexpected trailing data');
  }
}

/**
 * Decrypt and unpack an encrypted blob back into the folder `destDir`. Verifies
 * the ciphertext hash, the GCM tag and the plaintext hash; any failure throws
 * and leaves no trusted output.
 */
export async function decryptBackupArchive(encFile: string, meta: ArchiveMeta, destDir: string, km: KeyManager = getKeyManager(), expectedId?: string): Promise<void> {
  if (!validMeta(meta)) throw new ArchiveError('bad_meta', 'The backup description is not valid');
  // When the caller knows which backup it asked for, the sidecar must name that
  // one — this is the trust anchor the AAD binding and header check are measured
  // against (a swapped-in valid-but-different backup is refused).
  if (expectedId !== undefined && meta.id !== expectedId) throw new ArchiveError('wrong_backup', 'This is not the backup that was asked for');
  // Cheap, up-front: the bytes on disk are the bytes we wrote (truncation/corruption/swap).
  assertMemoryFilesystemAccess(encFile);
  const onDisk = createHash('sha256');
  await pipeline(createUnprotectedReadStream(encFile), onDisk);
  const got = onDisk.digest();
  const want = Buffer.from(meta.cipherSha256, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ArchiveError('tampered', 'The backup was changed and cannot be trusted');

  const key = await km.getKey(meta.keyId);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(meta.iv, 'base64'), { authTagLength: TAG_BYTES });
  decipher.setAAD(aadFor(meta.id, meta.createdAt));
  decipher.setAuthTag(Buffer.from(meta.authTag, 'base64'));
  const plainHash = createHash('sha256');

  // Unpack into a staging folder beside destDir (same filesystem, so the promote
  // is an atomic rename). Nothing reaches destDir until the GCM tag AND the
  // plaintext hash both verify, so unauthenticated plaintext is never released.
  const parent = path.dirname(path.resolve(destDir));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(parent, '.restoring-'));
  try {
    // One pass: decrypt → gunzip → hash → unpack. decipher.final() (reached as the
    // pipeline drains) throws on a bad GCM tag, so a tampered blob fails closed.
    await pipeline(
      createUnprotectedReadStream(encFile),
      decipher,
      createGunzip(),
      hashTap(plainHash),
      (source: AsyncIterable<Buffer>) => unpack(source, staging, meta.originalSize, meta.id),
    );
    const gotPlain = plainHash.digest();
    const wantPlain = Buffer.from(meta.originalSha256, 'hex');
    if (gotPlain.length !== wantPlain.length || !timingSafeEqual(gotPlain, wantPlain)) throw new ArchiveError('tampered', 'The restored backup does not match what was saved');
    // Verified: promote the staging folder to destDir atomically.
    if (fs.existsSync(destDir)) throw new ArchiveError('exists', 'The restore target already exists');
    fs.renameSync(staging, destDir);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}
