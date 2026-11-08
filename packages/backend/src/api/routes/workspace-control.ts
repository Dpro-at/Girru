import type {FastifyInstance} from 'fastify';
import {actorOf} from '../../auth/auth-gate.js';
import {auditMcpOutcome} from '../../services/mcp-audit.js';
import {ScopeError} from '../../repositories/scope.js';
import {ControlError,previewWorkspaceControl,requestWorkspaceControl,workspaceControlStatus,workspaceControlHistory,workspaceControlOptions} from '../../services/workspace-control.js';
export async function workspaceControlRoutes(app:FastifyInstance){
 const add=(method:'GET'|'POST',url:string,handler:(r:any)=>Promise<unknown>)=>app.route({method,url,bodyLimit:64000,config:{access:'owner'},async handler(req,reply){try{const actor=actorOf(req);if(!actor)throw new ScopeError(401,'Owner required');return await handler(req);}catch(error){if(method==='POST')auditMcpOutcome(actorOf(req)?.userId,'workspace_control.'+(url.endsWith('/request')?'request':'preview')+'.external','workspace_control',undefined,'refused',error instanceof ControlError||error instanceof ScopeError?error.status:400);if(error instanceof ControlError||error instanceof ScopeError)return reply.code(error.status).send({error:error.message});const code=error&&typeof error==='object'&&'code' in error?String(error.code):'control_invalid_or_unavailable';return reply.code(400).send({error:code});}}});
 add('GET','/api/workspace-control/options',r=>workspaceControlOptions(actorOf(r)!));
 add('GET','/api/workspace-control/history',r=>workspaceControlHistory(actorOf(r)!));
 add('POST','/api/workspace-control/preview',r=>previewWorkspaceControl(actorOf(r)!,r.body));
 add('POST','/api/workspace-control/request',r=>requestWorkspaceControl(actorOf(r)!,r.body));
 add('GET','/api/workspace-control/:id',r=>workspaceControlStatus(actorOf(r)!,r.params.id));
}
