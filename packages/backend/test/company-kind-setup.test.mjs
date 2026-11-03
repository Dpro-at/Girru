// ONBOARD-COMPANYTYPE-01: "What does your company do?" is answered right after the company name,
// saved with the owner, returned by /api/first-run, and the UI list matches the backend kinds.
// Run: node --import tsx --test test/company-kind-setup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-company-kind-'));
const warmup = join(dir, 'transformer-warmup.ts');
writeFileSync(warmup, 'export const ready: boolean = true;\n');
await import((await import('node:url')).pathToFileURL(warmup).href);
process.chdir(dir);
process.env.HOME = dir;
process.env.USERPROFILE = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only

const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
const { default: Fastify } = await import('fastify');
const { default: setupRoutes } = await import('../src/api/routes/setup.ts');
const { authRoutes } = await import('../src/api/routes/auth.ts');
const { firstRunRoutes } = await import('../src/api/routes/first-run.ts');
const { issueSetupToken } = await import('../src/auth/setup-token.ts');
const { validCompanyKind } = await import('../src/onboarding/first-run.ts');
const { COMPANY_KINDS } = await import('../src/services/department-groups.ts');
const ui = await import(new URL('../../core-ui/src/company-kinds.js', import.meta.url).href);

const db = getDatabase();
await db.initialize();
const app = Fastify();
await app.register(setupRoutes);
await app.register(authRoutes);
await app.register(firstRunRoutes, { discovery: { home: dir, roots: [dir] } });
await app.ready();
test.after(async () => { await (await import('../src/onboarding/discovery.ts')).stopFirstRunDiscovery(); await app.close(); await (await import('../src/services/discovery-fs.ts')).discoveryFs.close(); closeDatabase(); process.chdir(backendDir); rmSync(dir, { recursive: true, force: true }); });

const OWNER = { name: 'Fictional Owner', email: 'owner@example.test', password: 'Fresh-Install-Pass-42!' };
const KIND = 'healthcare rehabilitation and medical services';

test('the UI kinds list is the backend list: same ids, labels and order', () => {
  assert.deepEqual(ui.COMPANY_KIND_CHOICES.map(k => [k.id, k.label]), COMPANY_KINDS.map(k => [k.id, k.label]));
});

test('only a general, known or custom kind is accepted, the same way on both sides', () => {
  for (const ok of ['', KIND, 'custom:Robot repair', 'custom:Bäckerei 24']) { assert.equal(validCompanyKind(ok), true, ok); assert.equal(ui.validCompanyKind(ok), true, ok); }
  for (const bad of [null, 1, 'Healthcare', 'unknown kind', 'custom:', 'custom: padded', 'custom:x'.padEnd(80, 'x'), 'custom:semi;colon', 'custom:line\nbreak']) {
    assert.equal(validCompanyKind(bad), false, String(bad)); assert.equal(ui.validCompanyKind(bad), false, String(bad));
  }
});

test('setup refuses a kind without a company or an unknown kind, and creates no owner', async () => {
  for (const payload of [{ ...OWNER, companyKind: KIND }, { ...OWNER, workspaceType: 'individual', companyKind: KIND }, { ...OWNER, workspaceType: 'company', companyName: 'Example Company', companyKind: 'unknown kind' }]) {
    const r = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: { ...payload, setupToken: issueSetupToken() } });
    assert.equal(r.statusCode, 400); assert.equal(r.json().code, 'missing_fields');
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/setup/status' })).json().setupRequired, true);
});

test('the kind is saved with the owner, returned by /api/first-run and dropped when the workspace becomes personal', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/setup/admin', payload: { ...OWNER, workspaceType: 'company', companyName: 'Example Company', companyKind: KIND, setupToken: issueSetupToken() } })).statusCode, 200);
  const token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER.email, password: OWNER.password } })).json().token;
  const call = (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual((await call('GET', '/api/first-run')).json(), { pending: true, step: 'discovery', workspaceType: 'company', companyName: 'Example Company', companyKind: KIND });
  assert.equal((await call('PUT', '/api/first-run', { step: 'discovery', workspaceType: 'company', companyName: 'Renamed Company' })).json().companyKind, KIND, 'renaming keeps the kind');
  const personal = (await call('PUT', '/api/first-run', { step: 'discovery', workspaceType: 'individual' })).json();
  assert.equal(Object.hasOwn(personal, 'companyKind'), false);
});
