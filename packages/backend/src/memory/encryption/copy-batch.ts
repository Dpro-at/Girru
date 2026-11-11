/** Inactive bounded copy verifier. Does not open databases or activate encryption. */
import {MEMORY_COPY_MAX_ROWS,MEMORY_COPY_MAX_ENCODED_BYTES} from './copy-limits.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { encryptMemoryRow, decryptMemoryRow, memoryRowSurfaceManifest, type MemoryRowScope, type MemoryRowTable } from './row-codec.js';
import { MemoryCipherError } from './envelope.js';
type Row = Record<string, unknown>;
export interface MemoryCopyBatch { v: 1; activationReady: false; table: MemoryRowTable; ownerId: string; memberId: string; keyId: string; rows: Row[]; sourceMac: string; receiptMac: string }
const MAX_BYTES = MEMORY_COPY_MAX_ENCODED_BYTES;
function encode(rows: Row[]): string {
  let bytes = 0;
  if (!Array.isArray(rows) || rows.length > MEMORY_COPY_MAX_ROWS) throw new MemoryCipherError();
  const encoded = rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new MemoryCipherError();
    return Object.keys(row).sort().map(field => {
      let value = row[field];
      if (['is_team_critical','auto_enriched','needs_improvement','pack_hit','uses_indexed'].includes(field) && (value === 0 || value === 1)) value = Boolean(value);
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && !Buffer.isBuffer(value)) throw new MemoryCipherError();
      if (typeof value === 'number' && !Number.isFinite(value)) throw new MemoryCipherError();
      bytes += Buffer.byteLength(field) + (Buffer.isBuffer(value) ? value.length * 2 : typeof value === 'string' ? Buffer.byteLength(value) * 6 : 32);
      if (bytes > MAX_BYTES) throw new MemoryCipherError();
      return [field, Buffer.isBuffer(value) ? ['bytes', value.toString('base64')] : ['scalar', value]];
    });
  });
  return JSON.stringify(encoded);
}
/** Bounded canonical transport size, including binary-to-base64 encoding. */
export function memoryCopyEncodedBytes(rows:Row[]):number{return Buffer.byteLength(encode(rows));}
function mac(key: Buffer, purpose: string, value: string): string {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new MemoryCipherError();
  return createHmac('sha256', key).update('girru-memory-copy-v1\0').update(purpose).update('\0').update(value).digest('hex');
}
function same(a: string, b: string): boolean {
  return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function contract(table: MemoryRowTable, rows: Row[], scope: MemoryRowScope): Row[] {
  const s = memoryRowSurfaceManifest().find(x => x.table === table);
  if (!s) throw new MemoryCipherError();
  encode(rows);
  const fields = [s.owner,s.id,...s.bound,...s.clear,...s.text,...s.binary].sort().join('\0');
  const ids = new Set<string>();
  for (const row of rows) {
    if (Object.keys(row).sort().join('\0') !== fields || row[s.owner] !== scope.ownerId || typeof row[s.id] !== 'string' || !(row[s.id] as string).length || ids.has(row[s.id] as string)) throw new MemoryCipherError();
    ids.add(row[s.id] as string);
  }
  return [...rows].sort((a,b) => (a[s.id] as string) < (b[s.id] as string) ? -1 : (a[s.id] === b[s.id] ? 0 : 1));
}
function body(batch: MemoryCopyBatch): string {
  return JSON.stringify([batch.v,batch.activationReady,batch.table,batch.ownerId,batch.memberId,batch.keyId,batch.sourceMac,encode(batch.rows)]);
}
/** Keys remain caller-owned. Receipt proves one bounded subset only, never whole-profile completeness. */
export function prepareMemoryCopyBatch(table: MemoryRowTable, source: Row[], scope: MemoryRowScope, key: Buffer, keyId: string, verificationKey: Buffer): MemoryCopyBatch {
  const plain = contract(table,source,scope);
  const rows = plain.map(row => encryptMemoryRow(table,row,scope,key,keyId));
  const batch: MemoryCopyBatch = {v:1,activationReady:false,table,ownerId:scope.ownerId,memberId:scope.memberId,keyId,rows,sourceMac:mac(verificationKey,'source',JSON.stringify([table,scope.ownerId,scope.memberId,keyId,encode(plain)])),receiptMac:''};
  batch.receiptMac = mac(verificationKey,'receipt',body(batch));
  verifyMemoryCopyBatch(batch,rows,scope,key,keyId,verificationKey);
  return batch;
}
/** Authenticate bounded ciphertext/metadata without opening a data key. Not plaintext source verification. */
export function verifyMemoryCopyCiphertext(batch:MemoryCopyBatch,scope:MemoryRowScope,keyId:string,verificationKey:Buffer):void{
 try{
  if(!batch||batch.v!==1||batch.activationReady!==false||batch.ownerId!==scope.ownerId||batch.memberId!==scope.memberId||batch.keyId!==keyId||!same(batch.receiptMac,mac(verificationKey,'receipt',body(batch))))throw new MemoryCipherError();
  contract(batch.table,batch.rows,scope);
 }catch{throw new MemoryCipherError();}
}

/** Compare persisted read-back rows against the receipt; altered/missing/extra rows fail closed. */
export function verifyMemoryCopyBatch(batch: MemoryCopyBatch, readback: Row[], scope: MemoryRowScope, key: Buffer, keyId: string, verificationKey: Buffer): void {
  try {
    if (batch.v !== 1 || batch.activationReady !== false || batch.ownerId !== scope.ownerId || batch.memberId !== scope.memberId || batch.keyId !== keyId || !same(batch.receiptMac,mac(verificationKey,'receipt',body(batch)))) throw new MemoryCipherError();
    const rows = contract(batch.table,readback,scope);
    if (encode(rows) !== encode(batch.rows)) throw new MemoryCipherError();
    const plain = rows.map(row => decryptMemoryRow(batch.table,row,scope,key,keyId));
    if (!same(batch.sourceMac,mac(verificationKey,'source',JSON.stringify([batch.table,scope.ownerId,scope.memberId,keyId,encode(plain)])))) throw new MemoryCipherError();
  } catch { throw new MemoryCipherError(); }
}
