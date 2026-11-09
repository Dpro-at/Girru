/** Exact owned-memory schema only. Control users, sessions, agents, and devices are never cloned. */
import {all,one,run,dialect,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import {memoryRowSurfaceManifest,type MemoryRowTable} from './row-codec.js';
import {initializeEncryptedTopicIndexStep} from './topic-index.js';
import {createProvisionedMemoryMemberKeyStore} from './member-key-store.js';
import {createMemoryReadAuditStore} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
const TABLES=['memories','memory_versions','memory_file_proposals','memory_weekly_summaries','agent_handoffs','memory_bridge_handoffs','memory_pinned_facts','memory_recall_traces','doc_index_sources','doc_index_files','doc_index_chunks','memory_encryption_document_admissions','memory_encryption_legacy_graph','memory_open_questions','memory_import_batches','memory_health_events','memory_retention_runs','memory_bridge_audit','memory_bridge_registrations','memory_encryption_auxiliary'] as const;
const REAL=new Set(['importance_score','quality_score','completeness_score','clarity_score','usefulness_score']);
const INTEGER=new Set(['expiry_timestamp','is_team_critical','auto_enriched','needs_improvement','embedding_dims','last_accessed_at','access_count','drawer_revision','version','base_revision','applied_revision','position','pack_hit','pack_chars','prompt_tokens','ttft_ms','uses_indexed','enabled','revision','files','chunks','unreadable','limited','bytes','mtime_ms','pages','ordinal','page','epoch','forget_sequence','source_revision','file_revision','parts','latest_version','committed_version','dry_run','existed','task_no']);
const DEFAULTS:Record<string,Record<string,string>>={memories:{importance_score:'0.5',last_accessed_at:'0',access_count:'0',is_team_critical:'0',auto_enriched:'0',needs_improvement:'0'},memory_recall_traces:{pack_hit:'0',pack_chars:'0',prompt_tokens:'0',uses_indexed:'0'},doc_index_sources:{enabled:'1',revision:'0',files:'0',chunks:'0',unreadable:'0',limited:'0'},doc_index_files:{revision:'1',chunks:'0'},memory_bridge_registrations:{existed:'1'},memory_retention_runs:{dry_run:'1'}};
function fail():never{throw new MemoryCipherError();}
export type OwnedMemorySchemaLease={profileId:string;ownerId:string;storageId:string;kind:'new-app-owned-encrypted-memory';isCurrent:()=>boolean};
export function ownedMemorySchemaDefinitions(){
 const surfaces=memoryRowSurfaceManifest();if(surfaces.length!==20||surfaces.map(surface=>surface.table).sort().join(',')!==[...TABLES].sort().join(','))fail();
 return surfaces.map(surface=>{const fields=[surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary];return{table:surface.table,fields,columns:fields.map(field=>({name:field,type:surface.binary.includes(field)?'BLOB':REAL.has(field)?'REAL':INTEGER.has(field)?'INTEGER':'TEXT',primary:field===surface.id,required:field===surface.owner||field===surface.id,defaultSQL:DEFAULTS[surface.table]?.[field]??null}))};});
}
export function* verifyOwnedMemorySchemaStep():Step<void>{
 if((yield* dialect())!=='sqlite')fail();for(const surface of ownedMemorySchemaDefinitions()){
  const actual=yield* all<{name:string;type:string;pk:number;notnull:number}>('SELECT name,type,pk,"notnull" FROM pragma_table_info(?)',surface.table);
  if(actual.length!==surface.columns.length)fail();const byName=new Map(actual.map(column=>[column.name,column]));
  for(const expected of surface.columns){const found=byName.get(expected.name);if(!found||found.type.toUpperCase()!==expected.type||Boolean(found.pk)!==expected.primary||expected.required&&!found.notnull&&!found.pk)fail();}
 }
 for(const forbidden of ['users','auth_sessions','agents_config','devices','agent_permissions'])if(yield* one('SELECT name FROM sqlite_master WHERE type=? AND name=?','table',forbidden))fail();
}
/** The caller must own a genuinely new empty SQLite file and keep the real native connection lease. */
export async function initializeOwnedMemoryProfileSchema(input:{runner:StepRunner;lease:OwnedMemorySchemaLease;auditKey:Buffer}){
 const {runner,lease}=input;if(!lease||lease.kind!=='new-app-owned-encrypted-memory'||!lease.isCurrent()||runner.inTransaction?.()!==false||!Buffer.isBuffer(input.auditKey)||input.auditKey.length!==32)fail();
 await runner.tx(function*(){if(!lease.isCurrent()||(yield* dialect())!=='sqlite')fail();const existing=yield* all<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");if(existing.some(table=>table.name!=='memory_encryption_host_connection'))fail();
  for(const surface of ownedMemorySchemaDefinitions())yield* run(`CREATE TABLE ${surface.table}(${surface.columns.map(column=>`${column.name} ${column.type}${column.primary?' PRIMARY KEY':''}${column.required?' NOT NULL':''}${column.defaultSQL===null?'':` DEFAULT ${column.defaultSQL}`}`).join(',')})`);
  yield* initializeEncryptedTopicIndexStep();yield* verifyOwnedMemorySchemaStep();if(!lease.isCurrent())fail();
 },{immediate:true});
 const memberKeys=createProvisionedMemoryMemberKeyStore(runner);await memberKeys.initialize();const audit=createMemoryReadAuditStore(runner,lease.ownerId,input.auditKey);try{await audit.initialize();}finally{audit.close();}
 if(!lease.isCurrent())fail();await runner.tx(verifyOwnedMemorySchemaStep,{immediate:true});return Object.freeze({profileId:lease.profileId,ownerId:lease.ownerId,storageId:lease.storageId,isCurrent:lease.isCurrent,verify:()=>runner.tx(verifyOwnedMemorySchemaStep,{immediate:true})});
}
export type OwnedMemoryDeclaredTable=typeof TABLES[number]&MemoryRowTable;
