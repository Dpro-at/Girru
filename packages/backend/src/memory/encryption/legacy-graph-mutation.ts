import {captureVerifiedProfilePresenceScope,refreshVerifiedProfilePresenceScope} from './profile-presence-lifecycle.js';
import {historicalGraphReferenceParentsStep,captureLogicalMemoryParentsMetadataStep,assertLogicalMemoryParentMetadataStep} from './logical-memory-parents.js';
import {isProtectedMemoryRunner} from './memory-effect.js';
import {beforeEncryptedMemoryEffect,memoryEffectDigest} from './memory-effect.js';
/** Owner-approved graph decisions with protected pending-root custody and atomic ciphertext replacement. */
import {createHash} from "node:crypto";
import {selectedGraphClusters} from "../graph/clusters.js";
import type {GraphForgetMutationJournal,PreparedGraphForgetMutation} from "./forget-scrub-gateway.js";
import {all,one,run as sqlRun,dialect,tableColumns,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import {normalizeDrawer,defaultDrawerForType} from '../drawers.js';
import {captureAuthenticatedMemoryRun,authenticatedMemoryRunStep,authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedMemoryCandidates} from './candidate-loader.js';
import {memoryRowSurfaceManifest,decryptMemoryRow} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {loadLegacyGraphRecordsStep,openLegacyGraphRecords,prepareLegacyGraphRecords,replaceLegacyGraphRecordsStep,LEGACY_GRAPH_RECORD_TABLE} from './legacy-graph-records.js';
import {projectLegacyGraphBundle,type LegacyGraphBundle,type LegacyGraphMemory} from './legacy-graph-bundle.js';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor} from './restore-package.js';
import type {MemoryRestoreAuthorityLease} from './restore-guard.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';

type Row=Record<string,unknown>;
import type {LegacyGraphReadInput,LegacyGraphRootAnchor} from './legacy-graph-gateway.js';
export type LegacyGraphAction={kind:'decide-link';linkId:string;decision:'approve'|'reject'}|{kind:'dismiss-cluster';clusterId:string;drawer:string;entityIds:readonly string[];memoryIds:readonly string[]};
export type LegacyGraphReviewLease={ownerId:string;actorId:string;actionDigest:string;rootGeneration:number;isCurrent:()=>boolean};
export type LegacyGraphMutationInput=LegacyGraphReadInput&{action:LegacyGraphAction;graphMutationJournal:GraphForgetMutationJournal;authorizeReview:(intent:{ownerId:string;agentId:string;actionDigest:string;root:LegacyGraphRootAnchor})=>Promise<LegacyGraphReviewLease|null>};
function captureAction(value:LegacyGraphAction):LegacyGraphAction{
 if(!value||Object.getPrototypeOf(value)!==Object.prototype)throw new MemoryCipherError();
 if(Object.values(Object.getOwnPropertyDescriptors(value)).some(field=>!('value' in field)||!field.enumerable))throw new MemoryCipherError();
 const keys=Object.keys(value).sort().join(',');
 if(value.kind==='decide-link'){if(keys!=='decision,kind,linkId'||!identifier(value.linkId)||!['approve','reject'].includes(value.decision))throw new MemoryCipherError();return{kind:value.kind,linkId:value.linkId,decision:value.decision};}
 if(value.kind!=='dismiss-cluster'||keys!=='clusterId,drawer,entityIds,kind,memoryIds'||!/^[a-f0-9]{32}$/.test(value.clusterId)||typeof value.drawer!=='string'||value.drawer.length>512)throw new MemoryCipherError();
 const ids=(items:readonly string[])=>{if(!Array.isArray(items)||!items.length||items.length>5000||items.some(id=>!identifier(id))||new Set(items).size!==items.length)throw new MemoryCipherError();return[...items].sort();};
 const result={kind:value.kind,clusterId:value.clusterId,drawer:value.drawer,entityIds:ids(value.entityIds),memoryIds:ids(value.memoryIds)} as const;
 if(createHash('sha256').update(JSON.stringify([result.drawer,result.entityIds])).digest('hex').slice(0,32)!==result.clusterId)throw new MemoryCipherError();return result;
}
export function legacyGraphMutationActionDigest(action:LegacyGraphAction):string{return createHash('sha256').update(JSON.stringify(captureAction(action))).digest('hex');}
const IDENTITY_FIELDS=['id','user_id','type','status','drawer_kind','drawer_key','source_agent_id','expiry_timestamp','valid_from','valid_to','superseded_by'] as const;
const MAX_ROWS=5000,MAX_IDENTITY_BYTES=8*1024*1024,MAX_PLAINTEXT_BYTES=8*1024*1024;
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
const canonicalSet=(rows:readonly Row[])=>JSON.stringify(rows.map(canonicalEncryptedRow));
function graphAuthority(anchor:LegacyGraphRootAnchor){return captureMemoryRestoreAnchor({v:1,ownerId:anchor.ownerId,memberId:anchor.memberId,authorityId:anchor.authorityId,keyId:anchor.keyId,epoch:anchor.epoch,forgetSequence:anchor.forgetSequence,forgetMac:anchor.forgetMac});}
function graphRootAnchor(value:LegacyGraphRootAnchor):LegacyGraphRootAnchor{
 if(!value||Object.keys(value).sort().join(',')!=='authorityId,bundleId,epoch,forgetMac,forgetSequence,generation,keyId,memberId,ownerId,parts,sha256,v'||value.v!==1)throw new MemoryCipherError();
 const head=graphAuthority(value);
 if(!Number.isSafeInteger(value.parts)||value.parts<0||value.parts>11||!Number.isSafeInteger(value.generation)||value.generation<1)throw new MemoryCipherError();
 if(value.parts===0?(value.bundleId!==null||value.sha256!==null):(typeof value.bundleId!=='string'||!/^[a-f0-9]{64}$/.test(value.bundleId)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)))throw new MemoryCipherError();
 return{...head,bundleId:value.bundleId,sha256:value.sha256,parts:value.parts,generation:value.generation};
}
function graphRowsMatchRoot(rows:readonly Row[],root:LegacyGraphRootAnchor){
 if(rows.length!==root.parts||rows.some((row,index)=>row.owner_id!==root.ownerId||row.bundle_id!==root.bundleId||row.sha256!==root.sha256||row.parts!==root.parts||row.ordinal!==index))throw new MemoryCipherError();
}

/** Complete owner identity set, not a content read. All statuses are retained for graph-reference validation. */
function* ownerMemoryIdentitiesStep(ownerId:string):Step<Row[]>{
 const driver=yield* dialect();if(driver==='postgres')yield* sqlRun('LOCK TABLE memories IN SHARE MODE');
 const surface=memoryRowSurfaceManifest().find(item=>item.table==='memories');if(!surface)throw new MemoryCipherError();
 const expected=[surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary];
 const columns=driver==='sqlite'?(yield* all<{name:string}>('SELECT name FROM pragma_table_xinfo(?)','memories')).map(row=>row.name):yield* tableColumns('memories');
 if([...columns].sort().join('\0')!==[...expected].sort().join('\0'))throw new MemoryCipherError();
 const lengths=IDENTITY_FIELDS.map(field=>driver==='sqlite'?`COALESCE(length(CAST(${field} AS BLOB)),0)`:`COALESCE(octet_length(CAST(${field} AS TEXT)),0)`);
 const size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) n,SUM(${lengths.join('+')}) b FROM memories WHERE user_id=?`,ownerId);
 const count=Number(size?.n),bytes=Number(size?.b??0);
 if(!Number.isSafeInteger(count)||count<0||count>MAX_ROWS||!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX_IDENTITY_BYTES)throw new MemoryCipherError();
 const rows=yield* all<Row>(`SELECT ${IDENTITY_FIELDS.join(',')} FROM memories WHERE user_id=? ORDER BY id LIMIT ${MAX_ROWS+1}`,ownerId);
 if(rows.length!==count||new Set(rows.map(row=>row.id)).size!==rows.length||rows.some(row=>!identifier(row.id)||row.user_id!==ownerId))throw new MemoryCipherError();
 return rows;
}
function minimalMemory(row:Readonly<Row>,content:string):LegacyGraphMemory{
 if(!identifier(row.id)||!identifier(row.user_id)||typeof content!=='string')throw new MemoryCipherError();
 const result:LegacyGraphMemory={id:row.id,user_id:row.user_id,content};
 for(const field of ['status','drawer_kind','drawer_key'] as const){
  const value=row[field];if(value!==undefined){if(value!==null&&typeof value!=='string')throw new MemoryCipherError();result[field]=value;}
 }
 return result;
}
function validityTime(value:unknown):number{
 if(typeof value!=='string'||!value||value.length>256)return NaN;
 // Legacy SQLite timestamps are UTC text even though they do not include a zone suffix.
 const text=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)?value.replace(' ','T')+'Z':value;
 return Date.parse(text);
}
function selectedMemory(row:Readonly<Row>,authorize:(row:Readonly<Row>)=>boolean):boolean{
 if(!authorize(row))return false;
 if(row.expiry_timestamp!==null&&row.expiry_timestamp!==undefined){const expiry=Number(row.expiry_timestamp);if(!Number.isFinite(expiry)||expiry<=Date.now())return false;}
 if(row.valid_from!==null&&row.valid_from!==undefined){const starts=validityTime(row.valid_from);if(!Number.isFinite(starts)||starts>Date.now())return false;}
 if(row.valid_to!==null&&row.valid_to!==undefined){const ends=validityTime(row.valid_to);if(!Number.isFinite(ends)||ends<=Date.now())return false;}
 return row.superseded_by===null||row.superseded_by===undefined;
}
function emptyBundle(ownerId:string):LegacyGraphBundle{
 return{v:1,ownerId,rows:{memory_graph_entities:[],memory_graph_links:[],memory_graph_link_sources:[],memory_graph_mentions:[],memory_graph_state:[],memory_graph_cluster_dismissals:[]}};
}

/** Projectors are trusted synchronous host code; computation precedes the final read-set/authority transaction. */
export async function mutateAuthenticatedLegacyGraph(input:LegacyGraphMutationInput):Promise<{id:string;status:'active'|'rejected'}|{id:string;dismissed:true}>{
 const {runner,token,session,recordRead,captureAuthority,captureGraphRoot}=input;let key:Buffer|undefined;const plaintextBuffers:Buffer[]=[];
 try{
  if(typeof input.authorizeReview!=='function'||typeof input.graphMutationJournal!=='function'||typeof recordRead!=='function'||typeof captureAuthority!=='function'||typeof captureGraphRoot!=='function'||input.includeReviewStates!==undefined&&typeof input.includeReviewStates!=='boolean')throw new MemoryCipherError();
  const action=captureAction(input.action),actionDigest=createHash('sha256').update(JSON.stringify(action)).digest('hex'),includeReviewStates=true,run={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(drawer=>({...drawer}))};
  const boundary=()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();};boundary();
  const lease=session.capture(),auth=await captureAuthenticatedMemoryRun(runner,token,run);boundary();
  if(run.audience!=='owner'||auth.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const owner=await runner.read(authenticatedMemoryOwnerStep(token));boundary();if(owner.ownerId!==auth.ownerId||owner.sessionId!==auth.revision.sessionId)throw new MemoryCipherError();
  const supplied=await captureAuthority();boundary();if(!supplied||typeof supplied.isCurrent!=='function'||supplied.isCurrent()!==true)throw new MemoryCipherError();
  const authority={anchor:captureMemoryRestoreAnchor(supplied.anchor),isCurrent:supplied.isCurrent.bind(supplied)};
  if(authority.anchor.ownerId!==auth.ownerId||authority.anchor.memberId!==lease.scope.memberId)throw new MemoryCipherError();
  const suppliedRoot=await captureGraphRoot();boundary();if(!suppliedRoot||typeof suppliedRoot.isCurrent!=='function'||suppliedRoot.isCurrent()!==true)throw new MemoryCipherError();
  const graphRoot={anchor:graphRootAnchor(suppliedRoot.anchor),isCurrent:suppliedRoot.isCurrent.bind(suppliedRoot)};
  if(!sameMemoryRestoreAnchor(authority.anchor,graphAuthority(graphRoot.anchor)))throw new MemoryCipherError();
  let pending:PreparedGraphForgetMutation|undefined,review:LegacyGraphReviewLease|undefined;
  let dataValidUntil=Infinity;
  const current=()=>process.env.AGENT_PLAYER_READONLY!=='1'&&lease.isCurrent()&&authority.isCurrent()===true&&(pending?pending.isCurrent()===true:graphRoot.isCurrent()===true)&&(!review||review.isCurrent()===true)&&Date.now()<Math.min(auth.revision.validUntil,dataValidUntil);
  const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock);
  const check=async()=>{
   boundary();if(!current()||await validate()!==true||!current())throw new MemoryCipherError();
   const fresh=await captureAuthority();boundary();
   if(!fresh||typeof fresh.isCurrent!=='function'||fresh.isCurrent()!==true||!sameMemoryRestoreAnchor(authority.anchor,captureMemoryRestoreAnchor(fresh.anchor))||!current())throw new MemoryCipherError();
   if(pending){if(!pending.isCurrent()||!current())throw new MemoryCipherError();return;}
   const freshRoot=await captureGraphRoot();boundary();
   if(!freshRoot||typeof freshRoot.isCurrent!=='function'||freshRoot.isCurrent()!==true||JSON.stringify(graphRootAnchor(freshRoot.anchor))!==JSON.stringify(graphRoot.anchor)||!current())throw new MemoryCipherError();
  };await check();
  if(isProtectedMemoryRunner(runner))await refreshVerifiedProfilePresenceScope(runner,auth.ownerId);const presenceScope=captureVerifiedProfilePresenceScope(runner,auth.ownerId);if(isProtectedMemoryRunner(runner)&&!presenceScope)throw new MemoryCipherError();
  const captured=await runner.tx(function*(){const identities=yield* ownerMemoryIdentitiesStep(auth.ownerId),references=presenceScope?yield* historicalGraphReferenceParentsStep(presenceScope):identities.map(row=>({id:String(row.id),user_id:auth.ownerId})),parentMetadata=presenceScope?yield* captureLogicalMemoryParentsMetadataStep(auth.ownerId):null;return{identities,references,parentMetadata,graph:yield* loadLegacyGraphRecordsStep(auth.ownerId)};},{immediate:true});await check();
  const structuralMemories:LegacyGraphMemory[]=captured.references.map(row=>{const live=captured.identities.find(identity=>identity.id===row.id);return live?minimalMemory(live,''):{id:row.id,user_id:row.user_id,content:'',status:'trashed'};});
  graphRowsMatchRoot(captured.graph,graphRoot.anchor);
  const expectedIdentities=canonicalSet(captured.identities),expectedGraph=canonicalSet(captured.graph);
  const identities=new Map(captured.identities.map(row=>[String(row.id),row])),candidates=await loadEncryptedMemoryCandidates(runner,auth.ownerId);await check();
  const selected=candidates.filter(row=>selectedMemory(row,auth.access.authorize));
  for(const row of selected){if(row.expiry_timestamp!==null&&row.expiry_timestamp!==undefined)dataValidUntil=Math.min(dataValidUntil,Number(row.expiry_timestamp));if(row.valid_to!==null&&row.valid_to!==undefined)dataValidUntil=Math.min(dataValidUntil,validityTime(row.valid_to));}
  for(const row of selected){const identity=identities.get(String(row.id));if(!identity||canonicalEncryptedRow(Object.fromEntries(IDENTITY_FIELDS.map(field=>[field,row[field]])))!==canonicalEncryptedRow(identity))throw new MemoryCipherError();}
  const expectedMemories=new Map(selected.map(row=>[String(row.id),canonicalEncryptedRow(row)]));
  for(const [table,rows] of [[LEGACY_GRAPH_RECORD_TABLE,captured.graph],['memories',selected]] as const){
   for(let offset=0;offset<rows.length;offset+=500){await check();
    if(await recordRead({readerKind:'agent',readerId:run.agentId,purpose:includeReviewStates?'view':'recall',records:rows.slice(offset,offset+500).map(row=>({table,id:String(row.id)}))})!==true)throw new MemoryCipherError();await check();
   }
  }
  const authorized:Row[]=[];let scoped=emptyBundle(auth.ownerId),full:LegacyGraphBundle|null=null;
  if(selected.length){
   const material=await lease.resolveKey({user_id:auth.ownerId});key=material.key;
   if(!Buffer.isBuffer(key)||key.length!==32||material.id!==authority.anchor.keyId||material.scope.ownerId!==lease.scope.ownerId||material.scope.memberId!==lease.scope.memberId)throw new MemoryCipherError();await check();
   let bytes=0;
   for(const [index,row] of selected.entries()){
    if(!current())throw new MemoryCipherError();if(index%64===0)await check();
    const plain=decryptMemoryRow('memories',row,lease.scope,key,material.id);
    for(const value of Object.values(plain))if(Buffer.isBuffer(value))plaintextBuffers.push(value);
    if(!selectedMemory(plain,auth.access.authorize)||plain.id!==row.id||typeof plain.content!=='string')throw new MemoryCipherError();
    bytes+=Object.values(plain).reduce<number>((sum,value)=>sum+(typeof value==='string'?Buffer.byteLength(value,'utf8'):Buffer.isBuffer(value)?value.length:16),0);
    if(bytes>MAX_PLAINTEXT_BYTES)throw new MemoryCipherError();authorized.push(plain);
   }
   const stored=openLegacyGraphRecords(captured.graph,structuralMemories,lease.scope,key,material.id);await check();
   full=stored;
   const visible=authorized.map(row=>{const memory=minimalMemory(row,String(row.content)),drawer=row.drawer_kind==null?defaultDrawerForType(typeof row.type==='string'?row.type:undefined):normalizeDrawer({kind:row.drawer_kind,key:row.drawer_key??''});return{...memory,drawer_kind:drawer.kind,drawer_key:drawer.key??''};});
   scoped=projectLegacyGraphBundle(stored??emptyBundle(auth.ownerId),visible,{includeReviewStates});
  }
  if(!full||!key)throw new MemoryCipherError();
  const granted=await input.authorizeReview({ownerId:auth.ownerId,agentId:run.agentId,actionDigest,root:{...graphRoot.anchor}});await check();
  if(!granted||granted.ownerId!==auth.ownerId||granted.actorId!==auth.ownerId||granted.actionDigest!==actionDigest||granted.rootGeneration!==graphRoot.anchor.generation||typeof granted.isCurrent!=='function'||!granted.isCurrent())throw new MemoryCipherError();
  review={ownerId:granted.ownerId,actorId:granted.actorId,actionDigest,rootGeneration:granted.rootGeneration,isCurrent:granted.isCurrent.bind(granted)};
  let targetIds:string[],result:{id:string;status:'active'|'rejected'}|{id:string;dismissed:true};
  const at=new Date().toISOString();
  if(action.kind==='decide-link'){
   const visible=scoped.rows.memory_graph_links.find(link=>link.id===action.linkId&&link.status==='pending');
   const target=full.rows.memory_graph_links.find(link=>link.id===action.linkId&&link.status==='pending');if(!visible||!target)throw new MemoryCipherError();
   targetIds=scoped.rows.memory_graph_link_sources.filter(source=>source.link_id===target.id).map(source=>String(source.memory_id));
   // Entity fields also aggregate incident decisions and mentions; every supporting memory needs write permission.
   const endpoints=new Set([target.src_id,target.dst_id]),incident=new Set(full.rows.memory_graph_links.filter(link=>endpoints.has(link.src_id)||endpoints.has(link.dst_id)).map(link=>link.id));
   targetIds=[...new Set([...targetIds,...full.rows.memory_graph_mentions.filter(row=>endpoints.has(row.entity_id)).map(row=>String(row.memory_id)),...full.rows.memory_graph_link_sources.filter(row=>incident.has(row.link_id)).map(row=>String(row.memory_id))])];
   const status=action.decision==='approve'?'active':'rejected';target.status=status;target.decided_by=review.actorId;target.decided_at=at;result={id:action.linkId,status};
  }else{
   const cluster=selectedGraphClusters(scoped,authorized,{includeDismissed:true,limit:1000}).find(value=>value.id===action.clusterId);
   if(!cluster||cluster.drawer!==action.drawer||JSON.stringify(cluster.entities.map(entity=>entity.id).sort())!==JSON.stringify(action.entityIds)||JSON.stringify([...cluster.memoryIds].sort())!==JSON.stringify(action.memoryIds))throw new MemoryCipherError();
   const entities=new Set(action.entityIds),incident=new Set(full.rows.memory_graph_links.filter(link=>entities.has(String(link.src_id))||entities.has(String(link.dst_id))).map(link=>link.id));
   targetIds=[...new Set([...action.memoryIds,...full.rows.memory_graph_mentions.filter(row=>entities.has(String(row.entity_id))).map(row=>String(row.memory_id)),...full.rows.memory_graph_link_sources.filter(row=>incident.has(row.link_id)).map(row=>String(row.memory_id))])];
   if(!full.rows.memory_graph_cluster_dismissals.some(row=>row.cluster_id===action.clusterId))full.rows.memory_graph_cluster_dismissals.push({user_id:auth.ownerId,cluster_id:action.clusterId,drawer_id:action.drawer,dismissed_by:review.actorId,created_at:at});
   result={id:action.clusterId,dismissed:true};
  }
  const targetRows=targetIds.map(id=>authorized.find(row=>row.id===id));
  if(!targetIds.length||targetRows.some(row=>!row||!selectedMemory(row,auth.access.authorizeWrite)))throw new MemoryCipherError();
  const after=prepareLegacyGraphRecords(full,structuralMemories,lease.scope,key,authority.anchor.keyId,at);
  await check();
  const freeze=(rows:readonly Row[])=>Object.freeze(rows.map(row=>Object.freeze({...row})));
  await beforeEncryptedMemoryEffect({runner,action:'mutate-legacy-graph',auth,isCurrent:()=>current()&&!!review?.isCurrent(),targetDigest:memoryEffectDigest([actionDigest,captured.graph,after])});
  const prepared=await input.graphMutationJournal(freeze(captured.graph),freeze(after));
  if(!prepared||typeof prepared.isCurrent!=='function'||typeof prepared.commit!=='function')throw new MemoryCipherError();
  // Preparing the native journal intentionally invalidates the old root lease.
  pending={isCurrent:prepared.isCurrent.bind(prepared),commit:prepared.commit.bind(prepared)};
  await check();
  await runner.tx(function*(){
   const fresh=yield* authenticatedMemoryRunStep(token,run),freshOwner=yield* authenticatedMemoryOwnerStep(token);
   if(freshOwner.ownerId!==owner.ownerId||freshOwner.sessionId!==owner.sessionId||freshOwner.tokenVersion!==owner.tokenVersion)throw new MemoryCipherError();
   for(const row of targetRows)if(!row||!selectedMemory(row,fresh.access.authorizeWrite))throw new MemoryCipherError();
   if(JSON.stringify(fresh.revision)!==JSON.stringify(auth.revision)||!current())throw new MemoryCipherError();
   if(captured.parentMetadata)yield* assertLogicalMemoryParentMetadataStep(captured.parentMetadata);
   const finalIdentities=yield* ownerMemoryIdentitiesStep(auth.ownerId),finalGraph=yield* loadLegacyGraphRecordsStep(auth.ownerId);graphRowsMatchRoot(finalGraph,graphRoot.anchor);
   if(canonicalSet(finalIdentities)!==expectedIdentities||canonicalSet(finalGraph)!==expectedGraph)throw new MemoryCipherError();
   const ids=[...expectedMemories.keys()].sort();
   for(let offset=0;offset<ids.length;offset+=500){const batch=ids.slice(offset,offset+500),rows=yield* all<Row>(`SELECT * FROM memories WHERE user_id=? AND id IN (${batch.map(()=>'?').join(',')}) ORDER BY id`,auth.ownerId,...batch);
    if(rows.length!==batch.length||rows.some(row=>!selectedMemory(row,fresh.access.authorize)||canonicalEncryptedRow(row)!==expectedMemories.get(String(row.id))))throw new MemoryCipherError();
   }
   if(!current())throw new MemoryCipherError();
   yield* replaceLegacyGraphRecordsStep(auth.ownerId,captured.graph,after);
   if(!current())throw new MemoryCipherError();
  },{immediate:true});await check();
  if(!pending||await pending.commit()!==true)throw new MemoryCipherError();
  // The pending lease may retire on successful commit; never retry or undo an uncertain commit.
  boundary();if(!lease.isCurrent()||!authority.isCurrent()||!review.isCurrent()||await validate()!==true)throw new MemoryCipherError();
  const finalAuthority=await captureAuthority();boundary();if(!finalAuthority||!finalAuthority.isCurrent()||!sameMemoryRestoreAnchor(authority.anchor,captureMemoryRestoreAnchor(finalAuthority.anchor)))throw new MemoryCipherError();
  return result;
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);for(const buffer of plaintextBuffers)buffer.fill(0);}
}
