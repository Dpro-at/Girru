/** Only bounded, manifest-verified package bytes can enter the private installation stage. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash, timingSafeEqual} from 'node:crypto';
import {parsePackage, type PackageFile, type StorePackage} from './store-repo.js';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest();
const matches = (bytes: Buffer | string, expected: string) => /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(digest(bytes), Buffer.from(expected, 'hex'));
const reviewedFiles = new WeakSet<object>();
export function captureReviewedStorePackage(input: StorePackage): Readonly<StorePackage> {
  const parsed = parsePackage(input);
  if (!matches(JSON.stringify(parsed.files), parsed.sha256)) throw Error('the package list does not match its checksum');
  for (const file of parsed.files) { Object.freeze(file); reviewedFiles.add(file); }
  Object.freeze(parsed.files);
  return Object.freeze(parsed);
}

export type PackageResponse = {ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; headers?: {get(name: string): string | null}; body?: ReadableStream<Uint8Array> | null};
export type PackageFetch = (url: string, init: {signal: AbortSignal; headers: Record<string, string>; redirect: 'error'}) => Promise<PackageResponse>;
export type VerifiedStoreFile = Readonly<{path: string}>;
const verified = new WeakMap<VerifiedStoreFile, {expected: Readonly<PackageFile>; bytes: Buffer}>();
const refuse = () => Error('a file is not what the Girru Store reviewed; try again later');

export async function downloadReviewedStoreFile(expected: Readonly<PackageFile>, url: string, get: PackageFetch): Promise<VerifiedStoreFile> {
  if (!reviewedFiles.has(expected) || !Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > 5 * 1024 * 1024) throw refuse();
  const res = await get(url, {signal: AbortSignal.timeout(20_000), headers: {'User-Agent': 'Girru', 'Accept-Encoding': 'identity'}, redirect: 'error'});
  if (!res.ok) throw Error(`the Girru Store answered ${res.status}`);
  const length = res.headers?.get('content-length');
  const encoding = res.headers?.get('content-encoding');
  // Fetch decompresses encoded bodies: their wire Content-Length is not the manifest's decoded size.
  if (length !== null && length !== undefined && (!/^\d+$/.test(length) || (!encoding || encoding === 'identity') && Number(length) !== expected.size)) {
    await res.body?.cancel(); throw refuse();
  }
  let bytes: Buffer;
  if (res.body) {
    const reader = res.body.getReader(), chunks: Buffer[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > expected.size) throw refuse();
        chunks.push(Buffer.from(part.value));
      }
      bytes = Buffer.concat(chunks, size);
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  } else {
    // Buffered host adapters are trusted API implementations, not remote response bodies.
    // Real Fetch responses expose body; a missing network stream cannot bypass the bound.
    if ('body' in res && expected.size !== 0) throw refuse();
    bytes = Buffer.from(await res.arrayBuffer());
  }
  if (bytes.length !== expected.size || !matches(bytes, expected.sha256)) throw refuse();
  const file = Object.freeze({path: expected.path});
  verified.set(file, {expected: Object.freeze({...expected}), bytes: Buffer.from(bytes)});
  return file;
}

function record(file: VerifiedStoreFile) {
  const value = verified.get(file);
  if (!value || file.path !== value.expected.path || value.bytes.length !== value.expected.size || !matches(value.bytes, value.expected.sha256)) throw refuse();
  return value;
}
export const verifiedStoreFileBytes = (file: VerifiedStoreFile): Buffer => Buffer.from(record(file).bytes);

/** A branded in-memory receipt is required; downloaded values cannot choose arbitrary write bytes. */
export function writeVerifiedStoreFile(directory: string, file: VerifiedStoreFile): void {
  const value = record(file), parts = file.path.split('/');
  if (!parts.length || parts.length > 8 || parts.some(part => !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(part) || part === '.' || part === '..')) throw refuse();
  const root = fs.realpathSync(directory), stage = fs.lstatSync(directory);
  if (!stage.isDirectory() || stage.isSymbolicLink() || process.platform !== 'win32' && ((stage.mode & 0o077) !== 0 || typeof process.getuid !== 'function' || stage.uid !== process.getuid())) throw refuse();
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part); fs.mkdirSync(parent, {recursive: true, mode: 0o700});
    const st = fs.lstatSync(parent);
    if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(parent) !== parent) throw refuse();
  }
  const current = fs.lstatSync(directory);
  if (current.dev !== stage.dev || current.ino !== stage.ino || current.isSymbolicLink() || fs.realpathSync(directory) !== root) throw refuse();
  const target = path.join(parent, parts[parts.length - 1]!);
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw refuse();
    fs.writeFileSync(fd, value.bytes); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
