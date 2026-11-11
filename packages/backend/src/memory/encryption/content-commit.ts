/** Inactive SQL primitive; caller MUST authenticate, audit decrypts, validate revisions and enclose in a transaction. */
import {one,run,dialect,type Step,type SqlParam} from '../../repositories/sql-steps.js';
import {decryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {MEMORY_CONTENT_UPDATE_FIELDS} from './content-update.js';
import {recordEncryptedVersionStep} from './version-writer.js';
import {normalizeDrawer,defaultDrawerForType,type DrawerRef} from '../drawers.js';
import {verifyEncryptedTopicClaimStep,syncEncryptedTopicIndexStep} from './topic-index.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
function snapshot(row:Row):Row{return Object.fromEntries(Object.entries(row).map(([f,v])=>[f,Buffer.isBuffer(v)?Buffer.from(v):v]));}
function canonical(row:Row){return JSON.stringify(Object.keys(row).sort().map(f=>[f,Buffer.isBuffer(row[f])?(row[f] as Buffer).toString('base64'):row[f]]));}
export function* commitEncryptedContentStep(expectedInput:Row,replacementInput:Row,suppliedScope:MemoryRowScope,suppliedKey:Buffer,keyId:string,actor:string,suppliedLookupKey?:Buffer,moveTarget?:DrawerRef):Step<void>{
 const lookupKey=suppliedLookupKey?Buffer.from(suppliedLookupKey):undefined;
 const expected=snapshot(expectedInput),replacement=snapshot(replacementInput),scope={...suppliedScope},key=Buffer.from(suppliedKey);
 try{
  const old=decryptMemoryRow('memories',expected,scope,key,keyId),next=decryptMemoryRow('memories',replacement,scope,key,keyId);
  if(typeof old.id!=='string'||typeof actor!=='string'||!actor||actor.length>256)throw new MemoryCipherError();
  const target=moveTarget?normalizeDrawer(moveTarget):undefined;
  if(target&&(!lookupKey||next.drawer_kind!==target.kind||next.drawer_key!==(target.key??'')))throw new MemoryCipherError();
  const editable=new Set<string>(target?['drawer_kind','drawer_key']:MEMORY_CONTENT_UPDATE_FIELDS);
  if(Object.keys(old).some(f=>!editable.has(f)&&canonical({value:old[f]})!==canonical({value:next[f]})))throw new MemoryCipherError();
  const driver=yield* dialect();
  if(lookupKey){if(driver==='postgres')yield* run(target?'LOCK TABLE memory_encryption_topics IN ACCESS EXCLUSIVE MODE':'LOCK TABLE memory_encryption_topics IN SHARE MODE');yield* verifyEncryptedTopicClaimStep(old,lookupKey);}
  const current=yield* one<Row>(`SELECT * FROM memories WHERE id=? AND user_id=?${driver==='postgres'?' FOR UPDATE':''}`,old.id,scope.ownerId);
  if(!current||canonical(current)!==canonical(expected))throw new MemoryCipherError();
  const fields=Object.keys(replacement).filter(f=>f!=='id'&&f!=='user_id');
  const result=yield* run(`UPDATE memories SET ${fields.map(f=>f+'=?').join(',')} WHERE id=? AND user_id=? AND content=?`,...fields.map(f=>(typeof replacement[f]==='boolean'?Number(replacement[f]):replacement[f]) as SqlParam),old.id,scope.ownerId,expected.content as string);
  if(result.changes!==1)throw new MemoryCipherError();
  const drawer=old.drawer_kind==null?defaultDrawerForType(typeof old.type==='string'?old.type:undefined):normalizeDrawer({kind:old.drawer_kind,key:old.drawer_key??''});
  const entry=(r:Row)=>({type:String(r.type),content:String(r.content),importance:Math.min(10,Math.max(1,Math.round((typeof r.importance_score==='number'?r.importance_score:0.5)*10)))});
  if(target&&lookupKey)yield* syncEncryptedTopicIndexStep(next,lookupKey);
  const common={memoryId:old.id,userId:scope.ownerId,drawer,actor};
  const baselineId=yield* recordEncryptedVersionStep({...common,change:'baseline',entry:entry(old),sourceRow:old},scope,key,keyId,true);
  const updateId=yield* recordEncryptedVersionStep({...common,drawer:target??drawer,change:'update',entry:entry(next),sourceRow:next},scope,key,keyId);
  for(const id of [baselineId,updateId])if(id){const version=yield* one<Row>('SELECT * FROM memory_versions WHERE id=? AND user_id=?',id,scope.ownerId);if(!version)throw new MemoryCipherError();decryptMemoryRow('memory_versions',version,scope,key,keyId);}
  const stored=yield* one<Row>('SELECT * FROM memories WHERE id=? AND user_id=?',old.id,scope.ownerId);
  if(!stored||canonical(stored)!==canonical(replacement))throw new MemoryCipherError();
  if(lookupKey)yield* verifyEncryptedTopicClaimStep(next,lookupKey);
 }finally{key.fill(0);lookupKey?.fill(0);}
}

/** Shared internal snapshot/equality helpers; not an authenticity check. */
export {snapshot as snapshotEncryptedRow,canonical as canonicalEncryptedRow};
