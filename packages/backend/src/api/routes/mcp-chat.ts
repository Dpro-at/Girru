import type {FastifyInstance} from 'fastify';
import {actorOf} from '../../auth/auth-gate.js';
import {ScopeError} from '../../repositories/scope.js';
import {McpChatError,readMcpMessages,sendMcpMessage} from '../../services/mcp-chat.js';
export async function mcpChatRoutes(app:FastifyInstance,options:{start?:typeof import('./chat-conversations.js').startTurn}={}){
 const wrap=(method:'GET'|'POST',url:string,handle:(r:any)=>Promise<unknown>)=>app.route({method,url,config:{access:'owner'},bodyLimit:12000,async handler(req,reply){try{return await handle(req);}catch(error){if(error instanceof ScopeError||error instanceof McpChatError)return reply.code(error.status).send({error:error.message});throw error;}}});
 wrap('GET','/api/chat/mcp/conversations/:id/messages',r=>readMcpMessages(actorOf(r),r.params.id,r.query));
 wrap('POST','/api/chat/mcp/conversations/:id/send',async r=>sendMcpMessage(actorOf(r),r.params.id,r.body,options.start??(await import('./chat-conversations.js')).startTurn));
}
