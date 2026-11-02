// STORE-MAP-01 P2 (board SM5, decision D7): the words people see follow the backend switch.
// The switches route is read only in both gates; the rules list and the eye carry precedence and
// groups through the contract; the pages show the new words only while the switch is on.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { allowedStoreSwitches, storeSwitchesResponse, STORE_SWITCHES_PATH } = require('../src/store-switches-contract.js');
const { agentRulesResponse, RULE_GROUPS } = require('../src/agent-rules-contract.js');
const { allowed } = require('../scripts/application-server.cjs');
const { allowedRequest } = require('../src/session.ts');
const { RulesController, PRECEDENCE_ORDER, PRECEDENCE_TITLES } = require('../src/agent-rules.ts');
const { storeSwitches } = require('../src/store-switches.ts');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const ID = '3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b';
const rule = (x = {}) => ({ id: ID, text: 'Chat in Arabic', when: null, projectId: null, who: 'all', targets: [], paused: false, status: 'active', source: 'owner', suggestedBy: null, reason: null, version: 1, createdAt: '', updatedAt: '', shipped: false, locked: false, ...x });

test('switches route: GET only, in the browser gate and the desktop bridge; only p2 passes back', () => {
  for (const gate of [allowedStoreSwitches, (m, p, b) => allowedRequest(m, p, b), (m, p, b) => allowed(m, p, b)]) {
    assert.ok(gate('GET', STORE_SWITCHES_PATH, undefined));
    assert.ok(!gate('PUT', STORE_SWITCHES_PATH, { p2: true }));
    assert.ok(!gate('GET', `${STORE_SWITCHES_PATH}/x`, undefined));
  }
  assert.deepEqual(storeSwitchesResponse(200, { p2: true, secret: 'x' }), { p2: true });
  assert.deepEqual(storeSwitchesResponse(200, { p2: 'yes' }), { p2: false });
  assert.deepEqual(storeSwitchesResponse(403, {}), { code: 'forbidden' });
});

test('storeSwitches: read once per client; anything unreadable is off', async () => {
  let n = 0;
  const on = { request: async () => { n++; return { status: 200, body: { p2: true } }; } };
  assert.deepEqual(await storeSwitches(on), { p2: true });
  assert.deepEqual(await storeSwitches(on), { p2: true });
  assert.equal(n, 1);
  assert.deepEqual(await storeSwitches({ request: async () => { throw Error('down'); } }), { p2: false });
});

test('rules contract: precedence and groups pass; an unknown group is dropped', () => {
  const list = agentRulesResponse('/api/agent-rules', 200, { rules: [rule()], suggestions: [], departments: [], starter: [], precedence: true });
  assert.equal(list.precedence, true);
  assert.equal(agentRulesResponse('/api/agent-rules', 200, { rules: [], suggestions: [] }).precedence, false);
  const eye = agentRulesResponse('/api/agent-rules/effective?agentId=a1', 200, { rules: [rule({ group: 'safety' }), rule({ group: 'boss' })], precedence: true });
  assert.equal(eye.precedence, true);
  assert.equal(eye.rules[0].group, 'safety');
  assert.ok(!('group' in eye.rules[1]));
  assert.deepEqual(RULE_GROUPS, PRECEDENCE_ORDER);
  assert.deepEqual(Object.keys(PRECEDENCE_TITLES), PRECEDENCE_ORDER);
});

test('controller: the rules page knows when the backend applies precedence', async () => {
  const make = (precedence) => ({ request: async (r) => {
    if (r.path === '/api/agent-rules') return { status: 200, body: { rules: [], suggestions: [], departments: [], precedence } };
    if (r.path === '/api/chat/projects') return { status: 200, body: { projects: [] } };
    throw Error(r.path);
  } });
  const on = new RulesController(make(true)); await on.load();
  assert.equal(on.getSnapshot().precedence, true);
  const off = new RulesController(make(false)); await off.load();
  assert.equal(off.getSnapshot().precedence, false);
});

test('pages: the approved words, shown only with the switch', () => {
  const rules = src('AgentRules.tsx');
  assert.match(rules, /s\.precedence\s*\n?\s*\? 'A rule without “When” always applies\. When two disagree, the stronger one wins, in this order: safety rules, this project, rules for this agent, its department, all agents\. An agent’s own instructions, specialties and skills never override a rule\.'/);
  assert.match(rules, /'This is the list the agent gets before a task, strongest group first: Safety \(always on\) · This project · For this agent · Its department · All agents\. Inside a group the later rule wins\. Paused rules are left out\.'/);
  assert.match(rules, /When two disagree, the later one wins\./, 'the earlier words stay while the switch is off');
  assert.deepEqual(Object.values(PRECEDENCE_TITLES), ['Safety (always on)', 'This project', 'For this agent', 'Its department', 'All agents']);
  const mem = src('MemorySettings.tsx');
  assert.match(mem, /\['Saves only what will matter later', 'decisions with their reason, your preferences, facts needed again, lessons; never drafts, small talk or secrets'\]/);
  assert.match(mem, /\(p2 \? \[SAVE_ROW, \.\.\.STANDING\] : STANDING\)/);
  const sp = src('SpecialtyLibrary.tsx');
  assert.match(sp, /\{p2&&<small className="fine-print sp-first-line">Agents see only this line until they open the guide — say what it is for in one sentence:/);
  assert.match(sp, /length\}\/160/);
  assert.match(src('AgentSpecialtiesSkills.tsx'), /\{p2\?' The agent sees each one’s name and first line until it opens it\.':''\}/);
});
