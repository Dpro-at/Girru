/**
 * GENVR-WORLD-01 (board W1, GV1e): a world's folder, project and Girru chat, who answers, the chat's
 * latest lines and the world behind a chat project. Owner only. The Studio chat itself is a Girru chat run.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { chooseWorldAgent, openWorld, WorldError, worldHistory, worldOfChatProject } from '../../services/genvr-world.js';
import { safeConsole, safeErrorFields } from '../../services/safe-error-log.js';
import { redactSecrets } from '../../services/secret-redact.js';

const OWNER_ONLY = ['owner'] as const;
type Req = FastifyRequest<{ Params: { id: string } }>;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export async function genvrWorldRoutes(app: FastifyInstance) {
  const config = { access: 'owner' as const };
  const asOwner = (fn: (ownerId: string, request: Req, reply: FastifyReply) => Promise<unknown>) => async (request: Req, reply: FastifyReply) => {
    const ownerId = authorizeActiveRole(request, reply, OWNER_ONLY);
    if (ownerId === null) return reply;
    try { return await fn(ownerId, request, reply); }
    catch (error) {
      // A failure shown in plain words keeps its raw reason in the log.
      if (error instanceof WorldError && error.cause instanceof Error) safeConsole.log('[GenVR world] failed', { ...safeErrorFields(error.cause), reason: redactSecrets(error.cause.message).text.replace(/\s+/g, ' ').slice(0, 300) });
      if (error instanceof WorldError) return reply.code(error.status).send({ code: error.code, ...(error.message !== error.code ? { message: error.message } : {}) });
      // The reason, with secrets taken out, so a failed turn can be understood from the log.
      const reason = error instanceof Error ? redactSecrets(error.message).text.replace(/\s+/g, ' ').slice(0, 300) : '';
      safeConsole.log('[GenVR world] failed', { ...safeErrorFields(error), ...(reason ? { reason } : {}) });
      return reply.code(502).send({ code: 'model_unavailable', message: 'The agent could not answer. Try again or pick another agent.' });
    }
  };
  app.post('/api/genvr/worlds/:id/open', { config }, asOwner(async (owner, request) => {
    const body = request.body;
    if (!record(body) || Object.keys(body).join() !== 'name' || typeof body.name !== 'string' || body.name.length > 200) throw new WorldError(400, 'invalid_input');
    return openWorld(owner, request.params.id, body.name);
  }));
  app.put('/api/genvr/worlds/:id/agent', { config }, asOwner(async (owner, request) => {
    const body = request.body;
    if (!record(body) || Object.keys(body).join() !== 'agentId' || typeof body.agentId !== 'string') throw new WorldError(400, 'invalid_input');
    return { answerer: await chooseWorldAgent(owner, request.params.id, body.agentId) };
  }));
  app.get('/api/genvr/worlds/:id/history', { config }, asOwner(async (owner, request) => worldHistory(owner, request.params.id)));
  app.get('/api/genvr/worlds/of-chat-project/:id', { config }, asOwner(async (owner, request, reply) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(request.params.id)) throw new WorldError(400, 'invalid_input');
    const world = await worldOfChatProject(owner, request.params.id);
    return world ?? reply.code(404).send({ code: 'not_found' });
  }));
}
