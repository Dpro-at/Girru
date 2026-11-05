import {storeHostApp,storeHostStatus,retireStoreHostApp} from '../../services/store-host-apps.js';
import {q} from '../../repositories/sql-steps.js';
import type {FastifyInstance} from 'fastify';
import {authorizeActiveRole} from '../../auth/route-guards.js';
import {isLoopbackPeer} from './terminal.js';
import {extensionsAvailable} from '../../plugins/extension-runner.js';
import {readStore,localCatalogue,installFromStore,uninstallFromStore} from '../../services/store-catalogue.js';
import {addJob} from '../../services/store-install.js';
import {codeRuntimeStatus} from '../../services/code-runtime.js';
import {genvrRuntimeStatus} from '../../services/genvr-runtime.js';
import {addPrivateApp} from '../../services/private-apps.js';
import {requestRestart} from '../restart-request.js';

/** APPS-06: an added or removed app needs Girru to start again; the desktop app does it by itself. */
const restart=()=>!!process.env.AGENT_PLAYER_LAUNCH_TOKEN&&requestRestart();
const JOB=/^[0-9a-f-]{36}$/;

const ID=/^[a-z0-9][a-z0-9._@:-]{0,319}$/i,HASH=/^[a-f0-9]{64}$/;
const body=(x:unknown,keys:string[])=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>keys.includes(k));

/**
 * The Store (STORE-UI-01): one read for the whole window, and Add / Remove for
 * apps from Girru's registry. Owner only, from this computer only (the index
 * includes the coding apps' local catalogue copies). An Add carries the hash
 * of exactly what the owner was shown; the MCP tool uses the same routes.
 */
export async function storeRoutes(app:FastifyInstance,options:{home?:string}={}){
 const guard=(request:Parameters<typeof authorizeActiveRole>[0],reply:Parameters<typeof authorizeActiveRole>[1])=>{
  if(!authorizeActiveRole(request,reply,['owner']))return false;
  if(!isLoopbackPeer(request)){reply.code(403).send({code:'not_loopback'});return false;}
  return true;
 };
 app.get('/api/store/apps/:id/status',{config:{access:'owner'}},async(request,reply)=>{
  if(!guard(request,reply))return;
  const {id}=request.params as {id:string};if(!storeHostApp(id)||Object.keys(request.query as object).length)return reply.code(400).send({code:'invalid_app_status'});
  reply.header('Cache-Control','no-store');return storeHostStatus(id);
 });
 app.post('/api/store/apps/:id/activation',{config:{access:'owner'},bodyLimit:1024},async(request,reply)=>{
  if(!guard(request,reply))return;
  const {id}=request.params as {id:string},value=request.body as {enabled?:unknown}|null;
  if(!storeHostApp(id)||Object.keys(request.query as object).length||!value||Object.keys(value).length!==1||!Object.hasOwn(value,'enabled')||typeof value.enabled!=='boolean')return reply.code(400).send({code:'invalid_app_activation'});
  const state=await storeHostStatus(id);if(!state.installed||value.enabled&&!state.ready)return reply.code(409).send({code:'app_not_ready'});
  await q.run("INSERT INTO extension_configs(extension_id,enabled,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(extension_id) DO UPDATE SET enabled=excluded.enabled,updated_at=CURRENT_TIMESTAMP",id,value.enabled?1:0);
  if(!value.enabled){if(id==='browser')await (await import('../../services/browser-runtime.js')).stopBrowserRuntime();if(id==='call-center')await (await import('../../services/call-center-runtime.js')).stopCallCenterRuntime();retireStoreHostApp(id);if(id==='call-center')(await import('../../services/call-center-runtime.js')).retireCallCenterRuntime();}
  return {ok:true,enabled:value.enabled,restart:restart()?'auto':'manual'};
 });
 app.get('/api/store',{config:{access:'owner'}},async(request,reply)=>{
  if(!guard(request,reply))return;
  if(Object.keys(request.query as object).length)return reply.code(400).send({code:'invalid_input'});
  reply.header('Cache-Control','no-store');
  try{return await readStore(request.authUser!.id,localCatalogue({home:options.home}));}
  catch{return reply.code(503).send({code:'store_unavailable'});}
 });
 app.post('/api/store/install',{config:{access:'owner'}},async(request,reply)=>{
  if(!guard(request,reply))return;
  const b=request.body as {id?:unknown;hash?:unknown};
  if(!body(b,['id','hash'])||typeof b.id!=='string'||!ID.test(b.id)||typeof b.hash!=='string'||!HASH.test(b.hash))return reply.code(400).send({code:'invalid_input'});
  if(b.id.startsWith('registry:')&&!extensionsAvailable())return reply.code(409).send({code:'not_installable',message:'Adding apps from the registry works only with the local database.'});
  const r=await installFromStore(request.authUser!.id,b.id,b.hash,{restart});
  return r.ok?r:reply.code(r.code==='not_found'?404:409).send({code:r.code,message:r.message});
 });
 app.post('/api/store/uninstall',{config:{access:'owner'}},async(request,reply)=>{
  if(!guard(request,reply))return;
  const b=request.body as {id?:unknown;confirm?:unknown};
  if(!body(b,['id','confirm'])||typeof b.id!=='string'||!ID.test(b.id)||(b.confirm!==undefined&&b.confirm!==true))return reply.code(400).send({code:'invalid_input'});
  const r=await uninstallFromStore(request.authUser!.id,b.id,{confirm:b.confirm===true,restart});
  return r.ok?r:reply.code(409).send({code:r.code,message:r.message,...(r.data?{data:r.data}:{})});
 });
 // SA6: add a private app from a folder in the owner's home folder (checked like a Store app, never listed).
 app.post('/api/store/private',{config:{access:'owner'}},async(request,reply)=>{
  if(!guard(request,reply))return;
  const b=request.body as {folder?:unknown};
  if(!body(b,['folder'])||typeof b.folder!=='string'||!b.folder.trim()||b.folder.length>1024||b.folder.includes('\0'))return reply.code(400).send({code:'invalid_input'});
  if(!extensionsAvailable())return reply.code(409).send({code:'not_installable',message:'Adding apps works only with the local database.'});
  const r=await addPrivateApp(b.folder.trim(),{home:options.home,restart});
  return r.ok?{ok:true,state:'installed',id:r.id,name:r.name,restart:r.restart}:reply.code(r.code==='invalid_folder'?400:409).send({code:r.code==='invalid_folder'?'invalid_folder':'refused',message:r.message});
 });
 // CODE-STORE-01: where the Code app stands on this computer (footer and My apps say "Install Code" when it is missing).
 app.get('/api/apps/code',{config:{access:'owner'}},async(request,reply)=>{
  if(!guard(request,reply))return;
  if(Object.keys(request.query as object).length)return reply.code(400).send({code:'invalid_input'});
  reply.header('Cache-Control','no-store');
  return codeRuntimeStatus();
 });
 app.get('/api/apps/genvr',{config:{access:'owner'}},async(request,reply)=>{
  if(!guard(request,reply))return;
  if(Object.keys(request.query as object).length)return reply.code(400).send({code:'invalid_input'});
  reply.header('Cache-Control','no-store');
  return genvrRuntimeStatus();
 });
 // APPS-06: how adding an app from the Girru Store goes (the window asks while it waits).
 app.get('/api/store/install/:job',{config:{access:'owner'}},async(request,reply)=>{
  if(!guard(request,reply))return;
  const {job}=request.params as {job:string};
  const j=JOB.test(job)?addJob(job):null;
  if(!j)return reply.code(404).send({code:'not_found'});
  reply.header('Cache-Control','no-store');
  return {step:j.step,done:j.done,...(j.total?{received:j.received??0,total:j.total}:{}),...(j.done?{ok:j.ok===true,message:j.message??'',restart:j.restart??'manual'}:{})};
 });
}
