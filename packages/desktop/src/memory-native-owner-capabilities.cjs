'use strict';
/** Native owner confirmations produce short, exact, one-use capabilities. Read proof handles are never accepted. */
const {randomBytes}=require('node:crypto'),{AsyncLocalStorage}=require('node:async_hooks');
const C=require('../../identity/src/memory-native-proof.cjs');
const KINDS=Object.freeze(['prepare-profile','activate-profile','resume-profile','forget-memory','forget-person','move-memory','restore-memory','rotate-memory','approve-proposal','quality-update','owner-new-content','question-create','question-update','question-resolve','question-delete','enroll-trust','enroll-graph','advance-authority','advance-audit','graph-decision','graph-persist','auxiliary-persist','read-master','read-jwt']);
const error=()=>Error('memory_owner_confirmation_unavailable');
const copy=value=>JSON.parse(JSON.stringify(value));
function createMemoryNativeOwnerCapabilities({dialog,getWindow,captureOwnerContext,captureProfile,captureAuthority}){
 if(!dialog||typeof dialog.showMessageBox!=='function'||[getWindow,captureOwnerContext,captureProfile,captureAuthority].some(value=>typeof value!=='function'))C.unsupported();
 const grants=new Map(),context=new AsyncLocalStorage();let closed=false;
 const alive=()=>{if(closed)throw error();};
 function intent(value){C.exact(value,['kind','profileId','operationId','challengeId','prior','next']);if(!KINDS.includes(value.kind))throw error();C.text(value.profileId);C.text(value.operationId,128);C.opaque(value.challengeId);const wire=JSON.stringify(value);if(Buffer.byteLength(wire)>2*1024*1024)throw error();return copy(value);}
 async function snapshot(request){
  alive();const owner=await captureOwnerContext();alive();if(!owner||typeof owner.isCurrent!=='function'||typeof owner.validateCurrent!=='function'||await owner.validateCurrent()!==true||!owner.isCurrent()||typeof owner.ownerId!=='string'||typeof owner.sessionId!=='string'||typeof owner.operationId!=='string'||owner.operationId!==request.operationId)throw error();
  const profile=await captureProfile(request.profileId);alive();if(!profile||profile.profileId!==request.profileId||profile.ownerId!==owner.ownerId||typeof profile.isCurrent!=='function'||!profile.isCurrent())throw error();
  const head=await captureAuthority(request.profileId);alive();if(!head||typeof head.isCurrent!=='function'||!head.isCurrent())throw error();
  const authority=head.anchor===null?null:C.value('restore',head.anchor);
  // Only a newly allocated, explicitly approved target may have no authority yet.
  if(authority===null&&profile.kind!=='new-native-owned-target')throw error();if(authority&&authority.ownerId!==owner.ownerId)throw error();
  return{ownerId:owner.ownerId,sessionId:owner.sessionId,authority,profile,owner,head};
 }
 async function request(raw,display){
  const requested=intent(raw),before=await snapshot(requested),window=getWindow();if(!window||window.isDestroyed?.())throw error();
  if(display!==undefined){C.exact(display,['verb','targetIds','derivedContainerReset']);if(typeof display.verb!=='string'||display.verb.length>128||!Array.isArray(display.targetIds)||display.targetIds.length>5000||typeof display.derivedContainerReset!=='boolean')throw error();}
  const permanent=['forget-memory','forget-person'].includes(requested.kind),warning=permanent?'\nPERMANENT CONTENT LOSS: ALL historical version and Trash content/payload will become unavailable. IDs and bound metadata are retained. Derived container files will also be reset. There is no automatic restore or re-import.':'';
  const move=requested.kind==='move-memory'?`\nMove from: ${C.canonical(requested.next.move?.from)}\nMove to: ${C.canonical(requested.next.move?.to)}`:'';
  const detail=`Operation: ${display?.verb??requested.kind}${requested.kind==='owner-new-content'?' (NEW CONTENT)':''}\nProfile: ${requested.profileId}\nOwner: ${before.ownerId}\nTransition: ${C.digest({prior:requested.prior,next:requested.next})}${warning}${move}\nTargets: ${(display?.targetIds??[]).join(', ')}\nThis permission applies once to this exact local operation.`;
  const answer=await dialog.showMessageBox(window,{type:'question',buttons:['Allow once','Cancel'],defaultId:1,cancelId:1,noLink:true,title:'Approve encrypted memory operation',message:permanent?'Permanently forget the approved targets and all archived content?':'Allow this operation for the selected profile?',detail,...(permanent?{checkboxLabel:'I understand ALL historical version and Trash content/payload will become unavailable and derived containers will be reset.',checkboxChecked:false}:{})});
  alive();if(await before.owner.validateCurrent()!==true)throw error();if(answer?.response!==0||permanent&&answer.checkboxChecked!==true||window.isDestroyed?.()||!before.owner.isCurrent()||!before.profile.isCurrent()||!before.head.isCurrent())throw error();
  const after=await snapshot(requested);if(after.ownerId!==before.ownerId||after.sessionId!==before.sessionId||C.canonical(after.authority)!==C.canonical(before.authority))throw error();
  for(const [id,grant]of grants)if(grant.expiresAt<=Date.now())grants.delete(id);if(grants.size>=32)throw error();
  let transition=null;
  if(['enroll-trust','advance-authority','forget-memory','forget-person','rotate-memory'].includes(requested.kind)){
   if(typeof before.head.authorizeTransition!=='function')C.unsupported();
   const nextAuthority=C.value('restore',requested.kind==='enroll-trust'?requested.next.restore:['forget-memory','forget-person','rotate-memory'].includes(requested.kind)?requested.next.authority:requested.next);
   transition=await before.head.authorizeTransition(Object.freeze({kind:requested.kind,profileId:requested.profileId,operationId:requested.operationId,challengeId:requested.challengeId,prior:before.authority,next:nextAuthority,intentDigest:C.digest(requested),authorityRange:requested.next.authorityRange??null,actionDigest:requested.next.actionDigest??null,reviewDigest:requested.next.reviewDigest??null,targetIds:requested.next.targetIds??[],personKey:requested.next.personKey??null,personPlanDigest:requested.next.personPlanDigest??null,entityIds:requested.next.entityIds??[]}));
   if(!transition||typeof transition.isCurrent!=='function'||!transition.isCurrent()||C.canonical(transition.prior)!==C.canonical(before.authority)||C.canonical(transition.next)!==C.canonical(nextAuthority)||transition.intentDigest!==C.digest(requested))throw error();
  }
  const grantId=randomBytes(32).toString('base64url'),expiresAt=Date.now()+60000,deadline=performance.now()+60000;
  const current=()=>!closed&&Date.now()<expiresAt&&performance.now()<deadline&&before.owner.isCurrent()===true&&before.profile.isCurrent()===true&&(transition?transition.isCurrent()===true:before.head.isCurrent()===true);
  grants.set(grantId,{requested,digest:C.digest(requested),before,expiresAt,current});
  return Object.freeze({grantId,expiresAt,ownerId:before.ownerId,profileId:requested.profileId,operationId:requested.operationId,isCurrent:current});
 }
 async function consume(grantId,raw){
  alive();C.opaque(grantId);const requested=intent(raw),held=grants.get(grantId);grants.delete(grantId);
  if(!held||held.digest!==C.digest(requested)||!held.current())throw error();const fresh=await snapshot(requested);
  if(!held.current()||fresh.ownerId!==held.before.ownerId||fresh.sessionId!==held.before.sessionId||C.canonical(fresh.authority)!==C.canonical(held.before.authority))throw error();
  let released=false;const current=()=>!released&&held.current();
  return Object.freeze({kind:requested.kind,grantId,ownerId:held.before.ownerId,profileId:requested.profileId,operationId:requested.operationId,challengeId:requested.challengeId,expiresAt:held.expiresAt,authority:held.before.authority,prior:copy(requested.prior),next:copy(requested.next),actionDigest:C.digest(requested),isCurrent:current,async validateCurrent(){return await held.before.owner.validateCurrent()===true&&current();},release(){released=true;}});
 }
 return Object.freeze({request,consume,
  async run(grantId,raw,operation){if(typeof operation!=='function'||context.getStore())throw error();const capability=await consume(grantId,raw);try{return await context.run(capability,()=>operation(capability));}finally{capability.release();}},
  captureOperation(){const capability=context.getStore();if(!capability||!capability.isCurrent())throw error();return Object.freeze({...capability,...(capability.kind==='enroll-trust'?{enrollmentGrant:capability}:{})});},
  async authorizePersistence({kind,operation,prior,next}){const capability=context.getStore();if(!capability||await capability.validateCurrent()!==true||!capability||!capability.isCurrent()||!operation||operation.ownerId!==capability.ownerId||operation.profileId!==capability.profileId||operation.operationId!==capability.operationId||!['trust','graph','auxiliary'].includes(kind)||kind==='trust'&&!['enroll-trust','advance-authority','advance-audit'].includes(capability.kind)||kind==='graph'&&!['enroll-graph','graph-decision','graph-persist'].includes(capability.kind)||kind==='auxiliary'&&capability.kind!=='auxiliary-persist'||C.canonical(prior)!==C.canonical(capability.prior)||C.canonical(next)!==C.canonical(capability.next))throw error();return capability;},
  close(){closed=true;grants.clear();},
 });
}
module.exports={createMemoryNativeOwnerCapabilities};
