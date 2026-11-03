/**
 * Settings › Phone (MOB-PAIR-01 / MOB-LINK-01): the owner pairs, renames and
 * forgets phones. Owner only (auth gate tier + the check below); an agent, a
 * channel turn or any other service actor is refused. Bodies are exact: an
 * unknown key is a 400.
 *
 *   GET    /api/phone                          { computer, devices, relayUrl, connection, wifi }
 *   POST   /api/phone/pairing                  { path } → { id, qr, expiresAt }
 *   GET    /api/phone/pairing/:id              { state, qr, expiresAt, request?: { name, model, checkCode }, warning?, deviceId? }
 *   POST   /api/phone/pairing/:id/allow        { lifetimeDays, path } → { deviceId }
 *   POST   /api/phone/pairing/:id/deny
 *   DELETE /api/phone/pairing/:id
 *   PATCH  /api/phone/devices/:id              { name?, path?, lifetimeDays? }
 *   DELETE /api/phone/devices/:id              forget
 *   POST   /api/phone/devices/forget-all       → { forgotten }
 *   PUT    /api/phone/settings                 { relayUrl }
 *
 * Errors are { code }: invalid_request, not_found, wifi_off, no_request, pairing_closed, identity_unavailable.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { phoneLink, PhoneLinkError } from '../../phone/service.js';
import { PhoneStoreError, isLifetime, isPath, validRelayUrl } from '../../phone/store.js';
import { cleanName } from '../../phone/protocol/pairing.js';

const PAIRING_ID = /^ps_[A-Za-z0-9_-]{22}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{43}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;

type Req = FastifyRequest<{ Params: { id?: string }; Body: unknown }>;

function ownerOf(request: FastifyRequest, reply: FastifyReply): string | null {
  const u = request.authUser, a = request.actor;
  if (!u) { reply.code(401).send({ code: 'unauthenticated' }); return null; }
  if (u.role !== 'owner' || (a && (a.kind !== 'user' || a.userId !== u.id))) { reply.code(403).send({ code: 'owner_only' }); return null; }
  return u.id;
}

const bad = (reply: FastifyReply) => reply.code(400).send({ code: 'invalid_request' });
const notFound = (reply: FastifyReply) => reply.code(404).send({ code: 'not_found' });

/** A plain object with only these keys (all required unless listed as optional). */
function exact(body: unknown, required: string[], optional: string[] = []): Record<string, unknown> | null {
  if (body === undefined && !required.length) return {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !required.includes(k) && !optional.includes(k))) return null;
  if (required.some((k) => !Object.hasOwn(b, k))) return null;
  return b;
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof PhoneLinkError) return reply.code(err.status).send({ code: err.code });
  if (err instanceof PhoneStoreError) return reply.code(503).send({ code: err.code });
  throw err;
}

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export async function phoneRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  fastify.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });

  fastify.get('/api/phone', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (!owner) return reply;
    try { return await phoneLink().overview(owner); } catch (err) { return fail(reply, err); }
  });

  fastify.post('/api/phone/pairing', { config }, async (request: Req, reply) => {
    const owner = ownerOf(request, reply); if (!owner) return reply;
    const b = exact(request.body, ['path']);
    if (!b || !isPath(b.path)) return bad(reply);
    try {
      const r = await phoneLink().startPairing(owner, b.path);
      return reply.code(201).send({ id: r.id, qr: r.qr, expiresAt: iso(r.expiresAt) });
    } catch (err) { return fail(reply, err); }
  });

  fastify.get('/api/phone/pairing/:id', { config }, async (request: Req, reply) => {
    const owner = ownerOf(request, reply); if (!owner) return reply;
    if (!PAIRING_ID.test(request.params.id ?? '')) return notFound(reply);
    const v = phoneLink().pairingView(request.params.id!, owner);
    if (!v) return notFound(reply);
    return { ...v, expiresAt: iso(v.expiresAt) };
  });

  fastify.post('/api/phone/pairing/:id/allow', { config }, async (request: Req, reply) => {
    const owner = ownerOf(request, reply); if (!owner) return reply;
    if (!PAIRING_ID.test(request.params.id ?? '')) return notFound(reply);
    const b = exact(request.body, ['lifetimeDays', 'path']);
    if (!b || !isLifetime(b.lifetimeDays) || !isPath(b.path)) return bad(reply);
    try { return await phoneLink().allow(request.params.id!, owner, { lifetimeDays: b.lifetimeDays, path: b.path }); } catch (err) { return fail(reply, err); }
  });

  fastify.post('/api/phone/pairing/:id/deny', { config }, async (request: Req, reply) => {
    const owner = ownerOf(request, reply); if (!owner) return reply;
    if (!PAIRING_ID.test(request.params.id ?? '')) return notFound(reply);
    if (!exact(request.body, [])) return bad(reply);
    try { phoneLink().deny(request.params.id!, owner); return { ok: true }; } catch (err) { return fail(reply, err); }
  });

  fastify.delete('/api/phone/pairing/:id', { config }, async (request: Req, reply) => {
    const owner = ownerOf(request, reply); if (!owner) return reply;
    if (!PAIRING_ID.test(request.params.id ?? '')) return notFound(reply);
    try { phoneLink().closePairing(request.params.id!, owner); return { ok: true }; } catch (err) { return fail(reply, err); }
  });

  fastify.patch('/api/phone/devices/:id', { config }, async (request: Req, reply) => {
    const owner = ownerOf(request, reply); if (!owner) return reply;
    if (!DEVICE_ID.test(request.params.id ?? '')) return notFound(reply);
    const b = exact(request.body, [], ['name', 'path', 'lifetimeDays']);
    if (!b || !Object.keys(b).length) return bad(reply);
    if (b.name !== undefined && (typeof b.name !== 'string' || !NAME.test(b.name.trim()))) return bad(reply);
    if (b.path !== undefined && !isPath(b.path)) return bad(reply);
    if (b.lifetimeDays !== undefined && !isLifetime(b.lifetimeDays)) return bad(reply);
    const patch = { ...(b.name !== undefined ? { name: cleanName(b.name) } : {}), ...(b.path !== undefined ? { path: b.path as 'anywhere' | 'wifi' } : {}), ...(b.lifetimeDays !== undefined ? { lifetimeDays: b.lifetimeDays as 30 | 60 | 90 | 120 | null } : {}) };
    try { return (await phoneLink().patchDevice(owner, request.params.id!, patch)) ? { ok: true } : notFound(reply); } catch (err) { return fail(reply, err); }
  });

  fastify.delete('/api/phone/devices/:id', { config }, async (request: Req, reply) => {
    const owner = ownerOf(request, reply); if (!owner) return reply;
    if (!DEVICE_ID.test(request.params.id ?? '')) return notFound(reply);
    try { return (await phoneLink().forget(owner, request.params.id!)) ? { ok: true } : notFound(reply); } catch (err) { return fail(reply, err); }
  });

  fastify.post('/api/phone/devices/forget-all', { config }, async (request: Req, reply) => {
    const owner = ownerOf(request, reply); if (!owner) return reply;
    if (!exact(request.body, [])) return bad(reply);
    try { return { forgotten: await phoneLink().forgetAll(owner) }; } catch (err) { return fail(reply, err); }
  });

  fastify.put('/api/phone/settings', { config }, async (request: Req, reply) => {
    const owner = ownerOf(request, reply); if (!owner) return reply;
    const b = exact(request.body, ['relayUrl']);
    if (!b || !validRelayUrl(b.relayUrl)) return bad(reply);
    try { await phoneLink().setRelayUrl(b.relayUrl); return { relayUrl: b.relayUrl }; } catch (err) { return fail(reply, err); }
  });
}
