/** Explicit owner API for injected encrypted runtime. No profile paths, keys, run scopes or restore targets from HTTP. */
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {actorOf} from '../../auth/auth-gate.js';
import {actorOrReply,requireOwner} from '../../repositories/scope.js';
import {parseDrawerId} from '../../memory/drawers.js';
import type {createEncryptedMemoryRuntime} from '../../memory/encryption/runtime-host.js';
import {memoryRowSurfaceManifest,type MemoryRowTable} from '../../memory/encryption/row-codec.js';
type Runtime=ReturnType<typeof createEncryptedMemoryRuntime>;
const identifier=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
export async function registerEncryptedMemoryRoutes(app:FastifyInstance,runtimeOrGetter:Runtime|(()=>Runtime|null),_options:{isEncryptedMemorySelected?:()=>boolean}={}){
 const config={access:'owner' as const},base='/api/memory/encryption';
 const selected=new WeakMap<FastifyRequest,Runtime>();
 const owner=(request:FastifyRequest,reply:FastifyReply)=>{const actor=actorOrReply(reply,actorOf(request),requireOwner);if(!actor)return false;let runtime:Runtime|null;try{runtime=typeof runtimeOrGetter==='function'?runtimeOrGetter():runtimeOrGetter;}catch{runtime=null;}if(!runtime){reply.code(503).send({error:'Encrypted memory is unavailable',code:'encrypted_memory_unavailable'});return false;}if(actor.userId!==runtime.ownerId){reply.code(404).send({error:'Not found',code:'not_found'});return false;}selected.set(request,runtime);return true;};

 const body=(request:FastifyRequest)=>request.body&&typeof request.body==='object'&&!Array.isArray(request.body)?request.body as Record<string,unknown>:{};
 const attempt=async(reply:FastifyReply,fn:()=>Promise<unknown>)=>{try{return await fn();}catch{return reply.code(409).send({error:'Encrypted memory operation unavailable',code:'encrypted_memory_unavailable'});}};
 app.addHook('preValidation',async(request,reply)=>{
  const route=request.routeOptions.url??'';if(!route.startsWith(base+'/')||!['POST','PATCH','PUT'].includes(request.method))return;
  if(request.body!==undefined&&(!request.body||typeof request.body!=='object'||Array.isArray(request.body)))return reply.code(400).send({error:'Object request required'});
 });
 app.get<{Params:{table:string};Querystring:{after?:string;limit?:string}}>(base+'/rows/:table',{config},async(request,reply)=>{
  if(!owner(request,reply))return reply;const {table}=request.params,query=request.query;
  if(!memoryRowSurfaceManifest().some(surface=>surface.table===table)||Object.keys(query).some(key=>!['after','limit'].includes(key))||query.after!==undefined&&!identifier(query.after)||query.limit!==undefined&&(typeof query.limit!=='string'||!/^\d{1,3}$/.test(query.limit)||Number(query.limit)<1||Number(query.limit)>200))return reply.code(400).send({error:'Invalid pagination'});
  return attempt(reply,()=>selected.get(request)!.listOwnerIds({table:table as MemoryRowTable,after:query.after,limit:query.limit===undefined?undefined:Number(query.limit)}));
 });
 app.post(base+'/import',{config},async(request,reply)=>{
  if(!owner(request,reply))return reply;const value=body(request);if(typeof value.text!=='string'||Buffer.byteLength(value.text)>512*1024||!['markdown','text'].includes(String(value.format))||typeof value.drawer!=='string'||Object.keys(value).some(key=>!['text','format','drawer'].includes(key)))return reply.code(400).send({error:'Invalid text import'});
  return attempt(reply,()=>selected.get(request)!.queueOwnerImport({text:value.text as string,format:value.format as 'markdown'|'text',drawer:parseDrawerId(value.drawer as string)}));
 });
 app.post(base+'/pinned-facts',{config},async(request,reply)=>{
  if(!owner(request,reply))return reply;const value=body(request);if(typeof value.scope!=='string'||value.scope.length>512||typeof value.text!=='string'||value.text.length>500||Object.keys(value).some(key=>!['scope','text'].includes(key)))return reply.code(400).send({error:'Invalid pinned fact'});
  return attempt(reply,()=>selected.get(request)!.addPinnedFact({scope:value.scope as string,text:value.text as string}));
 });
 app.patch<{Params:{table:string;id:string}}>(base+'/auxiliary/:table/:id',{config},async(request,reply)=>{
  if(!owner(request,reply))return reply;const {table,id}=request.params,patch=body(request),fields=table==='memory_pinned_facts'?['text']:table==='memory_weekly_summaries'?['text','model_text']:[];
  if(!fields.length||!identifier(id)||!Object.keys(patch).length||Object.entries(patch).some(([field,value])=>!fields.includes(field)||value!==null&&typeof value!=='string'||value===null&&field!=='model_text'))return reply.code(400).send({error:'Invalid auxiliary update'});
  return attempt(reply,async()=>{await selected.get(request)!.updateOwnerAuxiliary({table:table as 'memory_pinned_facts'|'memory_weekly_summaries',id,patch:patch as Record<string,string|null>});return{updated:true};});
 });
 app.post(base+'/weekly-summary',{config},async(request,reply)=>{
  if(!owner(request,reply))return reply;if(Object.keys(body(request)).length)return reply.code(400).send({error:'Invalid request'});return attempt(reply,()=>selected.get(request)!.summarizeWeekly());
 });
 app.get<{Params:{id:string}}>(base+'/graph/:id',{config},async(request,reply)=>{
  if(!owner(request,reply))return reply;if(!identifier(request.params.id))return reply.code(400).send({error:'Invalid memory'});return attempt(reply,()=>selected.get(request)!.previewGraph(request.params.id));
 });
 app.post<{Params:{id:string}}>(base+'/graph/:id/decision',{config},async(request,reply)=>{
  if(!owner(request,reply))return reply;const value=body(request);if(!identifier(request.params.id)||typeof value.reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(value.reviewHash)||!['approve','reject'].includes(String(value.decision))||Object.keys(value).some(key=>!['reviewHash','decision'].includes(key)))return reply.code(400).send({error:'Reviewed graph decision required'});
  return attempt(reply,()=>selected.get(request)!.decideGraph(request.params.id,value.reviewHash as string,value.decision as 'approve'|'reject'));
 });
 app.get(base+'/documents/status',{config},async(request,reply)=>owner(request,reply)?attempt(reply,()=>selected.get(request)!.documentStatus()):reply);
 app.post(base+'/document-imports',{config},async(request,reply)=>{if(!owner(request,reply))return reply;const value=body(request);if(typeof value.fileId!=='string'||!/^[a-f0-9]{32}$/.test(value.fileId)||Object.keys(value).some(key=>key!=='fileId'))return reply.code(400).send({error:'Host-authorized document required'});return attempt(reply,()=>selected.get(request)!.previewDocumentImport(value.fileId as string));});
 app.get<{Params:{id:string}}>(base+'/document-imports/:id',{config},async(request,reply)=>{if(!owner(request,reply))return reply;if(!/^[a-f0-9-]{36}$/.test(request.params.id))return reply.code(400).send({error:'Invalid document review'});return attempt(reply,()=>selected.get(request)!.readDocumentImport(request.params.id));});
 app.post<{Params:{id:string}}>(base+'/document-imports/:id/decision',{config},async(request,reply)=>{if(!owner(request,reply))return reply;const value=body(request);if(!/^[a-f0-9-]{36}$/.test(request.params.id)||typeof value.reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(value.reviewHash)||!['approve','reject'].includes(String(value.decision))||value.confirmation!==undefined&&typeof value.confirmation!=='string'||Object.keys(value).some(key=>!['reviewHash','decision','confirmation'].includes(key)))return reply.code(400).send({error:'Explicit reviewed new-content decision required'});return attempt(reply,()=>selected.get(request)!.decideDocumentImport({admissionId:request.params.id,reviewHash:value.reviewHash as string,decision:value.decision as 'approve'|'reject',confirmation:value.confirmation as string|undefined}));});
 app.get(base+'/status',{config},async(request,reply)=>owner(request,reply)?{state:selected.get(request)!.status(),activationReady:false}:reply);
 app.get<{Params:{table:string;id:string}}>(base+'/rows/:table/:id',{config},async(request,reply)=>{
  if(!owner(request,reply))return reply;const {table,id}=request.params;if(!identifier(id)||!memoryRowSurfaceManifest().some(s=>s.table===table))return reply.code(400).send({error:'Invalid record'});
  return attempt(reply,async()=>{const row=await selected.get(request)!.readOwnerRow(table as MemoryRowTable,id);return row?{row}:reply.code(404).send({error:'Not found',code:'not_found'});});
 });
 app.get(base+'/proposals',{config},async(request,reply)=>{if(!owner(request,reply))return reply;return attempt(reply,()=>selected.get(request)!.listOwnerIds({table:'memory_file_proposals',pendingOnly:true}));});
 app.get<{Params:{id:string}}>(base+'/proposals/:id',{config},async(request,reply)=>{if(!owner(request,reply))return reply;if(!identifier(request.params.id))return reply.code(400).send({error:'Invalid proposal'});return attempt(reply,()=>selected.get(request)!.readProposal(request.params.id));});
 app.post<{Params:{id:string}}>(base+'/proposals/:id/decision',{config},async(request,reply)=>{
  if(!owner(request,reply))return reply;const requestBody=body(request);if(!identifier(request.params.id)||typeof requestBody.reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(requestBody.reviewHash)||!['approve','reject'].includes(String(requestBody.decision))||Object.keys(requestBody).some(key=>!['reviewHash','decision'].includes(key)))return reply.code(400).send({error:'Reviewed decision required'});
  return attempt(reply,()=>selected.get(request)!.decideProposal(request.params.id,requestBody.reviewHash as string,requestBody.decision as 'approve'|'reject'));
 });
 app.post<{Params:{id:string}}>(base+'/rows/:id/trash',{config},async(request,reply)=>{if(!owner(request,reply))return reply;if(!identifier(request.params.id)||Object.keys(body(request)).length)return reply.code(400).send({error:'Invalid request'});return attempt(reply,()=>selected.get(request)!.deleteToTrash(request.params.id));});
 app.post<{Params:{id:string}}>(base+'/rows/:id/restore',{config},async(request,reply)=>{if(!owner(request,reply))return reply;const requestBody=body(request);if(!identifier(request.params.id)||Object.keys(requestBody).some(key=>key!=='confirmDropTopic')||requestBody.confirmDropTopic!==undefined&&typeof requestBody.confirmDropTopic!=='boolean')return reply.code(400).send({error:'Invalid request'});return attempt(reply,()=>selected.get(request)!.restoreTrash(request.params.id,requestBody.confirmDropTopic===true));});
 app.post<{Params:{id:string}}>(base+'/rows/:id/forget',{config},async(request,reply)=>{if(!owner(request,reply))return reply;const requestBody=body(request);if(!identifier(request.params.id)||requestBody.confirm!==true||Object.keys(requestBody).some(key=>key!=='confirm'))return reply.code(400).send({error:'Explicit confirmation required'});return attempt(reply,()=>selected.get(request)!.forget(request.params.id));});
}

export function registerEncryptedMemoryLegacyGuard(app:FastifyInstance,allowEncryptedBridge=false){
 const base='/api/memory/encryption';
 // Existing plaintext handlers must not silently operate on an injected encrypted profile.
 app.addHook('preHandler',async(request,reply)=>{
  const url=request.routeOptions.url??request.url.split('?')[0];
  // This is an explicitly injected isolated runtime, not a switch for the normal app.
  // Unconverted chat/import/bridge handlers must not reach plaintext stores indirectly.
  const supported=allowEncryptedBridge&&['/api/memory-bridge/mcp/session','/api/memory-bridge/mcp/call'].includes(url)||url.startsWith(base+'/')||url==='/api/health'||url==='/health'||url.startsWith('/api/auth/');
  if(url.startsWith('/api/')&&!supported)return reply.code(503).send({error:'This operation requires an encrypted adapter',code:'encrypted_memory_adapter_required'});
 });
}
