import {isTrustedOwnerNewContentAdmission,type OwnerNewContentAdmission} from './owner-content-admission.js';
/** ENC-01 existing-row adapter. No runtime wiring, schema changes or authorization bypass. */
import { createHash,createHmac,timingSafeEqual } from 'node:crypto';
import {isTrustedEncryptedRunWriteAdmission,type captureEncryptedRunWriteAdmission} from './run-admission.js';
import { sealMemoryText, openMemoryText, MemoryCipherError } from './envelope.js';
const surfaces = {
  memories: { owner: 'user_id', id: 'id', bound: ['type', 'memory_layer', 'status', 'importance_score', 'created_at', 'expiry_timestamp', 'consolidation_status', 'visibility', 'source_agent_id', 'is_team_critical', 'team_id', 'quality_score', 'completeness_score', 'clarity_score', 'usefulness_score', 'auto_enriched', 'enriched_at', 'needs_improvement', 'drawer_kind', 'drawer_key', 'embedding_model', 'embedding_dims', 'source', 'trust', 'valid_from', 'valid_to', 'superseded_by'], clear: ['last_accessed_at', 'access_count'], text: ['content', 'metadata', 'tags', 'embedding', 'context', 'outcomes', 'emotions', 'related_memory_ids', 'topic_key', 'source_ref'], binary: ['embedding_vec'] },
  memory_versions: { owner: 'user_id', id: 'id', bound: ['memory_id', 'drawer_kind', 'drawer_key', 'drawer_revision', 'version', 'change', 'type', 'importance_score', 'proposal_id', 'created_by', 'created_at'], clear: [], text: ['content', 'reason', 'snapshot'], binary: [] },
  memory_file_proposals: { owner: 'user_id', id: 'id', bound: ['agent_id', 'drawer_kind', 'drawer_key', 'base_hash', 'base_revision', 'status', 'source', 'created_by', 'created_at', 'decided_by', 'decided_at', 'applied_revision', 'import_batch_id'], clear: [], text: ['changes', 'note', 'reasons', 'conflict_with', 'decision'], binary: [] },
  memory_weekly_summaries: { owner: 'user_id', id: 'id', bound: ['period_start', 'period_end', 'model', 'created_by', 'created_at'], clear: [], text: ['digest', 'text', 'model_text'], binary: [] },
  agent_handoffs: { owner: 'owner_id', id: 'id', bound: ['agent_id', 'scope_kind', 'scope_id', 'project_id', 'version', 'source', 'run_id', 'client', 'created_at', 'card_id', 'task_no', 'conversation_id', 'from_agent_id'], clear: [], text: ['done', 'remaining', 'next_steps', 'open_questions', 'blockers', 'files_touched'], binary: [] },
  memory_bridge_handoffs: { owner: 'owner_id', id: 'id', bound: ['project_id', 'client', 'created_at', 'agent_id'], clear: [], text: ['done', 'remaining', 'next_steps', 'open_questions'], binary: [] },
  memory_pinned_facts: { owner: 'owner_id', id: 'id', bound: ['scope_kind', 'scope_id', 'position', 'created_by', 'created_at', 'updated_at'], clear: [], text: ['text'], binary: [] },
  memory_recall_traces: { owner: 'user_id', id: 'run_id', bound: ['session_id', 'agent_id', 'pack_hit', 'pack_chars', 'prompt_tokens', 'ttft_ms', 'created_at', 'uses_indexed'], clear: [], text: ['items', 'context'], binary: [] },
  doc_index_sources: { owner: 'owner_id', id: 'id', bound: ['kind', 'ref_id', 'enabled', 'state', 'revision', 'files', 'chunks', 'unreadable', 'limited', 'scanned_at', 'updated_at'], clear: [], text: ['note'], binary: [] },
  doc_index_files: { owner: 'owner_id', id: 'id', bound: ['source_id', 'file_hash', 'revision', 'bytes', 'mtime_ms', 'status', 'pages', 'chunks', 'indexed_at'], clear: [], text: ['root', 'rel_path', 'display_path', 'reason'], binary: [] },
  doc_index_chunks: { owner: 'owner_id', id: 'id', bound: ['file_id', 'source_id', 'scope_kind', 'scope_key', 'ordinal', 'page', 'file_hash', 'revision', 'embedding_model', 'created_at'], clear: [], text: ['heading', 'content', 'lex'], binary: ['embedding_vec'] },
  memory_encryption_document_admissions: { owner: 'owner_id', id: 'id', bound: ['source_id','file_id','file_hash','key_id','authority_id','epoch','forget_sequence','forget_mac','source_revision','file_revision','review_hash','state','created_by','created_at','decided_by','decided_at'], clear: [], text: ['plan'], binary: [] },
  memory_encryption_legacy_graph: { owner: 'owner_id', id: 'id', bound: ['bundle_id','ordinal','parts','sha256','format','created_at'], clear: [], text: ['payload'], binary: [] },
  memory_open_questions: { owner:'user_id',id:'id',bound:['agent_id','status','resolved_memory_id','asked_at','resolved_at'],clear:[],text:['question_hash','question'],binary:[] },
  memory_import_batches: { owner:'user_id',id:'id',bound:['source_kind','status','latest_version','committed_version','created_at','updated_at','expires_at','committed_at','closed_at'],clear:[],text:['options','committed_hash','operation_key','receipt'],binary:[] },
  memory_health_events: { owner:'owner_id',id:'id',bound:['kind','at'],clear:[],text:['ref','detail'],binary:[] },
  memory_retention_runs: { owner:'user_id',id:'id',bound:['dry_run','actor','created_at'],clear:[],text:['result'],binary:[] },
  memory_bridge_audit: { owner:'owner_id',id:'id',bound:['client','project_id','action','created_at'],clear:[],text:['detail'],binary:[] },
  memory_bridge_registrations: { owner:'owner_id',id:'id',bound:['client','existed','before_sha256','after_sha256','status','created_at','undone_at'],clear:[],text:['config_path','backup_path'],binary:[] },
  memory_encryption_auxiliary: { owner:'owner_id',id:'id',bound:['bundle_id','ordinal','parts','sha256','format','created_at'],clear:[],text:['payload'],binary:[] },
} as const;
export type MemoryRowTable = keyof typeof surfaces;
export interface MemoryRowScope { ownerId: string; memberId: string }
type Row = Record<string, unknown>;
type OriginAuthority={v:1;ownerId:string;memberId:string;authorityId:string;keyId:string;epoch:number;forgetSequence:number;forgetMac:string};
export type ProducerOrigin=(OriginAuthority&{kind:'admitted-run';agentId:string;runId:string;sourceDigest:string})|(OriginAuthority&{kind:'owner-new-content';actionId:string;action:OwnerNewContentAdmission['intent']['action'];inputDigest:string;contentDigest:string});
type Provenance={table:MemoryRowTable;ownerId:string;memberId:string;id:string;fields:Record<string,{hash:string;origin:ProducerOrigin}>};
// Enumerable private symbols survive trusted object-spread edits; they are not SQL columns.
const provenance=Symbol('authenticated-memory-producer');
function valueHash(value:unknown){return createHash('sha256').update(value===null?'null':Buffer.isBuffer(value)?'bytes:'+value.toString('base64'):'text:'+String(value)).digest('hex');}
function parseOrigin(value:unknown):ProducerOrigin{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new MemoryCipherError();const p=value as ProducerOrigin;
 if(p.v!==1||[p.ownerId,p.memberId,p.authorityId,p.keyId].some(v=>typeof v!=='string'||!v.length||Buffer.byteLength(v)>256)||!Number.isSafeInteger(p.epoch)||p.epoch<1||!Number.isSafeInteger(p.forgetSequence)||p.forgetSequence<0||typeof p.forgetMac!=='string'||!/^[a-f0-9]{64}$/.test(p.forgetMac))throw new MemoryCipherError();
 if(p.kind==='admitted-run'){if(Object.keys(p).sort().join(',')!=='agentId,authorityId,epoch,forgetMac,forgetSequence,keyId,kind,memberId,ownerId,runId,sourceDigest,v'||[p.agentId,p.runId].some(v=>typeof v!=='string'||!v.length||Buffer.byteLength(v)>256)||typeof p.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(p.sourceDigest))throw new MemoryCipherError();}
 else if(p.kind==='owner-new-content'){if(Object.keys(p).sort().join(',')!=='action,actionId,authorityId,contentDigest,epoch,forgetMac,forgetSequence,inputDigest,keyId,kind,memberId,ownerId,v'||typeof p.actionId!=='string'||!p.actionId||Buffer.byteLength(p.actionId)>256||!['answer-question','pin','text-import','file-import','correct-memory'].includes(p.action)||![p.inputDigest,p.contentDigest].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)))throw new MemoryCipherError();}
 else throw new MemoryCipherError();return Object.freeze({...p});
}
function attachOrigin(table:MemoryRowTable,row:Row,scope:MemoryRowScope,origin:ProducerOrigin,selectedFields?:readonly string[]):Row{
 const s=surface(table),allowed=new Set<string>([...s.text,...s.binary]),selected=selectedFields?[...selectedFields]:[...allowed];if(row[s.owner]!==scope.ownerId||typeof row[s.id]!=='string'||selected.some(field=>!allowed.has(field))||new Set(selected).size!==selected.length)throw new MemoryCipherError();const fields:Provenance['fields']={};for(const field of allowed){const prior=encryptedFieldProducer(table,row,field,scope);if(prior)fields[field]=Object.freeze({hash:valueHash(row[field]),origin:prior as ProducerOrigin});}for(const field of selected)fields[field]=Object.freeze({hash:valueHash(row[field]),origin});const output={...row};Object.defineProperty(output,provenance,{enumerable:true,value:Object.freeze({table,ownerId:scope.ownerId,memberId:scope.memberId,id:row[s.id],fields:Object.freeze(fields)})});return output;
}
/** Only a current native NEW CONTENT action may give owner-authored fields a fresh origin. */
export function attachOwnerNewContentProducer(table:MemoryRowTable,row:Row,scope:MemoryRowScope,admission:OwnerNewContentAdmission,selectedFields?:readonly string[]):Row{
 if(!isTrustedOwnerNewContentAdmission(admission)||admission.ownerId!==scope.ownerId||admission.memberId!==scope.memberId||!['memories','memory_pinned_facts','memory_file_proposals'].includes(table))throw new MemoryCipherError();const direct=table==='memories'?row.content:table==='memory_pinned_facts'?row.text:undefined;if(direct!==undefined&&(typeof direct!=='string'||createHash('sha256').update(direct).digest('hex')!==admission.intent.contentDigest))throw new MemoryCipherError();const a=admission.anchor;return attachOrigin(table,row,scope,parseOrigin({v:1,kind:'owner-new-content',ownerId:scope.ownerId,memberId:scope.memberId,authorityId:a.authorityId,keyId:a.keyId,epoch:a.epoch,forgetSequence:a.forgetSequence,forgetMac:a.forgetMac,actionId:admission.actionId,action:admission.intent.action,inputDigest:admission.intent.inputDigest,contentDigest:admission.intent.contentDigest}),selectedFields);
}
/** A request cannot mint provenance: only a live, registry-issued pre-model admission is accepted. */
export function attachEncryptedRunProducer(table:MemoryRowTable,row:Row,scope:MemoryRowScope,admission:NonNullable<ReturnType<typeof captureEncryptedRunWriteAdmission>>,selectedFields?:readonly string[]):Row{
 const s=surface(table);if(!isTrustedEncryptedRunWriteAdmission(admission)||row[s.owner]!==scope.ownerId||admission.ownerId!==scope.ownerId||admission.memberId!==scope.memberId||typeof row[s.id]!=='string')throw new MemoryCipherError();
 const a=admission.anchor,origin=parseOrigin({v:1,kind:'admitted-run',ownerId:scope.ownerId,memberId:scope.memberId,agentId:admission.agentId,runId:admission.runId,authorityId:a.authorityId,keyId:a.keyId,epoch:a.epoch,forgetSequence:a.forgetSequence,forgetMac:a.forgetMac,sourceDigest:createHash('sha256').update(JSON.stringify(admission.sources)).digest('hex')});
 return attachOrigin(table,row,scope,origin,selectedFields);
}
/** Unknown v1 fields return null; copying is never a new content admission. */
export function encryptedFieldProducer(table:MemoryRowTable,row:Row,field:string,scope:MemoryRowScope):Readonly<ProducerOrigin>|null{
 const p=(row as Row&{[provenance]?:Provenance})[provenance],s=surface(table);if(!p||p.table!==table||p.ownerId!==scope.ownerId||p.memberId!==scope.memberId||p.id!==row[s.id])return null;const item=p.fields[field];return item&&item.hash===valueHash(row[field])?item.origin:null;
}
function surface(table: MemoryRowTable) {
  if (!Object.hasOwn(surfaces, table)) throw new MemoryCipherError();
  return surfaces[table];
}
/** Static coverage candidates, not proof all memory surfaces/SQL predicates are integrated. */
export function memoryRowSurfaceManifest():Array<{table:MemoryRowTable;owner:'user_id'|'owner_id';id:'id'|'run_id';bound:string[];clear:string[];text:string[];binary:string[]}> {
  return (Object.keys(surfaces) as MemoryRowTable[]).map(table => {const s=surfaces[table];return { table, owner: s.owner, id: s.id, bound: [...s.bound], clear: [...s.clear], text: [...s.text], binary: [...s.binary] };});
}
function convert(table: MemoryRowTable, row: Row, scope: MemoryRowScope, key: Buffer, keyId: string, encrypting: boolean, selectedFields?:ReadonlySet<string>): Row {
  const s = surface(table);
  if (!row || typeof row !== 'object' || Array.isArray(row) || row[s.owner] !== scope.ownerId || typeof row[s.id] !== 'string') throw new MemoryCipherError();
  const allowed = new Set<string>([s.owner, s.id, ...s.bound, ...s.clear, ...s.text, ...s.binary]);
  if (Object.keys(row).some(field => !allowed.has(field))) throw new MemoryCipherError();
  for (const field of s.clear) if (Object.hasOwn(row, field) && row[field] !== null && !(typeof row[field] === 'number' && Number.isFinite(row[field]))) throw new MemoryCipherError();
  const bound = s.bound.map(field => {
    if (!Object.hasOwn(row, field)) throw new MemoryCipherError();
    let value = row[field];
    if (['is_team_critical','auto_enriched','needs_improvement','pack_hit','uses_indexed'].includes(field) && (value === 0 || value === 1)) value = Boolean(value);
    if (value !== null && !(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 4096)
      && !(typeof value === 'number' && Number.isFinite(value))
      && !(['is_team_critical','auto_enriched','needs_improvement','pack_hit','uses_indexed'].includes(field) && typeof value === 'boolean')) throw new MemoryCipherError();
    return [field, value];
  });
  const scopeHash = createHash('sha256').update(JSON.stringify(bound)).digest('base64url');
  const output = { ...row };
  const decoded:Provenance={table,ownerId:scope.ownerId,memberId:scope.memberId,id:row[s.id] as string,fields:{}};
  for (const [fields, binary] of [[s.text, false], [s.binary, true]] as const) for (const field of fields) {
    if (!Object.hasOwn(row, field)) throw new MemoryCipherError();
    if(!encrypting&&selectedFields&&!selectedFields.has(field))continue;
    const context = { ownerId: scope.ownerId, memberId: scope.memberId, recordId: row[s.id] as string, field: `${table}.${field}:${scopeHash}` };
    if (encrypting) {
      const value = row[field];
      if (value !== null && (binary ? !Buffer.isBuffer(value) : typeof value !== 'string')) throw new MemoryCipherError();
      const original = value === null ? { kind: 'null' } : { kind: binary ? 'bytes' : 'text', value: binary ? (value as Buffer).toString('base64') : value };
      const producer=encryptedFieldProducer(table,row,field,scope);
      const tagged=producer?{tagVersion:2,...original,producer}:original;
      const raw = sealMemoryText(JSON.stringify(tagged), key, keyId, context);
      output[field] = binary ? Buffer.from(raw, 'utf8') : raw;
    } else {
      const value = row[field];
      if (binary ? !Buffer.isBuffer(value) : typeof value !== 'string') throw new MemoryCipherError();
      let tagged = JSON.parse(openMemoryText(binary ? (value as Buffer).toString('utf8') : value as string, key, keyId, context));
      if (!tagged || typeof tagged !== 'object' || Array.isArray(tagged)) throw new MemoryCipherError();
      let producer:ProducerOrigin|undefined;if(Object.hasOwn(tagged,'tagVersion')){if(tagged.tagVersion!==2||Object.keys(tagged).sort().join(',')!==(tagged.kind==='null'?'kind,producer,tagVersion':'kind,producer,tagVersion,value'))throw new MemoryCipherError();producer=parseOrigin(tagged.producer);if(producer.ownerId!==scope.ownerId||producer.memberId!==scope.memberId)throw new MemoryCipherError();const{tagVersion:_,producer:__,...base}=tagged;tagged=base;}
      if (tagged.kind === 'null' && Object.keys(tagged).length === 1) output[field] = null;
      else if (Object.keys(tagged).sort().join(',') === 'kind,value' && tagged.kind === (binary ? 'bytes' : 'text') && typeof tagged.value === 'string') {
        if (binary) {
          const bytes = Buffer.from(tagged.value, 'base64');
          if (bytes.toString('base64') !== tagged.value) throw new MemoryCipherError();
          output[field] = bytes;
        } else output[field] = tagged.value;
      } else throw new MemoryCipherError();
      if(producer)decoded.fields[field]=Object.freeze({hash:valueHash(output[field]),origin:producer});
    }
  }
  if(!encrypting&&Object.keys(decoded.fields).length)Object.defineProperty(output,provenance,{enumerable:true,value:Object.freeze({...decoded,fields:Object.freeze(decoded.fields)})});
  return output;
}
/** Caller checks permissions and selects the correct member key before invoking the codec. */
export function encryptMemoryRow(table: MemoryRowTable, row: Row, scope: MemoryRowScope, key: Buffer, keyId: string): Row {
  return convert(table, row, scope, key, keyId, true);
}
/** Whole-row contract: missing fields, NULL replacements and legacy plaintext fail closed. */
export function decryptMemoryRow(table: MemoryRowTable, row: Row, scope: MemoryRowScope, key: Buffer, keyId: string): Row {
  try { return convert(table, row, scope, key, keyId, false); } catch { throw new MemoryCipherError(); }
}

/** Header-first consumers can authorize scope without opening unrelated content fields. */
export function decryptMemoryRowField(table:MemoryRowTable,row:Row,field:string,scope:MemoryRowScope,key:Buffer,keyId:string):{value:unknown;producer:Readonly<ProducerOrigin>|null}{
 try{const s=surface(table);if(!new Set<string>([...s.text,...s.binary]).has(field))throw new MemoryCipherError();const partial=convert(table,row,scope,key,keyId,false,new Set([field]));return{value:partial[field],producer:encryptedFieldProducer(table,partial,field,scope)};}catch{throw new MemoryCipherError();}
}

/** Exact content-only historical carry. No new origin is issued and old baselines cannot borrow a current approval. */
export function carryEncryptedMemoryContentProducer(sourceTable:'memories'|'memory_versions',source:Row,targetTable:'memories'|'memory_versions',target:Row,scope:MemoryRowScope):Row{
 if(source.user_id!==scope.ownerId||target.user_id!==scope.ownerId||typeof source.content!=='string'||target.content!==source.content||source.type!==target.type||!(sourceTable==='memories'&&targetTable==='memory_versions'&&target.memory_id===source.id||sourceTable==='memory_versions'&&targetTable==='memories'&&source.memory_id===target.id))throw new MemoryCipherError();const origin=encryptedFieldProducer(sourceTable,source,'content',scope);return origin?attachOrigin(targetTable,target,scope,origin as ProducerOrigin,['content']):{...target};
}

/** Preserve an authenticated proposal entry's producer; approval is not a new content admission. */
export function carryEncryptedProposalContentProducer(proposal:Row,target:Row,scope:MemoryRowScope):Row{
 if(proposal.user_id!==scope.ownerId||target.user_id!==scope.ownerId||typeof proposal.changes!=='string'||typeof target.content!=='string')throw new MemoryCipherError();
 const changes=JSON.parse(proposal.changes);if(!Array.isArray(changes)||changes.length<1||changes.length>200||!changes.some(change=>change&&['add','update'].includes(change.op)&&change.after?.content===target.content&&change.after?.type===target.type))throw new MemoryCipherError();
 const origin=encryptedFieldProducer('memory_file_proposals',proposal,'changes',scope);if(!origin)return{...target};
 return attachOrigin('memories',target,scope,origin as ProducerOrigin,['content']);
}


/** Data-key-authenticated field provenance for a versioned encrypted Trash payload. */
export function certifyEncryptedTrashProducers(row:Row,scope:MemoryRowScope,key:Buffer){
 if(!Buffer.isBuffer(key)||key.length!==32||row.user_id!==scope.ownerId)throw new MemoryCipherError();const s=surface('memories'),fields:Record<string,{hash:string;origin:Readonly<ProducerOrigin>}>=Object.create(null);for(const field of [...s.text,...s.binary]){const origin=encryptedFieldProducer('memories',row,field,scope);if(origin)fields[field]={hash:valueHash(row[field]),origin};}const body=JSON.stringify(['girru-trash-producers',1,scope.ownerId,scope.memberId,row.id,Object.keys(row).sort().map(field=>[field,valueHash(row[field])]),fields]);return{fields,mac:createHmac('sha256',key).update(body).digest('hex')};
}
export function restoreCertifiedEncryptedTrashProducers(row:Row,scope:MemoryRowScope,key:Buffer,certificate:unknown):Row{
 if(!certificate||typeof certificate!=='object'||Array.isArray(certificate)||Object.keys(certificate).sort().join(',')!=='fields,mac'||!Buffer.isBuffer(key)||key.length!==32||row.user_id!==scope.ownerId)throw new MemoryCipherError();const proof=certificate as {fields:Record<string,{hash:string;origin:unknown}>;mac:string};if(!proof.fields||typeof proof.fields!=='object'||Array.isArray(proof.fields)||typeof proof.mac!=='string'||!/^[a-f0-9]{64}$/.test(proof.mac))throw new MemoryCipherError();const body=JSON.stringify(['girru-trash-producers',1,scope.ownerId,scope.memberId,row.id,Object.keys(row).sort().map(field=>[field,valueHash(row[field])]),proof.fields]),expected=createHmac('sha256',key).update(body).digest();if(!timingSafeEqual(expected,Buffer.from(proof.mac,'hex')))throw new MemoryCipherError();const s=surface('memories'),allowed=new Set<string>([...s.text,...s.binary]);let result={...row};for(const [field,item]of Object.entries(proof.fields)){if(!allowed.has(field)||!item||Object.keys(item).sort().join(',')!=='hash,origin'||item.hash!==valueHash(row[field]))throw new MemoryCipherError();const origin=parseOrigin(item.origin);if(origin.ownerId!==scope.ownerId||origin.memberId!==scope.memberId)throw new MemoryCipherError();result=attachOrigin('memories',result,scope,origin,[field]);}return result;
}
