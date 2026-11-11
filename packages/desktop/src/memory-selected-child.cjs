'use strict';
/** Owned Node child transport. Native proof producers and approvals remain in trusted main. */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{randomBytes}=require('node:crypto');
const C=require('../../identity/src/memory-native-proof.cjs');
const error=()=>Error('selected_memory_child_unavailable');
const opaque=()=>randomBytes(32).toString('base64url');
const CALLS=Object.freeze({ 'read-master':[], 'read-jwt':[], 'advance-authority':['expected','next'], 'advance-audit':['expected','next'], 'graph-prepare':['before','after'], 'graph-commit':['intentId'], 'windows-acl':['profileRoot','file'] });
function bounded(value,max=32*1024*1024){const wire=JSON.stringify(value);if(typeof wire!=='string'||Buffer.byteLength(wire)>max)throw error();return JSON.parse(wire);}
function callRequest(value){C.exact(value,['v','type','binding','requestId','operationId','handle','method','args']);if(value.v!==1||value.type!=='memory-native-call'||!Object.hasOwn(CALLS,value.method))throw error();C.exact(value.args,CALLS[value.method]);return {...bounded(value),binding:C.binding(value.binding),requestId:C.opaque(value.requestId),operationId:C.text(value.operationId,128),handle:C.opaque(value.handle)};}
function createSelectedMemoryChild(options){
 if(!options||typeof options.createRegistry!=='function'||typeof options.authorizeLaunch!=='function'||!options.nativeHandlers||Object.keys(options.nativeHandlers).sort().join(',')!==Object.keys(CALLS).sort().join(',')||Object.values(options.nativeHandlers).some(handler=>typeof handler!=='function')||typeof options.parkIngress!=='function')throw error();
 for(const file of [options.nodeExecutable,options.entry]){if(typeof file!=='string'||!path.isAbsolute(file)||fs.realpathSync(file)!==file||!fs.statSync(file).isFile())throw error();}
 let child,registry,grant,state='new',launch,closePromise;const drains=new Map(),resumes=new Map(),parks=new Map();
 const keyFor=event=>C.canonical({binding:C.binding(event.binding),mutationId:C.opaque(event.mutationId),nonce:C.opaque(event.nonce),serial:C.number(event.serial,1),operationId:C.text(event.operationId,128)});
 const send=message=>new Promise((resolve,reject)=>{if(!child?.connected||state==='closed')return reject(error());child.send(message,err=>err?reject(error()):resolve());});
 function wait(map,event){const key=keyFor(event);if(map.has(key))throw error();let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});const timer=setTimeout(()=>{map.delete(key);reject(error());},15000);map.set(key,{promise,resolve:value=>{clearTimeout(timer);resolve(value);},reject:()=>{clearTimeout(timer);map.delete(key);reject(error());}});return promise;}

 const stop=()=>{if(closePromise)return closePromise;state='closed';launch?.reject(error());closePromise=(async()=>{for(const map of [drains,resumes,parks])for(const pending of [...map.values()])pending.reject();try{await registry?.close();}finally{if(child&&!child.killed)child.kill();grant=undefined;}})();return closePromise;};
 async function receive(raw){
  if(state==='closed'||!grant?.isCurrent()||!raw||typeof raw!=='object')throw error();
  if(raw.type==='memory-proof-request'){const req=C.request(raw);if(!C.sameBinding(req.binding,registry.binding??launch.binding))throw error();await send(await registry.handleRequest(req));return;}
  if(raw.type==='memory-proof-preparked'){const ack=C.preparked(raw),pending=parks.get(keyFor(ack));if(!pending)throw error();pending.resolve(ack);return;}
  if(raw.type==='memory-proof-drained'){const ack=C.ack(raw),pending=drains.get(keyFor(ack));if(!pending)throw error();pending.resolve(ack);return;}
  if(raw.type==='memory-proof-resumed'){C.exact(raw,['v','type','binding','mutationId','operationId','serial','nonce']);const ack=C.resumed(raw),event=C.resume({...ack,type:'memory-proof-resume'}),pending=resumes.get(keyFor(event));if(!pending)throw error();pending.resolve(ack);return;}
  if(raw.type==='memory-native-call'){
   const request=callRequest(raw);if(!C.sameBinding(request.binding,launch.binding))throw error();
   // Freshness is established by the registry, not by trusting a child-supplied handle string.
   const proof=await registry.handleRequest(C.request({v:1,type:'memory-proof-request',binding:launch.binding,requestId:opaque(),operation:'fresh',operationId:request.operationId,handle:request.handle}));
   const required=request.method.startsWith('graph-')?['profile','genesis','restore','audit','graph']:request.method==='windows-acl'?['profile']:['profile','genesis','restore','audit'];
   if(Object.keys(proof.descriptor.fields).sort().join(',')!==required.sort().join(',')||proof.descriptor.operationId!==request.operationId||!C.sameBinding(proof.descriptor.binding,launch.binding)||!grant.isCurrent())throw error();
   if(required.includes('restore')&&(proof.values.restore.ownerId!==grant.config.ownerId||proof.values.genesis.ownerId!==grant.config.ownerId||proof.values.audit.ownerId!==grant.config.ownerId))throw error();
   let value;
   try{value=await options.nativeHandlers[request.method](Object.freeze(request),Object.freeze(proof));if(!grant.isCurrent())throw error();
    if(request.method==='read-master'||request.method==='read-jwt'){
     if(!Buffer.isBuffer(value)||value.length<(request.method==='read-master'?32:32)||value.length>(request.method==='read-master'?32:128))throw error();
     await send({v:1,type:'memory-native-result',requestId:request.requestId,ok:true,value:{base64:value.toString('base64')}});
    }else await send({v:1,type:'memory-native-result',requestId:request.requestId,ok:true,value:bounded(value)});
   }finally{if(Buffer.isBuffer(value))value.fill(0);}return;
  }
  if(raw.type==='memory-selected-ready'){C.exact(raw,['v','type','binding','address','activationReady']);if(raw.v!==1||!C.sameBinding(raw.binding,launch.binding)||raw.activationReady!==false||typeof raw.address!=='string'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(raw.address))throw error();state='ready';launch.resolve(Object.freeze({address:raw.address,activationReady:false}));return;}
  throw error();
 }
 return Object.freeze({
  async start(){if(state!=='new')throw error();state='starting';
   try{
    const approved=await options.authorizeLaunch();if(!approved||typeof approved.isCurrent!=='function'||!approved.isCurrent())throw error();
    const config=bounded(approved.config,65536),binding=C.binding(approved.binding);grant={config,binding,isCurrent:approved.isCurrent.bind(approved)};
    // Secrets and inherited data-root overrides never enter the child environment or command line.
    const env={};for(const name of ['PATH','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL'])if(typeof process.env[name]==='string')env[name]=process.env[name];
    child=spawn(options.nodeExecutable,[options.entry],{cwd:path.dirname(options.entry),env,stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',windowsHide:true,shell:false});
    if(!child.pid)throw error();
    const ready=new Promise((resolve,reject)=>{launch={binding,resolve,reject};});
    child.on('message',raw=>{receive(raw).catch(()=>{launch.reject(error());void stop().catch(()=>{});});});child.once('error',()=>{launch.reject(error());void stop().catch(()=>{});});child.once('exit',()=>{launch.reject(error());void stop().catch(()=>{});});
    registry=await options.createRegistry({binding,childPid:child.pid,
     parkIngress:async event=>{const hold=await options.parkIngress(event);if(!hold||hold.operationId!==event.operationId||typeof hold.isCurrent!=='function'||typeof hold.release!=='function'||!hold.isCurrent())throw error();let released=false;try{const waiting=wait(parks,event);await send(C.prepark({...event,type:'memory-proof-prepark'}));const ack=C.preparked(await waiting);if(keyFor(ack)!==keyFor(event)||!hold.isCurrent())throw error();return Object.freeze({operationId:event.operationId,isCurrent:()=>!released&&grant?.isCurrent()===true&&hold.isCurrent()===true,async release(){if(released)return;released=true;await hold.release();}});}catch{await hold.release();throw error();}finally{parks.delete(keyFor(event));}},
     publishInvalidation:event=>{const waiting=wait(drains,event);waiting.catch(()=>{});return send(C.invalidation(event));},
     drainChild:event=>{const pending=drains.get(keyFor(event));if(!pending)throw error();return pending.promise.finally(()=>drains.delete(keyFor(event)));},
     resumeChild:async event=>{const waiting=wait(resumes,event);await send(C.resume(event));try{return C.resumed(await waiting);}finally{resumes.delete(keyFor(event));}},
    });
    if(!registry||typeof registry.initialize!=='function'||typeof registry.handleRequest!=='function'||typeof registry.close!=='function')throw error();
    const proof=C.bootstrap(await registry.initialize());if(!C.sameBinding(proof.binding,binding)||!grant.isCurrent())throw error();
    await send({v:1,type:'memory-selected-bootstrap',proof,config});
    const timeout=setTimeout(()=>{launch.reject(error());void stop().catch(()=>{});},30000);try{return await ready;}finally{clearTimeout(timeout);}
   }catch{await stop();throw error();}
  },stop,status:()=>state,
 });
}
module.exports={createSelectedMemoryChild,callRequest};
