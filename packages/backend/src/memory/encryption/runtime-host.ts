import {isTrustedPreparedEncryptedForgetPlan,type PreparedEncryptedForgetPlan} from './forget-scrub-gateway.js';
import {moveEncryptedOwnerMemory} from './owner-move-gateway.js';
import {forgetEncryptedPersonGraph} from './person-graph-forget.js';
import {queueEncryptedOwnerTraceCorrection} from './owner-correction-gateway.js';
import {captureEncryptedPerson} from './person-owner.js';
import {readEncryptedOwnerTrust,setEncryptedOwnerVerified,readEncryptedCorrected,setEncryptedCorrectedChecked,type EncryptedQualityOwnerInput} from './encrypted-quality-owner.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {one} from '../../repositories/sql-steps.js';
import {readEncryptedOwnerTrace,readEncryptedOwnerMessageTrace,encryptedOwnerTraceMetrics} from './trace-owner-reader.js';
import {readAuthenticatedEncryptedAgentNotes} from './agent-notes-reader.js';
import {runProfilePresenceOperation,type ProfilePresenceServices} from './profile-presence-lifecycle.js';
import {registerProtectedMemoryRunner} from './memory-effect.js';
import {readAuthenticatedEncryptedQuestions,createAuthenticatedEncryptedQuestion,mutateAuthenticatedEncryptedQuestion,answerAuthenticatedEncryptedQuestion} from './questions-gateway.js';
import {validateEncryptedDocumentRuntimeCoverage} from './document-runtime-coverage.js';
import {auditedOwnerAuxiliary,type AuxiliaryRootLease} from './auxiliary-root-gateway.js';
import {captureEncryptedRunWriteAdmission,observeEncryptedRunContextSources} from './run-admission.js';
import {ensureAuxiliaryRecordSchemaStep} from './auxiliary-records.js';
import {mutateAuthenticatedLegacyGraph,type LegacyGraphAction,type LegacyGraphMutationInput} from './legacy-graph-mutation.js';
import {readEncryptedDocumentStatus} from './document-status.js';
import {recallLegacyGraph} from './legacy-graph-recall.js';
import {projectAuthenticatedLegacyGraph,type LegacyGraphRootLease} from './legacy-graph-gateway.js';
import type {LegacyGraphBundle} from './legacy-graph-bundle.js';
import {ensureLegacyGraphRecordSchemaStep} from './legacy-graph-records.js';
import {previewAuthenticatedDocumentImport,readAuthenticatedDocumentImport,decideAuthenticatedDocumentImport} from './document-admission.js';
import {ensureDocumentAdmissionSchemaStep} from './document-admission-schema.js';
import {encryptedDocumentScopes,recallEncryptedDocuments} from './document-reader.js';
import {configureEncryptedDocumentSource,indexAuthenticatedEncryptedDocumentFile} from './document-writer.js';
import {reviewAuthenticatedEncryptedGraph} from './graph-gateway.js';
import {recallReviewedEncryptedGraph} from './graph-projection.js';
import {projectAuthenticatedEncryptedRunMemories} from './run-list-reader.js';
import {readAuthenticatedEncryptedHistory} from './history-reader.js';
import {queueAuthenticatedEncryptedOwnerImport} from './import-gateway.js';
import {readAuthenticatedEncryptedContext} from './context-reader.js';
import {readAuthenticatedEncryptedPinnedFacts} from './pinned-reader.js';
import {saveAuthenticatedEncryptedRecallTrace,setAuthenticatedEncryptedTraceTiming} from './trace-gateway.js';
import {listAuthenticatedEncryptedRunMemories} from './run-list-reader.js';
import {readAuthenticatedEncryptedRunMemory} from './run-row-reader.js';
import {rotateAuthenticatedMemoryToQuarantine} from './rotation-host.js';
import {createSelectedMemoryEmbedding,type SelectedMemoryEmbeddingOptions} from './local-embedding.js';
import {assertNoUncoveredExternalProjectCopiesStep} from './forget-coverage.js';
import {queueAuthenticatedEncryptedConflict} from './conflict-proposal.js';
/** Explicit selected-profile composition; constructing it never selects a profile, enrolls custody or registers routes. */
import {createAuthenticatedMemoryRestoreHost} from './restore-host.js';
import {createAuthorityBoundMemoryOperationsHost} from './authority-operations-host.js';
import {createMemoryForgetAuthorityStore} from './forget-authority-store.js';
import {recallAuthenticatedMemoryFromDatabase} from './recall-gateway.js';
import {updateAuthenticatedEncryptedAuxiliary} from './declared-update.js';
import {captureEncryptedMutationGuard} from './run-mutation-guard.js';
import {saveAuthenticatedEncryptedHandoff,readAuthenticatedEncryptedHandoff} from './handoff-gateway.js';
import {addAuthenticatedEncryptedPinnedFact} from './pinned-gateway.js';
import {runAuthenticatedEncryptedWeeklySummary} from './weekly-summary-gateway.js';
import {MemoryCipherError} from './envelope.js';
import {decideAuthenticatedEncryptedAddition} from './addition-decision.js';
import {queueAuthenticatedEncryptedAddition} from './proposal-create.js';
import {createAuthenticatedEncryptedMemory} from './create-gateway.js';
import {readAuthenticatedEncryptedOwnerRow,listAuthenticatedEncryptedOwnerIds} from './read-gateway.js';
import {updateAuthenticatedIndexedMemoryContent} from './write-gateway.js';
import {moveAuthenticatedMemoryDrawer} from './move-gateway.js';
import {findAuthenticatedMemoryByTopic} from './topic-gateway.js';
import {readAuthenticatedEncryptedProposal,approveAuthenticatedEncryptedSupersession,rejectAuthenticatedEncryptedProposal} from './proposal-gateway.js';
type StepRunnerForRotation=Parameters<typeof rotateAuthenticatedMemoryToQuarantine>[0]['targetRunner'];
type RestoreInput=Parameters<typeof createAuthenticatedMemoryRestoreHost>[0];
type OperationsInput=Parameters<typeof createAuthorityBoundMemoryOperationsHost>[0];
export function createEncryptedMemoryRuntime(input:Omit<RestoreInput,'captureAuthority'>&Pick<OperationsInput,'lookupKey'|'profile'|'graphMutationJournal'>&{authority:ReturnType<typeof createMemoryForgetAuthorityStore>;profileId?:string;currentOperationId?:ProfilePresenceServices['currentOperationId'];captureProfilePresence?:ProfilePresenceServices['captureProfilePresence'];prepareProfilePresence?:ProfilePresenceServices['prepareProfilePresence'];embeddings?:SelectedMemoryEmbeddingOptions;provisionReplacement?:Parameters<typeof rotateAuthenticatedMemoryToQuarantine>[0]['provisionReplacement'];authorizeGraphReview?:LegacyGraphMutationInput['authorizeReview'];captureGraphRoot?:()=>Promise<LegacyGraphRootLease|null>;captureAuxiliaryRoot?:()=>Promise<AuxiliaryRootLease|null>;auxiliaryMutationJournal?:OperationsInput['auxiliaryMutationJournal'];refreshHostFoundations?:()=>Promise<void>;documentAuthorizer?:Parameters<typeof previewAuthenticatedDocumentImport>[0]['authorizeFile']}){
 const {runner,token,session,authority}=input;
 const principal=session.capture().scope,ownerId=principal.ownerId;if(input.profileId)registerProtectedMemoryRunner(runner,ownerId,input.profileId);
 const lookupKey=Buffer.from(input.lookupKey),embedding=input.embeddings?createSelectedMemoryEmbedding(input.embeddings,input.refreshHostFoundations):undefined;
 if(!authority||typeof authority.capture!=='function')throw new MemoryCipherError();
 const restore=createAuthenticatedMemoryRestoreHost({...input,captureAuthority:()=>authority.capture()});
 const operations=createAuthorityBoundMemoryOperationsHost({...input,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)});
 let state:'new'|'starting'|'ready'|'failed'|'locked'|'closing'|'closed'='new',active:Promise<unknown>|undefined;
 const boundary=(expected:'new'|'ready'='ready')=>{if(state!==expected||process.env.AGENT_PLAYER_READONLY==='1'||runner.inTransaction?.()!==false||!session.isUnlocked())throw new MemoryCipherError();};
 const presenceServices=():ProfilePresenceServices=>{if(!input.profileId||!input.currentOperationId||!input.captureProfilePresence||!input.prepareProfilePresence)throw new MemoryCipherError();return{runner,ownerId,memberId:principal.memberId,profileId:input.profileId,currentOperationId:input.currentOperationId,captureAuthority:()=>authority.capture(),captureProfilePresence:input.captureProfilePresence,prepareProfilePresence:input.prepareProfilePresence,isRuntimeCurrent:()=>state==='new'||state==='starting'||state==='ready'};};
 function perform<T>(fn:()=>Promise<T>,locksOnSuccess=false,readOnlyContent=false,expected:'new'|'ready'='ready'):Promise<T>{
  try{boundary(expected);if(active)throw new MemoryCipherError();const pending=(async()=>{try{const result=await runProfilePresenceOperation(presenceServices(),{readOnlyContent},fn);if(locksOnSuccess){if(state!==expected||runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1')throw new MemoryCipherError();session.lock();state='locked';}else boundary(expected);return result;}catch{session.lock();if(state!=='closing'&&state!=='closed')state='failed';throw new MemoryCipherError();}})();active=pending;void pending.finally(()=>{if(active===pending)active=undefined;}).catch(()=>undefined);return pending;}catch{return Promise.reject(new MemoryCipherError());}
 }
 const qualityServices=():EncryptedQualityOwnerInput=>{if(!input.captureAuxiliaryRoot)throw new MemoryCipherError();return{runner,token,session,ownerQualityKey:input.verificationKey,captureAuthority:()=>authority.capture(),captureAuxiliaryRoot:input.captureAuxiliaryRoot,recordRead:intent=>restore.recordRead(intent)};};
 const performRead=<T>(fn:()=>Promise<T>)=>perform(fn,false,true);

 return Object.freeze({
  ownerId,
  async start(){if(state!=='new'||active)throw new MemoryCipherError();state='starting';
   const pending=(async()=>{try{
    // Schemas are provisioned and witnessed before construction. Missing content
    // tables are an integrity failure; startup must never recreate their absence.
    if(authority.status()==='new')await authority.initialize();if(state!=='starting'||!session.isUnlocked())throw new MemoryCipherError();
    const result=await runProfilePresenceOperation(presenceServices(),{},async()=>{
     await runner.tx(()=>assertNoUncoveredExternalProjectCopiesStep(ownerId),{immediate:true});if(state!=='starting'||!session.isUnlocked())throw new MemoryCipherError();
     await restore.start();if(state!=='starting'||!session.isUnlocked())throw new MemoryCipherError();
     await validateEncryptedDocumentRuntimeCoverage({runner,token,session,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)});return operations.start();
    });if(state!=='starting'||!session.isUnlocked())throw new MemoryCipherError();state='ready';return result;
   }catch{if(!(['closing','closed'] as readonly string[]).includes(state))state='failed';session.lock();await operations.stop();await restore.close();authority.close();embedding?.close();lookupKey.fill(0);throw new MemoryCipherError();}})();active=pending;try{return await pending;}finally{if(active===pending)active=undefined;}
  },
  runPreparationOperation:<T>(operation:()=>Promise<T>,readOnlyContent=false)=>perform(operation,false,readOnlyContent,'new'),

  mutateForRun:(request:{run:Parameters<typeof captureEncryptedMutationGuard>[0]['run'];id:string;operation:'trash'|'restore'|'forget'},preparedPlan?:PreparedEncryptedForgetPlan)=>perform(async()=>{
   const run={...request.run,delegatedFrom:[...request.run.delegatedFrom],drawers:request.run.drawers.map(drawer=>({...drawer}))},id=request.id,operation=request.operation;
   if(!['trash','restore','forget'].includes(operation))throw new MemoryCipherError();
   const guard=await captureEncryptedMutationGuard({runner,token,session,run,id,fromHistory:operation==='restore'});
   if(operation==='forget'&&(!preparedPlan||!isTrustedPreparedEncryptedForgetPlan(preparedPlan)))throw new MemoryCipherError();
   return operation==='trash'?operations.deleteToTrash(id,guard):operation==='restore'?operations.restore(id,false,guard):operations.forget(id,guard,preparedPlan);
  }),
  deleteToTrash:(id:string)=>perform(()=>operations.deleteToTrash(id)),
  restoreTrash:(id:string,confirmDropTopic=false)=>perform(()=>operations.restore(id,confirmDropTopic)),
  previewForgetPlan:(id:string,run?:Parameters<typeof captureEncryptedMutationGuard>[0]['run'])=>performRead(async()=>{const guard=run?await captureEncryptedMutationGuard({runner,token,session,run,id}):undefined;return operations.previewForgetPlan(id,undefined,guard);}),
  previewPersonForgetPlan:(personKey:string,request:{confirm:string;mentionIds?:readonly string[]})=>performRead(async()=>{if(request.confirm!==personKey||!input.captureGraphRoot)throw new MemoryCipherError();const {plan}=await captureEncryptedPerson({runner,token,session,captureAuthority:()=>authority.capture(),captureGraphRoot:input.captureGraphRoot,recordRead:intent=>restore.recordRead(intent),personKey,confirm:request.confirm,mentionIds:request.mentionIds?[...request.mentionIds]:[]});return{personPlan:plan,forgetPlan:plan.memoryIds.length?await operations.previewForgetPlan(plan.memoryIds[0],plan):null};}),
  forget:(id:string,preparedPlan?:PreparedEncryptedForgetPlan)=>perform(()=>{if(!preparedPlan||!isTrustedPreparedEncryptedForgetPlan(preparedPlan))throw new MemoryCipherError();return operations.forget(id,undefined,preparedPlan);}),
  resumeCleanup:()=>perform(()=>operations.resumeCleanup()),
  rotateToEmptyTarget:(targetRunner:StepRunnerForRotation)=>perform(async()=>{
   if(typeof input.provisionReplacement!=='function')throw new MemoryCipherError();
   return rotateAuthenticatedMemoryToQuarantine({runner,targetRunner,token,session,authority,restoreHost:restore,verificationKey:input.verificationKey,authorizeEmptyTarget:input.authorizeEmptyTarget,provisionReplacement:input.provisionReplacement});
  },true),
  captureRestorePackage:()=>performRead(()=>restore.capturePackage()),
  restoreToEmptyTarget:(...args:Parameters<typeof restore.restore>)=>perform(()=>restore.restore(...args)),
  recallCodingApp:(request:Pick<Parameters<typeof recallAuthenticatedMemoryFromDatabase>[0],'run'|'query'|'limit'|'callerLease'>&{client:string})=>performRead(()=>recallAuthenticatedMemoryFromDatabase({...request,runner,token,session,reader:{kind:'coding-app',id:request.client},embedQuery:embedding?.query,recordRead:intent=>restore.recordRead(intent)})),
  recall:(request:Pick<Parameters<typeof recallAuthenticatedMemoryFromDatabase>[0],'run'|'query'|'limit'|'embedding'|'filter'>)=>{
   const captured={...request,run:{...request.run,delegatedFrom:[...request.run.delegatedFrom],drawers:request.run.drawers.map(drawer=>({...drawer}))},embedding:request.embedding?{...request.embedding,vector:[...request.embedding.vector]}:undefined};
   return performRead(()=>recallAuthenticatedMemoryFromDatabase({...captured,runner,token,session,embedQuery:embedding?.query,recordRead:intent=>restore.recordRead(intent)}));
  },
  projectOwnerAuxiliary<T>(projector:Parameters<typeof auditedOwnerAuxiliary<T>>[1]):Promise<T>{return performRead(async()=>{if(!input.captureAuxiliaryRoot)throw new MemoryCipherError();return auditedOwnerAuxiliary({runner,token,session,captureAuthority:()=>authority.capture(),captureAuxiliaryRoot:input.captureAuxiliaryRoot,recordRead:intent=>restore.recordRead(intent)},projector);});},
  ownerMove:(id:string,drawer:Parameters<typeof moveEncryptedOwnerMemory>[0]['drawer'],reason?:string|null)=>perform(()=>moveEncryptedOwnerMemory({runner,token,session,lookupKey,id,drawer:{...drawer},reason,recordRead:intent=>restore.recordRead(intent)})),
  ownerTraceCorrection:(request:Pick<Parameters<typeof queueEncryptedOwnerTraceCorrection>[0],'runId'|'memoryId'|'text'>)=>perform(()=>queueEncryptedOwnerTraceCorrection({...request,runner,token,session,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)})),
  ownerForgetPerson:(personKey:string,request:{confirm:string;mentionIds?:readonly string[]},preparedPlan?:PreparedEncryptedForgetPlan)=>perform(async()=>{if(request.confirm!==personKey||!input.captureGraphRoot)throw new MemoryCipherError();const {plan}=await captureEncryptedPerson({runner,token,session,captureAuthority:()=>authority.capture(),captureGraphRoot:input.captureGraphRoot,recordRead:intent=>restore.recordRead(intent),personKey,confirm:request.confirm,mentionIds:request.mentionIds?[...request.mentionIds]:[]});if(plan.memoryIds.length){if(!preparedPlan||!isTrustedPreparedEncryptedForgetPlan(preparedPlan))throw new MemoryCipherError();return{...await operations.forgetPerson(plan,undefined,preparedPlan),drawer:plan.drawerCount,mentions:plan.mentionCount,graph:plan.graphCount};}if(!plan.graphEntityIds.length)return{drawer:0,mentions:0,graph:0,graphForgetComplete:true as const};if(!input.captureAuxiliaryRoot||!input.captureDisclosureInventory||!input.graphMutationJournal||!input.auxiliaryMutationJournal)throw new MemoryCipherError();return forgetEncryptedPersonGraph({runner,token,session,plan,captureAuthority:()=>authority.capture(),captureGraphRoot:input.captureGraphRoot,captureAuxiliaryRoot:input.captureAuxiliaryRoot,captureDisclosureInventory:input.captureDisclosureInventory,graphMutationJournal:input.graphMutationJournal,auxiliaryMutationJournal:input.auxiliaryMutationJournal,appendGraphForget:change=>authority.appendRange(Array.from({length:Math.ceil(change.entityIds.length/500)},(_,index)=>({...change,entityIds:change.entityIds.slice(index*500,(index+1)*500)}))),recordRead:intent=>restore.recordRead(intent)});}),
  ownerPerson:(personKey:string,exporting=false)=>performRead(async()=>{if(!input.captureGraphRoot)throw new MemoryCipherError();return(await captureEncryptedPerson({runner,token,session,captureAuthority:()=>authority.capture(),captureGraphRoot:input.captureGraphRoot,recordRead:intent=>restore.recordRead(intent),personKey,exporting})).view;}),
  ownerMemoryUsage:(id:string,limit=10)=>performRead(async()=>{if(!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id)||!Number.isSafeInteger(limit)||limit<1||limit>50||!input.captureAuxiliaryRoot)throw new MemoryCipherError();const uses=await auditedOwnerAuxiliary({runner,token,session,captureAuthority:()=>authority.capture(),captureAuxiliaryRoot:input.captureAuxiliaryRoot,recordRead:intent=>restore.recordRead(intent)},bundle=>{if(bundle.v!==2)throw new MemoryCipherError();return bundle.rows.memory_recall_uses!.filter(row=>row.memory_id===id).map(row=>({...row})).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))||String(b.run_id).localeCompare(String(a.run_id)));});const recent=[];for(const use of uses.slice(0,limit)){const trace=await runner.read(one<{session_id:string|null}>('SELECT session_id FROM memory_recall_traces WHERE user_id=? AND run_id=?',ownerId,String(use.run_id)));recent.push({runId:String(use.run_id),sessionId:trace?.session_id??null,agentId:typeof use.agent_id==='string'?use.agent_id:null,at:String(use.created_at)});}return{usedIn:uses.length,lastUsedAt:uses.length?String(uses[0].created_at):null,recent};}),
  ownerTrust:(ids:readonly string[])=>performRead(()=>readEncryptedOwnerTrust({...qualityServices(),ids:[...ids]})),
  ownerVerify:(id:string,verified:boolean)=>perform(()=>setEncryptedOwnerVerified({...qualityServices(),id,verified})),
  ownerCorrected:(limit?:number)=>performRead(()=>readEncryptedCorrected({...qualityServices(),limit})),
  ownerCorrectedChecked:(id:string,checked:boolean)=>perform(()=>setEncryptedCorrectedChecked({...qualityServices(),id,checked})),
  ownerTrace:(runId:string)=>performRead(()=>readEncryptedOwnerTrace({runner,token,session,captureAuthority:()=>authority.capture(),runId,recordRead:intent=>restore.recordRead(intent)})),
  ownerMessageTrace:(messageId:string)=>performRead(()=>readEncryptedOwnerMessageTrace({runner,token,session,captureAuthority:()=>authority.capture(),messageId,recordRead:intent=>restore.recordRead(intent)})),
  ownerTraceMetrics:(limit?:number)=>performRead(()=>encryptedOwnerTraceMetrics({runner,token,session,captureAuthority:()=>authority.capture(),limit,recordRead:intent=>restore.recordRead(intent)})),
  documentFileRevision:(sourceId:string,fileId:string)=>performRead(async()=>{if(![sourceId,fileId].every(id=>/^[a-f0-9]{32}$/.test(id)))throw new MemoryCipherError();const lease=session.capture();return runner.tx(function*(){const owner=yield* authenticatedMemoryOwnerStep(token);if(owner.ownerId!==ownerId||!lease.isCurrent())throw new MemoryCipherError();const row=yield* one<{source_id:string;revision:number|string}>('SELECT source_id,revision FROM doc_index_files WHERE id=? AND owner_id=?',fileId,ownerId);if(row&&(row.source_id!==sourceId||!Number.isSafeInteger(Number(row.revision))||Number(row.revision)<0))throw new MemoryCipherError();if(!lease.isCurrent())throw new MemoryCipherError();return{sourceId,fileId,revision:row?Number(row.revision):0};},{immediate:true});}),
  documentStatus:()=>performRead(()=>readEncryptedDocumentStatus({runner,token,session,recordRead:intent=>restore.recordRead(intent)})),
  documentScopes:(request:{run:Parameters<typeof captureEncryptedMutationGuard>[0]['run']})=>{const run={...request.run,delegatedFrom:[...request.run.delegatedFrom],drawers:request.run.drawers.map(drawer=>({...drawer}))};return perform(()=>encryptedDocumentScopes({runner,token,session,run,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)}));},
  recallDocuments:(request:Pick<Parameters<typeof recallEncryptedDocuments>[0],'run'|'query'|'limit'|'scopes'>)=>{const run={...request.run,delegatedFrom:[...request.run.delegatedFrom],drawers:request.run.drawers.map(drawer=>({...drawer}))},query=request.query,limit=request.limit,scopes=request.scopes?JSON.parse(JSON.stringify(request.scopes)):undefined;return perform(()=>recallEncryptedDocuments({runner,token,session,run,query,limit,scopes,embedQuery:embedding?.query,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)}));},
  configureDocumentSource:(request:Pick<Parameters<typeof configureEncryptedDocumentSource>[0],'kind'|'refId'|'enabled'|'expectedRevision'>)=>{const captured={...request};return perform(()=>configureEncryptedDocumentSource({...captured,runner,token,session,recordRead:intent=>restore.recordRead(intent)}));},
  previewDocumentImport:(fileId:string)=>perform(async()=>{if(!input.documentAuthorizer)throw new MemoryCipherError();return previewAuthenticatedDocumentImport({runner,token,session,fileId,authorizeFile:input.documentAuthorizer,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)});}),
  readDocumentImport:(admissionId:string)=>performRead(async()=>{if(!input.documentAuthorizer)throw new MemoryCipherError();return readAuthenticatedDocumentImport({runner,token,session,admissionId,authorizeFile:input.documentAuthorizer,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)});}),
  decideDocumentImport:(request:Pick<Parameters<typeof decideAuthenticatedDocumentImport>[0],'admissionId'|'reviewHash'|'decision'|'confirmation'>)=>{const captured={...request};return perform(async()=>{if(!input.documentAuthorizer)throw new MemoryCipherError();return decideAuthenticatedDocumentImport({...captured,runner,token,session,authorizeFile:input.documentAuthorizer,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent),embedDocument:embedding?.document});});},
  mutateLegacyGraph(request:{run:Parameters<typeof captureEncryptedMutationGuard>[0]['run'];action:LegacyGraphAction}){const run={...request.run,delegatedFrom:[...request.run.delegatedFrom],drawers:request.run.drawers.map(drawer=>({...drawer}))},action=request.action.kind==='decide-link'?{...request.action}:{...request.action,entityIds:[...request.action.entityIds],memoryIds:[...request.action.memoryIds]};return perform(async()=>{if(!input.captureGraphRoot||!input.graphMutationJournal||!input.authorizeGraphReview)throw new MemoryCipherError();return mutateAuthenticatedLegacyGraph({runner,token,session,run,action,captureAuthority:()=>authority.capture(),captureGraphRoot:input.captureGraphRoot,graphMutationJournal:input.graphMutationJournal,authorizeReview:input.authorizeGraphReview,recordRead:intent=>restore.recordRead(intent)});});},
  projectLegacyGraph<T>(request:{run:Parameters<typeof captureEncryptedMutationGuard>[0]['run'];includeReviewStates?:boolean},project:(bundle:LegacyGraphBundle,memories:readonly Record<string,unknown>[])=>T):Promise<T>{const run={...request.run,delegatedFrom:[...request.run.delegatedFrom],drawers:request.run.drawers.map(drawer=>({...drawer}))};return performRead(()=>projectAuthenticatedLegacyGraph({runner,token,session,run,includeReviewStates:request.includeReviewStates,captureAuthority:()=>authority.capture(),captureGraphRoot:async()=>{if(!input.captureGraphRoot)throw new MemoryCipherError();return input.captureGraphRoot();},recordRead:intent=>restore.recordRead(intent)},project));},
  previewGraph:(id:string)=>performRead(()=>reviewAuthenticatedEncryptedGraph({runner,token,session,id,lookupKey,recordRead:intent=>restore.recordRead(intent)})),
  decideGraph:(id:string,reviewHash:string,action:'approve'|'reject')=>perform(()=>reviewAuthenticatedEncryptedGraph({runner,token,session,id,lookupKey,recordRead:intent=>restore.recordRead(intent)},{reviewHash,action})),
  recallGraph:(request:{run:Parameters<typeof listAuthenticatedEncryptedRunMemories>[0]['run'];query:string;limit?:number})=>{const run={...request.run,delegatedFrom:[...request.run.delegatedFrom],drawers:request.run.drawers.map(drawer=>({...drawer}))},query=request.query,limit=request.limit;return performRead(async()=>{const migrated=await projectAuthenticatedLegacyGraph({runner,token,session,run,captureAuthority:()=>authority.capture(),captureGraphRoot:async()=>{if(!input.captureGraphRoot)throw new MemoryCipherError();return input.captureGraphRoot();},recordRead:intent=>restore.recordRead(intent)},(bundle,rows)=>recallLegacyGraph(bundle,rows,query,limit));const reviewed=await projectAuthenticatedEncryptedRunMemories({runner,token,session,run,recordRead:intent=>restore.recordRead(intent)},rows=>recallReviewedEncryptedGraph(rows,lookupKey,query,limit));const hits=new Map<string,typeof migrated[number]>();for(const hit of [...migrated,...reviewed]){const previous=hits.get(hit.memory.id);if(!previous||previous.similarity<hit.similarity)hits.set(hit.memory.id,hit);}return[...hits.values()].sort((a,b)=>b.similarity-a.similarity||a.memory.id.localeCompare(b.memory.id)).slice(0,limit??10);});},
  readHistory:(request:Pick<Parameters<typeof readAuthenticatedEncryptedHistory>[0],'run'|'memoryId'>)=>performRead(()=>readAuthenticatedEncryptedHistory({...request,runner,token,session,recordRead:intent=>restore.recordRead(intent)})),
  queueOwnerImport:(request:Pick<Parameters<typeof queueAuthenticatedEncryptedOwnerImport>[0],'text'|'format'|'drawer'>)=>{const captured={text:request.text,format:request.format,drawer:{...request.drawer}};return perform(()=>queueAuthenticatedEncryptedOwnerImport({...captured,runner,token,session}));},
  queueHostFileImport:(request:Pick<Parameters<typeof queueAuthenticatedEncryptedOwnerImport>[0],'text'|'format'|'drawer'|'sourceLease'|'sourceDigest'>)=>{const captured={text:request.text,format:request.format,drawer:{...request.drawer},sourceLease:request.sourceLease,sourceDigest:request.sourceDigest};return perform(()=>{if(typeof captured.sourceLease!=='function'||!captured.sourceDigest)throw new MemoryCipherError();return queueAuthenticatedEncryptedOwnerImport({...captured,runner,token,session});});},
  readContext:(request:Pick<Parameters<typeof readAuthenticatedEncryptedContext>[0],'run'|'persona'|'handoffScope'|'allowPinned'|'reader'|'callerLease'>)=>performRead(()=>readAuthenticatedEncryptedContext({...request,runner,token,session,recordRead:intent=>restore.recordRead(intent)})),
  questionsForRun:(request:Pick<Parameters<typeof readAuthenticatedEncryptedQuestions>[0],'run'|'id'|'openOnly'>)=>performRead(()=>readAuthenticatedEncryptedQuestions({...request,runner,token,session,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)})),
  ownerQuestions:(request:Pick<Parameters<typeof readAuthenticatedEncryptedQuestions>[0],'id'|'openOnly'>)=>performRead(()=>readAuthenticatedEncryptedQuestions({...request,runner,token,session,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)})),
  questionMutationForRun:(request:Pick<Parameters<typeof mutateAuthenticatedEncryptedQuestion>[0],'run'|'id'|'operation'|'memoryId'>)=>perform(()=>mutateAuthenticatedEncryptedQuestion({...request,runner,token,session,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)})),
  ownerAnswerQuestion:(request:Pick<Parameters<typeof answerAuthenticatedEncryptedQuestion>[0],'id'|'text'|'drawer'>)=>perform(()=>answerAuthenticatedEncryptedQuestion({...request,runner,token,session,lookupKey,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)})),
  ownerQuestionMutation:(request:Pick<Parameters<typeof mutateAuthenticatedEncryptedQuestion>[0],'id'|'operation'|'memoryId'>)=>perform(()=>mutateAuthenticatedEncryptedQuestion({...request,runner,token,session,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)})),
  askQuestionForRun:(request:Pick<Parameters<typeof createAuthenticatedEncryptedQuestion>[0],'run'|'question'>)=>perform(()=>createAuthenticatedEncryptedQuestion({...request,runner,token,session,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)})),
  readAgentNotes:(request:Pick<Parameters<typeof readAuthenticatedEncryptedAgentNotes>[0],'run'|'agentId'>)=>performRead(()=>readAuthenticatedEncryptedAgentNotes({...request,runner,token,session,recordRead:intent=>restore.recordRead(intent)})),
  readPinnedFacts:(request:Pick<Parameters<typeof readAuthenticatedEncryptedPinnedFacts>[0],'run'|'reader'|'callerLease'|'allow'>)=>performRead(()=>readAuthenticatedEncryptedPinnedFacts({...request,runner,token,session,recordRead:intent=>restore.recordRead(intent)})),
  setRecallTraceTiming:(request:Pick<Parameters<typeof setAuthenticatedEncryptedTraceTiming>[0],'run'|'runId'|'ms'>)=>perform(()=>setAuthenticatedEncryptedTraceTiming({...request,runner,token,session,recordRead:intent=>restore.recordRead(intent)})),
  saveRecallTrace:(request:Pick<Parameters<typeof saveAuthenticatedEncryptedRecallTrace>[0],'run'|'trace'>)=>perform(()=>saveAuthenticatedEncryptedRecallTrace({...request,runner,token,session,captureAuthority:()=>authority.capture(),captureAuxiliaryRoot:async()=>{if(!input.captureAuxiliaryRoot)throw new MemoryCipherError();return input.captureAuxiliaryRoot();},auxiliaryMutationJournal:async(before,after)=>{if(!input.auxiliaryMutationJournal)throw new MemoryCipherError();return input.auxiliaryMutationJournal(before,after);},recordRead:intent=>restore.recordRead(intent)})),
  summarizeWeekly:()=>perform(()=>runAuthenticatedEncryptedWeeklySummary({runner,token,session,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)})),
  addPinnedFact:(request:Pick<Parameters<typeof addAuthenticatedEncryptedPinnedFact>[0],'scope'|'text'>)=>perform(()=>addAuthenticatedEncryptedPinnedFact({...request,runner,token,session})),
  updateOwnerAuxiliary:(request:Pick<Parameters<typeof updateAuthenticatedEncryptedAuxiliary>[0],'table'|'id'|'patch'>)=>perform(()=>updateAuthenticatedEncryptedAuxiliary({...request,runner,token,session,recordRead:intent=>restore.recordRead(intent)})),
  saveHandoffForRun:(request:Pick<Parameters<typeof saveAuthenticatedEncryptedHandoff>[0],'run'|'scope'|'body'>)=>perform(()=>saveAuthenticatedEncryptedHandoff({...request,runner,token,session,recordRead:intent=>restore.recordRead(intent)})),
  readHandoffForRun:(request:Pick<Parameters<typeof readAuthenticatedEncryptedHandoff>[0],'run'|'scope'>)=>performRead(()=>readAuthenticatedEncryptedHandoff({...request,runner,token,session,recordRead:intent=>restore.recordRead(intent)})),
  queueConflict:(request:Pick<Parameters<typeof queueAuthenticatedEncryptedConflict>[0],'run'|'drawer'|'memoryId'|'entry'|'reasons'>)=>perform(()=>{const producerAdmission=captureEncryptedRunWriteAdmission(ownerId,request.run.agentId);if(!producerAdmission)throw new MemoryCipherError();return queueAuthenticatedEncryptedConflict({...request,producerAdmission,runner,token,session,recordRead:intent=>restore.recordRead(intent)});}),
  queueAddition:(request:Pick<Parameters<typeof queueAuthenticatedEncryptedAddition>[0],'run'|'drawer'|'entry'|'reasons'>)=>perform(()=>{const producerAdmission=captureEncryptedRunWriteAdmission(ownerId,request.run.agentId);if(!producerAdmission)throw new MemoryCipherError();return queueAuthenticatedEncryptedAddition({...request,producerAdmission,runner,token,session});}),
  canAutomaticallyCreate:(agentId:string)=>captureEncryptedRunWriteAdmission(ownerId,agentId)!==null,
  createMemory:(request:Pick<Parameters<typeof createAuthenticatedEncryptedMemory>[0],'run'|'drawer'|'entry'|'topic'>)=>perform(async()=>{const producerAdmission=captureEncryptedRunWriteAdmission(ownerId,request.run.agentId);if(!producerAdmission)throw new MemoryCipherError();const documentCoverage=await validateEncryptedDocumentRuntimeCoverage({runner,token,session,captureAuthority:()=>authority.capture(),recordRead:intent=>restore.recordRead(intent)});return createAuthenticatedEncryptedMemory({...request,documentCoverage,producerAdmission,runner,token,session,lookupKey,embedDocument:embedding?.document});}),
  listOwnerIds:(request:Pick<Parameters<typeof listAuthenticatedEncryptedOwnerIds>[0],'table'|'after'|'limit'|'pendingOnly'>)=>performRead(()=>listAuthenticatedEncryptedOwnerIds({...request,runner,token,session})),
  listForRun:(request:Pick<Parameters<typeof listAuthenticatedEncryptedRunMemories>[0],'run'|'ids'>)=>performRead(()=>listAuthenticatedEncryptedRunMemories({...request,runner,token,session,recordRead:intent=>restore.recordRead(intent)})),
  readForRun:(request:Pick<Parameters<typeof readAuthenticatedEncryptedRunMemory>[0],'run'|'id'>)=>performRead(()=>readAuthenticatedEncryptedRunMemory({...request,runner,token,session,recordRead:intent=>restore.recordRead(intent)})),
  readOwnerRow:(table:Parameters<typeof readAuthenticatedEncryptedOwnerRow>[0]['table'],id:string)=>performRead(()=>readAuthenticatedEncryptedOwnerRow({runner,token,session,table,id,recordRead:intent=>restore.recordRead(intent)})),
  updateContent:(request:Pick<Parameters<typeof updateAuthenticatedIndexedMemoryContent>[0],'run'|'id'|'patch'>)=>perform(()=>{const producerAdmission=captureEncryptedRunWriteAdmission(ownerId,request.run.agentId);if(!producerAdmission)throw new MemoryCipherError();return updateAuthenticatedIndexedMemoryContent({...request,producerAdmission,runner,token,session,lookupKey,embedDocument:embedding?.document,recordRead:intent=>restore.recordRead(intent)});}),
  moveDrawer:(request:Pick<Parameters<typeof moveAuthenticatedMemoryDrawer>[0],'run'|'id'|'source'|'target'>)=>perform(()=>moveAuthenticatedMemoryDrawer({...request,runner,token,session,lookupKey,recordRead:intent=>restore.recordRead(intent)})),
  findByTopic:(request:Pick<Parameters<typeof findAuthenticatedMemoryByTopic>[0],'run'|'drawer'|'topic'>)=>performRead(()=>findAuthenticatedMemoryByTopic({...request,runner,token,session,lookupKey,recordRead:intent=>restore.recordRead(intent)})),
  decideProposal:(proposalId:string,reviewHash:string,decision:'approve'|'reject')=>perform(async()=>{
   const request={runner,token,session,captureAuthority:()=>authority.capture(),proposalId,reviewHash,recordRead:(intent:Parameters<typeof restore.recordRead>[0])=>restore.recordRead(intent)};
   if(decision==='reject')return rejectAuthenticatedEncryptedProposal(request);
   if(decision!=='approve')throw new MemoryCipherError();const proposal=await readAuthenticatedEncryptedProposal(request);if(!proposal)throw new MemoryCipherError();
   if(proposal.conflictWith){const result=await approveAuthenticatedEncryptedSupersession({...request,lookupKey});return{proposalId,memoryId:result.id,decision:'approve' as const};}
   return decideAuthenticatedEncryptedAddition({...request,decision,lookupKey});
  }),
  decideAddition:(proposalId:string,reviewHash:string,decision:'approve'|'reject')=>perform(()=>decideAuthenticatedEncryptedAddition({runner,token,session,captureAuthority:()=>authority.capture(),proposalId,reviewHash,decision,lookupKey,recordRead:intent=>restore.recordRead(intent)})),
  readProposal:(proposalId:string)=>performRead(()=>readAuthenticatedEncryptedProposal({runner,token,session,proposalId,recordRead:intent=>restore.recordRead(intent)})),
  approveSupersession:(proposalId:string,reviewHash:string)=>perform(()=>approveAuthenticatedEncryptedSupersession({runner,token,session,captureAuthority:()=>authority.capture(),proposalId,reviewHash,lookupKey,recordRead:intent=>restore.recordRead(intent)})),
  trackHistoricalCopies:()=>perform(()=>operations.trackHistoricalCopies()),
  captureInventory:(...args:Parameters<typeof operations.captureInventory>)=>perform(()=>operations.captureInventory(...args)),
  grantRoot:(...args:Parameters<typeof operations.grantRoot>)=>perform(()=>operations.grantRoot(...args)),
  revokeRoot:(...args:Parameters<typeof operations.revokeRoot>)=>perform(()=>operations.revokeRoot(...args)),
  async close(){if(state==='closed')return;state='closing';session.lock();try{await active;}catch{/* Durable journal/audit ambiguity is preserved; never retried here. */}
   try{await operations.stop();}finally{try{await restore.close();}finally{authority.close();embedding?.close();lookupKey.fill(0);state='closed';}}
  },
  status:()=>state,
 });
}
export function registerEncryptedMemoryRuntimeHooks(app:{addHook:(name:'onReady'|'onClose',hook:()=>Promise<void>)=>unknown},runtime:ReturnType<typeof createEncryptedMemoryRuntime>){
 app.addHook('onReady',async()=>{await runtime.start();});app.addHook('onClose',async()=>{await runtime.close();});
}
