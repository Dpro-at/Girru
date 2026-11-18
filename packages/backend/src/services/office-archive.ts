/** Read-only ZIP members for Office previews. Nothing is extracted onto disk. */
import { inflateRawSync } from 'node:zlib';

export class OfficeArchiveError extends Error {}
const fail = (): never => { throw new OfficeArchiveError('Unsupported or damaged Office archive'); };
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); return c >>> 0;
});
export function officeCrc32(data: Uint8Array): number {
  let c = 0xffffffff; for (const b of data) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
export type OfficeMember = { name: string; bytes: number; read: () => Buffer };
/** Stored/deflated, single-volume ZIP only; reject encrypted, ZIP64 and ambiguous member names. */
export function officeMembers(data: Buffer): OfficeMember[] {
  if (data.length < 22) return fail();
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
  }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) return fail();
  const count = data.readUInt16LE(end + 10), size = data.readUInt32LE(end + 12), start = data.readUInt32LE(end + 16);
  if (count > 4096 || count !== data.readUInt16LE(end + 8) || start + size !== end || size > 2 * 1024 * 1024) return fail();
  const members: OfficeMember[] = [], names = new Set<string>(); let p = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || data.readUInt32LE(p) !== 0x02014b50) return fail();
    const flags = data.readUInt16LE(p + 8), method = data.readUInt16LE(p + 10), crc = data.readUInt32LE(p + 16);
    const compressed = data.readUInt32LE(p + 20), bytes = data.readUInt32LE(p + 24);
    const nameLen = data.readUInt16LE(p + 28), extra = data.readUInt16LE(p + 30), comment = data.readUInt16LE(p + 32), offset = data.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extra + comment;
    if (next > end || data.readUInt16LE(p + 34) || (flags & (1 | 0x40 | 0x2000)) || ![0, 8].includes(method)) return fail();
    if (bytes > 8 * 1024 * 1024 || (total += bytes) > 24 * 1024 * 1024 || offset + 30 > start || compressed > data.length) return fail();
    const rawName = data.subarray(p + 46, p + 46 + nameLen);
    let name: string; try { name = new TextDecoder('utf-8', { fatal: true }).decode(rawName); } catch { return fail(); }
    if (!name || /[\\\x00-\x1f\x7f:]/.test(name) || name.startsWith('/') || name.split('/').some(x => x === '..' || x === '.') || names.has(name)) return fail();
    names.add(name);
    if (data.readUInt32LE(offset) !== 0x04034b50 || data.readUInt16LE(offset + 6) !== flags || data.readUInt16LE(offset + 8) !== method) return fail();
    const localNameLen = data.readUInt16LE(offset + 26), localExtra = data.readUInt16LE(offset + 28), begin = offset + 30 + localNameLen + localExtra;
    if (begin + compressed > start || !rawName.equals(data.subarray(offset + 30, offset + 30 + localNameLen))) return fail();
    members.push({ name, bytes, read: () => {
      let result: Buffer;
      try { result = method === 0 ? data.subarray(begin, begin + compressed) : inflateRawSync(data.subarray(begin, begin + compressed), { maxOutputLength: Math.min(bytes + 1, 8 * 1024 * 1024) }); } catch { return fail(); }
      if (result.length !== bytes || officeCrc32(result) !== crc) return fail();
      return result;
    } });
    p = next;
  }
  if (p !== end) return fail();
  return members;
}
