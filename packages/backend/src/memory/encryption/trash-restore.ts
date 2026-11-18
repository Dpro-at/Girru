/** Inactive strict restore primitive. Caller owns transaction, authorization/revisions and audited history decrypt. */
import {one,run,dialect,type Step,type SqlParam} from '../../repositories/sql-steps.js';
import {lockMemoryHistory} from '../versions.js';
import {normalizeDrawer,defaultDrawerForType} from '../drawers.js';
import {decryptMemoryRow,encryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {snapshotEncryptedRow,canonicalEncryptedRow} from './content-commit.js';
import {prepareEncryptedTrashRestore} from './trash-snapshot.js';
import {recordEncryptedVersionStep} from './version-writer.js';
import {syncEncryptedTopicIndexStep,verifyEncryptedTopicClaimStep} from './topic-index.js';
import {memoryTopicLookupToken} from './topic-lookup.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
export function* restoreEncryptedMemoryFromTrashStep(expectedInput:Row,suppliedScope:MemoryRowScope,suppliedKey:Buffer,keyId:string,suppliedLookup:Buffer,actor:string,isCurrent:()=>boolean,conflictInput?:Row):Step<string>{
 const conflict=conflictInput?snapshotEncryptedRow(conflictInput):undefined;
 const expected=snapshotEncryptedRow(expectedInput),scope={...suppliedScope},key=Buffer.from(suppliedKey),lookup=Buffer.from(suppliedLookup);
 try{
  if(!isCurrent()||lookup.length!==32||typeof actor!=='string'||!actor||actor.length>256)throw new MemoryCipherError();
  const history=decryptMemoryRow('memory_versions',expected,scope,key,keyId);
  if(history.change!=='delete'||typeof history.memory_id!=='string'||typeof history.snapshot!=='string'||typeof history.reason==='string'&&history.reason.startsWith('merged from project:'))throw new MemoryCipherError();
  let replacement=prepareEncryptedTrashRestore(history.snapshot,history.memory_id,scope,key,keyId,()=>isCurrent()),plain=decryptMemoryRow('memories',replacement,scope,key,keyId);
  const drawer=plain.drawer_kind==null?defaultDrawerForType(String(plain.type)):normalizeDrawer({kind:plain.drawer_kind,key:plain.drawer_key??''});
  if(history.drawer_kind!==drawer.kind||history.drawer_key!==(drawer.key??''))throw new MemoryCipherError();
  if((yield* dialect())==='postgres')yield* run('LOCK TABLE memory_encryption_topics IN ACCESS EXCLUSIVE MODE');
  yield* lockMemoryHistory(history.memory_id);
  const latest=yield* one<Row>('SELECT * FROM memory_versions WHERE memory_id=? ORDER BY version DESC LIMIT 1',history.memory_id);
  if(!latest||canonicalEncryptedRow(latest)!==canonicalEncryptedRow(expected)||(yield* one<Row>('SELECT id FROM memories WHERE id=?',history.memory_id))||!isCurrent())throw new MemoryCipherError();
  if(yield* one<Row>('SELECT memory_id FROM memory_encryption_topics WHERE owner_id=? AND memory_id=?',scope.ownerId,history.memory_id))throw new MemoryCipherError();
  if(conflict){
   const occupied=decryptMemoryRow('memories',conflict,scope,key,keyId);
   const currentConflict=yield* one<Row>(`SELECT * FROM memories WHERE id=? AND user_id=?`,String(occupied.id),scope.ownerId);
   const token=memoryTopicLookupToken(plain.topic_key as string|null,lookup,scope.ownerId,drawer);
   const occupiedDrawer=occupied.drawer_kind==null?defaultDrawerForType(String(occupied.type)):normalizeDrawer({kind:occupied.drawer_kind,key:occupied.drawer_key??''});
   if(!currentConflict||canonicalEncryptedRow(currentConflict)!==canonicalEncryptedRow(conflict)||occupied.id===plain.id||occupied.status!=='active'||!token||drawer.kind!==occupiedDrawer.kind||(drawer.key??'')!==(occupiedDrawer.key??'')||memoryTopicLookupToken(occupied.topic_key as string|null,lookup,scope.ownerId,occupiedDrawer)!==token||!isCurrent())throw new MemoryCipherError();
   yield* verifyEncryptedTopicClaimStep(occupied,lookup);
   plain.topic_key=null;replacement=encryptMemoryRow('memories',plain,scope,key,keyId);
  }
  const fields=Object.keys(replacement);
  yield* run(`INSERT INTO memories (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,...fields.map(f=>(typeof replacement[f]==='boolean'?Number(replacement[f]):replacement[f]) as SqlParam));
  // A conflicting unique topic claim aborts the transaction; no silent topic loss.
  yield* syncEncryptedTopicIndexStep(plain,lookup);
  const created=yield* recordEncryptedVersionStep({memoryId:history.memory_id,userId:scope.ownerId,drawer,actor,change:'create',sourceRow:plain,reason:'restored from Trash',entry:{type:String(plain.type),content:String(plain.content),importance:Math.min(10,Math.max(1,Math.round(Number(plain.importance_score??0.5)*10)))}},scope,key,keyId);
  const stored=yield* one<Row>('SELECT * FROM memories WHERE id=? AND user_id=?',history.memory_id,scope.ownerId);
  if(!created||!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(replacement)||!isCurrent())throw new MemoryCipherError();
  yield* verifyEncryptedTopicClaimStep(plain,lookup);
  const version=yield* one<Row>('SELECT * FROM memory_versions WHERE id=? AND user_id=?',created,scope.ownerId);
  if(!version||decryptMemoryRow('memory_versions',version,scope,key,keyId).change!=='create')throw new MemoryCipherError();
  if(conflict){const finalConflict=yield* one<Row>('SELECT * FROM memories WHERE id=? AND user_id=?',String(conflict.id),scope.ownerId);if(!finalConflict||canonicalEncryptedRow(finalConflict)!==canonicalEncryptedRow(conflict))throw new MemoryCipherError();yield* verifyEncryptedTopicClaimStep(decryptMemoryRow('memories',finalConflict,scope,key,keyId),lookup);}
  return history.memory_id;
 }finally{key.fill(0);lookup.fill(0);}
}
