'use strict';
/** Native scheduling consent never unlocks keys. Only the original still-unlocked local session can use a grant. */
const {randomBytes}=require('node:crypto');
const C=require('../../identity/src/memory-native-proof.cjs');
const {normalizeBackgroundScope}=require('./memory-native-background-store.cjs');
const fail=()=>{throw Error('memory_background_waiting_owner_unlock');};
const opaque=()=>randomBytes(32).toString('base64url');
function createMemoryNativeBackgroundDelegations({store,dialog,getWindow,captureOwnerContext,describeDefinition,describeClaim,captureUnlockedProfile}){
 if(!store||!dialog||typeof dialog.showMessageBox!=='function'||[getWindow,captureOwnerContext,describeDefinition,describeClaim,captureUnlockedProfile].some(value=>typeof value!=='function'))fail();
 const epochs=new Map(),claims=new Map(),consumed=new Set();let closed=false;
 function live(proof){return !closed&&proof&&typeof proof.isCurrent==='function'&&proof.isCurrent()===true;}
 async function owner(){const proof=await captureOwnerContext();if(!live(proof)||typeof proof.validateCurrent!=='function'||await proof.validateCurrent()!==true)fail();return proof;}
 async function approve({definitionHandle}){
  C.opaque(definitionHandle);const actor=await owner(),definition=await describeDefinition(definitionHandle);if(!live(actor)||!live(definition)||definition.ownerId!==actor.ownerId||definition.operationId!==actor.operationId)fail();
  const unlocked=await captureUnlockedProfile(definition.profileId);if(!live(unlocked)||unlocked.ownerId!==actor.ownerId||unlocked.profileId!==definition.profileId||typeof unlocked.unlockEpoch!=='string')fail();
  C.opaque(unlocked.unlockEpoch);const now=Date.now(),scope=normalizeBackgroundScope({...definition.scope,unlockEpoch:unlocked.unlockEpoch,keyPolicy:'current-unlocked-profile-only'});
  if(scope.ownerId!==actor.ownerId||scope.profileId!==unlocked.profileId||scope.expiresAt<=now||scope.expiresAt>now+7*86400000||scope.controlStorageId!==definition.controlStorageId)fail();
  if(typeof definition.label!=='string'||!definition.label||definition.label.length>200||typeof definition.promptPreview!=='string'||definition.promptPreview.length>12000)fail();
  const window=getWindow();if(!window||window.isDestroyed?.())fail();
  const response=await dialog.showMessageBox(window,{type:'question',title:'Allow background encrypted memory access',message:'Allow this exact task or schedule while this profile remains unlocked?',detail:`Task: ${definition.label}\nApproved prompt/template:\n${definition.promptPreview}\nOwner: ${scope.ownerId}\nProfile: ${scope.profileId}\nDefinition: ${C.canonical(scope.definition)}\nAgent: ${scope.agentId}\nProject: ${scope.project??'None'}\nAllowed actions: ${scope.actions.join(', ')}\nAllowed drawers: ${scope.drawers.join(', ')}\nMaximum uses: ${scope.useLimit}\nExpires: ${new Date(scope.expiresAt).toISOString()}\nDefinition and policy fingerprint: ${C.digest(scope)}\nLocking, switching profiles, closing, or restarting revokes key use. This does not allow automatic unlocking or access to another profile.`,buttons:['Allow bounded access','Cancel'],defaultId:1,cancelId:1,noLink:true,checkboxLabel:'I allow these background runs to use this currently unlocked encrypted profile within the displayed limits.',checkboxChecked:false});
  if(response?.response!==0||response.checkboxChecked!==true||window.isDestroyed?.()||await actor.validateCurrent()!==true||!live(actor)||!live(definition)||!live(unlocked))fail();
  const fresh=await describeDefinition(definitionHandle);if(!live(fresh)||C.canonical(fresh.scope)!==C.canonical(definition.scope)||fresh.ownerId!==actor.ownerId||fresh.operationId!==actor.operationId||fresh.label!==definition.label||fresh.promptPreview!==definition.promptPreview||!live(unlocked))fail();
  if([...epochs.values()].some(epoch=>live(epoch.unlocked)&&Date.now()<epoch.scope.expiresAt&&epoch.scope.profileId===scope.profileId&&C.canonical(epoch.scope.definition)===C.canonical(scope.definition)))fail();
  const id=opaque();await store.add(scope,id,actor);if(!live(unlocked)||!live(actor)||!live(definition))fail();
  epochs.set(id,{unlocked,scope});return Object.freeze({state:'approved',grantId:id,ownerId:scope.ownerId,profileId:scope.profileId,definition:scope.definition,expiresAt:scope.expiresAt,keyPolicy:scope.keyPolicy});
 }
 async function matchingParent({definitionHandle}){
  const definition=await describeDefinition(C.opaque(definitionHandle));if(!live(definition))fail();const state=await store.capture();if(!state.isCurrent())fail();
  const matches=state.record.grants.filter(item=>{const epoch=epochs.get(item.id);return !item.revoked&&item.used<item.scope.useLimit&&Date.now()<item.scope.expiresAt&&epoch&&live(epoch.unlocked)&&item.scope.unlockEpoch===definition.scope.unlockEpoch&&item.scope.keyPolicy===definition.scope.keyPolicy&&item.scope.modelPolicy===definition.scope.modelPolicy&&item.scope.ownerId===definition.ownerId&&item.scope.profileId===definition.profileId&&C.canonical(item.scope.definition)===C.canonical(definition.scope.definition)&&['agentId','project','taskHash','contractHash','scheduleHash','permissionsHash','modelPolicyHash','controlStorageId'].every(key=>item.scope[key]===definition.scope[key])&&C.canonical(item.scope.drawers)===C.canonical(definition.scope.drawers)&&C.canonical(item.scope.actions)===C.canonical(definition.scope.actions)&&C.canonical(item.scope.delegatedFrom)===C.canonical(definition.scope.delegatedFrom);});
  if(matches.length!==1||!live(definition)||!state.isCurrent())fail();return Object.freeze({grantId:matches[0].id,ownerId:matches[0].scope.ownerId,profileId:matches[0].scope.profileId,expiresAt:matches[0].scope.expiresAt});
 }
 async function claim({grantId,claimHandle}){
  C.opaque(grantId);C.opaque(claimHandle);const epoch=epochs.get(grantId);if(!epoch||!live(epoch.unlocked))fail();
  const actual=await describeClaim(claimHandle);if(!live(actual))fail();const scope=epoch.scope;
  const current=()=>live(actual)&&live(epoch.unlocked)&&Date.now()<Math.min(actual.expiresAt,scope.expiresAt);
  if(!current()||actual.unlockEpoch!==scope.unlockEpoch||actual.keyPolicy!==scope.keyPolicy||actual.modelPolicy!==scope.modelPolicy||actual.grantId!==grantId||actual.ownerId!==scope.ownerId||actual.profileId!==scope.profileId||actual.controlStorageId!==scope.controlStorageId||actual.agentId!==scope.agentId||actual.project!==scope.project||C.canonical(actual.definition)!==C.canonical(scope.definition)||!['taskHash','contractHash','scheduleHash','permissionsHash','modelPolicyHash'].every(key=>actual[key]===scope[key])||C.canonical(actual.drawers)!==C.canonical(scope.drawers)||C.canonical(actual.actions)!==C.canonical(scope.actions)||C.canonical(actual.delegatedFrom)!==C.canonical(scope.delegatedFrom))fail();
  for(const key of ['runId','taskId','workerId'])C.text(actual[key]);for(const key of ['inputDigest','contractDigest','policyDigest'])C.hash(actual[key]);
  if(scope.definition.kind==='task'&&actual.taskId!==scope.definition.taskId||!Number.isSafeInteger(actual.generation)||actual.generation<0||!Number.isSafeInteger(actual.expiresAt))fail();
  const fingerprint=C.digest({grantId,runId:actual.runId,taskId:actual.taskId,workerId:actual.workerId,generation:actual.generation,inputDigest:actual.inputDigest,contractDigest:actual.contractDigest,policyDigest:actual.policyDigest});if(consumed.has(fingerprint))fail();consumed.add(fingerprint);
  try{await store.consume(grantId,async record=>current()&&C.canonical(record.scope)===C.canonical(scope));if(!current())fail();}catch(error){throw error;}
  const nativeCurrent=()=>live(epoch.unlocked)&&epochs.get(grantId)===epoch&&Date.now()<scope.expiresAt;
  const id=opaque(),metadata=Object.freeze({grantId:id,ownerId:scope.ownerId,profileId:scope.profileId,controlStorageId:scope.controlStorageId,runId:actual.runId,agentId:scope.agentId,workerId:actual.workerId,generation:actual.generation,expiresAt:scope.expiresAt,inputDigest:actual.inputDigest,contractDigest:actual.contractDigest,policyDigest:actual.policyDigest,isCurrent:nativeCurrent});
  const proof=Object.freeze({kind:'memory-background-run-grant',id});claims.set(proof,metadata);return proof;
 }
 return Object.freeze({approve,matchingParent,claim,inspectGrant:proof=>{const value=claims.get(proof);return value?.isCurrent()?value:null;},close(){closed=true;epochs.clear();claims.clear();consumed.clear();}});
}
module.exports={createMemoryNativeBackgroundDelegations};
