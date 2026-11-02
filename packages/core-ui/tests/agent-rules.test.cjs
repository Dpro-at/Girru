// RULES-01: Agents › Rules — the wire contract, the grouping and words of the page, the controller, the wiring.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { allowedAgentRules, agentRulesResponse, agentRulesRoute } = require('../src/agent-rules-contract.js');
const { ruleGroups, whoWords, followers, reaches, RulesController } = require('../src/agent-rules.ts');
const { allowedRequest } = require('../src/session.ts');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const ID = '3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b';
const rule = (x) => ({ id: ID, text: 'Chat in Arabic', when: null, projectId: null, who: 'all', targets: [], paused: false, status: 'active', source: 'owner', suggestedBy: null, reason: null, version: 1, createdAt: '2026-10-29T09:00:00.000Z', updatedAt: '', ...x });

test('contract: only the Rules routes and shapes pass', () => {
  const ok = [['GET', '/api/agent-rules'], ['GET', `/api/agent-rules/effective?agentId=agent-1&projectId=p1`], ['GET', `/api/agent-rules/conflicts?agentId=agent-1`], ['GET', `/api/agent-rules/${ID}/versions`],
    ['POST', '/api/agent-rules', { text: 'x', who: 'departments', targets: ['development'] }], ['POST', '/api/agent-rules/starter'],
    ['POST', `/api/agent-rules/${ID}/delete`], ['POST', `/api/agent-rules/${ID}/undo-delete`], ['POST', `/api/agent-rules/${ID}/accept`], ['POST', `/api/agent-rules/${ID}/dismiss`],
    ['POST', `/api/agent-rules/${ID}/versions/2/restore`], ['PUT', `/api/agent-rules/${ID}`, { paused: true }], ['PUT', `/api/agent-rules/${ID}`, { when: 'a screen changes' }], ['PUT', `/api/agent-rules/${ID}`, { when: null }]];
  for (const [m, p, b] of ok) { assert.ok(allowedAgentRules(m, p, b), `${m} ${p}`); assert.ok(allowedRequest(m, p, b), `session ${m} ${p}`); }
  const no = [['POST', '/api/agent-rules', { text: '' }], ['POST', '/api/agent-rules', { text: 'x', extra: 1 }], ['POST', '/api/agent-rules', { who: 'all' }],
    ['PUT', `/api/agent-rules/${ID}`, {}], ['PUT', `/api/agent-rules/${ID}`, { who: 'everyone' }], ['PUT', `/api/agent-rules/${ID}`, { when: 'x'.repeat(301) }], ['PUT', `/api/agent-rules/${ID}`, { when: 3 }], ['DELETE', `/api/agent-rules/${ID}`],
    ['POST', `/api/agent-rules/${ID}/delete`, { x: 1 }], ['GET', '/api/agent-rules/effective?agentId='], ['POST', '/api/agent-rules/../users'], ['POST', '/api/agent-rules/suggestions', { text: 'x' }]];
  for (const [m, p, b] of no) assert.equal(allowedAgentRules(m, p, b), false, `${m} ${p} ${JSON.stringify(b)}`);
  assert.equal(agentRulesRoute('/api/agent-rulesX'), false);
});

test('contract: a rule comes back with its own fields only; a refused rule keeps its one-line reason', () => {
  const page = agentRulesResponse('/api/agent-rules', 200, { rules: [rule({ createdBy: 'owner-id', secret: 'x' })], suggestions: [], departments: ['development'], starter: ['a'] });
  assert.deepEqual(Object.keys(page.rules[0]).sort(), ['createdAt', 'id', 'locked', 'paused', 'projectId', 'reason', 'shipped', 'source', 'status', 'suggestedBy', 'targets', 'text', 'updatedAt', 'version', 'when', 'who']);
  assert.deepEqual(agentRulesResponse('/api/agent-rules', 400, { error: 'Write the rule as a sentence', code: 'invalid_rule' }), { code: 'invalid_rule', error: 'Write the rule as a sentence' });
  assert.deepEqual(agentRulesResponse(`/api/agent-rules/${ID}/delete`, 404, { error: 'x' }), { code: 'not_found' });
  assert.deepEqual(agentRulesResponse(`/api/agent-rules/${ID}/delete`, 200, { ok: true, undoMs: 600000 }), { ok: true, undoMs: 600000 });
  assert.deepEqual(agentRulesResponse('/api/agent-rules/conflicts?agentId=a', 200, { checked: true, conflicts: [{ a: 'x', b: 'y', why: 'w', extra: 1 }, { a: 1 }] }), { checked: true, conflicts: [{ a: 'x', b: 'y', why: 'w' }] });
  assert.throws(() => agentRulesResponse('/api/agent-rules', 200, { nothing: true }), /protocol/);
});

test('the page groups rules the way agents get them and says who follows each in words', () => {
  const agents = [{ id: 'a1', name: 'Lead', department: null }, { id: 'a2', name: 'Dev', department: 'development' }, { id: 'a3', name: 'QA', department: 'research' }];
  const projects = [{ id: 'p1', name: 'Dpro' }];
  const rules = [rule({ id: 'e' }), rule({ id: 'p', projectId: 'p1', who: 'departments', targets: ['development'] }), rule({ id: 'o', who: 'agents', targets: ['a3'] })];
  const groups = ruleGroups(rules, [rule({ id: 's', status: 'suggested' })], projects);
  assert.deepEqual(groups.map(g => [g.title, g.rules.map(r => r.id)]), [['Suggested by an agent', ['s']], ['Everywhere · all agents', ['e']], ['Project · Dpro', ['p']], ['Chosen agents', ['o']]]);
  assert.equal(whoWords(rules[0], agents), 'All agents');
  assert.equal(whoWords(rules[1], agents, projects), 'Development · 1 agent');
  assert.equal(whoWords(rules[2], agents), 'QA');
  assert.deepEqual(rules.map(r => followers(r, agents)), [3, 1, 1]);
  assert.equal(reaches(rules[1], agents[1], 'p1'), true);
  assert.equal(reaches(rules[1], agents[1], 'p2'), false, 'a project rule stays in its project');
  assert.equal(reaches(rules[1], agents[2], 'p1'), false, 'not in that department');
});

test('controller: delete shows Undo and Undo puts the rule back; a refused save shows the server words', async () => {
  const calls = []; let rules = [rule()];
  const client = { request: async (r) => {
    calls.push(`${r.method} ${r.path}`);
    if (r.path === '/api/agent-rules' && r.method === 'GET') return { status: 200, body: { rules, suggestions: [], departments: [] } };
    if (r.path === '/api/chat/projects') return { status: 200, body: { projects: [] } };
    if (r.path.endsWith('/delete')) { rules = []; return { status: 200, body: { ok: true, undoMs: 600000 } }; }
    if (r.path.endsWith('/undo-delete')) { rules = [rule()]; return { status: 200, body: { rule: rule() } }; }
    if (r.method === 'PUT') return { status: 400, body: { code: 'invalid_rule', error: 'Choose at least one department' } };
    throw Error(r.path);
  } };
  const c = new RulesController(client);
  await c.load();
  await c.remove(ID);
  assert.deepEqual([c.getSnapshot().rules.length, c.getSnapshot().toast?.text, c.getSnapshot().toast?.undo], [0, 'Rule deleted.', true]);
  await c.undo();
  assert.deepEqual([c.getSnapshot().rules.length, c.getSnapshot().selected, c.getSnapshot().toast], [1, ID, null]);
  await c.change(ID, { who: 'departments', targets: [] });
  assert.equal(c.getSnapshot().notice, 'Choose at least one department');
});

test('wiring: Rules is the owner\'s place in the Agents sidebar with a "needs you" badge; one main button; Undo, keyboard and right-click', () => {
  const d = src('src/AgentsDestination.tsx');
  assert.match(d, /rules=\{owner \? ruleSuggestions : undefined\}/);
  assert.match(d, /if \(department === 'rules' && owner && controller\)/);
  assert.match(d, /<span className="dk-place-name">Rules<\/span>\{rules>0&&<span className="dk-place-badge"/);
  const p = src('src/AgentRules.tsx');
  assert.equal((p.match(/className="primary"/g) ?? []).length, 4, 'New rule; Use this rule (only for a suggestion); Done and Write the files, each in its own sheet');
  for (const re of [/onContextMenu=/, /e\.key === 'Delete' \|\| e\.key === 'Backspace'/, /e\.key\.toLowerCase\(\) === 'z' && s\.lastDeleted/, /<Notice toast=\{s\.toast\} onUndo=/, /What an agent sees/, /Two rules disagree/, /\{byGroup \? 'The stronger one' : 'The later one'\}, “\{textOf\(winner\(x\.a, x\.b\)\)\}”, wins/, /Start with our usual rules/, /DocumentEditor/]) assert.match(p, re);
  assert.match(src('scripts/application-server.cjs'), /if \(agentRulesRoute\(target\)\) return allowedAgentRules\(method, target, body\);/);
});

test('RULES-02: a rule with a case reads "When X: rule"; the page offers Always / Only when… and shows what the agent reads', () => {
  const { ruleLine } = require('../src/agent-rules.ts');
  assert.equal(ruleLine({ text: 'Ask me first.', when: 'a hand-off fails twice' }), 'When a hand-off fails twice: Ask me first.');
  assert.equal(ruleLine({ text: 'Chat in Arabic.', when: null }), 'Chat in Arabic.');
  const p = src('src/AgentRules.tsx');
  for (const re of [/aria-label="When it applies"/, />Always<\/button>/, /Only when…<\/button>/, /aria-label="The case"/, /<b>The agent reads:<\/b>/, /className="rules-when" title="Only in this case"/, /rules-when-lead/, /two rules for different cases do not disagree/]) assert.match(p, re);
  assert.equal(agentRulesResponse(`/api/agent-rules/${ID}/versions`, 200, { versions: [{ version: 1, text: 't', when: 'w', changedAt: 'x' }] }).versions[0].when, 'w');
});

test('RULES-04: one list — put back and the files routes pass the contract; the page shows a lock for safety rules and the files line in each project', () => {
  for (const [m, p, b] of [['POST', `/api/agent-rules/${ID}/put-back`], ['GET', '/api/agent-rules/files/p1'], ['POST', '/api/agent-rules/files/p1', { mode: 'private' }]]) assert.ok(allowedAgentRules(m, p, b) && allowedRequest(m, p, b), `${m} ${p}`);
  for (const [m, p, b] of [['PUT', '/api/agent-rules/basics/basic:language', { paused: true }], ['POST', '/api/agent-rules/files/p1', { mode: 'public' }], ['POST', '/api/agent-rules/files/p1'], ['POST', `/api/agent-rules/${ID}/put-back`, { a: 1 }]]) assert.equal(allowedAgentRules(m, p, b), false, `${m} ${p}`);
  const page = agentRulesResponse('/api/agent-rules', 200, { rules: [rule({ id: 'x', source: 'girru', shipped: true, locked: true })], suggestions: [] });
  assert.deepEqual([page.rules[0].source, page.rules[0].shipped, page.rules[0].locked, 'basics' in page], ['girru', true, true, false]);
  const f = agentRulesResponse('/api/agent-rules/files/p1', 200, { files: { projectId: 'p1', folder: '/secret/path', mode: 'private', written: true, upToDate: true, files: [{ name: 'CLAUDE.md', action: 'add' }, { name: 'x', action: 'rm -rf' }], rules: 'r' } });
  assert.deepEqual([f.files.hasFolder, f.files.files.length, 'folder' in f.files], [true, 1, false], 'the folder path itself never reaches the page');
  assert.deepEqual(agentRulesResponse('/api/agent-rules/files/p1', 200, f), f, 'checked twice (bridge, then page) it stays the same');
  const groups = ruleGroups([rule({ id: 'g', source: 'girru', shipped: true })], [], [{ id: 'p9', name: 'Website', folder: '/w' }]);
  assert.deepEqual(groups.map(g => [g.title, g.rules.length]), [['Everywhere · all agents', 1], ['Project · Website', 0]], 'a project with a folder gets its heading even with no rules');
  const p = src('src/AgentRules.tsx');
  assert.doesNotMatch(p, /Girru basics|Built in|Write my own version/);
  for (const re of [/r\.locked \? <span className="rules-paused" title="Safety rule: always on">/, /LockedInspector/, /Put back as it came/, /Files for Claude Code, Codex, Gemini/, /No rules of its own; it gets the everywhere rules\./, /Private on this computer/, /Write the files/, /!selected\.shipped\) \{ e\.preventDefault\(\); void c\.remove/]) assert.match(p, re);
});
