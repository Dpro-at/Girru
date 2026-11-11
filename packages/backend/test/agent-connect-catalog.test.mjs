import './fixtures/channel-library.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import extension from './fixtures/agent-connect-legacy/index.js';

test('expanded host protects all catalog routes, hides provider settings and preserves blank credential updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-connect-host-'));
  // Server-side runtime settings (S0-Q.6): state stays in the temp dir, interpreter does not exist.
  process.env.AGENT_CONNECT_STATE_DIR = directory;
  process.env.AGENT_CONNECT_PYTHON = join(directory, 'missing-python');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE extension_configs (extension_id TEXT PRIMARY KEY, enabled INTEGER); INSERT INTO extension_configs VALUES (\'agent-connect\', 1)');
  let config = {};
  const app = Fastify();
  const api = {
    db, getConfig: () => config, setConfig: value => { config = value; }, log() {},
    authorizeChannelRequest(request) {
      if (request.headers.authorization !== 'Bearer owner') throw new Error('Forbidden');
      return 'owner';
    },
    async processChannelMessage() { throw new Error('Automatic replies should be off'); },
    registerRoutes(fn) { app.register(fn, { prefix: '/api/ext/agent-connect' }); },
    registerTool() {},
  };
  await extension.register(api);
  await app.ready();
  const auth = { authorization: 'Bearer owner' };
  try {
    const catalog = (await app.inject({ url: '/api/ext/agent-connect/catalog', headers: auth })).json();
    assert.equal(catalog.channels.length, 33);
    // CHANNELS-01: every catalog channel, Telegram and Discord included, is hosted here.
    for (const channel of catalog.channels) {
      const url = `/api/ext/agent-connect/${channel.id}/config`;
      assert.equal((await app.inject({ url })).statusCode, 403);
      assert.equal((await app.inject({ url, headers: auth })).statusCode, 200);
    }
    const url = '/api/ext/agent-connect/ntfy/config';
    const saved = await app.inject({ method: 'PUT', url, headers: auth, payload: { config: {
      configured: true, environment: { NTFY_TOKEN: 'private-test-value' }, settings: { token: 'private-settings-value' },
      allowed_users: 'topic', allowed_channels: 'topic', state_directory: 'ntfy-test',
    } } });
    assert.equal(saved.statusCode, 200);
    const read = await app.inject({ url, headers: auth });
    assert.equal(read.body.includes('private-test-value'), false);
    assert.equal(read.body.includes('private-settings-value'), false);
    assert.equal(read.json().config.auto_reply, false);
    await app.inject({ method: 'PUT', url, headers: auth, payload: { config: { allowed_users: 'topic,other' } } });
    assert.equal(config.channels.ntfy.environment.NTFY_TOKEN, 'private-test-value');
    assert.equal(config.channels.ntfy.owner_user_id, 'owner');
    const forbidden = await app.inject({ method: 'PUT', url, headers: auth, payload: { config: { environment: { PYTHONPATH: 'untrusted' } } } });
    assert.equal(forbidden.statusCode, 400);
    assert.equal(config.channels.ntfy.environment.NTFY_TOKEN, 'private-test-value');
  } finally {
    await app.close(); db.close(); await rm(directory, { recursive: true, force: true });
  }
});
