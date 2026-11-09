/** Internal encrypted history step. Caller owns authorization, read audit and enclosing update transaction. */
import {run,one,type Step} from '../../repositories/sql-steps.js';
import {randomUUID} from 'node:crypto';
import {lockMemoryHistory,lastVersionStep,drawerRevisionStep,type RecordVersionInput} from '../versions.js';
import {encryptMemoryRow,decryptMemoryRow,carryEncryptedMemoryContentProducer,type MemoryRowScope} from './row-codec.js';
import {MemoryCipherError} from './envelope.js';
export function* recordEncryptedVersionStep(input:RecordVersionInput&{sourceRow?:Record<string,unknown>},scope:MemoryRowScope,key:Buffer,keyId:string,baselineOnlyIfMissing=false):Step<string|undefined>{
 input={...input,drawer:{...input.drawer},entry:input.entry?{...input.entry}:null};
 scope={...scope};key=Buffer.from(key);
 try{
 if(input.userId!==scope.ownerId||!input.memoryId||!['baseline','create','update','delete'].includes(input.change)||typeof input.actor!=='string'||!input.actor)throw new MemoryCipherError();
 yield* lockMemoryHistory(input.memoryId);
 const previous=yield* lastVersionStep(input.memoryId);
 if(baselineOnlyIfMissing){if(input.change!=='baseline')throw new MemoryCipherError();if(previous!==null)return;}
 if(previous!==null&&(!Number.isSafeInteger(previous)||previous<1))throw new MemoryCipherError();
 const version=(previous??0)+1,revision=input.revision??(yield* drawerRevisionStep(input.userId,input.drawer));
 if(!Number.isSafeInteger(version)||!Number.isSafeInteger(revision)||revision<0)throw new MemoryCipherError();
 const row={id:randomUUID(),memory_id:input.memoryId,user_id:input.userId,drawer_kind:input.drawer.kind,drawer_key:input.drawer.key??'',drawer_revision:revision,version,change:input.change,type:input.entry?.type??null,content:input.entry?.content??null,importance_score:input.entry?input.entry.importance/10:null,proposal_id:input.proposalId??null,created_by:input.actor,created_at:new Date().toISOString(),reason:typeof input.reason==='string'?input.reason.slice(0,200):null,snapshot:input.snapshot??null};
 const encrypted=encryptMemoryRow('memory_versions',input.sourceRow?carryEncryptedMemoryContentProducer('memories',input.sourceRow,'memory_versions',row,scope):row,scope,key,keyId),fields=Object.keys(encrypted);
 yield* run(`INSERT INTO memory_versions (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,...fields.map(f=>encrypted[f] as string|number|null));
 const stored=yield* one<Record<string,unknown>>('SELECT * FROM memory_versions WHERE id=? AND user_id=?',row.id,scope.ownerId);
 if(!stored)throw new MemoryCipherError();
 const restored=decryptMemoryRow('memory_versions',stored,scope,key,keyId);
 if(Object.keys(row).some(field=>restored[field]!==row[field as keyof typeof row]))throw new MemoryCipherError();
 return row.id;
 }finally{key.fill(0);}
}
