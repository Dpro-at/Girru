import type { FastifyInstance } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { isLoopbackPeer } from './terminal.js';
import { listSshKeys, publicKeyLine } from '../../services/ssh-keys.js';

const ID = /^[a-f0-9]{64}$/;

/**
 * Settings › Security › SSH keys (SSH-KEYS-01). Owner only, from this computer only.
 *   GET /api/security/ssh-keys             every key: name, type, fingerprint, comment, where, hosts
 *   GET /api/security/ssh-keys/:id/public  the public key line (for Copy public key)
 * Private keys are never opened; there is no route that could return one.
 */
export async function sshKeysRoutes(app: FastifyInstance, options: { home?: string } = {}) {
  const guard = (request: Parameters<typeof authorizeActiveRole>[0], reply: Parameters<typeof authorizeActiveRole>[1]) => {
    if (!authorizeActiveRole(request, reply, ['owner'])) return false;
    if (!isLoopbackPeer(request)) { reply.code(403).send({ code: 'not_loopback' }); return false; }
    return true;
  };
  app.get('/api/security/ssh-keys', { config: { access: 'owner' } }, async (request, reply) => {
    if (!guard(request, reply)) return;
    if (Object.keys(request.query as object).length) return reply.code(400).send({ code: 'invalid_input' });
    reply.header('Cache-Control', 'no-store');
    return { keys: await listSshKeys(options.home) };
  });
  app.get<{ Params: { id: string } }>('/api/security/ssh-keys/:id/public', { config: { access: 'owner' } }, async (request, reply) => {
    if (!guard(request, reply)) return;
    if (!ID.test(request.params.id) || Object.keys(request.query as object).length) return reply.code(400).send({ code: 'invalid_input' });
    reply.header('Cache-Control', 'no-store');
    const line = await publicKeyLine(request.params.id, options.home);
    return line ? { publicKey: line } : reply.code(404).send({ code: 'not_found' });
  });
}
