import {actorOf} from '../../auth/auth-gate.js';
import {actorOrReply,requireOwner} from '../../repositories/scope.js';
import {MAX_PERSONALITY_BYTES,validAgentFileId} from '../../services/agent-files.js';
import {AuthTokenError,verifyRequestTokenAsync} from '../../auth/jwt.js';
/**
 * Agent Files API Routes
 *
 * RESTful endpoints for managing agent PERSONALITY.md and MEMORY.md files
 */

import type { FastifyInstance } from 'fastify';
import {
  readPersonality,
  writePersonality,
  readMemorySnapshot,
  writeMemoryCAS,
  getAgentFiles,
  initializeAgentDir
} from '../../services/agent-files.js';
import { sendInternalError } from '../error-handler.js';
import { storeP4Enabled } from '../../services/store-p4.js';
import { AgentMemoryConflict, AgentMemoryInputError, agentMemoryStatus, agentNotes, saveAgentNotes } from '../../memory/agent-drawer.js';
import { PersonalityVersionConflict, savePersonalityText } from '../../services/personality-record.js';
import { PersonalityInputError } from '../../services/personality.js';
import { PersonalityNotFoundError } from '../../services/personality-store.js';
import { FileLibraryError, addFile, listFiles, listVersions, readFile, readVersion, removeFile, restoreFile, saveFile, setRead } from '../../services/agent-file-library.js';

export async function agentFilesRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/agents/:id/personality - Get PERSONALITY.md
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/agents/:id/personality',
    {config:{access:'owner'}},
    async (request, reply) => {
      if(!actorOrReply(reply,actorOf(request),requireOwner))return reply;
      if(!validAgentFileId(request.params.id))return reply.code(400).send({code:'invalid_agent_id'});
      const { id } = request.params;

      try {
        const content = await readPersonality(id);
        return {
          success: true,
          content
        };
      } catch (err: any) {
        return sendInternalError(reply, '[AgentFiles] GET /api/agents/:id/personality', err);
      }
    }
  );

  /**
   * PUT /api/agents/:id/personality - Update PERSONALITY.md
   */
  fastify.put<{ Params: { id: string }; Body: { content: string } }>(
    '/api/agents/:id/personality',
    {config:{access:'owner'}},
    async (request, reply) => {
      if(!actorOrReply(reply,actorOf(request),requireOwner))return reply;
      if(!validAgentFileId(request.params.id))return reply.code(400).send({code:'invalid_agent_id'});
      const { id } = request.params;
      const content = request.body?.content;

      // STORE-MAP-01 P4 (T7): a version of the one personality record, with a change check
      // (expectedVersion, the version read); the generated settings part is never taken from the body.
      if (storeP4Enabled()) {
        const body = (request.body ?? {}) as { content?: unknown; expectedVersion?: unknown };
        if (typeof body.content!=='string'||Buffer.byteLength(body.content,'utf8')>MAX_PERSONALITY_BYTES||Object.keys(body).some(k=>k!=='content'&&k!=='expectedVersion')) return reply.code(400).send({ success:false, error:'content is required' });
        if (body.expectedVersion===undefined) return reply.code(400).send({ success:false, error:'expectedVersion is required (the version you read)', code:'expected_version_required' });
        try {
          const v = await savePersonalityText(id, body.content, body.expectedVersion, actorOf(request)?.userId ?? 'owner');
          return { success:true, message:'Personality updated', version:v.version };
        } catch (err: any) {
          if (err instanceof PersonalityVersionConflict) return reply.code(409).send({ success:false, code:'changed' });
          if (err instanceof PersonalityInputError) return reply.code(400).send({ success:false, error:err.message });
          if (err instanceof PersonalityNotFoundError) return reply.code(404).send({ success:false, code:'not_found' });
          return sendInternalError(reply, '[AgentFiles] PUT /api/agents/:id/personality', err);
        }
      }

      if (typeof content!=='string'||!content||Buffer.byteLength(content,'utf8')>MAX_PERSONALITY_BYTES||Object.keys(request.body).some(k=>k!=='content')) {
        return reply.code(400).send({
          success: false,
          error: 'content is required'
        });
      }

      try {
        await writePersonality(id, content);
        return {
          success: true,
          message: 'Personality updated'
        };
      } catch (err: any) {
        return sendInternalError(reply, '[AgentFiles] PUT /api/agents/:id/personality', err);
      }
    }
  );

  const memoryOwner=async(request:any,reply:any)=>{
    reply.header('Cache-Control','no-store');
    try{const verified=await verifyRequestTokenAsync(request),actor=request.actor;
      if(!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==verified.userId||verified.user.role!=='owner'){reply.code(403).send({code:'forbidden'});return false;}return true;
    }catch(error){reply.code(error instanceof AuthTokenError?401:503).send({code:'memory_unavailable'});return false;}
  };
  fastify.get<{Params:{id:string}}>('/api/agents/:id/memory',{config:{access:'owner'}},async(request,reply)=>{
    if(!await memoryOwner(request,reply))return;
    if(Object.keys(request.query as object).length)return reply.code(400).send({code:'invalid_memory_request'});
    // STORE-MAP-01 P5: after the import the notes are read from the agent's own drawer (same shape).
    try{const notes=await agentNotes(request.params.id);if(notes)return {success:true,content:notes.content,hash:notes.hash,truncated:false,redacted:false};return {success:true,...await readMemorySnapshot(request.params.id)};}catch{return reply.code(503).send({code:'memory_unavailable'});}
  });
  // STORE-MAP-01 P5: imported or not, history rows, and whether MEMORY.md was changed outside Girru.
  fastify.get<{Params:{id:string}}>('/api/agents/:id/memory/status',{config:{access:'owner'}},async(request,reply)=>{
    if(!await memoryOwner(request,reply))return;
    try{return await agentMemoryStatus(request.params.id);}catch{return reply.code(503).send({code:'memory_unavailable'});}
  });
  fastify.put<{Params:{id:string};Body:{content?:unknown;expectedHash?:unknown}}>('/api/agents/:id/memory',{config:{access:'owner'}},async(request,reply)=>{
    if(!await memoryOwner(request,reply))return;
    const body=request.body;
    if(!body||typeof body.content!=='string'||Buffer.byteLength(body.content,'utf8')>32768||Object.keys(request.query as object).length)return reply.code(400).send({code:'invalid_memory_request'});
    if(!Object.hasOwn(body,'expectedHash')||!(body.expectedHash===null||typeof body.expectedHash==='string'&&/^[a-f0-9]{64}$/.test(body.expectedHash)))return reply.code(409).send({code:'memory_review_required'});
    if(typeof body.expectedHash==='string'&&await agentNotes(request.params.id).catch(()=>null)){
      try{const saved=await saveAgentNotes(request.params.id,body.content,body.expectedHash,(request as any).actor?.userId??'owner');return {success:true,content:saved.content,hash:saved.hash,truncated:false,redacted:saved.redacted};}
      catch(error){return reply.code(error instanceof AgentMemoryConflict||error instanceof AgentMemoryInputError?409:503).send({code:error instanceof AgentMemoryConflict||error instanceof AgentMemoryInputError?'memory_not_written':'memory_write_unconfirmed'});}
    }
    try{return {success:true,...await writeMemoryCAS(request.params.id,body.content,body.expectedHash)};}catch(error){return reply.code(error instanceof Error&&/conflict|reviewed_memory_required|memory_too_large/.test(error.message)?409:503).send({code:error instanceof Error&&/conflict|reviewed_memory_required|memory_too_large/.test(error.message)?'memory_not_written':'memory_write_unconfirmed'});}
  });
  fastify.post('/api/agents/:id/memory/append',{config:{access:'owner'}},async(request,reply)=>{
    if(!await memoryOwner(request,reply))return;
    return reply.code(409).send({code:'memory_review_required'});
  });

  // Agent page › Files (AGENT-FILES-01): owner only. The old unguarded /knowledge routes are gone.
  //   GET  …/library                      { files: [{ name, kind, size, read }], removed: [{ id, name, removedAt }] }
  //   GET  …/library/file?name=           { name, kind, content, hash, managed, redacted, read }
  //   PUT  …/library/file                 { name, content, expectedHash } → { hash, redacted } (409 changed, 413 too_large)
  //   POST …/library/file                 { name, content, read? } → add a Knowledge file (409 name_taken)
  //   POST …/library/remove | /restore | /read     { name } | { id } | { name, read }
  //   GET  …/library/versions?name=  and  …/library/version?name=&id=
  const libraryOwner=(request:any,reply:any)=>{reply.header('Cache-Control','no-store');if(!actorOrReply(reply,actorOf(request),requireOwner))return false;if(!validAgentFileId(request.params.id)){reply.code(400).send({code:'invalid_agent'});return false;}return true;};
  const libraryFail=(reply:any,error:unknown)=>error instanceof FileLibraryError?reply.code(error.status).send({code:error.code}):reply.code(503).send({code:'files_unavailable'});
  const only=(body:unknown,keys:string[])=>!!body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body as object).every(k=>keys.includes(k));
  const lib={config:{access:'owner' as const}};
  fastify.get<{Params:{id:string}}>('/api/agents/:id/library',lib,async(request,reply)=>{
    if(!libraryOwner(request,reply))return reply;
    try{return await listFiles(request.params.id);}catch(error){return libraryFail(reply,error);}
  });
  fastify.get<{Params:{id:string};Querystring:{name?:string}}>('/api/agents/:id/library/file',lib,async(request,reply)=>{
    if(!libraryOwner(request,reply))return reply;
    try{return await readFile(request.params.id,request.query.name);}catch(error){return libraryFail(reply,error);}
  });
  fastify.put<{Params:{id:string};Body:{name?:unknown;content?:unknown;expectedHash?:unknown}}>('/api/agents/:id/library/file',{...lib,bodyLimit:3*1024*1024},async(request,reply)=>{
    if(!libraryOwner(request,reply))return reply;
    const b=request.body;if(!only(b,['name','content','expectedHash'])||!b||!('expectedHash' in b))return reply.code(400).send({code:'invalid_input'});
    try{return await saveFile(request.params.id,b.name,b.content,b.expectedHash);}catch(error){return libraryFail(reply,error);}
  });
  fastify.post<{Params:{id:string};Body:{name?:unknown;content?:unknown;read?:unknown}}>('/api/agents/:id/library/file',{...lib,bodyLimit:3*1024*1024},async(request,reply)=>{
    if(!libraryOwner(request,reply))return reply;
    const b=request.body;if(!only(b,['name','content','read']))return reply.code(400).send({code:'invalid_input'});
    try{return reply.code(201).send(await addFile(request.params.id,b.name,b.content,b.read??true));}catch(error){return libraryFail(reply,error);}
  });
  fastify.post<{Params:{id:string};Body:{name?:unknown}}>('/api/agents/:id/library/remove',lib,async(request,reply)=>{
    if(!libraryOwner(request,reply))return reply;
    if(!only(request.body,['name']))return reply.code(400).send({code:'invalid_input'});
    try{return await removeFile(request.params.id,request.body.name);}catch(error){return libraryFail(reply,error);}
  });
  fastify.post<{Params:{id:string};Body:{id?:unknown}}>('/api/agents/:id/library/restore',lib,async(request,reply)=>{
    if(!libraryOwner(request,reply))return reply;
    if(!only(request.body,['id']))return reply.code(400).send({code:'invalid_input'});
    try{return await restoreFile(request.params.id,request.body.id);}catch(error){return libraryFail(reply,error);}
  });
  fastify.post<{Params:{id:string};Body:{name?:unknown;read?:unknown}}>('/api/agents/:id/library/read',lib,async(request,reply)=>{
    if(!libraryOwner(request,reply))return reply;
    if(!only(request.body,['name','read']))return reply.code(400).send({code:'invalid_input'});
    try{return await setRead(request.params.id,request.body.name,request.body.read);}catch(error){return libraryFail(reply,error);}
  });
  fastify.get<{Params:{id:string};Querystring:{name?:string}}>('/api/agents/:id/library/versions',lib,async(request,reply)=>{
    if(!libraryOwner(request,reply))return reply;
    try{return {versions:await listVersions(request.params.id,request.query.name)};}catch(error){return libraryFail(reply,error);}
  });
  fastify.get<{Params:{id:string};Querystring:{name?:string;id?:string}}>('/api/agents/:id/library/version',lib,async(request,reply)=>{
    if(!libraryOwner(request,reply))return reply;
    try{return await readVersion(request.params.id,request.query.name,request.query.id);}catch(error){return libraryFail(reply,error);}
  });

  /**
   * GET /api/agents/:id/files - Get all agent files
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/agents/:id/files',
    {config:{access:'owner'}},
    async (request, reply) => {
      if(!await memoryOwner(request,reply))return;
      const { id } = request.params;

      try {
        const files = await getAgentFiles(id);
        return {
          success: true,
          ...files
        };
      } catch (err: any) {
        return sendInternalError(reply, '[AgentFiles] GET /api/agents/:id/files', err);
      }
    }
  );

  /**
   * POST /api/agents/:id/initialize - Initialize agent directory
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/agents/:id/initialize',
    {config:{access:'owner'}},
    async (request, reply) => {
      if(!await memoryOwner(request,reply))return;
      const { id } = request.params;

      try {
        await initializeAgentDir(id);
        return {
          success: true,
          message: 'Agent directory initialized'
        };
      } catch (err: any) {
        return sendInternalError(reply, '[AgentFiles] POST /api/agents/:id/initialize', err);
      }
    }
  );
}
