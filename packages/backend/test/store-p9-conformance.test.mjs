// STORE-MAP-01 P9 XP3/XP4: every provider format passes the same five-verb memory scenario before it
// counts as supported. Synthetic tool calls in each provider's own wire format (Claude API, Ollama /
// LM Studio, OpenAI API, Gemini API, MCP); no live provider, no network, no credits.
//  - every format in PROVIDER_FORMATS passes: save (topic key), recall, supersede by id, handoff,
//    propose, a refused wrong argument, and a last recall with the new fact and not the old one;
//  - a format that drops a verb, or a script that never supersedes, fails and stays "memory limited";
//  - the tool lists come from the one contract definition (same names and arguments everywhere).
// Run: node --import tsx --test test/store-p9-conformance.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const C = await import(pathToFileURL(join(process.cwd(), 'src/memory/conformance.ts')).href);
const { contractDefinitions } = await import(pathToFileURL(join(process.cwd(), 'src/memory/contract.ts')).href);

const OLD = 'Release day is Friday';
const NEW = 'Release day is Thursday';
// The scenario as plain (name, args); each format wraps it in its own wire shape.
const steps = (ids) => [
  ['memory_save', { content: OLD, topic_key: 'release-day', request_id: 'req-00001' }],
  ['memory_recall', { query: 'release day' }],
  ['memory_supersede', { id: ids.found ?? 'x', content: NEW, request_id: 'req-00002' }],
  ['memory_handoff', { done: ['Moved the release'], left: [], next: ['Tell the team'] }],
  ['memory_propose', { content: 'Releases always on Thursday from now on' }],
  ['memory_recall', { query: 'release', colour: 'red' }], // a wrong argument: refused
  ['memory_recall', { query: 'release day', limit: 5 }],
];
const WIRE = {
  anthropic: ([name, args]) => ({ type: 'tool_use', id: 'toolu_1', name, input: args }),
  ollama: ([name, args]) => ({ function: { name, arguments: args } }),
  openai: ([name, args]) => ({ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }),
  gemini: ([name, args]) => ({ functionCall: { name, args } }),
  mcp: ([name, args]) => ({ name, arguments: args }),
};

test('every provider format passes the same five-verb scenario', async () => {
  assert.deepEqual(C.PROVIDER_FORMATS.map((f) => f.id).sort(), Object.keys(WIRE).sort(), 'a new format needs its fixture here');
  for (const format of C.PROVIDER_FORMATS) {
    const exec = C.inMemoryExecutor();
    const r = await C.runConformance(format, (ids) => steps(ids).map(WIRE[format.id]), { newText: NEW, oldText: OLD }, exec);
    assert.equal(r.passed, true, `${format.id}: ${r.failures.join('; ')}`);
    assert.equal(r.steps.filter((s) => !s.ok).length, 1, 'only the wrong argument is refused');
    assert.match(r.steps.find((s) => !s.ok).error, /colour is not an argument/);
    assert.equal(exec.handoffs.length, 1);
    assert.equal(exec.proposals.length, 1);
    C.recordConformance(r);
    assert.equal(C.memorySupport(format.id), 'supported');
  }
});

test('the tool lists come from the one contract', () => {
  const verbs = contractDefinitions().map((d) => `memory_${d.verb}`);
  for (const format of C.PROVIDER_FORMATS) {
    const text = JSON.stringify(format.encodeTools(contractDefinitions()));
    for (const v of verbs) assert.ok(text.includes(`"${v}"`), `${format.id} lists ${v}`);
    assert.ok(text.includes('topic_key') && text.includes('request_id'), `${format.id} keeps the arguments`);
  }
});

test('a format that loses a verb, or a script that never supersedes, fails and stays memory limited', async () => {
  const broken = { ...C.PROVIDER_FORMATS[0], id: 'broken-provider', encodeTools: (defs) => C.PROVIDER_FORMATS[0].encodeTools(defs).filter((t) => t.name !== 'memory_supersede') };
  let r = await C.runConformance(broken, (ids) => steps(ids).map(WIRE.anthropic), { newText: NEW, oldText: OLD });
  assert.equal(r.passed, false);
  assert.ok(r.failures.includes('tool list has no memory_supersede'));
  C.recordConformance(r);
  assert.equal(C.memorySupport('broken-provider'), 'memory limited');

  const lazy = (ids) => steps(ids).filter(([n]) => n !== 'memory_supersede').map(WIRE.openai);
  r = await C.runConformance(C.PROVIDER_FORMATS.find((f) => f.id === 'openai'), lazy, { newText: NEW, oldText: OLD });
  assert.equal(r.passed, false);
  assert.ok(r.failures.includes('supersede did not succeed'));
  assert.ok(r.failures.includes('the last recall did not return the new fact'));
  assert.ok(r.failures.includes('the last recall still returned the replaced fact'));
  C.recordConformance(r);
  assert.equal(C.memorySupport('openai'), 'memory limited');
  assert.equal(C.memorySupport('never-tested'), 'memory limited');
});
