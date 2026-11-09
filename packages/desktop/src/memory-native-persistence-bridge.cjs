'use strict';
/** Native-only assembly of real custody state and late persistence tickets. No renderer or environment inputs. */
const C=require('../../identity/src/memory-native-proof.cjs');
function createMemoryNativePersistenceBridge(options){
 if(!options||['getRegistry','getCustody','captureGraphState','captureAuxiliaryState','capturePresenceState','captureOperation','authorizePersistence','prepareGraphPreflight','prepareAuxiliaryPreflight','preparePresencePreflight'].some(key=>typeof options[key]!=='function'))C.unsupported();
 const profileId=C.text(options.profileId),ownerId=C.text(options.ownerId);let closed=false;
 const current=()=>{if(closed)throw C.error();};
 function proof(field,value,lease){if(!lease||typeof lease.isCurrent!=='function'||lease.isCurrent()!==true)throw C.error();const normalized=C.value(field,value);return{value:normalized,isCurrent:()=>!closed&&lease.isCurrent()===true};}
 async function state(overrides={}){
  current();const custody=options.getCustody();if(!custody||typeof custody.captureGenesis!=='function'||typeof custody.captureAuthority!=='function'||typeof custody.auditCustody?.capture!=='function')C.unsupported();
  let result;
  if(overrides.trust){const captured=overrides.trust();if(!captured?.value||captured.value.ownerId!==ownerId)C.unsupported();result={genesis:proof('genesis',captured.value.genesis,captured),restore:proof('restore',captured.value.restore,captured),audit:proof('audit',captured.value.audit,captured)};}
  else{const genesis=await custody.captureGenesis(),restore=await custody.captureAuthority(),audit=await custody.auditCustody.capture();result={genesis:proof('genesis',genesis?.anchor,genesis),restore:proof('restore',restore?.anchor,restore),audit:proof('audit',audit?.head,audit)};}
  const graph=overrides.graph?overrides.graph():await options.captureGraphState(profileId);current();
  if(!graph||typeof graph.isCurrent!=='function'||!graph.isCurrent())C.unsupported();if(graph.value!==null)result.graph=proof('graph',graph.value,graph);
  const auxiliary=overrides.auxiliary?overrides.auxiliary():await options.captureAuxiliaryState(profileId);current();
  if(!auxiliary||typeof auxiliary.isCurrent!=='function'||!auxiliary.isCurrent())C.unsupported();if(auxiliary.value!==null)result.auxiliary=proof('auxiliary',auxiliary.value,auxiliary);
  if(result.auxiliary&&result.auxiliary.value.anchor.ownerId!==ownerId)throw C.error();
  const presence=overrides.presence?overrides.presence():await options.capturePresenceState(profileId);current();
  if(!presence||typeof presence.isCurrent!=='function'||!presence.isCurrent())C.unsupported();if(presence.value!==null)result.presence=proof('presence',presence.value,presence);
  if(result.presence&&result.presence.value.anchor.ownerId!==ownerId)throw C.error();
  if(result.genesis.value.ownerId!==ownerId||result.restore.value.ownerId!==ownerId||result.audit.value.ownerId!==ownerId||result.graph&&result.graph.value.anchor.ownerId!==ownerId||Object.values(result).some(value=>!value.isCurrent()))throw C.error();return result;
 }
 function bundleFromRecord(capture,kind){return()=>{const held=capture();if(!held||typeof held.isCurrent!=='function'||!held.isCurrent())throw C.error();const record=held.value;if(record!==null&&record.ownerId!==ownerId)throw C.error();const slot=record?.slots.find(slot=>slot.profileId===profileId)??null;return{value:slot&&kind==='auxiliary'?{purpose:'memory-auxiliary',...slot}:slot&&kind==='presence'?{purpose:'memory-profile-presence',...slot}:slot,isCurrent:()=>!closed&&held.isCurrent()};};}
 function changed(prior,next,kind){
  if(kind==='trust'){return ['genesis','restore','audit'].filter(field=>C.canonical(prior?.[field]??null)!==C.canonical(next[field]));}
  const pick=record=>record?.slots.find(slot=>slot.profileId===profileId)??null;return C.canonical(pick(prior))===C.canonical(pick(next))?[]:[kind];
 }
 async function begin(request,kind){
  current();if(!request||request.ownerId!==ownerId||kind!=='trust'&&request.profileId!==undefined&&request.profileId!==profileId)throw C.error();
  const operation=await options.captureOperation(Object.freeze({kind,profileId,ownerId,persistenceId:request.operationId}));
  if(!operation||typeof operation.isCurrent!=='function'||!operation.isCurrent()||operation.ownerId!==ownerId||operation.profileId!==profileId)C.unsupported();const operationId=C.text(operation.operationId,128);
  const capture=kind==='trust'?request.captureTrustState:kind==='graph'?request.captureGraphState:kind==='auxiliary'?request.captureAuxiliaryState:request.capturePresenceState;if(typeof capture!=='function')C.unsupported();
  // This local producer authorizes the exact native transition, not merely a fresh read handle.
  const permission=await options.authorizePersistence({kind,operation,prior:request.prior,next:request.next});
  if(!permission||typeof permission.isCurrent!=='function'||!permission.isCurrent()||!operation.isCurrent())C.unsupported();
  const registry=options.getRegistry();if(!registry||typeof registry.beginMutation!=='function')C.unsupported();
  const captureState=()=>state(kind==='trust'?{trust:capture}:{[kind]:bundleFromRecord(capture,kind)});
  const changedFields=changed(request.prior,request.next,kind);
  const bindTicket=ticket=>Object.freeze({isCurrent:()=>!closed&&operation.isCurrent()&&permission.isCurrent()&&ticket.isCurrent(),async complete(){if(closed||!operation.isCurrent()||!permission.isCurrent()){await ticket.fail();throw C.error();}return ticket.complete();},fail:()=>ticket.fail()});
  if(kind==='trust'&&request.prior===null){
   if(typeof registry.beginEnrollmentPersistence!=='function'||!operation.enrollmentGrant)C.unsupported();
   const ticket=await registry.beginEnrollmentPersistence({operationId,grantId:operation.enrollmentGrant.grantId},{captureState});
   if(!operation.isCurrent()||!permission.isCurrent()){await ticket.fail();throw C.error();}return bindTicket(ticket);
  }
  let bundlePermitId;
  if(kind!=='trust'){
   const preflight=await (kind==='graph'?options.prepareGraphPreflight:kind==='auxiliary'?options.prepareAuxiliaryPreflight:options.preparePresencePreflight)({operation,permission,profileId,prior:request.prior,next:request.next});
   if(!operation.isCurrent()||!permission.isCurrent()||!preflight||preflight.operationId!==operationId||typeof preflight.isCurrent!=='function'||!preflight.isCurrent())C.unsupported();
   const register=kind==='graph'?registry.registerGraphPreflight:kind==='auxiliary'?registry.registerAuxiliaryPreflight:registry.registerPresencePreflight;if(typeof register!=='function')C.unsupported();bundlePermitId=register(preflight);
  }
  const ticket=await registry.beginMutation({operationId,changedFields,...(bundlePermitId?{[kind+'PermitId']:bundlePermitId}:{})},{captureState});
  if(!operation.isCurrent()||!permission.isCurrent()){await ticket.fail();throw C.error();}
  // Semantic read authority may survive an audit refresh; the exact write permit must also remain current.
  return bindTicket(ticket);
 }
 return Object.freeze({captureNativeState:()=>state(),beginTrustPersistence:request=>begin(request,'trust'),beginGraphPersistence:request=>begin(request,'graph'),beginAuxiliaryPersistence:request=>begin(request,'auxiliary'),beginPresencePersistence:request=>begin(request,'presence'),close(){closed=true;}});
}
module.exports={createMemoryNativePersistenceBridge};
