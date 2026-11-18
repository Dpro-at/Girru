import {memoryControlQuery} from './control-runner.js';
/** Conservative metadata-only gate until external project-file manifests are integrated. */
import {one,run,dialect,tableExists,type Step} from '../../repositories/sql-steps.js';
import {MemoryCipherError} from './envelope.js';
function* assertNoUncoveredControlCopiesStep(ownerId:string):Step<void>{
 const driver=yield* dialect();
 for(const table of ['chat_projects','memory_bridge_folders','memory_project_design'])if(yield* tableExists(table)){
  if(driver==='postgres')yield* run(`LOCK TABLE ${table} IN SHARE MODE`);
  const row=table==='chat_projects'
   ?yield* one<{n:number|string}>("SELECT count(*) n FROM chat_projects WHERE user_id=? AND folder IS NOT NULL AND trim(folder)<>''",ownerId)
   :table==='memory_project_design'
   ?yield* one<{n:number|string}>("SELECT count(*) n FROM memory_project_design WHERE owner_id=? AND (trim(found)<>'{}' OR previous IS NOT NULL OR file_written_at IS NOT NULL)",ownerId)
   :yield* one<{n:number|string}>('SELECT count(*) n FROM memory_bridge_folders WHERE owner_id=? AND (files_enabled<>0 OR written_at IS NOT NULL OR brief_hash IS NOT NULL)',ownerId);
  if(!row||!Number.isSafeInteger(Number(row.n))||Number(row.n)!==0)throw new MemoryCipherError();
 }
 if(yield* tableExists('projection_state')){
  if(!(yield* tableExists('change_scopes')))throw new MemoryCipherError();
  if(driver==='postgres'){
   yield* run('LOCK TABLE change_scopes IN SHARE MODE');
   yield* run('LOCK TABLE projection_state IN SHARE MODE');
  }
  // Scope ownership survives project deletion; do not depend on a live chat row.
  const row=yield* one<{n:number|string}>(`SELECT count(*) n FROM projection_state p
   JOIN change_scopes s ON s.scope=p.scope WHERE s.owner_id=?
   AND (p.target IS NOT NULL OR p.content_hash IS NOT NULL OR p.pending_hash IS NOT NULL)`,ownerId);
  if(!row||!Number.isSafeInteger(Number(row.n))||Number(row.n)!==0)throw new MemoryCipherError();
 }

 if(yield* tableExists('agent_rules')){const copies=yield* one<{n:number|string}>("SELECT count(*) n FROM agent_rules WHERE source='agent' AND reason LIKE '%lesson:%'");if(!copies||Number(copies.n)!==0)throw new MemoryCipherError();}
}

export function* assertNoUncoveredExternalProjectCopiesStep(ownerId:string):Step<void>{
 yield* memoryControlQuery(()=>assertNoUncoveredControlCopiesStep(ownerId));const driver=yield* dialect();
 // Removing current folder metadata must not hide previously captured external-copy evidence.
 if(yield* tableExists('memory_encryption_external_plan_checkpoints')){
  if(driver==='postgres')yield* run('LOCK TABLE memory_encryption_external_plan_checkpoints IN SHARE MODE');
  const row=yield* one<{n:number|string}>('SELECT count(*) n FROM memory_encryption_external_plan_checkpoints WHERE owner_id=?',ownerId);
  if(!row||!Number.isSafeInteger(Number(row.n))||Number(row.n)!==0)throw new MemoryCipherError();
 }

}

/** Full gate: document rows must actually be absent, including after a forget transaction's reset. */
export function* assertNoUncoveredProjectCopiesStep(ownerId:string):Step<void>{
 yield* assertNoUncoveredExternalProjectCopiesStep(ownerId);const driver=yield* dialect();
 // Document text can independently reproduce a forgotten memory. Until the protected
 // document scrub/suppression authority is complete, never report destructive coverage.
 for(const table of ['doc_index_files','doc_index_chunks'])if(yield* tableExists(table)){
  if(driver==='postgres')yield* run(`LOCK TABLE ${table} IN SHARE MODE`);
  const row=yield* one<{n:number|string}>(`SELECT count(*) n FROM ${table} WHERE owner_id=?`,ownerId);
  if(!row||!Number.isSafeInteger(Number(row.n))||Number(row.n)!==0)throw new MemoryCipherError();
 }
}
