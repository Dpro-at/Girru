/** Conservative invalidation of derived containers. Metadata holding external authority is never discarded. */
import {createHash} from 'node:crypto';
import {run,one,type Step,type SqlParam} from '../../repositories/sql-steps.js';
import {decryptMemoryRow,encryptMemoryRow,memoryRowSurfaceManifest,type MemoryRowScope} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import type {ForgetRows} from './forget-scrub-store.js';
import {MemoryCipherError} from './envelope.js';
export const FORGET_INVALIDATED_TABLES=['memory_versions','memory_file_proposals','memory_weekly_summaries','agent_handoffs','memory_bridge_handoffs','memory_pinned_facts','memory_recall_traces','memory_open_questions','memory_import_batches','memory_health_events','memory_retention_runs','memory_bridge_audit'] as const;
export type InvalidatedForgetRows=Pick<ForgetRows,typeof FORGET_INVALIDATED_TABLES[number]>;
export function prepareExtraMemoryForget(input:{rows:ForgetRows;scope:MemoryRowScope;key:Buffer;keyId:string;actorId:string;at:string;isCurrent:()=>boolean}):InvalidatedForgetRows{
 if(!input.isCurrent()||!Number.isFinite(Date.parse(input.at)))throw new MemoryCipherError();const result={} as InvalidatedForgetRows;
 const redaction=JSON.stringify({v:1,redacted:true,reason:'memory-forget',requiresOwnerNewContent:true});
 for(const table of FORGET_INVALIDATED_TABLES)result[table]=input.rows[table].map(cipher=>{
  const row=decryptMemoryRow(table,cipher,input.scope,input.key,input.keyId),next={...row};
  if(table==='memory_versions'){next.content=null;next.reason='History and Trash contents invalidated after permanent forget; explicit new content review required.';next.snapshot=null;}
  else if(table==='memory_file_proposals'){next.changes='[]';next.note='Invalidated after memory forget; new content needs owner review.';next.reasons=null;next.conflict_with=null;next.decision=null;if(row.status==='pending'){next.status='cancelled';next.decided_by=input.actorId;next.decided_at=input.at;}}
  else if(table==='memory_weekly_summaries'){next.digest=JSON.stringify({userId:input.scope.ownerId,periodStart:row.period_start,periodEnd:row.period_end,drawers:[],totals:{total:0,created:0,updated:0,deleted:0,forgotten:0,pending:0}});next.text='Invalidated after memory forget.';next.model_text=null;next.model=null;}
  else if(table==='agent_handoffs'||table==='memory_bridge_handoffs'){for(const field of ['done','remaining','next_steps','open_questions',...(table==='agent_handoffs'?['blockers','files_touched']:[])])next[field]='[]';}
  else if(table==='memory_pinned_facts'){next.text='[Removed after memory forget; owner review required]';next.updated_at=input.at;}
  else if(table==='memory_recall_traces'){next.items='[]';next.context='';next.pack_chars=0;}
  else if(table==='memory_open_questions'){next.question_hash=createHash('sha256').update(JSON.stringify(['forgotten-question',input.scope.ownerId,row.id,input.at])).digest('hex');next.question='[Removed after memory forget]';next.status='expired';next.resolved_memory_id=null;next.resolved_at=input.at;}
  else if(table==='memory_import_batches'){next.status='expired';next.options=redaction;next.committed_hash=null;next.operation_key=null;next.receipt=redaction;next.updated_at=input.at;next.expires_at=input.at;next.closed_at=input.at;}
  else if(table==='memory_health_events'){next.ref=null;next.detail=redaction;}
  else if(table==='memory_retention_runs')next.result=redaction;
  else if(table==='memory_bridge_audit')next.detail=redaction;
  if(!input.isCurrent())throw new MemoryCipherError();return encryptMemoryRow(table,next,input.scope,input.key,input.keyId);
 });
 // Registration config/backup paths are authority pointers, not a newly admitted source.
 // Retain their encrypted rows/status and all independent external holds until actual cleanup proves coverage.
 if(!input.isCurrent())throw new MemoryCipherError();return result;
}
/** Complete owner readset CAS is held by the caller, in the same transaction as tombstone insertion. */
export function* writeExtraMemoryForgetStep(ownerId:string,rows:InvalidatedForgetRows):Step<void>{
 for(const table of FORGET_INVALIDATED_TABLES){const surface=memoryRowSurfaceManifest().find(item=>item.table===table);if(!surface)throw new MemoryCipherError();
  const columns=[surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary],seen=new Set<string>();
  for(const row of rows[table]){if(!row||row[surface.owner]!==ownerId||typeof row[surface.id]!=='string'||!row[surface.id]||seen.has(String(row[surface.id]))||Object.keys(row).sort().join(',')!==[...columns].sort().join(','))throw new MemoryCipherError();seen.add(String(row[surface.id]));const fields=columns.filter(field=>field!==surface.id&&field!==surface.owner);const changed=yield* run(`UPDATE ${table} SET ${fields.map(field=>field+'=?').join(',')} WHERE ${surface.id}=? AND ${surface.owner}=?`,...fields.map(field=>row[field] as SqlParam),String(row[surface.id]),ownerId);if(changed.changes!==1)throw new MemoryCipherError();const stored=yield* one<Record<string,unknown>>(`SELECT * FROM ${table} WHERE ${surface.id}=? AND ${surface.owner}=?`,String(row[surface.id]),ownerId);if(!stored||canonicalEncryptedRow(stored)!==canonicalEncryptedRow(row))throw new MemoryCipherError();}
 }
}
