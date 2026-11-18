// FIRSTRUN-01: a new owner gets the setup steps once; tools, local model and the Welcome chat.
// Run: node --import tsx --test test/first-run-steps.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-first-run-steps-'));
// Start the persistent transformer outside the disposable working directory.
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
const { aiTools, localModelStep, localModelCommand, recommendedLocal, welcomeText, teamLine, firstRunState } = await import('../src/onboarding/first-run.ts');
const { sql, one } = await import('../src/repositories/sql-steps.js');
const { listConversationMessages } = await import('../src/repositories/chat-conversations.ts');

const db = getDatabase();
await db.initialize();
const app = Fastify();
await app.register(setupRoutes);
await app.register(authRoutes);
await app.register(firstRunRoutes,{discovery:{home:dir,roots:[dir]}});
await app.ready();
test.after(async () => { await (await import('../src/onboarding/discovery.ts')).stopFirstRunDiscovery(); await app.close(); await (await import('../src/services/discovery-fs.ts')).discoveryFs.close(); closeDatabase(); process.chdir(backendDir); rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); });

const OWNER = { name: 'Mohamed Test', email: 'owner@example.test', password: 'Fresh-Install-Pass-42!' };
let token = '';
const call = (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });

test('a new owner discovers device sources before tools or agents; progress is owner-only and steps are remembered', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/setup/admin', payload: { ...OWNER, workspaceType: 'company', companyName: 'Example Company', setupToken: issueSetupToken() } })).statusCode, 200);
  token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: OWNER.email, password: OWNER.password } })).json().token;
  assert.deepEqual((await call('GET', '/api/first-run')).json(), { pending: true, step: 'discovery', workspaceType: 'company', companyName: 'Example Company' });
  assert.equal((await call('PUT','/api/first-run',{step:'tools'})).statusCode,409,'discovery cannot be skipped');
  assert.equal((await call('POST','/api/first-run/finish')).statusCode,409,'finish cannot bypass discovery');
  assert.equal((await app.inject({method:'GET',url:'/api/first-run/discovery'})).statusCode,401);
  assert.equal((await call('POST','/api/first-run/discovery',{home:'/fictional'})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/first-run/discovery',headers:{authorization:`Bearer ${token}`},remoteAddress:'203.0.113.9'})).statusCode,403);
  mkdirSync(join(dir,'Projects','inventory'),{recursive:true});writeFileSync(join(dir,'Projects','inventory','AGENTS.md'),'# Inventory\nUse signed release manifests.\n');
  mkdirSync(join(dir,'.claude','projects','-fictional-first','memory'),{recursive:true});writeFileSync(join(dir,'.claude','projects','-fictional-first','memory','user.md'),'---\nname: Fixture preference\ntype: user\n---\nPrivate fixture content must not leave inventory.\n');
  mkdirSync(join(dir,'.claude','skills','fixture-skill'),{recursive:true});writeFileSync(join(dir,'.claude','skills','fixture-skill','SKILL.md'),'---\nname: fixture-skill\ndescription: Fictional inventory skill\n---\nUse bounded inventory.\n');
  mkdirSync(join(dir,'.codex'),{recursive:true});writeFileSync(join(dir,'.codex','config.toml'),'[mcp_servers.fixture]\ncommand = "node"\nargs = ["fictional.js"]\n');
  mkdirSync(join(dir,'.ssh'),{recursive:true});writeFileSync(join(dir,'.ssh','id_ed25519'),'PRIVATE-FIXTURE-NOT-READ');
  const beforeAgents=db.prepare('SELECT count(*) AS n FROM agents_config').get().n;
  const starts=await Promise.all([call('POST','/api/first-run/discovery'),call('POST','/api/first-run/discovery')]);assert.ok(starts.every(response=>response.statusCode===200));
  await (await import('../src/onboarding/discovery.ts')).stopFirstRunDiscovery();
  assert.equal((await call('POST','/api/first-run/discovery')).statusCode,200,'saved discovery resumes after shutdown');
  let inventory;
  for(let i=0;i<200;i++){inventory=(await call('GET','/api/first-run/discovery')).json();if(inventory.status==='done'||inventory.status==='error')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(inventory.status,'done',JSON.stringify(inventory));assert.ok(inventory.counts.projects>=1);assert.ok(inventory.counts.notes>=1);assert.equal(inventory.counts.memories,1);assert.equal(inventory.counts.skills,1);assert.equal(inventory.counts.mcp,1);assert.equal(inventory.counts.ssh,1);
  assert.doesNotMatch(JSON.stringify(inventory),/signed release manifests|PRIVATE-FIXTURE|Private fixture|Projects|inventory\/|user_id|documents/,'only counts, bounded display names and fixed notices leave the backend');
  assert.ok(inventory.samples.some(item=>item.kind==='ssh'&&item.name==='id_ed25519'));assert.ok(inventory.samples.some(item=>item.kind==='skill'&&item.name==='fixture-skill'));assert.ok(inventory.samples.every(item=>!/[\\/]/.test(item.name)));
  assert.ok(inventory.folderNames.includes('inventory'));assert.ok(inventory.folderNames.length<=4);assert.ok(inventory.folderNames.every(name=>!/[\\/]/.test(name)));
  assert.equal(db.prepare('SELECT count(*) AS n FROM agents_config').get().n,beforeAgents,'inventory never creates agents');
  assert.deepEqual((await call('POST','/api/first-run/discovery')).json(),inventory,'completed inventory is not restarted');
  assert.equal((await call('PUT','/api/first-run',{step:'tools'})).json().step,'tools');
  for (const workspaceType of [null, 'owner', {}, []]) assert.equal((await call('PUT', '/api/first-run', { step: 'model', workspaceType })).statusCode, 400);
  assert.equal((await call('PUT', '/api/first-run', { step: 'team' })).json().companyName, 'Example Company');
  const individual = (await call('PUT', '/api/first-run', { step: 'team', workspaceType: 'individual' })).json();
  assert.equal(individual.workspaceType, 'individual'); assert.equal(Object.hasOwn(individual, 'companyName'), false);
  for (const companyName of ['', ' padded ', 'x'.repeat(101), 'line\nbreak', null]) assert.equal((await call('PUT', '/api/first-run', { step: 'tools', workspaceType: 'company', companyName })).statusCode, 400);
  assert.equal((await call('PUT', '/api/first-run', { step: 'team', workspaceType: 'company', companyName: 'Fictional Works' })).json().workspaceType, 'company');
  assert.equal((await call('PUT', '/api/first-run', { step: 'tools' })).json().workspaceType, 'company');
  assert.deepEqual((await call('GET', '/api/first-run')).json(), { pending: true, step: 'tools', workspaceType: 'company', companyName: 'Fictional Works' });
  const stored = await sql().read(one('SELECT answers FROM onboarding_state WHERE user_id = (SELECT id FROM users WHERE email = ?)', OWNER.email));
  assert.equal(JSON.parse(stored.answers).companyName, 'Fictional Works', 'saved in database, not only projected in the response');
  assert.equal((await call('PUT', '/api/first-run', { step: 'nowhere' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/first-run' })).statusCode, 401, 'owner only');
});

test('an owner without the first-run row (existed before) never sees the steps', async () => {
  assert.deepEqual(await firstRunState('someone-older'), { pending: false, step: 'tools' });
});

test('AI tools: installed and signed-in states come from the tools\' own files, commands are fixed text', async () => {
  const home = join(dir, 'fake-home'), bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'codex', 'npm']) { writeFileSync(join(bin, name), '#!/bin/sh\n'); chmodSync(join(bin, name), 0o755); }
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@example.test' } }));
  // The Gemini CLI entry as it is with GIRRU_STORE_P7 off (SUB1 below covers it on).
  const p7 = process.env.GIRRU_STORE_P7; process.env.GIRRU_STORE_P7 = '0';
  const asked = [];
  const tools = await aiTools({ home, platform: 'darwin', dirs: [bin], keychain: async (service, h) => { asked.push([service, h]); return true; } }).finally(() => { if (p7 !== undefined) process.env.GIRRU_STORE_P7 = p7; });
  assert.deepEqual(asked, [['Claude Code-credentials', home]], 'the keychain of this HOME is asked for the saved login by name only');
  const byId = Object.fromEntries(tools.map(t => [t.id, t]));
  assert.deepEqual([byId.claude.installed, byId.claude.signedIn, byId.claude.install], [true, true, null]);
  assert.deepEqual([byId.codex.installed, byId.codex.signedIn, byId.codex.signIn], [true, false, 'codex login']);
  assert.deepEqual([byId.gemini.installed, byId.gemini.install], [false, 'npm install -g @google/gemini-cli']);
  assert.ok(!JSON.stringify(tools).includes('x@example.test'), 'no account detail is returned');
});

test('Claude Code is not "signed in" when its login was not saved (account written, keychain item missing)', async () => {
  // The test build: claude wrote oauthAccount to ~/.claude.json, then "Couldn't save your login" (a temp HOME has no login keychain).
  const home = mkdtempSync(join(dir, 'home-unsaved-')), bin = join(home, 'bin');
  mkdirSync(bin); writeFileSync(join(bin, 'claude'), '#!/bin/sh\n'); chmodSync(join(bin, 'claude'), 0o755);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ userID: 'u', oauthAccount: { emailAddress: 'x@example.test' } }));
  const claude = async (opts) => (await aiTools({ home, dirs: [bin], ...opts })).find(t => t.id === 'claude');
  assert.equal((await claude({ platform: 'darwin', keychain: async () => false })).signedIn, false, 'macOS: no keychain item = not signed in');
  assert.equal((await claude({ platform: 'darwin', keychain: async () => true })).signedIn, true, 'macOS: saved in the keychain = signed in');
  assert.equal((await claude({ platform: 'linux', keychain: async () => true })).signedIn, false, 'Linux/Windows: the account alone is not a saved login');
  mkdirSync(join(home, '.claude')); writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
  assert.equal((await claude({ platform: 'linux', keychain: async () => false })).signedIn, true, 'the credentials file is a saved login');
  rmSync(join(home, '.claude', '.credentials.json')); rmSync(join(home, '.claude.json'));
  let asked = false;
  assert.equal((await claude({ platform: 'darwin', keychain: async () => { asked = true; return true; } })).signedIn, false, 'never started: not signed in');
  assert.equal(asked, false, 'the keychain is only asked once Claude has an account');
});

test('Claude Code: what the CLI itself reports (auth status) decides first; files only when it cannot answer', async () => {
  const home = mkdtempSync(join(dir, 'home-status-')), bin = join(home, 'bin');
  mkdirSync(bin); writeFileSync(join(bin, 'claude'), '#!/bin/sh\n'); chmodSync(join(bin, 'claude'), 0o755);
  const claude = async (opts) => (await aiTools({ home, platform: 'darwin', dirs: [bin], ...opts })).find(t => t.id === 'claude');
  const asked = [];
  // Signed in with the real login keychain, nothing under HOME at all (Mohamed's case): the CLI says yes.
  assert.equal((await claude({ claudeStatus: async (b, h) => { asked.push([b, h]); return true; }, keychain: async () => false })).signedIn, true);
  assert.deepEqual(asked, [[join(bin, 'claude'), home]], 'the found claude binary is asked, with this HOME');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@example.test' } }));
  assert.equal((await claude({ claudeStatus: async () => false, keychain: async () => true })).signedIn, false, 'the CLI saying no wins over files');
  assert.equal((await claude({ claudeStatus: async () => null, keychain: async () => true })).signedIn, true, 'no answer: the saved-login check decides');
});

test('claudeAuthStatus reads only loggedIn from the real CLI output', async () => {
  const { claudeAuthStatus } = await import('../src/onboarding/first-run.ts');
  const b = join(dir, 'auth'); const home = mkdtempSync(join(dir, 'home-cli-'));
  const fixture = (text, code = 0) => writeFileSync(b, `if (JSON.stringify(process.argv.slice(2)) !== '["status","--json"]' || process.env.HOME !== ${JSON.stringify(home)}) process.exit(2); process.stdout.write(${JSON.stringify(text)}); process.exit(${code});`);
  fixture('{"loggedIn":true,"email":"x@example.test"}');
  assert.equal(await claudeAuthStatus(process.execPath, home), true);
  fixture('{"loggedIn":false}', 1);
  assert.equal(await claudeAuthStatus(process.execPath, home), false, 'exit 1 with loggedIn false still answers false');
  fixture('nope');
  assert.equal(await claudeAuthStatus(process.execPath, home), null, 'an older CLI without the command gives no answer');
});

test('SUB1 (GIRRU_STORE_P7): the Google app is Antigravity (agy), signed in by its cached account', async () => {
  const home = mkdtempSync(join(dir, 'home-agy-')), bin = join(home, 'bin');
  mkdirSync(join(home, '.gemini'), { recursive: true }); mkdirSync(bin);
  for (const name of ['gemini', 'npm']) { writeFileSync(join(bin, name), '#!/bin/sh\n'); chmodSync(join(bin, name), 0o755); }
  writeFileSync(join(home, '.gemini', 'oauth_creds.json'), '{}');
  const p7Before = process.env.GIRRU_STORE_P7;
  process.env.GIRRU_STORE_P7 = '1';
  try {
    let g = (await aiTools({ home, platform: 'darwin', dirs: [bin] })).find(t => t.id === 'gemini');
    assert.deepEqual([g.name, g.installed, g.signedIn, g.signIn], ['Antigravity', false, false, 'agy'], 'the old gemini binary no longer counts');
    writeFileSync(join(bin, 'agy'), '#!/bin/sh\n'); chmodSync(join(bin, 'agy'), 0o755);
    rmSync(join(home, '.gemini', 'oauth_creds.json'));
    g = (await aiTools({ home, platform: 'darwin', dirs: [bin] })).find(t => t.id === 'gemini');
    assert.deepEqual([g.installed, g.signedIn], [true, false]);
    writeFileSync(join(home, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'x@example.test', old: [] }));
    const tools = await aiTools({ home, platform: 'darwin', dirs: [bin] });
    g = tools.find(t => t.id === 'gemini');
    assert.deepEqual([g.installed, g.signedIn, g.install], [true, true, null]);
    assert.ok(!JSON.stringify(tools).includes('x@example.test'), 'no account detail is returned');
  } finally { process.env.GIRRU_STORE_P7 = '0'; }
  assert.equal((await aiTools({ home, platform: 'darwin', dirs: [bin] })).find(t => t.id === 'gemini').name, 'Gemini CLI', 'P7 off: unchanged');
  process.env.GIRRU_STORE_P7 = p7Before ?? ''; if (p7Before === undefined) delete process.env.GIRRU_STORE_P7;
});

test('local model: recommendation by memory; command installs Ollama first only when missing', async () => {
  assert.equal(recommendedLocal(8).id, 'qwen3:4b');
  assert.equal(recommendedLocal(16).id, 'qwen3:4b');
  assert.equal(recommendedLocal(32).id, 'qwen3.5:9b', 'one size below what the memory holds');
  assert.equal(recommendedLocal(64).id, 'qwen3:14b');
  const missing = await localModelStep({ home: dir, platform: 'linux', dirs: [], memoryBytes: 32 * 1024 ** 3, models: async () => [] });
  assert.equal(missing.recommended, 'qwen3.5:9b');
  assert.equal(localModelCommand(missing, 'qwen3.5:9b'), 'curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen3.5:9b');
  assert.equal(localModelCommand(missing, 'rm -rf /'), null, 'only listed models');
  // What is already in Ollama comes first; an embedding model is not offered.
  const has = await localModelStep({ home: dir, platform: 'linux', dirs: [], memoryBytes: 32 * 1024 ** 3,
    models: async () => [{ name: 'qwen3-embedding:0.6b', size: 6e8, chat: false }, { name: 'llama3.2:3b', size: 2e9, chat: true }] });
  assert.equal(has.recommended, 'llama3.2:3b');
  assert.deepEqual(has.installed, ['llama3.2:3b']);
  assert.deepEqual(has.choices.map(c => c.id), ['llama3.2:3b', 'qwen3:4b', 'qwen3.5:9b', 'qwen3:14b']);
  const listedHas = await localModelStep({ home: dir, platform: 'linux', dirs: [], memoryBytes: 32 * 1024 ** 3, models: async () => [{ name: 'qwen3:4b', size: 3e9, chat: true }] });
  assert.equal(listedHas.recommended, 'qwen3:4b', 'an installed listed model is used, not downloaded again');
  const macNoBrew = await localModelStep({ home: dir, platform: 'darwin', dirs: [], memoryBytes: 8 * 1024 ** 3, models: async () => [] });
  if (!macNoBrew.ollama) assert.equal(macNoBrew.download, 'https://ollama.com/download');
});

test('finish opens one Welcome chat with the Main agent\'s greeting and the first question\'s answers', async () => {
  const first = (await call('POST', '/api/first-run/finish')).json();
  assert.ok(first.conversationId);
  assert.deepEqual((await call('POST', '/api/first-run/finish')).json(), first, 'repeat returns the same chat');
  assert.equal((await call('GET', '/api/first-run')).json().pending, false);
  const [message] = await listConversationMessages(first.conversationId);
  assert.equal((await (await import('../src/memory/import/automatic-project-import.ts')).automaticImportSettings((await sql().read(one('SELECT id FROM users WHERE email=?',OWNER.email))).id)).enabled,true,'new discovery acknowledgement enables import only after setup finish');
  assert.equal(message.role, 'assistant');
  assert.match(message.content, /Hi Mohamed/);
  assert.match(message.content, /Where do you want to talk to me\?/);
  assert.ok(JSON.stringify(message.parts).includes('Telegram'));
});

test('the team summary counts exactly the agents hired (3 picked: no "more"; 250: six names and 244 more)', () => {
  const team = n => Array.from({ length: n }, (_, i) => ({ name: `A${i}`, department: 'marketing' }));
  assert.doesNotMatch(teamLine(team(3)), /more/);
  assert.equal((teamLine(team(3)).match(/\*\*A\d\*\*/g) ?? []).length, 3);
  assert.match(teamLine(team(250)), / and 244 more$/, 'the "244 more" seen in the test build means 250 agents were hired');
  assert.match(teamLine(team(7)), / and 1 more$/);
});

test('welcome text names the team in plain words', () => {
  assert.match(welcomeText('Mohamed', 'Sami', [{ name: 'Nora', department: 'marketing' }, { name: 'Omar', department: 'sales' }]), /\*\*Nora\*\* \(marketing\) and \*\*Omar\*\* \(sales\)/);
});
