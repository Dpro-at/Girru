require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowedFirstRun, firstRunResponse, firstRunRoute } = require('../src/first-run-contract.js');
const { SetupSteps } = require('../src/FirstRunSetup.tsx');
const { NoticeCard, MomentsContext } = require('../src/ChatMoments.tsx');

test('FIRSTRUN-01 contract: only the reviewed paths and their exact shapes pass', () => {
  assert.equal(firstRunRoute('/api/first-run'), true);
  assert.equal(firstRunRoute('/api/first-run/other'), false);
  assert.equal(allowedFirstRun('GET', '/api/first-run', undefined), true);
  assert.equal(allowedFirstRun('PUT', '/api/first-run', { step: 'team' }), true);
  assert.equal(allowedFirstRun('PUT', '/api/first-run', { step: 'team', extra: 1 }), false);
  assert.equal(allowedFirstRun('PUT', '/api/first-run', { step: 'anything' }), false);
  assert.equal(allowedFirstRun('POST', '/api/first-run/finish', undefined), true);
  assert.equal(allowedFirstRun('POST', '/api/first-run/tools', undefined), false);
  assert.equal(allowedRequest('GET', '/api/first-run/local-model', undefined), true, 'the page client allows it too');
});

test('FIRSTRUN-01 contract: commands stay single lines; unknown tools and fields are dropped', () => {
  const tools = firstRunResponse('/api/first-run/tools', 200, { tools: [
    { id: 'claude', name: 'Claude Code', installed: true, signedIn: true, install: null, signIn: 'claude', secret: 'x' },
    { id: 'gemini', name: 'Gemini CLI', installed: false, signedIn: false, install: 'npm install -g @google/gemini-cli\nrm -rf ~', signIn: 'gemini' },
    { id: 'other', name: 'Other', installed: true, signedIn: true, install: null, signIn: 'x' }] });
  assert.deepEqual(tools, { tools: [{ id: 'claude', name: 'Claude Code', installed: true, signedIn: true, install: null, signIn: 'claude' }] });
  const local = firstRunResponse('/api/first-run/local-model', 200, { memoryGb: 16.2, recommended: 'qwen3.5:9b', ollama: false, installed: [], download: 'https://example.invalid/x',
    choices: [{ id: 'qwen3.5:9b', label: 'Qwen 3.5 · 9B', sizeGb: 6, note: 'Best balance.' }], commands: { 'qwen3.5:9b': 'ollama pull qwen3.5:9b' } });
  assert.equal(local.memoryGb, 16);
  assert.equal(local.download, null, 'only the Ollama download page passes');
  assert.equal(local.commands['qwen3.5:9b'], 'ollama pull qwen3.5:9b');
  assert.deepEqual(firstRunResponse('/api/first-run', 403, {}), { code: 'forbidden' });
});

test('setup steps include discovery before tools and team', () => {
  const html = renderToStaticMarkup(React.createElement(SetupSteps, { current: 'Local model' }));
  for (const s of ['Account', 'Your files', 'AI tools', 'Local model', 'Team']) assert.match(html, new RegExp(s));
  assert.match(html, /aria-current="step"[^>]*>Local model/);
});

test('the Main agent\'s setup question shows its answers as buttons that fill the box', () => {
  const drafted = [];
  const html = renderToStaticMarkup(React.createElement(MomentsContext.Provider, { value: { onDraft: t => drafted.push(t) } },
    React.createElement(NoticeCard, { part: { kind: 'notice', code: 'choices', text: 'Here in Girru\nTelegram\nWhatsApp' } })));
  assert.match(html, /aria-label="Quick answers"/);
  assert.equal((html.match(/class="moment-choice"/g) || []).length, 3);
});


test('workspace type survives both bridge projections; invalid values cannot change role or escape the contract', () => {
  for (const workspaceType of ['individual', 'company']) {
    const company = workspaceType === 'company' ? { companyName: 'Example Company' } : {};
    assert.equal(allowedFirstRun('PUT', '/api/first-run', { step: 'team', workspaceType, ...company }), true);
    const once = firstRunResponse('/api/first-run', 200, { pending: true, step: 'team', workspaceType, ...company, secret: 'ignored' });
    assert.deepEqual(firstRunResponse('/api/first-run', 200, once), { pending: true, step: 'team', workspaceType, ...company });
  }
  for (const workspaceType of [null, undefined, 'owner', [], {}]) {
    assert.equal(allowedFirstRun('PUT', '/api/first-run', { step: 'team', workspaceType }), false);
    assert.throws(() => firstRunResponse('/api/first-run', 200, { pending: true, step: 'team', workspaceType }), /protocol/);
  }
  assert.equal(allowedFirstRun('PUT', '/api/first-run', { step: 'team', workspaceType: 'company', role: 'owner' }), false);
});

test('installed local-model state and memory warning survive repeated bridge projections', () => {
  const body = { memoryGb: 16, recommended: 'installed-model', choices: [{ id: 'installed-model', label: 'Installed model', sizeGb: 3, note: 'Local', installed: true, minMemoryGb: 24 }], ollama: true, installed: ['installed-model'], commands: { 'installed-model': 'ollama pull installed-model' } };
  const result = firstRunResponse('/api/first-run/local-model', 200, firstRunResponse('/api/first-run/local-model', 200, body));
  assert.equal(result.choices[0].installed, true);
  assert.equal(result.choices[0].minMemoryGb, 24);
});


test('company name is asked only for a company, and requires a bounded single-line name', () => {
  const { WorkspaceTypeStep } = require('../src/WorkspaceTypeStep.tsx');
  const props = { onNext() {} };
  const company = renderToStaticMarkup(React.createElement(WorkspaceTypeStep, { ...props, value: 'company' }));
  assert.match(company, /Company name/);
  assert.match(company, /disabled=""[^>]*>Continue/);
  const filled = renderToStaticMarkup(React.createElement(WorkspaceTypeStep, { ...props, value: 'company', companyName: 'Example Company' }));
  assert.doesNotMatch(filled, /disabled=""[^>]*>Continue/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(WorkspaceTypeStep, { ...props, value: 'individual' })), /Company name/);
  for (const companyName of ['', ' padded ', 'x'.repeat(101), 'two\nlines', null]) assert.equal(allowedFirstRun('PUT', '/api/first-run', { step: 'tools', workspaceType: 'company', companyName }), false);
  assert.equal(allowedFirstRun('PUT', '/api/first-run', { step: 'tools', companyName: 'No type' }), false);
});


test('first-run discovery accepts only fixed requests and bounded public counts', () => {
  const path = '/api/first-run/discovery';
  const { allowed } = require('../scripts/application-server.cjs');
  for (const method of ['GET', 'POST']) {
    assert.equal(allowedFirstRun(method, path, undefined), true);
    assert.equal(allowedRequest(method, path, undefined), true);
    assert.equal(allowed(method, path, undefined), true);
    assert.equal(allowedFirstRun(method, path, { root: '/' }), false);
  }
  assert.equal(allowedFirstRun('DELETE', path, undefined), false);
  const body = { status: 'scanning', scanned: 100, counts: { projects: 3, memories: 8, notes: 4, skills: 2, mcp: 1, ssh: 2 }, denied: 1, unavailable: 0, limited: false, notice: 'Searching…', paths: ['/private/example'], privateKey: 'fictional-secret' };
  const once = firstRunResponse(path, 200, body);
  assert.deepEqual(firstRunResponse(path, 200, once), once);
  assert.equal(once.paths, undefined); assert.equal(once.privateKey, undefined);
  for (const invalid of [-1, Infinity, 1.2, '3']) assert.throws(() => firstRunResponse(path, 200, { ...body, counts: { ...body.counts, ssh: invalid } }), /protocol/);
  assert.deepEqual(firstRunResponse('/api/first-run', 200, { pending: true, step: 'discovery' }), { pending: true, step: 'discovery' });
});

test('setup discovery shows inventory categories and blocks Next until the scan finishes', () => {
  const { DiscoveryStep } = require('../src/FirstRunSetup.tsx');
  const client = { request() { throw Error('render must not start a request'); } };
  const html = renderToStaticMarkup(React.createElement(DiscoveryStep, { client, onNext() {} }));
  for (const label of ['Projects', 'Memory files', 'Project notes', 'Skills', 'MCP connections', 'SSH identities']) assert.ok(html.includes(label));
  assert.match(html, /Searching this computer/);
  assert.match(html, /disabled=""[^>]*>Next/);
  assert.ok(html.includes('private SSH key contents are never read'));
});


test('completed discovery shows public counts and enables Next; errors keep it blocked', () => {
  const { DiscoveryInventoryView } = require('../src/FirstRunSetup.tsx');
  const result = { status: 'done', scanned: 500, counts: { projects: 12, memories: 43, notes: 27, skills: 16, mcp: 3, ssh: 2 }, denied: 1, unavailable: 2, limited: true, notice: 'Discovery complete.' };
  const props = { result, onRetry() {}, onNext() {} };
  const html = renderToStaticMarkup(React.createElement(DiscoveryInventoryView, props));
  assert.match(html, /<dd>12<\/dd>/);
  assert.match(html, /<dd>43<\/dd>/);
  assert.match(html, /500 entries checked/);
  assert.match(html, /1 folder denied access/);
  assert.match(html, /Some locations could not be fully searched/);
  assert.doesNotMatch(html, /disabled=""[^>]*>Next/);
  const failed = renderToStaticMarkup(React.createElement(DiscoveryInventoryView, { ...props, error: true }));
  assert.match(failed, /disabled=""[^>]*>Next/);
  assert.match(failed, /Try again/);
});

test('discovery folder labels remain bounded basenames through both bridge projections', () => {
  const path = '/api/first-run/discovery';
  const body = { status: 'scanning', scanned: 5, counts: { projects: 2, memories: 0, notes: 0, skills: 0, mcp: 0, ssh: 0 }, denied: 0, unavailable: 0, limited: false, notice: 'Searching…', folderNames: ['Example project', '/private/hidden', 'C:\\Users\\private', 'line\nbreak', 'unused'] };
  const once = firstRunResponse(path, 200, body);
  assert.deepEqual(once.folderNames, ['Example project']);
  assert.deepEqual(firstRunResponse(path, 200, once), once);
  const { DiscoveryInventoryView } = require('../src/FirstRunSetup.tsx');
  const html = renderToStaticMarkup(React.createElement(DiscoveryInventoryView, { result: once, onRetry() {}, onNext() {} }));
  assert.ok(html.includes('Example project'));
  assert.doesNotMatch(html, /private\/hidden|Users\\private|line\nbreak/);
});

test('typed discovery samples expose display names only and reject path-shaped labels', () => {
  const path = '/api/first-run/discovery';
  const body = { status: 'scanning', scanned: 5, counts: { projects: 2, memories: 0, notes: 0, skills: 1, mcp: 1, ssh: 1 }, denied: 0, unavailable: 0, limited: false, notice: 'Searching…', samples: [{ kind: 'ssh', name: 'id_ed25519', content: 'never-project-this' }, { kind: 'skill', name: 'Design review' }, { kind: 'mcp', name: '/private/server' }, { kind: 'other', name: 'Unknown' }, { kind: 'file', name: 'line\nbreak' }] };
  const once = firstRunResponse(path, 200, body);
  assert.deepEqual(once.samples, [{kind:'ssh', name:'id_ed25519'}, {kind:'skill', name:'Design review'}]);
  assert.deepEqual(firstRunResponse(path, 200, once), once);
  assert.doesNotMatch(JSON.stringify(once), /never-project-this|private\/server|Unknown/);
});
