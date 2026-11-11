/** Declared-surface restore provenance. Trusted authority custody must live outside the restored backup. */
import {createHmac,timingSafeEqual} from 'node:crypto';
import {MemoryCipherError} from './envelope.js';
import {verifyMemorySnapshotCiphertext,type MemorySurfaceSnapshot,type MemorySnapshotCoverage} from './copy-manifest.js';
export type MemoryRestoreAnchor={v:1;authorityId:string;ownerId:string;memberId:string;keyId:string;epoch:number;forgetSequence:number;forgetMac:string};
export type MemoryRestorePackage={v:1|2|3|4|5;activationReady:false;coverage:MemorySnapshotCoverage;anchor:MemoryRestoreAnchor;snapshot:MemorySurfaceSnapshot;packageMac:string};
const identity=(value:unknown)=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=256&&!/[\u0000-\u001f\u007f]/u.test(value);
export function captureMemoryRestoreAnchor(value:MemoryRestoreAnchor):MemoryRestoreAnchor{
 if(!value||Object.keys(value).sort().join(',')!=='authorityId,epoch,forgetMac,forgetSequence,keyId,memberId,ownerId,v'||value.v!==1||![value.authorityId,value.ownerId,value.memberId,value.keyId].every(identity)||!Number.isSafeInteger(value.epoch)||value.epoch<1||!Number.isSafeInteger(value.forgetSequence)||value.forgetSequence<0||typeof value.forgetMac!=='string'||!/^[a-f0-9]{64}$/.test(value.forgetMac))throw new MemoryCipherError();
 return{v:1,authorityId:value.authorityId,ownerId:value.ownerId,memberId:value.memberId,keyId:value.keyId,epoch:value.epoch,forgetSequence:value.forgetSequence,forgetMac:value.forgetMac};
}
export function sameMemoryRestoreAnchor(a:MemoryRestoreAnchor,b:MemoryRestoreAnchor):boolean{return JSON.stringify(captureMemoryRestoreAnchor(a))===JSON.stringify(captureMemoryRestoreAnchor(b));}
function stamp(value:MemoryRestorePackage,key:Buffer):string{
 if(!Buffer.isBuffer(key)||key.length!==32||!value||Object.keys(value).sort().join(',')!=='activationReady,anchor,coverage,packageMac,snapshot,v'||![1,2,3,4,5].includes(value.v)||value.activationReady!==false||value.v!==value.snapshot?.version||value.coverage!==value.snapshot?.coverage)throw new MemoryCipherError();
 const anchor=captureMemoryRestoreAnchor(value.anchor);
 return createHmac('sha256',key).update(JSON.stringify(['girru-memory-restore-package',value.v,anchor,value.snapshot?.snapshotId,value.snapshot?.manifestMac,value.coverage,false])).digest('hex');
}
/** Caller obtains anchor from trusted host, NEVER from a backup or legacy permissive ledger parser. */
export function createMemoryRestorePackage(snapshot:MemorySurfaceSnapshot,anchorInput:MemoryRestoreAnchor,verificationKey:Buffer):MemoryRestorePackage{
 const anchor=captureMemoryRestoreAnchor(anchorInput);verifyMemorySnapshotCiphertext(snapshot,{ownerId:anchor.ownerId,memberId:anchor.memberId},anchor.keyId,verificationKey);
 const result:MemoryRestorePackage={v:snapshot.version,activationReady:false,coverage:snapshot.coverage,anchor,snapshot,packageMac:''};result.packageMac=stamp(result,verificationKey);return captureMemoryRestorePackage(result,verificationKey);
}
/** Authenticate and take an owned bounded ciphertext copy before asynchronous restore work. */
export function captureMemoryRestorePackage(value:MemoryRestorePackage,verificationKey:Buffer):MemoryRestorePackage{
 try{
  const expected=stamp(value,verificationKey);if(typeof value.packageMac!=='string'||!/^[a-f0-9]{64}$/.test(value.packageMac)||!timingSafeEqual(Buffer.from(value.packageMac,'hex'),Buffer.from(expected,'hex')))throw new MemoryCipherError();
  const anchor=captureMemoryRestoreAnchor(value.anchor);verifyMemorySnapshotCiphertext(value.snapshot,{ownerId:anchor.ownerId,memberId:anchor.memberId},anchor.keyId,verificationKey);
  const snapshot={...value.snapshot,batches:value.snapshot.batches.map(batch=>({...batch,rows:batch.rows.map(row=>Object.fromEntries(Object.entries(row).map(([field,data])=>[field,Buffer.isBuffer(data)?Buffer.from(data):data])))}))};
  return{v:value.v,activationReady:false,coverage:value.coverage,anchor,snapshot,packageMac:value.packageMac};
 }catch{throw new MemoryCipherError();}
}
