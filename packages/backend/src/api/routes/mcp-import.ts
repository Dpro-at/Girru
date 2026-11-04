import type { FastifyInstance } from 'fastify';
import { LocalMcpImport, LocalMcpError } from '../../mcp-client/local-import.js';
import { McpFoundList } from '../../mcp-client/found.js';
import { logAudit } from '../../services/audit-logger.js';
const KEY = /^[a-f0-9]{64}$/;
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export async function mcpImportRoutes(app: FastifyInstance, options: {store?: LocalMcpImport; found?: McpFoundList} = {}) {
 const store=options.store??new LocalMcpImport();
 const found=options.found??new McpFoundList(store.home);
 const owner=(request:{authUser?:{id:string;role:string}|null},reply:{code(n:number):{send(x:unknown):unknown}})=>{const user=request.authUser;if(!user){reply.code(401).send({code:'unauthenticated'});return null;}if(user.role!=='owner'){reply.code(403).send({code:'forbidden'});return null;}return user.id;};
 for(const action of ['scan','preview','import'] as const) app.post<{Body:Record<string,unknown>}>('/api/mcp-import/'+action,{config:{access:'owner'}},async(request,reply)=>{
  const user=request.authUser;if(!user)return reply.code(401).send({code:'unauthenticated'});if(user.role!=='owner')return reply.code(403).send({code:'forbidden'});
  const body=request.body;const keys=action==='scan'?[]:action==='preview'?['scanId','sourceId']:['scanId','sourceId','hash'];
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!==keys.sort().join(',')||keys.some(k=>typeof body[k]!=='string'||!(k==='hash'?/^[a-f0-9]{64}$/:/^[a-f0-9-]{36}$/).test(body[k] as string)))return reply.code(400).send({code:'invalid_input'});
  try {
   if(action==='scan')return await store.scan(user.id);
   if(action==='preview')return await store.preview(user.id,String(body.scanId),String(body.sourceId));
   const result=await store.import(user.id,String(body.scanId),String(body.sourceId),String(body.hash));
   logAudit({event_type:'mcp.server.change',event_category:'system',severity:'info',user_id:user.id,action:'mcp_server.import_disabled',success:true,resource_type:'mcp_server',resource_id:result.id,metadata:{duplicate:result.duplicate}});return result;
  }catch(error){if(error instanceof LocalMcpError)return reply.code(error.status).send({code:error.code});return reply.code(400).send({code:'import_unavailable'});}
 });

 // MCP-ONE-01 "Found, not added": one list across the coding apps and Store apps, read on every visit.
 app.get('/api/mcp-import/found',{config:{access:'owner'}},async(request,reply)=>{
  const id=owner(request,reply);if(id===null)return reply;
  if(Object.keys(request.query as object).length)return reply.code(400).send({code:'invalid_input'});
  reply.header('Cache-Control','no-store');
  try{const {rows,girru,skipped}=await found.list(id);return {rows,girru,skipped};}catch{return reply.code(400).send({code:'import_unavailable'});}
 });
 app.post<{Body:Record<string,unknown>}>('/api/mcp-import/found/add',{config:{access:'owner'}},async(request,reply)=>{
  const id=owner(request,reply);if(id===null)return reply;
  const b=request.body;
  if(!plain(b)||Object.keys(b).sort().join(',')!=='keepSecrets,key'||typeof b.key!=='string'||!KEY.test(b.key)||typeof b.keepSecrets!=='boolean')return reply.code(400).send({code:'invalid_input'});
  try{
   const result=await found.add(id,b.key,b.keepSecrets);
   logAudit({event_type:'mcp.server.change',event_category:'system',severity:'info',user_id:id,action:'mcp_server.import_disabled',success:true,resource_type:'mcp_server',resource_id:result.id,metadata:{duplicate:result.duplicate,keepSecrets:b.keepSecrets}});
   return result;
  }catch(error){if(error instanceof LocalMcpError)return reply.code(error.status).send({code:error.code});return reply.code(400).send({code:'import_unavailable'});}
 });
 app.post<{Body:Record<string,unknown>}>('/api/mcp-import/found/hide',{config:{access:'owner'}},async(request,reply)=>{
  if(owner(request,reply)===null)return reply;
  const b=request.body;
  if(!plain(b)||Object.keys(b).sort().join(',')!=='hidden,key'||typeof b.key!=='string'||!KEY.test(b.key)||typeof b.hidden!=='boolean')return reply.code(400).send({code:'invalid_input'});
  await found.hide(b.key,b.hidden);return {ok:true};
 });
}
