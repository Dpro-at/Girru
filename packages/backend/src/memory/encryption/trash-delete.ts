/** Inactive primitive. Caller owns transaction, live authorization/revision checks and durable pre-decrypt audit. */
import {one,run,dialect,type Step} from '../../repositories/sql-steps.js';
import {decryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {snapshotEncryptedRow,canonicalEncryptedRow} from './content-commit.js';
import {prepareEncryptedTrashSnapshot} from './trash-snapshot.js';
import {recordEncryptedVersionStep} from './version-writer.js';
import {verifyEncryptedTopicClaimStep} from './topic-index.js';
import {normalizeDrawer,defaultDrawerForType} from '../drawers.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
export function* deleteEncryptedMemoryToTrashStep(expectedInput:Row,suppliedScope:MemoryRowScope,suppliedKey:Buffer,keyId:string,suppliedLookup:Buffer,actor:string,reason:string,isCurrent:()=>boolean):Step<string>{
 const expected=snapshotEncryptedRow(expectedInput),scope={...suppliedScope},key=Buffer.from(suppliedKey),lookup=Buffer.from(suppliedLookup);
 try{
  if(typeof actor!=='string'||!actor||actor.length>256||typeof reason!=='string'||reason.length>200||lookup.length!==32||!isCurrent())throw new MemoryCipherError();
  const snapshot=prepareEncryptedTrashSnapshot(expected,scope,key,keyId,()=>isCurrent()),plain=decryptMemoryRow('memories',expected,scope,key,keyId);
  const driver=yield* dialect();if(driver==='postgres')yield* run('LOCK TABLE memory_encryption_topics IN ACCESS EXCLUSIVE MODE');
  const current=yield* one<Row>(`SELECT * FROM memories WHERE id=? AND user_id=?${driver==='postgres'?' FOR UPDATE':''}`,String(plain.id),scope.ownerId);
  if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(expected)||!isCurrent())throw new MemoryCipherError();
  yield* verifyEncryptedTopicClaimStep(plain,lookup);
  const drawer=plain.drawer_kind==null?defaultDrawerForType(String(plain.type)):normalizeDrawer({kind:plain.drawer_kind,key:plain.drawer_key??''});
  const common={memoryId:String(plain.id),userId:scope.ownerId,drawer,actor};
  const baseline=yield* recordEncryptedVersionStep({...common,change:'baseline',sourceRow:plain,entry:{type:String(plain.type),content:String(plain.content),importance:Math.min(10,Math.max(1,Math.round(Number(plain.importance_score??0.5)*10)))}},scope,key,keyId,true);
  const deleted=yield* run('DELETE FROM memories WHERE id=? AND user_id=? AND content=?',String(plain.id),scope.ownerId,expected.content as string);
  if(deleted.changes!==1)throw new MemoryCipherError();
  yield* run('DELETE FROM memory_encryption_topics WHERE owner_id=? AND memory_id=?',scope.ownerId,String(plain.id));
  const historyId=yield* recordEncryptedVersionStep({...common,change:'delete',entry:null,reason,snapshot},scope,key,keyId);
  if(!historyId)throw new MemoryCipherError();
  for(const id of [baseline,historyId])if(id){const stored=yield* one<Row>('SELECT * FROM memory_versions WHERE id=? AND user_id=?',id,scope.ownerId);if(!stored)throw new MemoryCipherError();const version=decryptMemoryRow('memory_versions',stored,scope,key,keyId);if(id===historyId&&(version.snapshot!==snapshot||version.change!=='delete'))throw new MemoryCipherError();}
  if((yield* one<Row>('SELECT id FROM memories WHERE id=?',String(plain.id)))||(yield* one<Row>('SELECT memory_id FROM memory_encryption_topics WHERE owner_id=? AND memory_id=?',scope.ownerId,String(plain.id)))||!isCurrent())throw new MemoryCipherError();
  return historyId;
 }finally{key.fill(0);lookup.fill(0);}
}
