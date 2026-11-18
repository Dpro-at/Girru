import './fixtures/channel-library.mjs';
// S0-Q.6: Agent Connect channel config cannot choose the interpreter, pass
// dangerous or foreign environment variables, or move state outside the
// server-controlled directory.
// Run: node --test test/agent-connect-config.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { CHANNEL_CATALOG } from 'agent-connect-dpro';
import extension from './fixtures/agent-connect-legacy/index.js';
import {
  isAllowedEnvironmentKey, isValidEnvironment, isValidSettings, filterSettings, isValidStateDirectory, resolvePythonExecutable,
  resolveStateDirectory, transportOptions, DEFAULT_PYTHON,
} from '../extensions/shared/channel-policy.js';

const base = await mkdtemp(join(tmpdir(), 'agent-connect-config-'));
const env = { AGENT_CONNECT_STATE_DIR: base, AGENT_CONNECT_PYTHON: '/opt/server/python3' };
test.after(() => rm(base, { recursive: true, force: true }));

test('interpreter comes from the server environment or the fixed default, never from config', () => {
  assert.equal(resolvePythonExecutable(env), '/opt/server/python3');
  assert.equal(resolvePythonExecutable({}), DEFAULT_PYTHON);
  const options = transportOptions('ntfy', { python_executable: '/tmp/evil', configured: true }, env);
  assert.equal(options.pythonExecutable, '/opt/server/python3');
  assert.equal(transportOptions('ntfy', { python_executable: '/tmp/evil' }, {}).pythonExecutable, DEFAULT_PYTHON);
});

test('state directory is confined under the server base directory', () => {
  assert.equal(resolveStateDirectory('ntfy', undefined, env), join(base, 'ntfy'));
  assert.equal(resolveStateDirectory('ntfy', 'team/ntfy', env), join(base, 'team', 'ntfy'));
  for (const bad of ['/etc', '/tmp/x', '..', '../x', 'a/../../x', 'a/..', '.', './x', 'a\\..\\x', 'C:\\x', '', 'a//b', 'a\0b', 42]) {
    assert.equal(isValidStateDirectory(bad), false, String(bad));
    assert.throws(() => resolveStateDirectory('ntfy', bad, env), String(bad));
  }
  assert.ok(transportOptions('ntfy', {}, env).stateDirectory.startsWith(base + sep));
});

test('environment names are limited to the channel provider allow-list', () => {
  for (const channel of CHANNEL_CATALOG) {
    for (const name of channel.requiredEnv) assert.ok(isAllowedEnvironmentKey(channel.id, name), `${channel.id} ${name}`);
  }
  assert.ok(isAllowedEnvironmentKey('ntfy', 'NTFY_TOKEN'));
  assert.ok(isAllowedEnvironmentKey('weixin', 'WEIXIN_HOME_CHANNEL'));
  const refused = [
    'PATH', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'AGENT_HOME', 'NTFY_HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
    'NODE_OPTIONS', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'ENCRYPTION_KEY', 'JWT_SECRET', 'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY', 'SLACK_BOT_TOKEN', 'NTFY_CLI_PATH', 'NTFY_STORE_DIR', 'NTFY_PLUGIN', 'NTFY_', 'ntfy_token',
  ];
  for (const name of refused) assert.equal(isAllowedEnvironmentKey('ntfy', name), false, name);
  assert.equal(isAllowedEnvironmentKey('buzz', 'BUZZ_CLI_PATH'), false);
  assert.equal(isAllowedEnvironmentKey('msgraph_webhook', 'MSGRAPH_WEBHOOK_STORE_PATH'), false);
  // A stored config with foreign names is filtered before reaching the worker.
  const options = transportOptions('ntfy', { environment: { NTFY_TOKEN: 'x', LD_PRELOAD: '/tmp/evil.so', JWT_SECRET: 'y' } }, env);
  assert.deepEqual(options.environment, { NTFY_TOKEN: 'x' });
});

test('review follow-up: no vendor-wide or credential-file variables; JSON variables must be inline', () => {
  for (const name of [
    'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_EXTERNAL_ACCOUNT_FILE', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_API_KEY',
    'GOOGLE_CHAT_CREDENTIALS', 'GOOGLE_CHAT_KEYFILE', 'AWS_SHARED_CREDENTIALS_FILE',
  ]) assert.equal(isAllowedEnvironmentKey('google_chat', name), false, name);
  assert.ok(isAllowedEnvironmentKey('google_chat', 'GOOGLE_CHAT_SERVICE_ACCOUNT_JSON'));
  assert.ok(isAllowedEnvironmentKey('google_chat', 'GOOGLE_CHAT_PROJECT_ID'));
  assert.equal(isAllowedEnvironmentKey('dingtalk', 'DINGTALK_CLIENT_ID'), true);
  assert.equal(isAllowedEnvironmentKey('sms', 'TWILIO_ACCOUNT_SID'), true);
  assert.equal(isAllowedEnvironmentKey('wecom_callback', 'WECOM_BOT_ID'), false, 'another channel\'s prefix');
  const sa = JSON.stringify({ type: 'service_account', client_email: 'x@example.test' });
  assert.ok(isValidEnvironment('google_chat', { GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: sa }));
  for (const value of ['/etc/keys/sa.json', '~/sa.json', 'file:///tmp/sa.json', '[]', '"x"', '{bad'])
    assert.equal(isValidEnvironment('google_chat', { GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: value }), false, value);
});

test('review follow-up: settings keys are allow-listed and extras cannot name paths, programs or URLs', () => {
  assert.ok(isValidSettings('ntfy', { token: 't', api_key: 'k', reply_to_mode: 'all', typing_indicator: false,
    extra: { topic: 'alerts', priority: 3, tags: ['a', 'b'], markdown: true } }));
  const refused = [
    { unknown: 'x' }, { home_channel: { id: 'x' } }, { channel_overrides: {} }, { token: 1 }, { reply_to_mode: 'sometimes' },
    { extra: { cli_path: '/bin/sh' } }, { extra: { store_path: 'x' } }, { extra: { state_dir: 'x' } },
    { extra: { config_file: 'x' } }, { extra: { command: 'id' } }, { extra: { bin: 'x' } }, { extra: { webhook_url: 'https://x' } },
    { extra: { base_url: 'https://x' } }, { extra: { credentials: 'x' } }, { extra: { topic: '/etc/passwd' } },
    { extra: { topic: '../x' } }, { extra: { topic: 'file:///x' } }, { extra: { topic: 'C:\\x' } },
    { extra: { Topic: 'x' } }, { extra: { nested: { a: 1 } } }, { extra: { tags: [{}] } }, { extra: 'x' },
  ];
  for (const settings of refused) assert.equal(isValidSettings('ntfy', settings), false, JSON.stringify(settings));
  // Relay's named extras are allowed only for relay.
  const relay = { extra: { url: 'wss://relay.example.test', platform: 'p', bot_id: 'b', descriptor: { name: 'x' } } };
  assert.ok(isValidSettings('relay', relay));
  assert.equal(isValidSettings('ntfy', relay), false);
  // Stored settings are filtered before reaching the worker.
  assert.deepEqual(filterSettings('ntfy', { token: 't', evil: 1, extra: { topic: 'a', cli_path: '/bin/sh' } }),
    { token: 't', extra: { topic: 'a' } });
  assert.deepEqual(transportOptions('ntfy', { settings: { token: 't', unknown: 'x' } }, env).settings, { token: 't' });
});

test('HTTP config: interpreter, foreign env and escaping state dir are refused; nothing is stored', async () => {
  const saved = { ...process.env };
  process.env.AGENT_CONNECT_STATE_DIR = base;
  process.env.AGENT_CONNECT_PYTHON = join(base, 'missing-python');
  const db = new Database(':memory:');
  // Disabled: no worker process is started by these requests.
  db.exec("CREATE TABLE extension_configs (extension_id TEXT PRIMARY KEY, enabled INTEGER); INSERT INTO extension_configs VALUES ('agent-connect', 0)");
  let config = {};
  const app = Fastify();
  const api = {
    db, getConfig: () => config, setConfig: value => { config = value; }, log() {},
    authorizeChannelRequest(request) {
      if (request.headers.authorization !== 'Bearer owner') throw new Error('Forbidden');
      return 'owner';
    },
    async processChannelMessage() { throw new Error('not used'); },
    registerRoutes(fn) { app.register(fn, { prefix: '/api/ext/agent-connect' }); },
    registerTool() {},
  };
  await extension.register(api);
  await app.ready();
  const url = '/api/ext/agent-connect/ntfy/config';
  const put = (body, headers = { authorization: 'Bearer owner' }) => app.inject({ method: 'PUT', url, headers, payload: body });
  const valid = { configured: true, allowed_users: 'u', allowed_channels: 'c' };
  try {
    // Unauthenticated callers are refused before any validation.
    assert.equal((await put({ config: { ...valid, python_executable: '/bin/sh' } }, {})).statusCode, 403);
    for (const body of [
      { config: { ...valid, python_executable: '/bin/sh' } },
      { ...valid, python_executable: '/bin/sh' },
      { config: { ...valid, environment: { LD_PRELOAD: '/tmp/evil.so' } } },
      { config: { ...valid, environment: { PYTHONSTARTUP: '/tmp/evil.py' } } },
      { config: { ...valid, environment: { JWT_SECRET: 'x' } } },
      { config: { ...valid, environment: { SLACK_BOT_TOKEN: 'other-channel' } } },
      { config: { ...valid, environment: { NTFY_TOKEN: 1 } } },
      { config: { ...valid, state_directory: '/etc' } },
      { config: { ...valid, environment: { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' } } },
      { config: { ...valid, settings: { unknown: 'x' } } },
      { config: { ...valid, settings: { extra: { cli_path: '/bin/sh' } } } },
      { config: { ...valid, state_directory: '../../outside' } },
    ]) {
      const res = await put(body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
    assert.deepEqual(config, {}, 'rejected requests store nothing');

    const ok = await put({ config: { ...valid, environment: { NTFY_TOKEN: 'secret-test-value' }, state_directory: 'ntfy-state' } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(config.channels.ntfy.python_executable, undefined);
    const options = transportOptions('ntfy', config.channels.ntfy);
    assert.equal(options.pythonExecutable, join(base, 'missing-python'));
    assert.equal(options.stateDirectory, join(base, 'ntfy-state'));
    assert.deepEqual(options.environment, { NTFY_TOKEN: 'secret-test-value' });

    // A legacy stored interpreter path is dropped on the next save and never used.
    config.channels.ntfy.python_executable = '/tmp/evil';
    assert.equal(transportOptions('ntfy', config.channels.ntfy).pythonExecutable, join(base, 'missing-python'));
    assert.equal((await put({ config: { allowed_users: 'u,v' } })).statusCode, 200);
    assert.equal(config.channels.ntfy.python_executable, undefined);
  } finally {
    await app.close(); db.close();
    for (const key of ['AGENT_CONNECT_STATE_DIR', 'AGENT_CONNECT_PYTHON']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
