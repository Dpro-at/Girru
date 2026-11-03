/**
 * STORE-MAP-01 P9 (XP3, XP4): the memory conformance check every provider
 * must pass before it counts as supported.
 *
 * One memory contract (contract.ts) is sent to each provider in that
 * provider's own tool format and comes back as that provider's own tool
 * calls. A ProviderFormat says how: `encodeTools` turns the contract into the
 * provider's tool list, `decodeCall` turns one of its tool calls back into a
 * contract verb and arguments. A new provider (an OpenAI or Gemini API
 * provider later) adds its format here and must pass `runConformance`:
 *
 *   1 save       a fact with a topic key
 *   2 recall     finds it
 *   3 supersede  replaces it by id with a corrected text
 *   4 handoff    done / left / next
 *   5 recall     returns the new fact and not the old one
 *   (+ propose, and a call with a wrong argument that must be refused)
 *
 * The provider's side is a script of synthetic tool calls in its wire
 * format (fixtures); nothing here calls a live provider or spends credits
 * (CX11). The server side is any VerbExecutor: the tests use the in-memory
 * one below, which keeps the contract's meaning (one current fact per topic
 * key, supersede keeps the old text as history). `memorySupport` answers
 * "supported" only for a format whose conformance passed in this process.
 */

import { contractDefinitions, ContractError, validateVerb, verbOfTool, type MemoryVerb, type ValidArgs } from './contract.js';

type Def = ReturnType<typeof contractDefinitions>[number];
const schemaOf = (d: Def) => ({ type: 'object', properties: d.properties, required: d.required, additionalProperties: false });

export interface ProviderFormat {
  id: string;
  /** The contract as this provider's tool list. */
  encodeTools(defs: readonly Def[]): unknown[];
  /** One tool call in this provider's wire format -> tool name and arguments (null: not a tool call). */
  decodeCall(raw: unknown): { name: string; args: unknown } | null;
}

const parseArgs = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return Symbol.for('unparseable'); }
};
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null);

export const PROVIDER_FORMATS: readonly ProviderFormat[] = [
  {
    id: 'anthropic', // Claude API: tools [{ name, description, input_schema }], calls { type: 'tool_use', name, input }
    encodeTools: (defs) => defs.map((d) => ({ name: `memory_${d.verb}`, description: d.description, input_schema: schemaOf(d) })),
    decodeCall: (raw) => { const r = obj(raw); return r?.type === 'tool_use' && typeof r.name === 'string' ? { name: r.name, args: r.input } : null; },
  },
  {
    id: 'ollama', // Ollama / LM Studio (OpenAI-like): tools [{ type: 'function', function: { name, description, parameters } }], calls { function: { name, arguments } }
    encodeTools: (defs) => defs.map((d) => ({ type: 'function', function: { name: `memory_${d.verb}`, description: d.description, parameters: schemaOf(d) } })),
    decodeCall: (raw) => { const f = obj(obj(raw)?.function); return f && typeof f.name === 'string' ? { name: f.name, args: parseArgs(f.arguments) } : null; },
  },
  {
    id: 'openai', // OpenAI API: the same tools, calls { type: 'function', function: { name, arguments: '<json>' } }
    encodeTools: (defs) => defs.map((d) => ({ type: 'function', function: { name: `memory_${d.verb}`, description: d.description, parameters: schemaOf(d), strict: false } })),
    decodeCall: (raw) => { const r = obj(raw); const f = obj(r?.function); return r?.type === 'function' && f && typeof f.name === 'string' ? { name: f.name, args: parseArgs(f.arguments) } : null; },
  },
  {
    id: 'gemini', // Gemini API: [{ functionDeclarations: [...] }], calls { functionCall: { name, args } }
    encodeTools: (defs) => [{ functionDeclarations: defs.map((d) => ({ name: `memory_${d.verb}`, description: d.description, parameters: { type: 'object', properties: d.properties, required: d.required } })) }],
    decodeCall: (raw) => { const f = obj(obj(raw)?.functionCall); return f && typeof f.name === 'string' ? { name: f.name, args: f.args } : null; },
  },
  {
    id: 'mcp', // coding apps over dpro-memory: tools/list { name, description, inputSchema }, tools/call { name, arguments }
    encodeTools: (defs) => defs.map((d) => ({ name: `memory_${d.verb}`, description: d.description, inputSchema: schemaOf(d) })),
    decodeCall: (raw) => { const r = obj(raw); return r && typeof r.name === 'string' ? { name: r.name, args: r.arguments } : null; },
  },
];

export interface VerbExecutor { run(verb: MemoryVerb, args: ValidArgs): Promise<{ text: string; data?: any }> }

/** The contract's meaning in memory (for the check): one current fact per topic key; supersede keeps history. */
export function inMemoryExecutor(): VerbExecutor & { facts: Map<string, { content: string; topicKey: string | null; replacedBy: string | null }>; handoffs: ValidArgs[]; proposals: string[] } {
  const facts = new Map<string, { content: string; topicKey: string | null; replacedBy: string | null }>();
  const handoffs: ValidArgs[] = [];
  const proposals: string[] = [];
  let n = 0;
  const current = () => [...facts.entries()].filter(([, f]) => !f.replacedBy);
  return {
    facts, handoffs, proposals,
    async run(verb, a) {
      if (verb === 'save') {
        const id = `m${++n}`;
        for (const [, f] of current()) if (a.topicKey && f.topicKey === a.topicKey) f.replacedBy = id;
        facts.set(id, { content: a.content!, topicKey: a.topicKey ?? null, replacedBy: null });
        return { text: `Saved ${id}`, data: { id } };
      }
      if (verb === 'recall') {
        const words = a.query!.toLowerCase().split(/\W+/).filter(Boolean);
        const hits = current().filter(([, f]) => words.some((w) => f.content.toLowerCase().includes(w))).slice(0, a.limit ?? 8);
        return { text: hits.length ? hits.map(([id, f]) => `- [${id}] ${f.content}`).join('\n') : 'Nothing found. Do not guess.', data: { results: hits.map(([id, f]) => ({ id, content: f.content })) } };
      }
      if (verb === 'supersede') {
        const old = facts.get(a.id!);
        if (!old || old.replacedBy) throw new ContractError('id is not a current memory (use an id that recall returned)');
        const id = `m${++n}`;
        old.replacedBy = id;
        facts.set(id, { content: a.content!, topicKey: old.topicKey, replacedBy: null });
        return { text: `Replaced ${a.id} by ${id}`, data: { id } };
      }
      if (verb === 'handoff') { handoffs.push(a); return { text: 'Handoff saved' }; }
      proposals.push(a.content!);
      return { text: 'Proposed; the owner reviews it' };
    },
  };
}

export interface ConformanceStep { verb: string; ok: boolean; error?: string }
export interface ConformanceResult { provider: string; passed: boolean; steps: ConformanceStep[]; failures: string[] }

/**
 * Run the scenario: `calls` are the provider's own tool calls (synthetic),
 * in order. The ids the executor returns are given to `calls` so a script
 * can supersede the memory it found (calls may be a function of the ids).
 */
export async function runConformance(
  format: ProviderFormat,
  calls: (ids: { saved?: string; found?: string }) => unknown[],
  expect: { newText: string; oldText: string },
  exec: VerbExecutor = inMemoryExecutor(),
): Promise<ConformanceResult> {
  const steps: ConformanceStep[] = [];
  const failures: string[] = [];
  const tools = format.encodeTools(contractDefinitions());
  const names = JSON.stringify(tools);
  for (const v of ['recall', 'save', 'supersede', 'handoff', 'propose']) if (!names.includes(`memory_${v}`)) failures.push(`tool list has no memory_${v}`);

  const ids: { saved?: string; found?: string } = {};
  let lastRecall = '';
  let refused = 0;
  // Calls are built step by step, so a later call can use an id an earlier one returned.
  for (let i = 0; ; i++) {
    const raw = calls(ids)[i];
    if (raw === undefined) break;
    const call = format.decodeCall(raw);
    const verb = call ? verbOfTool(call.name) : null;
    if (!call || !verb) { steps.push({ verb: '?', ok: false, error: 'not a memory tool call' }); failures.push(`call ${i + 1} is not a memory tool call`); continue; }
    try {
      const out = await exec.run(verb, validateVerb(verb, call.args));
      steps.push({ verb, ok: true });
      if (verb === 'recall') lastRecall = out.text;
      if (verb === 'save') ids.saved = out.data?.id;
      if (verb === 'recall' && out.data?.results?.[0]) ids.found = out.data.results[0].id;
    } catch (err) {
      if (!(err instanceof ContractError)) throw err;
      steps.push({ verb, ok: false, error: err.message });
      refused++;
    }
  }
  const did = (v: string) => steps.filter((s) => s.verb === v && s.ok).length;
  for (const v of ['save', 'supersede', 'handoff', 'propose']) if (did(v) < 1) failures.push(`${v} did not succeed`);
  if (did('recall') < 2) failures.push('recall did not run twice');
  if (refused < 1) failures.push('a wrong argument was not refused');
  // The last recall returns the new fact and not the replaced one.
  if (!lastRecall.includes(expect.newText)) failures.push('the last recall did not return the new fact');
  if (lastRecall.includes(expect.oldText)) failures.push('the last recall still returned the replaced fact');
  return { provider: format.id, passed: failures.length === 0, steps, failures };
}

const PASSED = new Set<string>();

/** Record a result (a provider counts as supported only after it passed). */
export function recordConformance(r: ConformanceResult): void {
  if (r.passed) PASSED.add(r.provider);
  else PASSED.delete(r.provider);
}

/** 'supported' after conformance passed; else 'memory limited' (the UI says so). */
export function memorySupport(provider: string): 'supported' | 'memory limited' {
  return PASSED.has(provider) ? 'supported' : 'memory limited';
}
