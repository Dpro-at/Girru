import {rotateEncryptedTrashSnapshot} from './trash-snapshot.js';
/** Declared-surface key rotation by verified copy, never by mutating the selected source in place. */
import {verifyMemorySurfaceSnapshot,sealMemorySurfaceSnapshot,type MemorySurfaceSnapshot} from './copy-manifest.js';
import {prepareMemoryCopyBatch} from './copy-batch.js';
import {decryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {captureMemoryRestoreAnchor,createMemoryRestorePackage,type MemoryRestoreAnchor} from './restore-package.js';
import {MemoryCipherError} from './envelope.js';
/** Caller audits the original capture before opening either key; this function has no persistence or enrollment. */
export function prepareEncryptedMemoryRotationCopy(input:{snapshot:MemorySurfaceSnapshot;scope:MemoryRowScope;previous:MemoryRestoreAnchor;next:MemoryRestoreAnchor;oldKey:Buffer;newKey:Buffer;verificationKey:Buffer;isCurrent:()=>boolean}){
 let oldKey:Buffer|undefined,newKey:Buffer|undefined,verificationKey:Buffer|undefined;
 try{
  if(![input.oldKey,input.newKey,input.verificationKey].every(key=>Buffer.isBuffer(key)&&key.length===32)||input.oldKey.equals(input.newKey)||typeof input.isCurrent!=='function'||input.isCurrent()!==true)throw new MemoryCipherError();
  oldKey=Buffer.from(input.oldKey);newKey=Buffer.from(input.newKey);verificationKey=Buffer.from(input.verificationKey);
  const scope={...input.scope},previous=captureMemoryRestoreAnchor(input.previous),next=captureMemoryRestoreAnchor(input.next),current=input.isCurrent;
  if(previous.ownerId!==scope.ownerId||previous.memberId!==scope.memberId||next.ownerId!==scope.ownerId||next.memberId!==scope.memberId||next.authorityId!==previous.authorityId||next.keyId===previous.keyId||next.epoch!==previous.epoch+1||next.forgetSequence!==previous.forgetSequence+1)throw new MemoryCipherError();
  verifyMemorySurfaceSnapshot(input.snapshot,scope,oldKey,previous.keyId,verificationKey);if(current()!==true)throw new MemoryCipherError();
  const oldMaterial=oldKey,newMaterial=newKey,receiptKey=verificationKey;
  const batches=input.snapshot.batches.map(batch=>{
   if(current()!==true)throw new MemoryCipherError();const rows=batch.rows.map(row=>{const plain=decryptMemoryRow(batch.table,row,scope,oldMaterial,previous.keyId);if(batch.table==='memory_versions'&&plain.snapshot!==null){if(typeof plain.snapshot!=='string'||typeof plain.memory_id!=='string')throw new MemoryCipherError();plain.snapshot=rotateEncryptedTrashSnapshot(plain.snapshot,plain.memory_id,scope,oldMaterial,previous.keyId,newMaterial,next.keyId,current);}return plain;});
   const prepared=prepareMemoryCopyBatch(batch.table,rows,scope,newMaterial,next.keyId,receiptKey);if(current()!==true)throw new MemoryCipherError();return prepared;
  });
  const snapshot=sealMemorySurfaceSnapshot(batches,scope,newKey,next.keyId,verificationKey);if(current()!==true)throw new MemoryCipherError();return createMemoryRestorePackage(snapshot,next,verificationKey);
 }catch{throw new MemoryCipherError();}finally{oldKey?.fill(0);newKey?.fill(0);verificationKey?.fill(0);}
}
