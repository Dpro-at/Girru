/** Internal encrypted-history snapshot format; not registered with plaintext Trash readers. */
import {decryptMemoryRow,encryptMemoryRow,memoryRowSurfaceManifest,certifyEncryptedTrashProducers,restoreCertifiedEncryptedTrashProducers,type MemoryRowScope} from './row-codec.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
const LIMIT=512*1024;
/** Caller must authenticate and durably audit before supplying the operation key. Returns RAM plaintext only. */
export function prepareEncryptedTrashSnapshot(cipher:Row,scope:MemoryRowScope,key:Buffer,keyId:string,authorize:(row:Readonly<Row>)=>boolean):string{
 try{
  if(authorize(cipher)!==true)throw new MemoryCipherError();
  const plain=decryptMemoryRow('memories',cipher,scope,key,keyId);
  if(plain.status!=='active'||authorize(plain)!==true)throw new MemoryCipherError();
  const row=Object.fromEntries(Object.entries(plain).map(([f,v])=>[f,Buffer.isBuffer(v)?{bytes:v.toString('base64')}:v]));
  const snapshot=JSON.stringify({format:'girru-encrypted-trash-row',version:2,row,producers:certifyEncryptedTrashProducers(plain,scope,key)});
  if(Buffer.byteLength(snapshot)>LIMIT)throw new MemoryCipherError();return snapshot;
 }catch{throw new MemoryCipherError();}
}
/** Restore preparation only. Caller must verify latest delete-version/no live row, authorization and topic conflict transactionally. */
export function prepareEncryptedTrashRestore(snapshot:string,expectedId:string,scope:MemoryRowScope,key:Buffer,keyId:string,authorize:(row:Readonly<Row>)=>boolean):Row{
 try{
  if(typeof snapshot!=='string'||Buffer.byteLength(snapshot)>LIMIT)throw new MemoryCipherError();
  const parsed=JSON.parse(snapshot);
  if(!parsed||Object.keys(parsed).sort().join(',')!==(parsed.version===2?'format,producers,row,version':'format,row,version')||parsed.format!=='girru-encrypted-trash-row'||![1,2].includes(parsed.version)||!parsed.row||typeof parsed.row!=='object'||Array.isArray(parsed.row))throw new MemoryCipherError();
  const surface=memoryRowSurfaceManifest().find(s=>s.table==='memories')!;
  const fields=[surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary];
  if(Object.keys(parsed.row).sort().join('\0')!==fields.sort().join('\0'))throw new MemoryCipherError();
  const row:Row={...parsed.row};const bytes=row.embedding_vec;
  if(bytes!==null){if(!bytes||typeof bytes!=='object'||Object.keys(bytes).join(',')!=='bytes'||typeof (bytes as Record<string,unknown>).bytes!=='string')throw new MemoryCipherError();const buffer=Buffer.from((bytes as Record<string,string>).bytes,'base64');if(buffer.toString('base64')!==(bytes as Record<string,unknown>).bytes)throw new MemoryCipherError();row.embedding_vec=buffer;}
  if(row.id!==expectedId||row.user_id!==scope.ownerId||row.status!=='active'||authorize(row)!==true)throw new MemoryCipherError();
  const authenticated=parsed.version===2?restoreCertifiedEncryptedTrashProducers(row,scope,key,parsed.producers):row;
  const cipher=encryptMemoryRow('memories',authenticated,scope,key,keyId);
  if(authorize(row)!==true)throw new MemoryCipherError();return cipher;
 }catch{throw new MemoryCipherError();}
}


/** Rotation verifies old certificates before re-signing the same content with the next data key. */
export function rotateEncryptedTrashSnapshot(snapshot:string,expectedId:string,scope:MemoryRowScope,oldKey:Buffer,oldKeyId:string,newKey:Buffer,newKeyId:string,isCurrent:()=>boolean):string{
 let plain:Row|undefined;try{if(!isCurrent())throw new MemoryCipherError();const prior=prepareEncryptedTrashRestore(snapshot,expectedId,scope,oldKey,oldKeyId,isCurrent);plain=decryptMemoryRow('memories',prior,scope,oldKey,oldKeyId);const next=encryptMemoryRow('memories',plain,scope,newKey,newKeyId);return prepareEncryptedTrashSnapshot(next,scope,newKey,newKeyId,isCurrent);}finally{if(plain)for(const value of Object.values(plain))if(Buffer.isBuffer(value))value.fill(0);}
}
