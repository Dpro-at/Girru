import {registerSelectedRequestOperations,type SelectedRequestOperation} from './selected-request-operation.js';
/** Isolated selected-copy HTTP host. Never imports normal application startup or opens a default database. */
import Fastify from 'fastify';
import {registerLaunchToken} from './launch-token.js';
import {registerEncryptedMemoryRoutes} from './routes/encrypted-memory.js';
import {userActor} from '../repositories/actor.js';
import type {createSelectedEncryptedMemoryHost} from '../memory/encryption/selected-host.js';
import {MemoryCipherError} from '../memory/encryption/envelope.js';
type Host=Awaited<ReturnType<typeof createSelectedEncryptedMemoryHost>>;
const loopback=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const sessionPath='/api/memory-bridge/mcp/session',callPath='/api/memory-bridge/mcp/call';
export async function buildSelectedEncryptedMemoryServer(input:{runOperation:SelectedRequestOperation;host:Host;launchToken:string;bridge?:Parameters<Host['createBridge']>[0]}){
 const {host,launchToken}=input;
 if(!host||typeof launchToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(launchToken))throw new MemoryCipherError();
 // Logging is deliberately disabled: no request bodies, query tokens or plaintext results are retained.
 const app=Fastify({logger:false,bodyLimit:1024*1024,trustProxy:false});
 let bridge:ReturnType<Host['createBridge']>|undefined;
 try{
  registerLaunchToken(app,launchToken);
  registerSelectedRequestOperations(app,input.runOperation);
  app.decorateRequest('authUser',null);app.decorateRequest('actor',null);
  app.addHook('onRequest',async(request,reply)=>{
   if(!loopback.has(request.socket.remoteAddress??''))return reply.code(403).send({error:'Forbidden',code:'forbidden'});
   const route=request.routeOptions.url;
   if(route==='/health'||bridge&&(route===sessionPath||route===callPath))return;
   const header=request.headers.authorization;
   if(typeof header!=='string'||!/^Bearer [^\s]+$/.test(header))return reply.code(401).send({error:'Authentication required',code:'unauthenticated'});
   try{const user=await host.authenticateOwner(header.slice(7));request.authUser=user;request.actor=userActor(user);}catch{return reply.code(401).send({error:'Authentication required',code:'unauthenticated'});}
  });
  app.addHook('onReady',async()=>{await input.runOperation(()=>host.runtime.start());});
  app.addHook('onClose',async()=>{bridge?.close();await host.runtime.close();});
  app.setErrorHandler((_error,_request,reply)=>{reply.code(409).send({error:'Encrypted memory operation unavailable',code:'encrypted_memory_unavailable'});});
  app.get('/health',async()=>({status:host.runtime.status(),activationReady:false}));
  await registerEncryptedMemoryRoutes(app,host.runtime);
  if(input.bridge){
   bridge=host.createBridge(input.bridge);const adapter=bridge.bridge;
   app.post<{Body:{client:string;nonce:string;proof:string}}>(sessionPath,async(request)=>{
    const body=request.body;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['client','nonce','proof'].includes(key)))throw new MemoryCipherError();return adapter.openSession(body);
   });
   app.post<{Body:{client:string;tool:string;args?:Record<string,unknown>;cwd?:string}}>(callPath,async(request)=>{
    const body=request.body,sessionToken=request.headers['x-dpro-bridge-token'],capabilityToken=request.headers['x-girru-capability'];
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['client','tool','args','cwd'].includes(key))||typeof sessionToken!=='string'||typeof capabilityToken!=='string')throw new MemoryCipherError();
    return adapter.call({client:body.client,tool:body.tool,args:body.args??{},cwd:body.cwd,sessionToken,capabilityToken});
   });
  }
  return Object.freeze({
   /** A trusted desktop host may choose a free port, never a network-facing address. */
   async listen(port=0){if(!Number.isInteger(port)||port<0||port>65535)throw new MemoryCipherError();try{return await app.listen({host:'127.0.0.1',port});}catch{await app.close();throw new MemoryCipherError();}},
   close:()=>app.close(),
  });
 }catch{bridge?.close();try{await app.close();}finally{await host.runtime.close();}throw new MemoryCipherError();}
}

/** Separate pre-activation owner review surface; never registers normal memory routes or starts its runtime. */
export async function buildSelectedDocumentAdmissionServer(input:{runOperation:SelectedRequestOperation;host:Host;review:Awaited<ReturnType<Host['openDocumentAdmissionReview']>>;launchToken:string}){
 const {host,review,launchToken}=input;
 if(!host||!review||review.status()!=='ready'||typeof launchToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(launchToken))throw new MemoryCipherError();
 const app=Fastify({logger:false,bodyLimit:65536,trustProxy:false});registerLaunchToken(app,launchToken);registerSelectedRequestOperations(app,input.runOperation);
 app.addHook('onRequest',async(request,reply)=>{if(!loopback.has(request.socket.remoteAddress??''))return reply.code(403).send({code:'forbidden'});const bearer=request.headers.authorization;if(typeof bearer!=='string'||!/^Bearer [^\s]+$/.test(bearer))return reply.code(401).send({code:'unauthenticated'});try{await host.authenticateOwner(bearer.slice(7));}catch{return reply.code(401).send({code:'unauthenticated'});}});
 app.setErrorHandler((_error,_request,reply)=>reply.code(409).send({code:'encrypted_document_review_unavailable'}));
 app.addHook('onClose',async()=>{await review.close();await host.runtime.close();});
 app.get('/api/memory/encryption/document-imports',()=>review.list());
 app.post<{Body:{fileId:string}}>('/api/memory/encryption/document-imports',request=>{const b=request.body;if(!b||Object.keys(b).join(',')!=='fileId'||typeof b.fileId!=='string'||!/^[a-f0-9]{32}$/.test(b.fileId))throw new MemoryCipherError();return review.preview(b.fileId);});
 app.get<{Params:{id:string}}>('/api/memory/encryption/document-imports/:id',request=>review.read(request.params.id));
 app.post<{Params:{id:string};Body:{reviewHash:string;decision:'approve'|'reject';confirmation?:string}}>('/api/memory/encryption/document-imports/:id/decision',request=>{const b=request.body;if(!b||Object.keys(b).some(key=>!['reviewHash','decision','confirmation'].includes(key)))throw new MemoryCipherError();return review.decide({admissionId:request.params.id,...b});});
 app.post<{Body:Parameters<typeof review.configureSource>[0]}>('/api/memory/encryption/document-sources',request=>{const b=request.body;if(!b||Object.keys(b).sort().join(',')!=='enabled,expectedRevision,kind,refId')throw new MemoryCipherError();return review.configureSource(b);});
 return Object.freeze({async listen(port=0){if(!Number.isInteger(port)||port<0||port>65535)throw new MemoryCipherError();try{return await app.listen({host:'127.0.0.1',port});}catch{await app.close();throw new MemoryCipherError();}},close:()=>app.close()});
}
