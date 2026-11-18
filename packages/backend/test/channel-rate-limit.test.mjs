import './fixtures/channel-library.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import Database from 'better-sqlite3';
import { registerChannelRoutes, stopChannel } from '../extensions/shared/channel-host.js';
import { RATE_LIMIT_PLUGIN_OPTIONS } from '../src/api/rate-limit-config.ts';

test('channel routes are rate limited inside the extension scope (CodeQL js/missing-rate-limiting)', async () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE extension_configs (extension_id TEXT PRIMARY KEY, enabled INTEGER); INSERT INTO extension_configs VALUES ('agent-connect', 1)");
  const app = Fastify();
  await app.register(rateLimit, { ...RATE_LIMIT_PLUGIN_OPTIONS });
  const api = { db, getConfig: () => ({}), setConfig() {}, log() {}, authorizeChannelRequest: () => 'owner' };
  await app.register(async child => registerChannelRoutes(child, api, 'telegram', {
    extensionId: 'agent-connect',
    createConnector: () => ({ state: 'disconnected', async connect() {}, async disconnect() {}, async send() { return { id: 'x' }; } }),
  }), { prefix: '/telegram' });
  try {
    await app.ready();
    const codes = [];
    for (let n = 0; n < 21; n++) codes.push((await app.inject({ method: 'POST', url: '/telegram/connect' })).statusCode);
    assert.ok(codes.slice(0, 20).every(c => c !== 429), 'the first 20 connects are not limited');
    const last = await app.inject({ method: 'POST', url: '/telegram/connect' });
    assert.equal(last.statusCode, 429);
    assert.equal(last.json().code, 'rate_limited');
    assert.notEqual((await app.inject({ url: '/telegram/status' })).statusCode, 429, 'each route has its own bucket');
  } finally { await stopChannel('telegram'); await app.close(); db.close(); }
});
