/** Inactive transaction step. Caller owns authenticated approval/revisions/audit and enclosing transaction. */
import {one,run,dialect,type Step,type SqlParam} from '../../repositories/sql-steps.js';
import {decryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {prepareEncryptedSupersession} from './supersession.js';
import {snapshotEncryptedRow,canonicalEncryptedRow} from './content-commit.js';
import {verifyEncryptedTopicClaimStep,syncEncryptedTopicIndexStep} from './topic-index.js';
import {recordEncryptedVersionStep} from './version-writer.js';
import {lastVersionStep} from '../versions.js';
import {normalizeDrawer,defaultDrawerForType} from '../drawers.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
export function* commitEncryptedSupersessionStep(expectedInput:Row,newInput:Row,suppliedScope:MemoryRowScope,suppliedKey:Buffer,keyId:string,suppliedLookupKey:Buffer,actor:string,historyContext?:{proposalId:string;previousRevision:number;revision:number;reason:string}):Step<void>{
 if(!Buffer.isBuffer(suppliedKey)||suppliedKey.length!==32||!Buffer.isBuffer(suppliedLookupKey)||suppliedLookupKey.length!==32)throw new MemoryCipherError();
 historyContext=historyContext?{...historyContext}:undefined;
 const expected=snapshotEncryptedRow(expectedInput),newCipher=snapshotEncryptedRow(newInput),scope={...suppliedScope},key=Buffer.from(suppliedKey),lookup=Buffer.from(suppliedLookupKey);
 try{
  if(historyContext&&(!historyContext.proposalId||!Number.isSafeInteger(historyContext.previousRevision)||historyContext.previousRevision<0||historyContext.revision!==historyContext.previousRevision+1))throw new MemoryCipherError();
  if(typeof actor!=='string'||!actor||actor.length>256)throw new MemoryCipherError();
  const old=decryptMemoryRow('memories',expected,scope,key,keyId),next=decryptMemoryRow('memories',newCipher,scope,key,keyId),replaced=prepareEncryptedSupersession(expected,newCipher,scope,key,keyId,()=>true,()=>true),replacedPlain=decryptMemoryRow('memories',replaced,scope,key,keyId);
  const driver=yield* dialect();if(driver==='postgres')yield* run('LOCK TABLE memory_encryption_topics IN ACCESS EXCLUSIVE MODE');
  yield* verifyEncryptedTopicClaimStep(old,lookup);
  const current=yield* one<Row>(`SELECT * FROM memories WHERE id=? AND user_id=?${driver==='postgres'?' FOR UPDATE':''}`,old.id as string,scope.ownerId);
  if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(expected))throw new MemoryCipherError();
  if(yield* one('SELECT 1 AS occupied FROM memories WHERE id=?',next.id as string))throw new MemoryCipherError();
  if((yield* lastVersionStep(next.id as string))!==null)throw new MemoryCipherError();
  const oldFields=Object.keys(replaced).filter(f=>f!=='id'&&f!=='user_id'),params=(row:Row,fields:string[])=>fields.map(f=>(typeof row[f]==='boolean'?Number(row[f]):row[f]) as SqlParam);
  const changed=yield* run(`UPDATE memories SET ${oldFields.map(f=>f+'=?').join(',')} WHERE id=? AND user_id=? AND content=?`,...params(replaced,oldFields),old.id as string,scope.ownerId,expected.content as string);
  if(changed.changes!==1)throw new MemoryCipherError();
  yield* syncEncryptedTopicIndexStep(replacedPlain,lookup);
  const newFields=Object.keys(newCipher);yield* run(`INSERT INTO memories (${newFields.join(',')}) VALUES (${newFields.map(()=>'?').join(',')})`,...params(newCipher,newFields));
  yield* syncEncryptedTopicIndexStep(next,lookup);
  const drawer=old.drawer_kind==null?defaultDrawerForType(typeof old.type==='string'?old.type:undefined):normalizeDrawer({kind:old.drawer_kind,key:old.drawer_key??''});
  const entry=(row:Row)=>({type:String(row.type),content:String(row.content),importance:Math.min(10,Math.max(1,Math.round((typeof row.importance_score==='number'?row.importance_score:0.5)*10)))});
  const baseline=yield* recordEncryptedVersionStep({memoryId:old.id as string,userId:scope.ownerId,drawer,actor,change:'baseline',entry:entry(old),sourceRow:old,revision:historyContext?.previousRevision,proposalId:historyContext?.proposalId},scope,key,keyId,true);
  const created=yield* recordEncryptedVersionStep({memoryId:next.id as string,userId:scope.ownerId,drawer,actor,change:'create',entry:entry(next),sourceRow:next,reason:historyContext?.reason??'supersession',revision:historyContext?.revision,proposalId:historyContext?.proposalId},scope,key,keyId);
  for(const id of [baseline,created])if(id){const version=yield* one<Row>('SELECT * FROM memory_versions WHERE id=? AND user_id=?',id,scope.ownerId);if(!version)throw new MemoryCipherError();decryptMemoryRow('memory_versions',version,scope,key,keyId);}
  for(const row of [replaced,newCipher]){const stored=yield* one<Row>('SELECT * FROM memories WHERE id=? AND user_id=?',row.id as string,scope.ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(row))throw new MemoryCipherError();}
  yield* verifyEncryptedTopicClaimStep(replacedPlain,lookup);yield* verifyEncryptedTopicClaimStep(next,lookup);
 }finally{key.fill(0);lookup.fill(0);}
}
