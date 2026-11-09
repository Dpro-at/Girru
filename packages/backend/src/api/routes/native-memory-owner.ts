import {currentMemoryReadOrigin} from '../../memory/encryption/read-origin-context.js';
/** Authenticated metadata-only entry to native owner review. No path, key or callback is accepted from the page. */
import type {FastifyInstance} from 'fastify';
export interface NativeMemoryPreparationService{request:(ownerId:string,token:string,method:'profiles'|'source-select'|'profile-prepare'|'profile-activate'|'document-pick'|'background-definitions'|'background-approve',input:Record<string,unknown>)=>Promise<unknown>}
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');
export async function nativeMemoryOwnerRoutes(app:FastifyInstance,options:{service?:NativeMemoryPreparationService}={}){
 for(const [suffix,method,http]of [['profiles','profiles','GET'],['select-source-copy','source-select','POST'],['prepare-new-profile','profile-prepare','POST'],['activate-profile','profile-activate','POST'],['pick-document','document-pick','POST'],['background-definitions','background-definitions','GET'],['background-approve','background-approve','POST']]as const){
  app.route({method:http,url:'/api/memory/encryption/native/'+suffix,bodyLimit:2048,config:{access:'owner',rateLimit:{max:10,timeWindow:'1 minute'}},handler:async(request,reply)=>{
   reply.header('Cache-Control','no-store');if(!request.authUser)return reply.code(401).send({code:'unauthenticated'});if(request.authUser.role!=='owner')return reply.code(403).send({code:'forbidden'});
   const query=request.query as Record<string,unknown>;if(query&&Object.keys(query).length)return reply.code(400).send({code:'invalid_input'});
   const input=http==='GET'?{}:request.body,keys=method==='profile-prepare'?['sourceId']:method==='profile-activate'?['profileId','reviewNonce']:method==='background-approve'?['kind','id']:[];
   if(http==='GET'&&request.body!==undefined||!exact(input,keys)||method==='profile-prepare'&&input.sourceId!==null&&(typeof input.sourceId!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.sourceId))||method==='profile-activate'&&(typeof input.profileId!=='string'||!/^owned-[A-Za-z0-9-]{1,128}$/.test(input.profileId)||typeof input.reviewNonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.reviewNonce)))return reply.code(400).send({code:'invalid_input'});
   if(method==='background-approve'&&(!['task','agent-cron'].includes(String(input.kind))||typeof input.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(input.id)))return reply.code(400).send({code:'invalid_input'});
   if(method==='background-approve'&&currentMemoryReadOrigin())return reply.code(403).send({code:'interactive_owner_required'});
   const authorization=request.headers.authorization,match=typeof authorization==='string'?/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization):null;if(!match)return reply.code(401).send({code:'unauthenticated'});
   if(!options.service)return reply.code(503).send({code:'native_memory_preparation_unavailable'});
   try{return await options.service.request(request.authUser.id,match[1],method,input);}catch{return reply.code(503).send({code:'native_memory_preparation_unavailable'});}
  }});
 }
}
