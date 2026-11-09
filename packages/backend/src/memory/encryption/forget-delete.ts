/** Internal database forget stage. Durable encrypted cleanup ticket must finish before reporting completion. */
import {randomUUID} from 'node:crypto';
import {run,one,tableExists,dialect,type Step,type SqlParam} from '../../repositories/sql-steps.js';
import {encryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {sealMemoryText} from './envelope.js';
import {forgetMemoryGraphStep} from '../graph/store.js';
import {forgetTrustStep} from '../quality/trust.js';
import {lockMemoryHistory,drawerRevisionStep} from '../versions.js';
import type {DrawerRef} from '../drawers.js';
import {MemoryCipherError} from './envelope.js';
export function* deleteEncryptedForgottenSourceStep(ownerId:string,id:string,drawer:DrawerRef,types:string[],texts:string[],scope:MemoryRowScope,key:Buffer,keyId:string,actor:string,isCurrent:()=>boolean,additionalMemories:Record<string,unknown>[]=[],createTicket=true):Step<{jobId:string;tombstone:Record<string,unknown>}>{
 if(ownerId!==scope.ownerId||!isCurrent())throw new MemoryCipherError();
 yield* run('CREATE TABLE IF NOT EXISTS memory_encryption_forget_jobs (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,memory_id TEXT NOT NULL,tombstone_id TEXT NOT NULL,plan TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL)');
 yield* lockMemoryHistory(id);const revision=yield* drawerRevisionStep(ownerId,drawer),at=new Date().toISOString();
 yield* run('DELETE FROM memories WHERE id=? AND user_id=?',id,ownerId);yield* run('DELETE FROM memory_versions WHERE memory_id=? AND user_id=?',id,ownerId);yield* run('DELETE FROM memory_encryption_topics WHERE owner_id=? AND memory_id=?',ownerId,id);
 const driver=yield* dialect();
 const queries:[string,string,string[]][]=[
 ['memory_sharing_audit','DELETE FROM memory_sharing_audit WHERE memory_id=?',[id]],['memory_quality_history','DELETE FROM memory_quality_history WHERE memory_id=?',[id]],['memory_enrichment_log','DELETE FROM memory_enrichment_log WHERE memory_id=?',[id]],['memory_relationships','DELETE FROM memory_relationships WHERE source_memory_id=? OR target_memory_id=?',[id,id]],['memory_chunks','DELETE FROM memory_chunks WHERE memory_id=?',[id]],['memory_relations','DELETE FROM memory_relations WHERE source_id=? OR target_id=?',[id,id]],['memory_fts','DELETE FROM memory_fts WHERE memory_id=?',[id]],['memory_index','DELETE FROM memory_index WHERE memory_id=?',[id]]];
 for(const [table,query,params] of queries)if(yield* tableExists(table))yield* run(query,...params);
 yield* forgetMemoryGraphStep(ownerId,id);yield* forgetTrustStep(ownerId,id);
 if(yield* tableExists('agent_rules')){const lesson="source='agent' AND suggested_by IS NULL AND status IN ('suggested','dismissed') AND reason LIKE '%lesson:%'";yield* run(`DELETE FROM agent_rules WHERE ${lesson} AND ${driver==='sqlite'?'instr(reason,?)':'strpos(reason,?)'}>0`,id);for(const text of texts)yield* run(`DELETE FROM agent_rules WHERE ${lesson} AND text=?`,text.replace(/\s+/g,' ').trim());}
 const row={id:randomUUID(),memory_id:id,user_id:ownerId,drawer_kind:drawer.kind,drawer_key:drawer.key??'',drawer_revision:revision,version:1,change:'forget',type:null,content:null,importance_score:null,proposal_id:null,created_by:actor,created_at:at,reason:null,snapshot:null};
 const tombstone=encryptMemoryRow('memory_versions',row,scope,key,keyId),fields=Object.keys(tombstone);yield* run('INSERT INTO memory_versions('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')',...fields.map(f=>tombstone[f] as SqlParam));
 if(!createTicket)return{jobId:'',tombstone};
 const jobId=randomUUID(),plan=sealMemoryText(JSON.stringify({v:1,ownerId,memoryId:id,types,texts,drawer,tombstoneId:row.id,additionalMemories}),key,keyId,{ownerId,memberId:scope.memberId,recordId:jobId,field:'forget-cleanup-plan'});
 yield* run("INSERT INTO memory_encryption_forget_jobs(id,owner_id,memory_id,tombstone_id,plan,status,created_at) VALUES(?,?,?,?,?,'pending',?)",jobId,ownerId,id,row.id,plan,at);
 if(!isCurrent()||(yield* one('SELECT id FROM memories WHERE id=?',id)))throw new MemoryCipherError();return{jobId,tombstone};
}
