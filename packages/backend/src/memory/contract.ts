/**
 * STORE-MAP-01 P6 (AG2, XP1, XP2): one memory contract.
 *
 * Five verbs mean the same thing whoever calls them:
 *   recall     search the memory this caller may read
 *   save       a lasting fact, with an optional topic key (one fact per topic)
 *   supersede  a new text that replaces one memory (the old one is kept as history)
 *   handoff    done / left / next / questions for the next agent
 *   propose    a fact, decision or correction the owner reviews first
 *
 * ONE definition below; both doors are generated from it (XP1): MCP tools for
 * coding apps and editors, and native tool definitions for API and local
 * models. The native ones are NOT added to every turn's tool list (that would
 * grow the per-turn prompt of local models, LOCAL-ONLY-01); they are loaded
 * on demand once tools-on-demand lands (P2b).
 *
 * The server checks every argument itself (XP2): unknown names, wrong types,
 * sizes, topic keys and ids are refused with a plain message, because models
 * (small local ones most of all) do not call tools reliably.
 */

import { normalizeTopicKey, TopicKeyError } from './topic-key.js';
import { storeP8Enabled } from '../services/store-p8.js';
import { asMcp, asNative, type ToolDef } from '../tools/tool-doors.js';

export const MEMORY_VERBS = ['recall', 'save', 'supersede', 'handoff', 'propose'] as const;
export type MemoryVerb = (typeof MEMORY_VERBS)[number];

export const MAX_FACT_CHARS = 4000;
export const MAX_QUERY_CHARS = 500;
export const MAX_LIST_ITEMS = 8;
export const MAX_LIST_ITEM_CHARS = 300;
const ID = /^[A-Za-z0-9_.@-]{1,200}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

type Prop = { type: 'string'; maxLength?: number; description: string } | { type: 'integer'; minimum: number; maximum: number; description: string }
  | { type: 'array'; maxItems: number; items: { type: 'string'; maxLength: number }; description: string };
interface VerbDefinition { verb: MemoryVerb; description: string; properties: Record<string, Prop>; required: string[] }

const requestId: Prop = { type: 'string', maxLength: 64, description: 'Optional id you choose for this write (8-64 letters, digits, - or _). Send the same id again when you retry after a timeout: it is never saved twice.' };
const lines = (what: string, max = MAX_LIST_ITEMS): Prop => ({ type: 'array', maxItems: max, items: { type: 'string', maxLength: MAX_LIST_ITEM_CHARS }, description: `${what} (up to ${max} short lines)` });

export const MEMORY_CONTRACT: readonly VerbDefinition[] = [
  { verb: 'recall', description: 'Search the memory you may read for this work. Returns the best matches with their ids; says so when nothing is found. Never guess a memory that is not returned.',
    properties: { query: { type: 'string', maxLength: MAX_QUERY_CHARS, description: 'What to look for' }, limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many results (default 8)' } }, required: ['query'] },
  { verb: 'save', description: 'Save one lasting fact. Give a topic key when the fact is the current answer to a question that can change (for example "release-day"); a later save with the same key replaces it. Never a secret.',
    properties: { content: { type: 'string', maxLength: MAX_FACT_CHARS, description: 'The fact, in one or two sentences' }, topic_key: { type: 'string', maxLength: 80, description: 'Optional stable key, lower-case words joined by -' }, request_id: requestId }, required: ['content'] },
  { verb: 'supersede', description: 'Replace one memory you found with recall by a corrected text. The old text stays in its history.',
    properties: { id: { type: 'string', maxLength: 200, description: 'The id of the memory to replace (from recall)' }, content: { type: 'string', maxLength: MAX_FACT_CHARS, description: 'The corrected text' }, request_id: requestId }, required: ['id', 'content'] },
  { verb: 'handoff', description: 'Before you stop, leave a short note for the next agent: what is done, what is left, the next steps, open questions. Never secrets.',
    properties: { done: lines('What is finished'), left: lines('What is still open'), next: lines('The next steps'), questions: lines('Open questions for the owner'), request_id: requestId }, required: [] },
  { verb: 'propose', description: 'Propose a fact, decision or correction the owner reviews before it is saved. One idea per call; never a secret.',
    properties: { content: { type: 'string', maxLength: MAX_FACT_CHARS, description: 'The proposal' }, request_id: requestId }, required: ['content'] },
];

/** STORE-MAP-01 P8 (D28): the handoff verb also takes blockers, files touched and the task (T-n). */
export const MAX_FILES = 30;
const P8_HANDOFF: Record<string, Prop> = {
  blockers: lines('What blocks the work now'),
  files: lines('Files you changed, as paths in the project', MAX_FILES),
  task: { type: 'string', maxLength: 12, description: 'Optional task number in the project\'s task file, like T-12' },
};

/** The verbs as they are now: with P8 on the handoff verb has its P8 arguments (one place for both doors and the checks). */
export function contractDefinitions(): readonly VerbDefinition[] {
  if (!storeP8Enabled()) return MEMORY_CONTRACT;
  return MEMORY_CONTRACT.map((d) => (d.verb === 'handoff' ? { ...d, properties: { ...d.properties, ...P8_HANDOFF } } : d));
}

const schemaOf = (d: VerbDefinition) => ({ type: 'object', properties: d.properties, required: d.required, additionalProperties: false });

/** XP1: the verbs as the one tool definition every door renders (tools/tool-doors.ts). */
export function contractToolDefs(): ToolDef[] {
  return contractDefinitions().map((d) => ({ name: `memory_${d.verb}`, description: d.description, input_schema: schemaOf(d) }));
}

/** XP1, door 1: the MCP tools (dpro-memory), named memory_<verb>. */
export function mcpContractTools(): Array<{ name: string; description: string; inputSchema: ReturnType<typeof schemaOf> }> {
  return contractToolDefs().map(asMcp);
}

/** XP1, door 2: the same verbs as native tool definitions (loaded on demand, never in every turn). */
export function nativeContractTools(): Array<{ name: string; description: string; input_schema: ReturnType<typeof schemaOf> }> {
  return contractToolDefs().map(asNative);
}

export const verbOfTool = (name: string): MemoryVerb | null => {
  const v = name.startsWith('memory_') ? name.slice(7) : '';
  return (MEMORY_VERBS as readonly string[]).includes(v) ? v as MemoryVerb : null;
};

export class ContractError extends Error {
  constructor(message: string) { super(message); }
}

export interface ValidArgs {
  query?: string; limit?: number; content?: string; topicKey?: string | null; id?: string; requestId?: string | null;
  done?: string[]; left?: string[]; next?: string[]; questions?: string[];
  /** P8 only. */
  blockers?: string[]; files?: string[]; task?: string;
}

/**
 * XP2: check every argument of a verb. Returns clean values or throws a
 * ContractError whose message tells the model exactly what to fix.
 */
export function validateVerb(verb: MemoryVerb, raw: unknown): ValidArgs {
  const d = contractDefinitions().find((x) => x.verb === verb);
  if (!d) throw new ContractError(`Unknown memory verb ${String(verb)}`);
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) throw new ContractError('Arguments must be an object');
  const args = (raw ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(args)) if (!(k in d.properties)) throw new ContractError(`${k} is not an argument of memory_${verb}`);
  for (const k of d.required) if (args[k] === undefined || args[k] === null || args[k] === '') throw new ContractError(`${k} is required`);
  const out: ValidArgs = {};
  for (const [k, p] of Object.entries(d.properties)) {
    const v = args[k];
    if (v === undefined || v === null) continue;
    if (p.type === 'string') {
      if (typeof v !== 'string') throw new ContractError(`${k} must be text`);
      const t = v.trim();
      if (p.maxLength && t.length > p.maxLength) throw new ContractError(`${k} is longer than ${p.maxLength} characters`);
      if (k === 'content' || k === 'query') { if (!t) throw new ContractError(`${k} is empty`); out[k] = t; }
      else if (k === 'topic_key') {
        try { out.topicKey = normalizeTopicKey(t); } catch (err) { throw new ContractError(err instanceof TopicKeyError ? `topic_key: ${err.message}` : 'topic_key is not valid'); }
      } else if (k === 'id') { if (!ID.test(t)) throw new ContractError('id is not a memory id (use an id that recall returned)'); out.id = t; }
      else if (k === 'request_id') { if (!REQUEST_ID.test(t)) throw new ContractError('request_id must be 8-64 letters, digits, - or _'); out.requestId = t; }
      else if (k === 'task') { if (!/^T-\d{1,6}$/.test(t)) throw new ContractError('task must be a task number like T-12'); out.task = t; }
    } else if (p.type === 'integer') {
      if (!Number.isInteger(v) || (v as number) < p.minimum || (v as number) > p.maximum) throw new ContractError(`${k} must be a whole number from ${p.minimum} to ${p.maximum}`);
      out.limit = v as number;
    } else {
      if (!Array.isArray(v) || v.length > p.maxItems || v.some((x) => typeof x !== 'string' || x.length > p.items.maxLength)) {
        throw new ContractError(`${k} must be a list of up to ${p.maxItems} lines of at most ${p.items.maxLength} characters`);
      }
      (out as Record<string, unknown>)[k] = (v as string[]).map((x) => x.trim()).filter(Boolean);
    }
  }
  return out;
}
