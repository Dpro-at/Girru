import {markStoreHostStarted,retireStoreHostApp} from './store-host-apps.js';
/** Only the reviewed optional Store app can load its telephony program. */
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import type Database from 'better-sqlite3';
import {installedAppDir} from '../config/backend-root.js';
import {getDatabase} from '../db/index.js';import {dbDriver} from '../db/pg/config.js';
import {reviewedChannelReceipt} from './channel-runtime.js';
import {readRegularFile} from './read-regular-file.js';
import {parseRuntimePackages} from './store-package-runtime.js';
import {createStoreAppData} from './store-app-data.js';
const override=()=>{const v=(process.env.GIRRU_CALL_CENTER_APP_DIR??'').trim();return path.isAbsolute(v)?v:null;};
const root=()=>override()??installedAppDir('call-center');
const turns=new Set<()=>void>();const requests=new AbortController();let retired=false;let loading:Promise<any>|null=null;let loadedRoot:string|null=null;
export function callCenterRuntimeAllowed(db:Database.Database,dir?:string):boolean{
 const app=root();if(!app||dir&&path.resolve(dir)!==path.resolve(app)||retired||!fs.existsSync(path.join(app,'index.js')))return false;
 if(override()){const row=db.prepare('SELECT enabled FROM extension_configs WHERE extension_id=?').get('call-center') as {enabled?:number}|undefined;return !row||row.enabled===1;}
 try{const receipt=(db.prepare('SELECT value FROM app_settings WHERE key=?').get('store.installed.call-center') as {value?:unknown}|undefined)?.value;const row=db.prepare('SELECT enabled FROM extension_configs WHERE extension_id=?').get('call-center') as {enabled?:number}|undefined;return row?.enabled===1&&reviewedChannelReceipt(receipt);}catch{return false;}
}
export function retireCallCenterRuntime(){retired=true;requests.abort();for(const end of turns)end();turns.clear();}
export async function stopCallCenterRuntime(){
 try{await (await import('../plugins/extension-runner.js')).getExtensionRunner().disableExtension('call-center');}
 catch{console.warn('[Call Center] Extension cleanup was unavailable; the host has been retired.');}
 finally{retireStoreHostApp('call-center');retireCallCenterRuntime();}
}
export async function loadCallCenterRuntime(){
 if(dbDriver()!=='sqlite'||process.env.EXTENSIONS_DISABLED==='true')return null;
 const app=root();if(!app)return null;const db=getDatabase().getDb();if(!callCenterRuntimeAllowed(db))return null;
 if(loading&&loadedRoot===app)return loading;loadedRoot=app;
 loading=(async()=>{
  const descriptor=(await readRegularFile(path.join(app,'app-host.npm'),128*1024,{root:app})).data,meta=JSON.parse(descriptor.toString('utf8'));
  if(meta.host!=='call-center'||meta.schema!==1||meta.protocolVersion!==1)throw Error('Call Center host is incompatible.');
  for(const item of parseRuntimePackages(descriptor)){const p=JSON.parse((await readRegularFile(path.join(app,...item.path.split('/'),'package.json'),65536,{root:app})).data.toString('utf8'));if(p.name!==item.name||p.version!==item.version)throw Error('Call Center runtime is incomplete.');}
  const data=createStoreAppData('call-center',db,()=>callCenterRuntimeAllowed(db)),check=()=>{if(!callCenterRuntimeAllowed(db)){const e=new Error('Call Center is not enabled.');Object.assign(e,{statusCode:503,code:'app_not_enabled'});throw e;}};
  const [errors,roles,config,secrets,types,mask,credentials,dialect,logs,channel,webhooks,internal]=await Promise.all([
   import('../api/error-handler.js'),import('../auth/route-guards.js'),import('../config/index.js'),import('../telephony/credentials.js'),import('../credentials/types.js'),import('../credentials/secret-mask.js'),import('../credentials/index.js'),import('../db/pg/dialect.js'),import('./safe-error-log.js'),import('../tools/channel-policy.js'),import('../webhooks/verify.js'),import('../../extensions/shared/internal-auth.js')]);
  const allowedNames=new Set(Object.values(secrets.TELEPHONY_KEYS)),seen=new Set<string>(),manager=credentials.getCredentialManager();
  const name=(n:string)=>{check();if(!allowedNames.has(n as never))throw Error('Call Center credential is outside its scope.');};
  const credentialPort=Object.freeze({
   async getByName(n:string,userId?:string){name(n);const owner=await secrets.getTelephonyOwnerId();if(userId&&userId!==owner)throw Error('Call Center credential owner is outside its scope.');const row=owner?await manager.getByName(n,owner):null;if(row)seen.add(row.id);return row;},
   async getValue(id:string){check();if(!seen.has(id))throw Error('Call Center credential is outside its scope.');return manager.getValue(id);},
   async getValueByName(n:string,userId?:string){name(n);const owner=await secrets.getTelephonyOwnerId();if(userId&&userId!==owner)throw Error('Call Center credential owner is outside its scope.');const value=await secrets.getTelephonySecret(n);if(!value)throw Error('Call Center credential is missing.');return value;},
  });
  const core=Object.freeze({
   'src/db/index.js':Object.freeze({getDatabase:()=>{check();return data.database;},telephonyNames:(agentId?:string,workflowId?:string)=>{
    check();const valid=(id:unknown)=>typeof id==='string'&&id.length<=200;
    return Object.freeze({agentName:valid(agentId)?(db.prepare('SELECT name FROM agents_config WHERE id=?').get(agentId) as {name?:string}|undefined)?.name??null:null,workflowName:valid(workflowId)?(db.prepare('SELECT name FROM workflows WHERE id=?').get(workflowId) as {name?:string}|undefined)?.name??null:null});
   }}),
   'src/repositories/sql-steps.js':data.steps,
   'src/db/pg/dialect.js':Object.freeze({nowText:dialect.nowText,secondsSinceText:dialect.secondsSinceText}),
   'src/config/index.js':Object.freeze({config:Object.freeze({host:config.config.host,port:config.config.port})}),
   'src/api/error-handler.js':Object.freeze({handleError:errors.handleError}),
   'src/auth/route-guards.js':Object.freeze({authorizeActiveRole:roles.authorizeActiveRole,OWNER_OR_ADMIN:Object.freeze([...roles.OWNER_OR_ADMIN])}),
   'src/telephony/credentials.js':Object.freeze({TELEPHONY_KEYS:Object.freeze({...secrets.TELEPHONY_KEYS}),getTelephonySecret:(n:string)=>{name(n);return secrets.getTelephonySecret(n);},setTelephonySecret:(n:string,value:string|undefined|null,callerId?:string)=>{name(n);return secrets.getTelephonyOwnerId().then(owner=>{check();if(!owner)throw Error('Call Center credential owner is outside its scope.');return secrets.setTelephonySecret(n,value,owner);});}}),
   'src/credentials/index.js':Object.freeze({getCredentialManager:()=>credentialPort,getCredentialStorage:()=>Object.freeze({get:async(n:string)=>{name(n);const owner=await secrets.getTelephonyOwnerId();return owner?manager.getByName(n,owner):null;}})}),
   'src/credentials/types.js':Object.freeze({CredentialType:types.CredentialType}),
   'src/credentials/secret-mask.js':Object.freeze({maskSecret:mask.maskSecret,isMaskedSecret:mask.isMaskedSecret}),
   'src/services/safe-error-log.js':Object.freeze({safeConsole:Object.freeze({...logs.safeConsole})}),
   'src/tools/channel-policy.js':Object.freeze({beginChannelTurn:(origin:{conversationId?:string})=>{check();const turn=channel.beginChannelTurn({channel:'telephony',conversationId:origin?.conversationId});turns.add(turn.end);return Object.freeze({...turn,end:()=>{turn.end();turns.delete(turn.end);}});},CHANNEL_TURN_HEADER:channel.CHANNEL_TURN_HEADER}),
   'src/webhooks/verify.js':Object.freeze({registerRawBodyParsers:webhooks.registerRawBodyParsers,verifyTwilioRequest:webhooks.verifyTwilioRequest,publicRequestUrl:webhooks.publicRequestUrl}),
   'extensions/shared/webhook-verify.js':Object.freeze({registerRawBodyParsers:webhooks.registerRawBodyParsers,verifyTwilioRequest:webhooks.verifyTwilioRequest,publicRequestUrl:webhooks.publicRequestUrl}),
   'extensions/shared/internal-auth.js':Object.freeze({telephonyRequest:async(action:string,payload:Record<string,unknown>,userId:string)=>{
    check();let route:string,body:unknown;
    if(action==='make'&&payload&&Object.keys(payload).every(k=>['callPointId','toNumber','customGreeting'].includes(k))){route='/api/telephony/calls/make';body=payload;}
    else if(action==='hangup'&&typeof payload?.callSid==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(payload.callSid)&&Object.keys(payload).length===1){route='/api/telephony/calls/'+encodeURIComponent(payload.callSid)+'/hangup';}
    else throw Error('Call Center request is outside its scope.');
    const headers=internal.internalAuthHeaders(userId);check();const host=['0.0.0.0','::'].includes(config.config.host)?'127.0.0.1':config.config.host;
    return fetch('http://'+(host.includes(':')?'['+host+']':host)+':'+config.config.port+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:requests.signal});
   }}),
  });
  const host=Object.freeze({core,check,retire:retireCallCenterRuntime});
  const mod=await import(pathToFileURL(path.join(app,'index.js')).href);if(typeof mod.loadCallCenter!=='function')throw Error('Call Center program is incompatible.');const program=await mod.loadCallCenter(host);markStoreHostStarted('call-center');return program;
 })().catch(error=>{loading=null;throw error;});return loading;
}
