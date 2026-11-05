import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlpacaRest } from '../extensions/trading/src/alpaca-rest.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import puppeteer from 'puppeteer';

test('patched Fastify plugins serve files and OpenAPI through Fastify 5', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpro-static-contract-'));
  const app = Fastify();
  try {
    await writeFile(join(root, 'fixture.txt'), 'synthetic document');
    await app.register(staticFiles, { root, prefix: '/files/' });
    await app.register(swagger, { openapi: { info: { title: 'Fixture', version: '1' } } });
    await app.register(swaggerUi, { routePrefix: '/documentation' });
    assert.equal((await app.inject('/files/fixture.txt')).body, 'synthetic document');
    const response = await app.inject('/documentation/json');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().info.title, 'Fixture');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('trading client retains authenticated paper requests without the legacy SDK', async () => {
  const requests = [];
  const client = createAlpacaRest({
    keyId: 'fixture-key', secretKey: 'fixture-secret', paper: true,
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      return { ok: true, text: async () => JSON.stringify({ id: 'synthetic-account', cash: '42.00' }) };
    },
  });
  assert.equal((await client.getAccount()).id, 'synthetic-account');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].url, 'https://paper-api.alpaca.markets/v2/account');
  assert.equal(requests[0].headers['APCA-API-KEY-ID'], 'fixture-key');
  assert.equal(requests[0].headers['APCA-API-SECRET-KEY'], 'fixture-secret');
});

test('patched browser driver accepts the supported headless option', async () => {
  assert.ok((await puppeteer.defaultArgs({ headless: true })).some(arg => arg.startsWith('--headless')));
  assert.ok(!(await puppeteer.defaultArgs({ headless: false })).some(arg => arg.startsWith('--headless')));
});
