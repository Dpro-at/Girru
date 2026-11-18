/** Empty, newly owned control databases must never become a plaintext memory fallback. */
import {createHash} from 'node:crypto';
import {all,one,run,dialect,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import {memoryRowSurfaceManifest} from './row-codec.js';
import {MemoryCipherError} from './envelope.js';
const EXTRA_TABLES=['memory_import_previews','memory_quality_history','memory_enrichment_log','memory_consolidation_log','memory_graph_entities','memory_graph_links','memory_graph_link_sources','memory_graph_mentions','memory_graph_state','memory_graph_cluster_dismissals','memory_chunks','memory_relations','memory_index','memory_fts','memory_trust','memory_trust_sources','memory_relationships','memory_deduplication_log','memory_sharing_audit','chat_memory_links','memory_recall_uses','agent_handoff_marks','memory_bridge_backflow','memory_project_design'] as const;
export function controlContentIsolationTables():readonly string[]{return Object.freeze([...new Set([...memoryRowSurfaceManifest().map(surface=>surface.table),...EXTRA_TABLES])].sort());}
export type NewControlIsolationLease={kind:'new-app-owned-control';profileId:string;storageId:string;isCurrent:()=>boolean};
const fail=():never=>{throw new MemoryCipherError();};
const identifier=(name:string)=>'"'+name.replaceAll('"','""')+'"';
function trigger(table:string,event:'INSERT'|'UPDATE'){
 const name='encrypted_control_no_'+event.toLowerCase()+'_'+createHash('sha256').update(table).digest('hex').slice(0,24);
 return{name,sql:`CREATE TRIGGER ${identifier(name)} BEFORE ${event} ON ${identifier(table)} BEGIN SELECT RAISE(ABORT, 'encrypted_control_content_disabled'); END`};
}
function* isolateStep(lease:NewControlIsolationLease,install:boolean):Step<void>{
 if(!lease.isCurrent()||(yield* dialect())!=='sqlite')fail();
 for(const table of controlContentIsolationTables()){
  const schema=yield* one<{type:string;sql:string|null}>('SELECT type,sql FROM sqlite_master WHERE name=?',table);
  if(!schema)continue;
  // A virtual table needs a genuine no-legacy-index bootstrap. Do not drop or rewrite it here.
  const catalog=yield* one<{type:string}>("SELECT type FROM pragma_table_list WHERE name=? AND schema='main'",table);
  if(schema.type!=='table'||!schema.sql||!catalog||catalog.type!=='table')fail();
  const present=yield* one(`SELECT 1 AS present FROM ${identifier(table)} LIMIT 1`);if(present)fail();
  for(const event of ['INSERT','UPDATE'] as const){const expected=trigger(table,event),existing=yield* one<{sql:string|null}>('SELECT sql FROM sqlite_master WHERE type=? AND name=?','trigger',expected.name);
   if(!existing){if(!install)fail();yield* run(expected.sql);}else if(existing.sql!==expected.sql)fail();
  }
  if(!lease.isCurrent())fail();
 }
 // Views with these exact names must not hide content or an alternate writable sink.
 const entries=yield* all<{name:string;type:string}>('SELECT name,type FROM sqlite_master WHERE type IN (?,?)','view','table');
 const names=new Set(controlContentIsolationTables());for(const entry of entries)if(names.has(entry.name)&&entry.type!=='table')fail();
 if(!lease.isCurrent())fail();
}
/** Only the trusted new-control producer may supply this lease; never enroll an existing profile. */
export async function isolateNewControlMemorySinks(input:{runner:StepRunner;lease:NewControlIsolationLease}){
 const {runner,lease}=input;if(!lease||lease.kind!=='new-app-owned-control'||!lease.profileId||!lease.storageId||typeof lease.isCurrent!=='function'||!lease.isCurrent()||runner.inTransaction?.()!==false)fail();
 await runner.tx(()=>isolateStep(lease,true),{immediate:true});
 return Object.freeze({profileId:lease.profileId,storageId:lease.storageId,isCurrent:lease.isCurrent,verify:()=>runner.tx(()=>isolateStep(lease,false),{immediate:true})});
}
