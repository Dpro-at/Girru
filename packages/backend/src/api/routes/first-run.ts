/**
 * FIRSTRUN-01 setup steps after the owner account (owner only).
 *
 *   GET  /api/first-run              -> { pending, step }
 *   PUT  /api/first-run              -> { step: 'tools' | 'model' | 'team' }
 *   GET  /api/first-run/tools        -> { tools: [{ id, name, installed, signedIn, install, signIn, needs? }] }
 *   GET  /api/first-run/local-model  -> { memoryGb, recommended, choices, ollama, installed, install, download, commands }
 *   POST /api/first-run/finish       -> { conversationId } (the Welcome chat)
 *
 * The commands are fixed strings for the owner to run in Girru's terminal; this
 * route never runs anything.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { firstRunDiscovery, startFirstRunDiscovery, stopFirstRunDiscovery } from '../../onboarding/discovery.js';
import { isLoopbackPeer } from '../../auth/setup-token.js';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { handleError } from '../error-handler.js';
import { validCompanyName, FIRST_RUN_STEPS, aiTools, finishFirstRun, firstRunState, localModelCommand, localModelStep, saveFirstRunStep, type FirstRunStep } from '../../onboarding/first-run.js';

const owner = (request: FastifyRequest, reply: FastifyReply) => authorizeActiveRole(request, reply, ['owner'] as const);

export async function firstRunRoutes(fastify: FastifyInstance, options: {discovery?:{home?:string;roots?:string[]}} = {}) {
  fastify.addHook('onClose',async()=>{await stopFirstRunDiscovery();});
  for(const method of ['GET','POST'] as const) fastify.route({method,url:'/api/first-run/discovery',handler:async(request,reply)=>{
    const userId=owner(request,reply);if(userId===null)return reply;
    if(!isLoopbackPeer(request.raw.socket?.remoteAddress))return reply.code(403).send({code:'not_loopback'});
    if(request.body!==undefined||Object.keys(request.query as object??{}).length)return reply.code(400).send({code:'invalid_input'});
    try{return method==='POST'?await startFirstRunDiscovery(userId,options.discovery):await firstRunDiscovery(userId);}catch{return reply.code(500).send({code:'discovery_failed'});}
  }});
  fastify.get('/api/first-run', async (request, reply) => {
    const userId = owner(request, reply); if (userId === null) return reply;
    try { return await firstRunState(userId); } catch (error) { if((error as any)?.code==='discovery_required')return reply.code(409).send({code:'discovery_required'});return handleError(reply, error, 'internal', '[FirstRun]'); }
  });

  fastify.put('/api/first-run', async (request, reply) => {
    const userId = owner(request, reply); if (userId === null) return reply;
    const body = request.body as { step?: unknown; workspaceType?: unknown; companyName?: unknown } | null;
    if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['step', 'workspaceType', 'companyName'].includes(k)) || (Object.hasOwn(body, 'workspaceType') && !['individual', 'company'].includes(body.workspaceType as string)) || !(FIRST_RUN_STEPS as readonly unknown[]).includes(body.step)) return reply.code(400).send({ error: 'step must be discovery, tools, model or team' });
    if (body.workspaceType === 'company' ? !validCompanyName(body.companyName) : Object.hasOwn(body, 'companyName')) return reply.code(400).send({ error: 'Invalid company name' });
    try { return await saveFirstRunStep(userId, body.step as FirstRunStep, body.workspaceType as 'individual' | 'company' | undefined, body.companyName as string | undefined); } catch (error) { if((error as any)?.code==='discovery_required')return reply.code(409).send({code:'discovery_required'});return handleError(reply, error, 'internal', '[FirstRun]'); }
  });

  fastify.get('/api/first-run/tools', async (request, reply) => {
    const userId = owner(request, reply); if (userId === null) return reply;
    try { return { tools: await aiTools() }; } catch (error) { if((error as any)?.code==='discovery_required')return reply.code(409).send({code:'discovery_required'});return handleError(reply, error, 'internal', '[FirstRun]'); }
  });

  fastify.get('/api/first-run/local-model', async (request, reply) => {
    const userId = owner(request, reply); if (userId === null) return reply;
    try {
      const step = await localModelStep();
      return { ...step, commands: Object.fromEntries(step.choices.map(c => [c.id, localModelCommand(step, c.id)])) };
    } catch (error) { if((error as any)?.code==='discovery_required')return reply.code(409).send({code:'discovery_required'});return handleError(reply, error, 'internal', '[FirstRun]'); }
  });

  fastify.post('/api/first-run/finish', async (request, reply) => {
    const userId = owner(request, reply); if (userId === null) return reply;
    try { return await finishFirstRun(userId); } catch (error) { if((error as any)?.code==='discovery_required')return reply.code(409).send({code:'discovery_required'});return handleError(reply, error, 'internal', '[FirstRun]'); }
  });
}
