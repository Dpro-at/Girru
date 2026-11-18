/** Strict authenticated forget/epoch transport. The expected head must come from non-restored custody. */
import {createHmac,timingSafeEqual} from 'node:crypto';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor,type MemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import {MemoryCipherError} from './envelope.js';
type EventAuthority={authorityId:string;ownerId:string;memberId:string;keyId:string;epoch:number;sequence:number;previous:string;mac:string};
export type MemoryAuthorityChange={kind:'forget';ids:readonly string[]}|{kind:'key-epoch';keyId:string}|{kind:'graph-forget';entityIds:readonly string[];personKey:string;inputDigest:string};
type ForgetEvent=EventAuthority&({v:1;kind:'forget'|'key-epoch';ids:string[]}|{v:2;kind:'graph-forget';entityIds:string[];personKey:string;inputDigest:string});
const MAX_BYTES=4*1024*1024,MAX_EVENTS=10000;
const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
function sign(key:Buffer,value:unknown):string{if(!Buffer.isBuffer(key)||key.length!==32)throw new MemoryCipherError();return createHmac('sha256',key).update(JSON.stringify(value)).digest('hex');}
const equal=(a:unknown,b:string)=>typeof a==='string'&&/^[a-f0-9]{64}$/.test(a)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
function body(e:ForgetEvent){const common=[e.authorityId,e.ownerId,e.memberId,e.keyId,e.epoch,e.sequence,e.previous,e.kind];return e.v===1?['girru-forget-authority-event',1,...common,e.ids]:['girru-forget-authority-event',2,...common,e.entityIds,e.personKey,e.inputDigest];}
function parseEvent(value:unknown):ForgetEvent{
 const e=value as ForgetEvent;if(!e||![e.authorityId,e.ownerId,e.memberId,e.keyId].every(id)||!Number.isSafeInteger(e.epoch)||e.epoch<1||!Number.isSafeInteger(e.sequence)||e.sequence<1||!equal(e.previous,e.previous)||!equal(e.mac,e.mac))throw new MemoryCipherError();
 if(e.v===1){if(Object.keys(e).sort().join(',')!=='authorityId,epoch,ids,keyId,kind,mac,memberId,ownerId,previous,sequence,v'||!['forget','key-epoch'].includes(e.kind)||!Array.isArray(e.ids)||e.ids.length>500||e.ids.some(s=>!id(s))||new Set(e.ids).size!==e.ids.length||e.ids.join('\0')!==[...e.ids].sort().join('\0')||e.kind==='forget'&&e.ids.length===0||e.kind==='key-epoch'&&e.ids.length!==0)throw new MemoryCipherError();return{...e,ids:[...e.ids]};}
 if(e.v!==2||e.kind!=='graph-forget'||Object.keys(e).sort().join(',')!=='authorityId,entityIds,epoch,inputDigest,keyId,kind,mac,memberId,ownerId,personKey,previous,sequence,v'||!Array.isArray(e.entityIds)||!e.entityIds.length||e.entityIds.length>500||e.entityIds.some(value=>!id(value))||new Set(e.entityIds).size!==e.entityIds.length||e.entityIds.join('\0')!==[...e.entityIds].sort().join('\0')||!id(e.personKey)||typeof e.inputDigest!=='string'||!/^[a-f0-9]{64}$/.test(e.inputDigest))throw new MemoryCipherError();return{...e,entityIds:[...e.entityIds]};
}
/** Explicit enrollment material only; calling this function never persists/enrolls any authority. */
export function memoryForgetAuthorityGenesis(input:Omit<MemoryRestoreAnchor,'v'|'forgetSequence'|'forgetMac'>,key:Buffer):MemoryRestoreAnchor{
 const base=captureMemoryRestoreAnchor({v:1,...input,forgetSequence:0,forgetMac:'0'.repeat(64)});
 return{...base,forgetMac:sign(key,['girru-forget-authority-genesis',1,base.authorityId,base.ownerId,base.memberId,base.keyId,base.epoch])};
}
/** Prepare a single append; trusted host must atomically persist and advance its expected head. */
export function prepareMemoryForgetAuthorityAppend(previous:MemoryRestoreAnchor,change:MemoryAuthorityChange,key:Buffer):{line:string;head:MemoryRestoreAnchor}{
 const prior=captureMemoryRestoreAnchor(previous);
 if(!change||!['forget','key-epoch','graph-forget'].includes(change.kind)||prior.forgetSequence>=MAX_EVENTS)throw new MemoryCipherError();
 const nextKey=change.kind==='key-epoch'?change.keyId:prior.keyId;
 if(!id(nextKey)||change.kind==='key-epoch'&&(nextKey===prior.keyId||!Number.isSafeInteger(prior.epoch+1)))throw new MemoryCipherError();
 const common={authorityId:prior.authorityId,ownerId:prior.ownerId,memberId:prior.memberId,keyId:nextKey,epoch:prior.epoch+(change.kind==='key-epoch'?1:0),sequence:prior.forgetSequence+1,previous:prior.forgetMac,mac:'0'.repeat(64)};
 const entry:ForgetEvent=change.kind==='graph-forget'?{...common,v:2,kind:'graph-forget',entityIds:[...change.entityIds].sort(),personKey:change.personKey,inputDigest:change.inputDigest}:{...common,v:1,kind:change.kind,ids:change.kind==='forget'?[...change.ids].sort():[]};
 parseEvent(entry);entry.mac=sign(key,body(entry));
 return{line:JSON.stringify(entry)+'\n',head:captureMemoryRestoreAnchor({v:1,authorityId:entry.authorityId,ownerId:entry.ownerId,memberId:entry.memberId,keyId:entry.keyId,epoch:entry.epoch,forgetSequence:entry.sequence,forgetMac:entry.mac})};
}
/** Reject malformed/truncated/reordered/extra lines; never skips damaged records or trusts an embedded head. */
export function verifyMemoryForgetAuthorityTransport(raw:Buffer,genesis:MemoryRestoreAnchor,expected:MemoryRestoreAnchor,key:Buffer):MemoryRestoreAnchor{
 try{
  if(!Buffer.isBuffer(raw)||raw.length>MAX_BYTES)throw new MemoryCipherError();
  let head=captureMemoryRestoreAnchor(genesis);const trusted=captureMemoryRestoreAnchor(expected);
  if(head.forgetSequence!==0||!sameMemoryRestoreAnchor(head,memoryForgetAuthorityGenesis({authorityId:head.authorityId,ownerId:head.ownerId,memberId:head.memberId,keyId:head.keyId,epoch:head.epoch},key)))throw new MemoryCipherError();
  const text=raw.toString('utf8');if(!Buffer.from(text,'utf8').equals(raw)||text.length&&!text.endsWith('\n'))throw new MemoryCipherError();
  const lines=text.length?text.slice(0,-1).split('\n'):[];if(lines.length>MAX_EVENTS)throw new MemoryCipherError();
  for(const line of lines){if(!line||Buffer.byteLength(line)>256*1024)throw new MemoryCipherError();const event=parseEvent(JSON.parse(line));
   if(event.authorityId!==head.authorityId||event.ownerId!==head.ownerId||event.memberId!==head.memberId||event.sequence!==head.forgetSequence+1||!equal(event.previous,head.forgetMac)||!equal(event.mac,sign(key,body(event)))||event.kind!=='key-epoch'&&(event.epoch!==head.epoch||event.keyId!==head.keyId)||event.kind==='key-epoch'&&(event.epoch!==head.epoch+1||event.keyId===head.keyId))throw new MemoryCipherError();
   head={v:1,authorityId:event.authorityId,ownerId:event.ownerId,memberId:event.memberId,keyId:event.keyId,epoch:event.epoch,forgetSequence:event.sequence,forgetMac:event.mac};
  }
  if(!sameMemoryRestoreAnchor(head,trusted))throw new MemoryCipherError();return head;
 }catch{throw new MemoryCipherError();}
}
/** Compose bounded transport with an explicit non-restored trusted head. Does not provide OS monotonic custody. */
export function createVerifiedMemoryRestoreAuthority(input:{key:Buffer;genesis:MemoryRestoreAnchor;captureTrusted:()=>Promise<MemoryRestoreAuthorityLease|null>;readTransport:(maxBytes:number)=>Promise<Buffer>}){
 if(!Buffer.isBuffer(input.key)||input.key.length!==32||typeof input.captureTrusted!=='function'||typeof input.readTransport!=='function')throw new MemoryCipherError();
 const key=Buffer.from(input.key),genesis=captureMemoryRestoreAnchor(input.genesis),capture=input.captureTrusted,read=input.readTransport;let closed=false;
 return{
  async capture():Promise<MemoryRestoreAuthorityLease|null>{let raw:Buffer|undefined;try{
   if(closed)throw new MemoryCipherError();const trusted=await capture();if(closed||!trusted||typeof trusted.isCurrent!=='function'||trusted.isCurrent()!==true)throw new MemoryCipherError();
   const expected=captureMemoryRestoreAnchor(trusted.anchor),current=trusted.isCurrent.bind(trusted);const received=await read(MAX_BYTES);if(!Buffer.isBuffer(received)||received.length>MAX_BYTES)throw new MemoryCipherError();raw=Buffer.from(received);if(closed||!current())throw new MemoryCipherError();
   const head=verifyMemoryForgetAuthorityTransport(raw,genesis,expected,key);if(closed||!current())throw new MemoryCipherError();return{anchor:head,isCurrent:()=>!closed&&current()};
  }catch{throw new MemoryCipherError();}finally{raw?.fill(0);}},
  close(){closed=true;key.fill(0);},
 };
}

/** Exact bounded range planning. Existing v1 single-event bodies are unchanged. */
export function prepareMemoryForgetAuthorityRange(previous:MemoryRestoreAnchor,changes:readonly MemoryAuthorityChange[],key:Buffer){
 if(!Array.isArray(changes)||!changes.length||changes.length>10000)throw new MemoryCipherError();let head=captureMemoryRestoreAnchor(previous),bytes=0;const entries:Array<{line:string;head:MemoryRestoreAnchor}>=[];for(const change of changes){const next=prepareMemoryForgetAuthorityAppend(head,change,key);bytes+=Buffer.byteLength(next.line);if(bytes>MAX_BYTES)throw new MemoryCipherError();entries.push(Object.freeze({line:next.line,head:Object.freeze({...next.head})}));head=next.head;}return Object.freeze({entries:Object.freeze(entries),head:Object.freeze({...head})});
}
