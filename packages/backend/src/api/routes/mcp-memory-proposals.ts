import type {FastifyInstance} from 'fastify';
import {repositories} from '../../repositories/index.js';
import {requestMeta} from '../../repositories/audit.js';
import {actorOf} from '../../auth/auth-gate.js';
import {ScopeError} from '../../repositories/scope.js';
import {MemoryFileError} from '../../memory/memory-files.js';
import {PreparedMemoryError,preparedMemoryContext,prepareMemoryProposal} from '../../services/mcp-memory-proposals.js';

export async function mcpMemoryProposalRoutes(app:FastifyInstance){
 const config={access:'owner' as const};
 app.get('/api/memory/mcp-proposals/context',{config},async(req,reply)=>{
  try{const query=req.query as Record<string,unknown>;if(Object.keys(query).some(k=>k!=='scope'))throw new PreparedMemoryError('Unknown context argument');return await preparedMemoryContext(actorOf(req),query.scope);}catch(error){if(error instanceof ScopeError||error instanceof PreparedMemoryError||error instanceof MemoryFileError)return reply.code(error.status).send({error:error.message});throw error;}
 });
 app.post('/api/memory/mcp-proposals',{config},async(req,reply)=>{
  try{const receipt=await prepareMemoryProposal(actorOf(req),req.body);if(!receipt.replayed)await repositories.audit.record(actorOf(req),{event_type:'data.create',event_category:'data_modification',severity:'info',resource_type:'memory_proposal',resource_id:receipt.proposalId,action:'memory_proposal.prepare',success:true,metadata:{scope:receipt.scope,source:'import',pendingApproval:true}},requestMeta(req));return reply.code(receipt.replayed?200:201).send(receipt);}catch(error){if(error instanceof ScopeError||error instanceof PreparedMemoryError||error instanceof MemoryFileError)return reply.code(error.status).send({error:error.message});throw error;}
 });
}
