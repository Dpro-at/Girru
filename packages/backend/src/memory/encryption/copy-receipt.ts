/** Historical copy-verification evidence; not a live integrity check or rollback-resistant anchor. */
import {createHmac,timingSafeEqual} from 'node:crypto';
import {one,run,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import type {MemorySurfaceSnapshot} from './copy-manifest.js';
import {MemoryCipherError} from './envelope.js';
const TABLE='memory_encryption_copy_receipts';
function payload(snapshot:MemorySurfaceSnapshot):string {
 return JSON.stringify({version:1,state:'copy-verified',activationReady:false,coverage:snapshot.coverage,snapshotId:snapshot.snapshotId,manifestMac:snapshot.manifestMac});
}
function sign(value:string,key:Buffer):string {
 if(!Buffer.isBuffer(key)||key.length!==32)throw new MemoryCipherError();
 return createHmac('sha256',key).update('girru-memory-copy-verified-v1\0').update(value).digest('hex');
}
/** Caller has authenticated snapshot and retains its ID/MAC outside the target. */
export function memoryCopyReceiptStep(snapshot:MemorySurfaceSnapshot,key:Buffer):()=>Step<void> {
 const text=payload(snapshot),signature=sign(text,key),id=snapshot.snapshotId;
 return function*(){
  yield* run(`CREATE TABLE IF NOT EXISTS ${TABLE} (snapshot_id TEXT PRIMARY KEY,payload TEXT NOT NULL,mac TEXT NOT NULL)`);
  yield* run(`INSERT INTO ${TABLE} (snapshot_id,payload,mac) VALUES(?,?,?)`,id,text,signature);
  const stored=yield* one<{payload:string;mac:string}>(`SELECT CASE WHEN length(payload)<=4096 THEN payload ELSE NULL END AS payload,mac FROM ${TABLE} WHERE snapshot_id=?`,id);
  if(stored?.payload!==text||stored.mac!==signature)throw new MemoryCipherError();
 };
}
/** Verifies historical receipt only, against a separately retained prepared snapshot. */
export async function verifyStoredMemoryCopyReceipt(runner:StepRunner,snapshot:MemorySurfaceSnapshot,key:Buffer):Promise<void>{
 const expected=payload(snapshot),signature=sign(expected,key),id=snapshot.snapshotId;
 try{
  const stored=await runner.read(one<{payload:string;mac:string}>(`SELECT CASE WHEN length(payload)<=4096 THEN payload ELSE NULL END AS payload,mac FROM ${TABLE} WHERE snapshot_id=?`,id));
  if(stored?.payload!==expected||typeof stored.mac!=='string'||!/^[a-f0-9]{64}$/.test(stored.mac)||!timingSafeEqual(Buffer.from(stored.mac,'hex'),Buffer.from(signature,'hex')))throw new MemoryCipherError();
 }catch{throw new MemoryCipherError();}
}
