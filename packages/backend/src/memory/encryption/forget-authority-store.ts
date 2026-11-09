/** Selected non-restored journal plus externally held CAS head. No default database, profile or enrollment. */
import {all,one,run,lockName,dialect,type StepRunner} from '../../repositories/sql-steps.js';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor,type MemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import {prepareMemoryForgetAuthorityAppend,prepareMemoryForgetAuthorityRange,verifyMemoryForgetAuthorityTransport,type MemoryAuthorityChange} from './forget-authority.js';
import {MemoryCipherError} from './envelope.js';
const TABLE='memory_encryption_forget_authority_events',MAX_BYTES=4*1024*1024;
export function createMemoryForgetAuthorityStore(input:{runner:StepRunner;key:Buffer;genesis:MemoryRestoreAnchor;captureTrusted:()=>Promise<MemoryRestoreAuthorityLease|null>;advanceTrusted:(expected:MemoryRestoreAnchor,next:MemoryRestoreAnchor)=>Promise<boolean>}){
 const {runner,captureTrusted,advanceTrusted}=input,genesis=captureMemoryRestoreAnchor(input.genesis);
 if(!Buffer.isBuffer(input.key)||input.key.length!==32||typeof captureTrusted!=='function'||typeof advanceTrusted!=='function')throw new MemoryCipherError();
 const key=Buffer.from(input.key);let state:'new'|'ready'|'failed'|'closed'='new',busy=false;
 const boundary=()=>{if(state==='closed'||state==='failed'||runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};
 function* transportStep(){
  const driver=yield* dialect(),bytes=driver==='postgres'?'octet_length(payload)':'length(CAST(payload AS BLOB))';
  const size=yield* one<{n:number|string;bytes:number|string}>(`SELECT count(*) n,COALESCE(SUM(${bytes}),0) bytes FROM ${TABLE} WHERE authority_id=?`,genesis.authorityId);
  if(!size||Number(size.n)>10000||Number(size.bytes)>MAX_BYTES)throw new MemoryCipherError();
  const rows=yield* all<{payload:string}>(`SELECT CASE WHEN ${bytes}<=262144 THEN payload ELSE NULL END AS payload FROM ${TABLE} WHERE authority_id=? ORDER BY sequence LIMIT 10001`,genesis.authorityId);
  if(rows.length!==Number(size.n)||rows.some(row=>typeof row.payload!=='string'))throw new MemoryCipherError();
  const raw=Buffer.from(rows.map(row=>row.payload+'\n').join(''),'utf8');if(raw.length>MAX_BYTES)throw new MemoryCipherError();return raw;
 }
 async function trusted(){boundary();const lease=await captureTrusted();boundary();if(!lease||typeof lease.isCurrent!=='function'||lease.isCurrent()!==true)throw new MemoryCipherError();const anchor=captureMemoryRestoreAnchor(lease.anchor),current=lease.isCurrent.bind(lease);if(anchor.authorityId!==genesis.authorityId||anchor.ownerId!==genesis.ownerId||anchor.memberId!==genesis.memberId)throw new MemoryCipherError();return{anchor,current};}
 async function perform<T>(fn:()=>Promise<T>):Promise<T>{boundary();if(busy)throw new MemoryCipherError();busy=true;try{return await fn();}catch{if(state!=='closed')state='failed';throw new MemoryCipherError();}finally{busy=false;}}
 function appendChanges(changes:readonly MemoryAuthorityChange[]){
  if(!Array.isArray(changes)||!changes.length||changes.length>10000)return Promise.reject(new MemoryCipherError());
  const captured=changes.map(change=>change.kind==='forget'?{kind:'forget' as const,ids:[...change.ids]}:change.kind==='graph-forget'?{kind:'graph-forget' as const,entityIds:[...change.entityIds],personKey:change.personKey,inputDigest:change.inputDigest}:{kind:'key-epoch' as const,keyId:change.keyId});
  return perform(async()=>{if(state!=='ready')throw new MemoryCipherError();const lease=await trusted(),range=prepareMemoryForgetAuthorityRange(lease.anchor,captured,key);
   await runner.tx(function*(){yield* lockName('forget-authority:'+genesis.authorityId);const raw=yield* transportStep();try{verifyMemoryForgetAuthorityTransport(raw,genesis,lease.anchor,key);if(raw.length+range.entries.reduce((bytes,entry)=>bytes+Buffer.byteLength(entry.line),0)>MAX_BYTES)throw new MemoryCipherError();}finally{raw.fill(0);}if(!lease.current())throw new MemoryCipherError();
    for(const entry of range.entries)yield* run(`INSERT INTO ${TABLE}(authority_id,sequence,payload) VALUES(?,?,?)`,genesis.authorityId,entry.head.forgetSequence,entry.line.slice(0,-1));
    const updated=yield* transportStep();try{verifyMemoryForgetAuthorityTransport(updated,genesis,range.head,key);}finally{updated.fill(0);}if(!lease.current())throw new MemoryCipherError();
   },{immediate:true});boundary();if(!lease.current()||await advanceTrusted({...lease.anchor},{...range.head})!==true)throw new MemoryCipherError();boundary();
   const fresh=await trusted();if(!sameMemoryRestoreAnchor(fresh.anchor,range.head))throw new MemoryCipherError();return{...range.head};
  });
 }

 return{
  initialize:()=>perform(async()=>{if(state!=='new')throw new MemoryCipherError();const lease=await trusted();
   await runner.tx(function*(){yield* run(`CREATE TABLE IF NOT EXISTS ${TABLE}(authority_id TEXT NOT NULL,sequence BIGINT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(authority_id,sequence))`);},{immediate:true});boundary();
   const raw=await runner.tx(transportStep,{immediate:true});try{verifyMemoryForgetAuthorityTransport(raw,genesis,lease.anchor,key);}finally{raw.fill(0);}boundary();if(!lease.current())throw new MemoryCipherError();state='ready';
  }),
  capture:()=>perform(async()=>{if(state!=='ready')throw new MemoryCipherError();const lease=await trusted(),raw=await runner.tx(transportStep,{immediate:true});let anchor:MemoryRestoreAnchor;try{anchor=verifyMemoryForgetAuthorityTransport(raw,genesis,lease.anchor,key);}finally{raw.fill(0);}boundary();if(!lease.current())throw new MemoryCipherError();return{anchor,isCurrent:()=>state==='ready'&&lease.current()};}),
  previewKeyEpoch:(keyId:string)=>perform(async()=>{
   if(state!=='ready')throw new MemoryCipherError();const lease=await trusted(),raw=await runner.tx(transportStep,{immediate:true});
   try{verifyMemoryForgetAuthorityTransport(raw,genesis,lease.anchor,key);}finally{raw.fill(0);}boundary();if(!lease.current())throw new MemoryCipherError();
   return prepareMemoryForgetAuthorityAppend(lease.anchor,{kind:'key-epoch',keyId},key).head;
  }),
  append:(change:MemoryAuthorityChange)=>appendChanges([change]),
  appendRange:(changes:readonly MemoryAuthorityChange[])=>appendChanges(changes),
  close(){state='closed';key.fill(0);},
  status:()=>state,
 };
}
