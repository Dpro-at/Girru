import {isOriginalMemoryMaintenanceAudit} from './internal-maintenance-audit.js';
import {AUXILIARY_V2_TABLES,type AuxiliaryTable} from './auxiliary-bundle.js';
import {LEGACY_GRAPH_TABLES,type LegacyGraphTable} from './legacy-graph-bundle.js';
/** Internal ENC-01 read audit. Trusted head custody and live read-path wiring remain separate. */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { all, one, run, lockName, dialect, type StepRunner } from '../../repositories/sql-steps.js';
import { memoryRowSurfaceManifest, type MemoryRowTable } from './row-codec.js';
import { MemoryCipherError } from './envelope.js';
export interface MemoryAuditAnchor { ownerId: string; sequence: number; mac: string }
export type MemoryAuditTable=MemoryRowTable|LegacyGraphTable|AuxiliaryTable;
export interface MemoryReadIntent {
  readerKind: 'user' | 'agent' | 'coding-app' | 'system';
  readerId: string;
  purpose: 'recall' | 'view' | 'tool' | 'export' | 'migration-verify' | 'internal-maintenance';
  records: Array<{ table: MemoryAuditTable; id: string }>;
}
export interface MemoryReadAuditEntry extends MemoryReadIntent { version: 1|2; ownerId: string; sequence: number; eventId: string; previous: string; at: string; mac: string }
const TABLE = 'memory_encryption_read_audit';
const issuedAuditStores=new WeakMap<object,()=>boolean>();
export function isTrustedMemoryReadAuditStore(value:unknown):boolean{try{return !!value&&typeof value==='object'&&issuedAuditStores.get(value)?.()===true;}catch{return false;}}
const MAX_PAYLOAD = 512 * 1024;
export const MEMORY_READ_HISTORY_MAX_ENTRIES=10000;
export const MEMORY_READ_HISTORY_MAX_BYTES=32*1024*1024;
export type VerifiedMemoryReadHistory={head:Readonly<MemoryAuditAnchor>;entries:readonly Readonly<MemoryReadAuditEntry>[]};
function parsePayload(raw: unknown): MemoryReadAuditEntry {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_PAYLOAD) throw new MemoryCipherError();
  return JSON.parse(raw);
}
const legacyTables=new Set<string>([...LEGACY_GRAPH_TABLES,...AUXILIARY_V2_TABLES]);
const tables = new Set<string>([...memoryRowSurfaceManifest().map(s => s.table),...LEGACY_GRAPH_TABLES,...AUXILIARY_V2_TABLES]);
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value)) throw new MemoryCipherError();
}
function validKey(key: Buffer) { if (!Buffer.isBuffer(key) || key.length !== 32) throw new MemoryCipherError(); }
function macEqual(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && /^[A-Za-z0-9_-]{43}$/.test(a) && /^[A-Za-z0-9_-]{43}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function sign(key: Buffer, value: unknown): string { validKey(key); return createHmac('sha256', key).update(JSON.stringify(value)).digest('base64url'); }
export function deriveMemoryAuditKey(master: Buffer, ownerId: string): Buffer {
  validKey(master); id(ownerId); return createHmac('sha256', master).update(JSON.stringify(['girru-memory', 1, 'read-audit-key', ownerId])).digest();
}
export function memoryAuditGenesis(ownerId: string, key: Buffer): MemoryAuditAnchor {
  id(ownerId); return { ownerId, sequence: 0, mac: sign(key, ['girru-memory-read-audit', 1, 'genesis', ownerId]) };
}
function intent(input: MemoryReadIntent,version:1|2=input?.purpose==='internal-maintenance'?2:1,persisted=false): MemoryReadIntent {
  if (!input || Object.keys(input).sort().join(',') !== 'purpose,readerId,readerKind,records') throw new MemoryCipherError();
  if(version===2){if(input.readerKind!=='system'||!['trace-auxiliary-maintenance','trace-timing-maintenance'].includes(input.readerId)||input.purpose!=='internal-maintenance'||!persisted&&!isOriginalMemoryMaintenanceAudit(input))throw new MemoryCipherError();}
  else if (!['user','agent','coding-app','system'].includes(input.readerKind) || !['recall','view','tool','export','migration-verify'].includes(input.purpose)) throw new MemoryCipherError();
  id(input.readerId);
  if (!Array.isArray(input.records) || !input.records.length || input.records.length > 1000) throw new MemoryCipherError();
  if(version===2&&input.readerId==='trace-timing-maintenance'&&input.records.length!==1)throw new MemoryCipherError();
  const records = input.records.map(record => {
    if (!record || Object.keys(record).sort().join(',') !== 'id,table' || !tables.has(record.table)||version===2&&record.table!==(input.readerId==='trace-auxiliary-maintenance'?'memory_encryption_auxiliary':'memory_recall_traces')||legacyTables.has(record.table)&&input.purpose!=='migration-verify') throw new MemoryCipherError();
    id(record.id); return { table: record.table, id: record.id };
  }).sort((a,b) => a.table < b.table ? -1 : a.table > b.table ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (records.some((r,i) => i > 0 && r.table === records[i-1].table && r.id === records[i-1].id)) throw new MemoryCipherError();
  return { readerKind: input.readerKind, readerId: input.readerId, purpose: input.purpose, records };
}
function anchor(value: MemoryAuditAnchor) {
  if (!value || Object.keys(value).sort().join(',') !== 'mac,ownerId,sequence') throw new MemoryCipherError();
  id(value.ownerId);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0 || value.sequence >= Number.MAX_SAFE_INTEGER || !macEqual(value.mac, value.mac)) throw new MemoryCipherError();
}
function body(e: Omit<MemoryReadAuditEntry, 'mac'>) {
  return ['girru-memory-read-audit', e.version, e.ownerId, e.sequence, e.eventId, e.previous, e.at, e.readerKind, e.readerId, e.purpose, e.records.map(r => [r.table,r.id])];
}
function checkEntry(e: MemoryReadAuditEntry, key: Buffer): MemoryReadAuditEntry {
  if (!e || Object.keys(e).sort().join(',') !== 'at,eventId,mac,ownerId,previous,purpose,readerId,readerKind,records,sequence,version' || ![1,2].includes(e.version)) throw new MemoryCipherError();
  id(e.ownerId); id(e.eventId);
  if (!Number.isSafeInteger(e.sequence) || e.sequence < 1 || !macEqual(e.previous,e.previous) || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)) || new Date(e.at).toISOString() !== e.at) throw new MemoryCipherError();
  const normalized = intent({readerKind:e.readerKind,readerId:e.readerId,purpose:e.purpose,records:e.records},e.version,true);
  if (JSON.stringify(normalized.records) !== JSON.stringify(e.records) || !macEqual(sign(key,body({...e,...normalized})),e.mac)) throw new MemoryCipherError();
  return e;
}
export function appendMemoryReadEntry(previous: MemoryAuditAnchor, input: MemoryReadIntent, key: Buffer, at = new Date().toISOString()): MemoryReadAuditEntry {
  anchor(previous); validKey(key);
  if (previous.sequence === 0 && !macEqual(previous.mac,memoryAuditGenesis(previous.ownerId,key).mac)) throw new MemoryCipherError();
  const normalized=intent(input);
  const data = {version:(normalized.purpose==='internal-maintenance'?2:1) as 1|2,ownerId:previous.ownerId,sequence:previous.sequence+1,eventId:randomUUID(),previous:previous.mac,at,...normalized};
  return checkEntry({...data,mac:sign(key,body(data))},key);
}
/** Requires the externally trusted expected head; a valid prefix alone is not proof against truncation. */
export function verifyMemoryReadChain(entries: MemoryReadAuditEntry[], expected: MemoryAuditAnchor, key: Buffer): void {
  anchor(expected);
  if (!Array.isArray(entries) || entries.length > 10000 || entries.length !== expected.sequence) throw new MemoryCipherError();
  let current = memoryAuditGenesis(expected.ownerId,key);
  for (const value of entries) {
    const e = checkEntry(value,key);
    if (e.ownerId !== expected.ownerId || e.sequence !== current.sequence+1 || !macEqual(e.previous,current.mac)) throw new MemoryCipherError();
    current = {ownerId:e.ownerId,sequence:e.sequence,mac:e.mac};
  }
  if (!macEqual(current.mac,expected.mac)) throw new MemoryCipherError();
}
/** Shared SQL steps, explicitly initialized only by its owner. No runtime/global database side effects. */
export function createMemoryReadAuditStore(runner: StepRunner, ownerId: string, suppliedKey: Buffer) {
  validKey(suppliedKey); id(ownerId); const key = Buffer.from(suppliedKey); let closed = false;
  function opened() { if (closed) throw new MemoryCipherError(); }
  async function captureVerifiedHistory(expected:MemoryAuditAnchor):Promise<VerifiedMemoryReadHistory>{
    opened();anchor(expected);if(expected.ownerId!==ownerId||expected.sequence>MEMORY_READ_HISTORY_MAX_ENTRIES)throw new MemoryCipherError();const head={...expected},operationKey=Buffer.from(key);
    try{
      // Check total wire bytes and count before transferring any audit payload to this process.
      const rows=await runner.tx(function*(){
        const driver=yield* dialect();if(driver==='postgres')yield* run(`LOCK TABLE ${TABLE} IN SHARE MODE`);
        const bytes=driver==='sqlite'?'length(CAST(payload AS BLOB))':'octet_length(payload)',size=yield* one<{n:number|string;b:number|string|null;largest:number|string|null}>(`SELECT count(*) n,SUM(${bytes}) b,MAX(${bytes}) largest FROM ${TABLE} WHERE owner_id=?`,ownerId);
        if(!size||Number(size.n)!==head.sequence||!Number.isSafeInteger(Number(size.n))||Number(size.n)<0||Number(size.n)>MEMORY_READ_HISTORY_MAX_ENTRIES||!Number.isSafeInteger(Number(size.b??0))||Number(size.b??0)<0||Number(size.b??0)>MEMORY_READ_HISTORY_MAX_BYTES||!Number.isSafeInteger(Number(size.largest??0))||Number(size.largest??0)>MAX_PAYLOAD)throw new MemoryCipherError();
        const values=yield* all<{sequence:number|string;mac:string;payload:string}>(`SELECT sequence,mac,CASE WHEN ${bytes}<=${MAX_PAYLOAD} THEN payload ELSE NULL END AS payload FROM ${TABLE} WHERE owner_id=? ORDER BY sequence LIMIT ${MEMORY_READ_HISTORY_MAX_ENTRIES+1}`,ownerId);
        if(values.length!==head.sequence)throw new MemoryCipherError();return values;
      },{immediate:true});
      const entries=rows.map(row=>{const entry=parsePayload(row.payload);if(entry.sequence!==Number(row.sequence)||!macEqual(entry.mac,row.mac))throw new MemoryCipherError();return entry;});verifyMemoryReadChain(entries,head,operationKey);opened();
      const immutable=entries.map(entry=>{const copy={...entry,records:entry.records.map(record=>Object.freeze({...record}))};Object.freeze(copy.records);return Object.freeze(copy);});return Object.freeze({head:Object.freeze(head),entries:Object.freeze(immutable)});
    }catch{throw new MemoryCipherError();}finally{operationKey.fill(0);}
  }
  const store={
    genesis() { opened(); return memoryAuditGenesis(ownerId,key); },
    async initialize() { opened(); await runner.tx(function*() { yield* run(`CREATE TABLE IF NOT EXISTS ${TABLE} (owner_id TEXT NOT NULL, sequence BIGINT NOT NULL, mac TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner_id,sequence))`); }); },
    async append(expected: MemoryAuditAnchor, input: MemoryReadIntent): Promise<MemoryAuditAnchor> {
      opened(); anchor(expected); if (expected.ownerId !== ownerId) throw new MemoryCipherError();
      const prior = {...expected}, operationKey = Buffer.from(key);intent(input);
      try {
        return await runner.tx(function*() {
          yield* lockName('memory-encryption-audit:'+ownerId);
          const driver=yield* dialect(),bytes=driver==='sqlite'?'length(CAST(payload AS BLOB))':'octet_length(payload)',size=yield* one<{n:number|string;b:number|string|null;largest:number|string|null}>(`SELECT count(*) n,SUM(${bytes}) b,MAX(${bytes}) largest FROM ${TABLE} WHERE owner_id=?`,ownerId);
          if(!size||Number(size.n)!==prior.sequence||!Number.isSafeInteger(Number(size.n))||Number(size.n)<0||Number(size.n)>=MEMORY_READ_HISTORY_MAX_ENTRIES||!Number.isSafeInteger(Number(size.b??0))||Number(size.b??0)<0||Number(size.b??0)>MEMORY_READ_HISTORY_MAX_BYTES||Number(size.largest??0)>MAX_PAYLOAD)throw new MemoryCipherError();
          const head = yield* one<{sequence:number|string;mac:string;payload:string}>(`SELECT sequence,mac,CASE WHEN length(payload)<=524288 THEN payload ELSE NULL END AS payload FROM ${TABLE} WHERE owner_id=? ORDER BY sequence DESC LIMIT 1`,ownerId);
          if (head) {
            const e = checkEntry(parsePayload(head.payload),operationKey);
            if (e.ownerId !== ownerId || e.sequence !== Number(head.sequence) || !macEqual(e.mac,head.mac) || e.sequence !== prior.sequence || !macEqual(e.mac,prior.mac)) throw new MemoryCipherError();
          } else if (prior.sequence !== 0) throw new MemoryCipherError();
          const entry = appendMemoryReadEntry(prior,input,operationKey),payload=JSON.stringify(entry);if(Buffer.byteLength(payload)>MAX_PAYLOAD||Number(size.b??0)+Buffer.byteLength(payload)>MEMORY_READ_HISTORY_MAX_BYTES)throw new MemoryCipherError();
          yield* run(`INSERT INTO ${TABLE} (owner_id,sequence,mac,payload) VALUES(?,?,?,?)`,ownerId,entry.sequence,entry.mac,payload);
          return {ownerId,sequence:entry.sequence,mac:entry.mac};
        });
      } catch { throw new MemoryCipherError(); }
      finally { operationKey.fill(0); }
    },
    captureVerifiedHistory,
    async verify(expected:MemoryAuditAnchor):Promise<void>{await captureVerifiedHistory(expected);},
    close() { key.fill(0); closed=true; },
  };
  issuedAuditStores.set(store,()=>!closed);return store;
}
