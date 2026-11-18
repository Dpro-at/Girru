import type {StepRunner} from '../../repositories/sql-steps.js';
/** Private owned-Node entry. No application bootstrap, environment loader, default server, or DB module is imported before native admission. */
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const C=require('../../../../identity/src/memory-native-proof.cjs');
type Row=Record<string,unknown>;
type OwnedConnection={kind:'new-app-owned-encrypted-memory'|'app-owned-encrypted-memory';profileId:string;ownerId:string;storageId:string;profileRoot:string;file:string;excludedRoots:string[]};
export type NativeSelectedConfig={v:1;authMode:'explicit-isolated-control-copy';ownerId:string;memberId:string;token:string;launchToken:string;source:OwnedConnection;journal:OwnedConnection;auth:OwnedConnection;profile:{profileRoot:string;memoryRoot:string;exportFiles:string[]};port:number};
const error=()=>Error('selected_memory_child_unavailable');
const opaque=()=>randomBytes(32).toString('base64url');
const CALLS:Record<string,string[]>={'read-master':[],'read-jwt':[],'advance-authority':['expected','next'],'advance-audit':['expected','next'],'graph-prepare':['before','after'],'graph-commit':['intentId'],'windows-acl':['profileRoot','file']};
const absolute=(value:unknown):string=>{if(typeof value!=='string'||value.length>4096||!path.isAbsolute(value)||path.resolve(value)!==value)throw error();return value;};
export function captureNativeSelectedConfig(value:unknown):NativeSelectedConfig{
 const v=value as NativeSelectedConfig;C.exact(v,['v','authMode','ownerId','memberId','token','launchToken','source','journal','auth','profile','port']);
 if(v.v!==1||v.authMode!=='explicit-isolated-control-copy'||!Number.isSafeInteger(v.port)||v.port<0||v.port>65535)throw error();C.text(v.ownerId);C.text(v.memberId);C.text(v.token,8192);C.opaque(v.launchToken);
 const connection=(item:OwnedConnection)=>{C.exact(item,['kind','profileId','ownerId','storageId','profileRoot','file','excludedRoots']);if(!['new-app-owned-encrypted-memory','app-owned-encrypted-memory'].includes(item.kind)||item.ownerId!==v.ownerId||!Array.isArray(item.excludedRoots)||item.excludedRoots.length<2||item.excludedRoots.length>16)throw error();C.text(item.profileId);C.text(item.storageId);return{...item,profileRoot:absolute(item.profileRoot),file:absolute(item.file),excludedRoots:item.excludedRoots.map(absolute)};};
 const source=connection(v.source),journal=connection(v.journal),auth=connection(v.auth);
 if(new Set([source.storageId,journal.storageId,auth.storageId]).size!==3||new Set([source.file,journal.file,auth.file]).size!==3||new Set([source.profileRoot,journal.profileRoot,auth.profileRoot]).size!==3)throw error();
 C.exact(v.profile,['profileRoot','memoryRoot','exportFiles']);if(!Array.isArray(v.profile.exportFiles)||v.profile.exportFiles.length>32)throw error();
 const profile={profileRoot:absolute(v.profile.profileRoot),memoryRoot:absolute(v.profile.memoryRoot),exportFiles:v.profile.exportFiles.map(absolute)};
 if(profile.profileRoot!==source.profileRoot)throw error();
 return{v:1,authMode:'explicit-isolated-control-copy',ownerId:v.ownerId,memberId:v.memberId,token:v.token,launchToken:v.launchToken,source,journal,auth,profile,port:v.port};
}
type Channel={send:(message:unknown)=>Promise<void>;onMessage:(handler:(message:unknown)=>void)=>()=>void;onClose:(handler:()=>void)=>()=>void};
/** Only the private child-process IPC endpoint may supply this channel; no HTTP/renderer adapter exists. */
export async function runNativeSelectedChild(channel:Channel){
 if(process.versions.electron||Number(process.versions.node.split('.')[0])!==24||typeof channel.send!=='function'||typeof channel.onMessage!=='function'||typeof channel.onClose!=='function')throw error();
 let closed=false,booted=false,client:any,coordinator:any,scope:any,host:any,server:any;
 const opened:any[]=[],pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>(),suspensions=new Map<string,any>();
 let bound:any,preparked:{event:any;ticket:any}|undefined;
 const fail=()=>{if(closed)return;closed=true;client?.close();scope?.close();coordinator?.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(error());}pending.clear();void server?.close().catch(()=>{});void host?.runtime.close().catch(()=>{});for(const connection of opened)try{connection.close();}catch{}};
 const unclose=channel.onClose(fail);
 const rpc=(message:Row)=>{if(closed)throw error();const operationId=coordinator.currentOperationId();if(!operationId)throw error();const continuation=coordinator.captureSuspension();if(suspensions.size>=4096&&!suspensions.has(operationId))throw error();suspensions.set(operationId,continuation);return new Promise<any>((resolve,reject)=>{const requestId=String(message.requestId);if(pending.size>=32||pending.has(requestId))return reject(error());const timer=setTimeout(()=>{pending.delete(requestId);reject(error());fail();},15000);pending.set(requestId,{resolve,reject,timer});channel.send(message).catch(()=>{clearTimeout(timer);pending.delete(requestId);reject(error());fail();});});};
 const nativeCall=async(method:string,args:Row={})=>{
  if(!Object.hasOwn(CALLS,method))throw error();C.exact(args,CALLS[method]);
  const operationId=coordinator.currentOperationId();if(!operationId)throw error();
  const fields=method.startsWith('graph-')?['profile','genesis','restore','audit','graph']:method==='windows-acl'?['profile']:['profile','genesis','restore','audit'];
  const proof=await client.capture(fields,operationId);
  const response=await rpc({v:1,type:'memory-native-call',binding:bound,requestId:opaque(),operationId,handle:proof.descriptor.handle,method,args});
  C.exact(response,['v','type','requestId','ok','value']);if(response.v!==1||response.type!=='memory-native-result'||response.ok!==true)throw error();return response.value;
 };
 let resolveReady:(value:{address:string;activationReady:false})=>void,rejectReady:(e:Error)=>void;
 const ready=new Promise<{address:string;activationReady:false}>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const unmessage=channel.onMessage(raw=>{void(async()=>{
  if(closed||!raw||typeof raw!=='object')throw error();const message=raw as any;
  if(message.type==='memory-selected-bootstrap'){
   if(booted)throw error();booted=true;C.exact(message,['v','type','proof','config']);if(message.v!==1)throw error();
   const bootstrap=C.bootstrap(message.proof),config=captureNativeSelectedConfig(message.config);bound=bootstrap.binding;
   if(bound.profileId!==config.source.profileId||bound.storageId!==config.source.storageId||bound.journalStorageId!==config.journal.storageId)throw error();
   // These imports happen only after the one-use trusted private bootstrap and path/grant binding.
   const [{createSelectedOperationCoordinator},{createMemoryNativeProofClient}]=await Promise.all([import('./selected-operation-coordinator.js'),import('./native-proof-client.js')]);
   let rawSource:any;
   const sourceFacade:any={dialect:'sqlite',inTransaction:()=>rawSource?.inTransaction()??false,read:(...args:any[])=>{if(!rawSource)throw error();return rawSource.read(...args);},tx:(...args:any[])=>{if(!rawSource)throw error();return rawSource.tx(...args);}};
   coordinator=createSelectedOperationCoordinator({runner:sourceFacade,launchId:bound.launchId,onPoison:fail});
   let parked:any;
   client=createMemoryNativeProofClient({bootstrap,
    requestFresh:(request:any)=>rpc(request),
    parkIngress:async(event:any)=>{if(!preparked||C.canonical({...preparked.event,type:'memory-proof-invalidate'})!==C.canonical(event)||!preparked.ticket.isCurrent())throw error();parked=preparked.ticket;return{operationId:event.operationId,isCurrent:parked.isCurrent,release:()=>parked.resume()};},
    drainOperations:async(event:any,ticket:any)=>{if(!parked?.isCurrent()||ticket.operationId!==event.operationId||parked.suspendedOperationId!==event.operationId||parked.activeOperations!==0||parked.activeTransactions!==0)throw error();return{suspendedOperationId:parked.suspendedOperationId,activeOperations:0,openTransactions:0};},
    resumeIngress:async(_event:any,ticket:any)=>{if(!parked?.isCurrent()||!ticket.isCurrent())throw error();await ticket.release();parked=undefined;preparked=undefined;},onRevoke:(fields:readonly string[])=>{if(fields.some(field=>['profile','genesis','restore'].includes(field)))host?.session.lock();},
   });
   await coordinator.runOperation(async()=>{
    const initial=await client.captureFoundation(['profile'],coordinator.currentOperationId());
    if(!initial.isCurrent())throw error();
    const {openOwnedSqliteMemoryProfile}=await import('./owned-sqlite-profile.js');
    const open=async(spec:OwnedConnection)=>{
     const actual=await openOwnedSqliteMemoryProfile({...spec,authorize:async()=>({...spec,isCurrent:()=>initial.isCurrent()}),verifyWindowsPrivateProfile:async(profileRoot,file)=>{const result=await nativeCall('windows-acl',{profileRoot,file});C.exact(result,['profileRoot','file']);if(result.profileRoot!==profileRoot||result.file!==file)throw error();return{profileRoot,file,isCurrent:()=>initial.isCurrent()};}});opened.push(actual);return actual;
    };
    const source=await open(config.source);rawSource=source.runner;const journal=await open(config.journal),auth=await open(config.auth);
    const privateKey=await nativeCall('read-jwt');C.exact(privateKey,['base64']);const key=Buffer.from(privateKey.base64,'base64');privateKey.base64='';
    const {createPrivateJwtContext}=await import('../../auth/private-jwt-context.js');
    try{scope=createPrivateJwtContext({key,isCurrent:()=>!closed&&source.isCurrent()&&auth.isCurrent()&&initial.isCurrent()});}finally{key.fill(0);}
    let genesisFoundation:any;
    const captured=async(field:string)=>{const proof=field==='genesis'?(genesisFoundation??=await client.captureFoundation(['genesis'],coordinator.currentOperationId())):await client.capture([field,'profile'],coordinator.currentOperationId());return{value:proof.values[field],isCurrent:proof.isCurrent};};
    const custody={
     async readProtectedMaster(){const value=await nativeCall('read-master');C.exact(value,['base64']);const bytes=Buffer.from(value.base64,'base64');value.base64='';if(bytes.length!==32){bytes.fill(0);throw error();}return bytes;},
     async captureGenesis(){const proof=await captured('genesis');return{anchor:proof.value,isCurrent:proof.isCurrent};},async captureAuthority(){const proof=await captured('restore');return{anchor:proof.value,isCurrent:proof.isCurrent};},
     advanceAuthority:async(expected:any,next:any)=>await nativeCall('advance-authority',{expected,next})===true,
     auditCustody:{async capture(){const proof=await captured('audit');return{head:proof.value,isCurrent:proof.isCurrent};},advance:async(expected:any,next:any)=>await nativeCall('advance-audit',{expected,next})===true},
    };
    const [{createSelectedEncryptedMemoryHost},{buildSelectedEncryptedMemoryServer}]=await Promise.all([import('./selected-host.js'),import('../../api/selected-memory-server.js')]);
    const runOperation=(fn:()=>Promise<any>)=>{if(coordinator.currentOperationId()){if(!scope.isCurrent())throw error();return fn();}return coordinator.runOperation(async()=>{
     await client.refreshFoundations(coordinator.currentOperationId());const refreshed=await client.capture(['profile'],coordinator.currentOperationId());if(!refreshed.isCurrent()||C.canonical(refreshed.values.profile)!==C.canonical(initial.values.profile))throw error();return scope.run(fn);
    });};
    await scope.run(async()=>{
     host=await createSelectedEncryptedMemoryHost({runner:coordinator.runner,journalRunner:coordinator.guardRunner(journal.runner),authRunner:coordinator.guardRunner(auth.runner),token:config.token,ownerId:config.ownerId,memberId:config.memberId,custody,profile:config.profile,
      authorizeJournal:async(runner:StepRunner)=>runner?{storageId:journal.storageId,isCurrent:journal.isCurrent}:null,authorizeAuthRunner:async(runner:StepRunner)=>runner?{storageId:auth.storageId,isCurrent:auth.isCurrent}:null,
      authorizeProfile:async()=>({profileId:source.profileId,storageId:source.storageId,profileRoot:config.profile.profileRoot,memoryRoot:config.profile.memoryRoot,isCurrent:source.isCurrent}),authorizeEmptyTarget:async()=>null,
      captureGraphRoot:async()=>{const proof=await captured('graph');if(proof.value.pending!==null)throw error();return{anchor:proof.value.anchor,isCurrent:proof.isCurrent};},
      graphMutationJournal:async(before:readonly Row[],after:readonly Row[])=>{const result=await nativeCall('graph-prepare',{before,after});C.exact(result,['intentId']);C.text(result.intentId);const proof=await captured('graph');if(proof.value.pending?.id!==result.intentId)throw error();return{isCurrent:proof.isCurrent,commit:async()=>await nativeCall('graph-commit',{intentId:result.intentId})===true};},
      // A read descriptor cannot establish a revocable owner-review capability. Closed until the native review-capability protocol is supplied.
      authorizeGraphReview:async()=>null,
     } as any);
     server=await buildSelectedEncryptedMemoryServer({host,launchToken:config.launchToken,runOperation} as any);
    });
    // Server startup must itself remain in the already-admitted startup operation.
    const address=await scope.run(()=>server.listen(config.port));if(closed||!source.isCurrent())throw error();
    await channel.send({v:1,type:'memory-selected-ready',binding:bound,address,activationReady:false});resolveReady({address,activationReady:false});
   });return;
  }
  if(!booted||!client)throw error();
  if(message.type==='memory-proof-response'||message.type==='memory-native-result'){const item=pending.get(C.opaque(message.requestId));if(!item)throw error();pending.delete(message.requestId);clearTimeout(item.timer);item.resolve(message);return;}
  if(message.type==='memory-proof-prepark'){const event=C.prepark(message);if(preparked||!C.sameBinding(event.binding,bound))throw error();const continuation=suspensions.get(event.operationId);if(!continuation||continuation.operationId!==event.operationId||!continuation.isCurrent())throw error();const ticket=await continuation.park(event.mutationId);if(!ticket.isCurrent()||ticket.suspendedOperationId!==event.operationId||ticket.activeOperations!==0||ticket.activeTransactions!==0)throw error();preparked={event,ticket};await channel.send(C.preparked({v:1,type:'memory-proof-preparked',binding:event.binding,mutationId:event.mutationId,operationId:event.operationId,serial:event.serial,nonce:event.nonce,suspendedOperationId:ticket.suspendedOperationId,activeOperations:0,openTransactions:0}));return;}
  if(message.type==='memory-proof-invalidate'){const ack=await client.handleInvalidation(C.invalidation(message));await channel.send(C.ack(ack));return;}
  if(message.type==='memory-proof-resume'){const event=C.resume(message);const ack=await client.handleResume(event);await channel.send(C.resumed(ack));return;}
  throw error();
 })().catch(()=>{rejectReady(error());fail();});});
 try{const result=await ready;return Object.freeze({...result,close(){unmessage();unclose();fail();}});}catch{unmessage();unclose();fail();throw error();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.send||!process.connected)throw error();
 void runNativeSelectedChild({send:message=>new Promise<void>((resolve,reject)=>process.send!(message,error=>error?reject(error):resolve())),onMessage:handler=>{process.on('message',handler);return()=>process.off('message',handler);},onClose:handler=>{process.once('disconnect',handler);return()=>process.off('disconnect',handler);}}).catch(()=>{process.exitCode=1;process.disconnect?.();});
}
