/** Dynamic admission on the actual control connection, including statements cached before enrollment. */
import type Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
type Fence={profileId:string;storageId:string;file:string;isCurrent:()=>boolean;canExecute:()=>boolean;trackIterator?:(closeCursor:()=>void)=>{isCurrent:()=>boolean;release:()=>void};runEffect?:<T>(effect:()=>Promise<T>)=>Promise<T>};
type State={native:Database.Database;proxy:Database.Database;key:string;iterators:Set<()=>void>};
const connections=new WeakMap<object,State>(),policies=new Map<string,Fence>();
const refused=()=>new Error('owned_control_admission_required');
const fileKey=(file:string)=>fs.existsSync(file)?fs.realpathSync(file):path.resolve(file);
const keyOf=(native:Database.Database)=>fileKey(native.name);
/** Refuse a second constructor before SQLite can open another descriptor to a fenced live file. */
export function assertSqliteControlOpen(file:string){if(policies.has(fileKey(file)))throw refused();}
function policy(state:State){return policies.get(state.key);}
function check(state:State){const fence=policy(state);if(fence&&(!state.native.open||fence.isCurrent()!==true||fence.canExecute()!==true))throw refused();}
function guardedCall(state:State,fn:()=>unknown){check(state);const result=fn();check(state);return result;}
/** A separate facade avoids native non-configurable back-reference invariants and hides addon symbols. */
function nativeFacade(raw:any,get:(target:any,key:string|symbol)=>unknown):any{
 let proxy:any;proxy=new Proxy(Object.create(Object.getPrototypeOf(raw)),{get(_target,key){if(typeof key==='symbol')return undefined;return get(raw,key);},ownKeys(){return Reflect.ownKeys(raw).filter(key=>typeof key==='string');},getOwnPropertyDescriptor(_target,key){if(typeof key!=='string')return undefined;const descriptor=Object.getOwnPropertyDescriptor(raw,key);return descriptor?{configurable:true,enumerable:descriptor.enumerable,writable:false,value:proxy[key]}:undefined;},set(){return false;},defineProperty(){return false;},deleteProperty(){return false;},preventExtensions(){return false;}});return proxy;
}
function statement(state:State,raw:any){return nativeFacade(raw,(target,key)=>{
 const value=Reflect.get(target,key,target);if(key==='database')return state.proxy;if(typeof value!=='function')return value;
 if(key==='iterate')return(...args:unknown[])=>{
  check(state);const fence=policy(state);if(fence&&typeof fence.trackIterator!=='function')throw refused();
  const iterator=value.apply(target,args) as Iterator<unknown>;let ended=false,lease:{isCurrent:()=>boolean;release:()=>void}|undefined;
  const finish=()=>{if(ended)return {done:true,value:undefined};try{return iterator.return?.()??{done:true,value:undefined};}finally{ended=true;state.iterators.delete(finish);lease?.release();}};
  try{lease=fence?.trackIterator?.(()=>{finish();});state.iterators.add(finish);check(state);}catch(error){finish();throw error;}
  return{[Symbol.iterator](){return this;},next(){try{if(lease&&!lease.isCurrent())throw refused();const result=guardedCall(state,()=>iterator.next()) as IteratorResult<unknown>;if(result.done)finish();return result;}catch(error){finish();throw error;}},return:finish};
 };
 return(...args:unknown[])=>{const result=guardedCall(state,()=>value.apply(target,args));return result===target?statement(state,target):result;};
});}

export function wrapSqliteControlConnection(native:Database.Database):Database.Database{
 if(connections.has(native))return connections.get(native)!.proxy;const state={native,key:keyOf(native),iterators:new Set()} as State;
 state.proxy=nativeFacade(native,(target,key)=>{const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
  if(key==='close')return()=>{for(const finish of [...state.iterators])finish();target.close();return state.proxy;};
  if(key==='prepare')return(...args:unknown[])=>statement(state,guardedCall(state,()=>value.apply(target,args)));
  if(key==='transaction')return(fn:(...args:any[])=>unknown)=>{const tx=value.call(target,fn),wrap=(run:Function)=>function(this:unknown,...args:unknown[]){return guardedCall(state,()=>run.apply(this,args));};const result=wrap(tx) as any;for(const variant of ['deferred','immediate','exclusive'])result[variant]=wrap(tx[variant]);result.default=result;result.database=state.proxy;return result;};
  if(key==='backup')return(...args:unknown[])=>{const fence=policy(state);if(!fence)return value.apply(target,args);if(typeof fence.runEffect!=='function')throw refused();check(state);return fence.runEffect(async()=>{const result=await value.apply(target,args);check(state);return result;});};
  if(key==='loadExtension')return(...args:unknown[])=>{if(policy(state))throw refused();return guardedCall(state,()=>value.apply(target,args));};
  return(...args:unknown[])=>{const result=guardedCall(state,()=>value.apply(target,args));return result===target?state.proxy:result;};
 });connections.set(native,state);connections.set(state.proxy,state);return state.proxy;
}
/** Native host only. There is deliberately no unbind that could restore an unfenced live writer. */
export function bindSqliteControlFence(connection:Database.Database,fence:Fence){
 const state=connections.get(connection);if(!state||state.iterators.size||!fence||typeof fence.profileId!=='string'||!fence.profileId||typeof fence.storageId!=='string'||!fence.storageId||typeof fence.file!=='string'||!path.isAbsolute(fence.file)||typeof fence.isCurrent!=='function'||typeof fence.canExecute!=='function'||fence.trackIterator!==undefined&&typeof fence.trackIterator!=='function'||fence.runEffect!==undefined&&typeof fence.runEffect!=='function'||!fence.isCurrent()||!state.native.open||state.native.name===':memory:')throw refused();
 const file=fs.realpathSync(fence.file);if(file!==fence.file||file!==fs.realpathSync(state.native.name)||policies.has(state.key))throw refused();
 const retained={...fence,isCurrent:fence.isCurrent.bind(fence),canExecute:fence.canExecute.bind(fence),...(fence.trackIterator?{trackIterator:fence.trackIterator.bind(fence)}:{}),...(fence.runEffect?{runEffect:fence.runEffect.bind(fence)}:{})};policies.set(state.key,retained);
 return Object.freeze({profileId:fence.profileId,storageId:fence.storageId,isCurrent:()=>state.native.open&&retained.isCurrent()===true});
}
/** Bounded lock metadata only, for the trusted constructor; never accepts SQL or reads payload rows. */
export function sqliteControlConnectionIdentity(connection:Database.Database){const state=connections.get(connection);if(!state||!state.native.open)throw refused();return Object.freeze({file:fs.realpathSync(state.native.name),open:true,inTransaction:state.native.inTransaction,lockingMode:state.native.pragma('locking_mode',{simple:true})});}
