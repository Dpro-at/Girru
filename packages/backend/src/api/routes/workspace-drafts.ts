import type {FastifyInstance} from 'fastify';
import {actorOf} from '../../auth/auth-gate.js';
import {ScopeError} from '../../repositories/scope.js';
import {WorkspaceDraftError,draftContext,saveWorkspaceDraft,listWorkspaceDrafts,readWorkspaceDraft} from '../../services/workspace-drafts.js';
export async function workspaceDraftRoutes(app:FastifyInstance){
 const add=(method:'GET'|'POST',url:string,handle:(r:any)=>Promise<unknown>)=>app.route({method,url,config:{access:'owner'},bodyLimit:26000,async handler(req,reply){try{return await handle(req);}catch(error){if(error instanceof WorkspaceDraftError||error instanceof ScopeError)return reply.code(error.status).send({error:error.message});throw error;}}});
 add('GET','/api/workspace-drafts',r=>listWorkspaceDrafts(actorOf(r)));add('GET','/api/workspace-drafts/context',r=>draftContext(actorOf(r),r.query));add('GET','/api/workspace-drafts/:id',r=>readWorkspaceDraft(actorOf(r),r.params.id));add('POST','/api/workspace-drafts',r=>saveWorkspaceDraft(actorOf(r),r.body));
}
