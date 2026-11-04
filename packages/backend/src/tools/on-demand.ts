/**
 * Tools on demand (STORE-MAP-01 P2b, LOCAL-ONLY-01 item 2; GIRRU_STORE_P2B).
 *
 * P0 measured that 63 % of a chat turn is tool definitions, too much for an
 * 8k–32k local model. With tools on demand a turn carries:
 *
 *  - the memory verbs in full, always (recall = memory_search, save and
 *    propose = memory_save, supersede = memory_edit, handoff = handoff_save);
 *  - `tool_load`, which gives the full form of other tools by name or group;
 *  - a short index in the system text: every other tool's name and one line.
 *
 * A loaded tool is sent in full on the following steps of the turn (the
 * native door) or comes back in the tool result (the subscription JSON
 * protocol). A tool that was not loaded can still be called by name: its
 * arguments are checked against its full schema (XP2) and a wrong call is
 * told what the tool takes, so a weak model recovers in one step.
 *
 * Small models (window ≤ 16k) get fewer and simpler tools: the memory verbs
 * without examples, a shorter index without the owner's admin tools, and at
 * most a few loaded tools at a time (the oldest leaves first).
 *
 * Security is unchanged: the list is built from the registry's granted tools
 * only, and every call still runs through the registry (grants, policies,
 * approvals). `tool_load` itself only describes tools the agent already has.
 */

import type { ToolResult } from './types.js';
import { checkToolArgs } from './validate-args.js';
import { groupOf, shortLine, simpleDef, type ToolDef } from './tool-doors.js';

export type ModelTier = 'small' | 'medium' | 'large';
export const TOOL_LOAD = 'tool_load';

/** The native door's memory verbs: always loaded, in this order (a stable prefix). */
export const MEMORY_VERB_TOOLS = ['memory_search', 'memory_save', 'memory_edit', 'handoff_save'] as const;

/** Owner admin tools a small model is not shown in the index (still loadable by name). */
const ADMIN = /^(memory_(doctor|scope|access|trash|restore|project_trash|group|bridge|review_(decide|routine)|graph_(review|topic|sync)|person|privacy|trust|corrected|question|move|forget|delete)|discovery|project_(design|databases)_apply|credentials_save|skill_install)/;

const LIMITS: Record<ModelTier, { loaded: number; perLoad: number; line: number }> = {
  small: { loaded: 3, perLoad: 3, line: 60 },
  medium: { loaded: 8, perLoad: 6, line: 80 },
  large: { loaded: 24, perLoad: 10, line: 90 },
};

export function tierOf(windowTokens: number): ModelTier {
  return windowTokens <= 16_384 ? 'small' : windowTokens <= 65_536 ? 'medium' : 'large';
}

const text = (t: string, error?: string): ToolResult => ({ content: [{ type: 'text', text: t }], ...(error ? { error } : {}) });

export class OnDemandTools {
  private readonly byName = new Map<string, ToolDef>();
  private readonly order: string[] = [];
  private loadedNames: string[] = [];
  private readonly limits: (typeof LIMITS)[ModelTier];

  /** Every tool fits the tools share: they are all sent in full, as before (no tool_load, no index). */
  readonly allInFull: boolean;

  constructor(all: readonly ToolDef[], readonly tier: ModelTier, opts: { fitTokens?: number } = {}) {
    for (const d of all) if (d.name !== TOOL_LOAD && !this.byName.has(d.name)) { this.byName.set(d.name, d); this.order.push(d.name); }
    this.limits = LIMITS[tier];
    const defs = this.order.map((n) => this.byName.get(n)!);
    this.allInFull = opts.fitTokens !== undefined && Math.ceil(JSON.stringify(defs).length / 3) <= opts.fitTokens;
  }

  /** The memory verbs this agent has (granted), in the fixed order. */
  always(): string[] { return MEMORY_VERB_TOOLS.filter((n) => this.byName.has(n)); }
  loaded(): string[] { return [...this.loadedNames]; }
  has(name: string): boolean { return name === TOOL_LOAD || this.byName.has(name); }
  groups(): string[] { return [...new Set(this.order.filter((n) => !this.always().includes(n)).map(groupOf))]; }

  /** The tool_load definition (its group list is part of it, so it is stable for one agent). */
  loadDef(): ToolDef {
    return {
      name: TOOL_LOAD,
      description: 'Get the full form of other tools before you use them. Name up to a few tools from the tool index, or one group.',
      input_schema: {
        type: 'object',
        properties: {
          names: { type: 'array', maxItems: this.limits.perLoad, items: { type: 'string', maxLength: 120 }, description: 'Tool names from the index' },
          group: { type: 'string', enum: this.groups(), description: 'A whole group (the first few tools of it)' },
        },
      },
    };
  }

  private full(name: string): ToolDef {
    const d = this.byName.get(name)!;
    return this.tier === 'small' ? simpleDef(d) : d;
  }

  /** The tools sent in full on this step: tool_load, the memory verbs, then what was loaded (in load order). */
  definitions(): ToolDef[] {
    if (!this.order.length) return [];
    if (this.allInFull) return this.order.map((n) => this.byName.get(n)!);
    return [this.loadDef(), ...this.always().map((n) => this.full(n)), ...this.loadedNames.map((n) => this.full(n))];
  }

  /** The short index for the system text (stable for one agent: it never lists what was loaded). */
  index(): string {
    if (this.allInFull) return '';
    const rest = this.order.filter((n) => !this.always().includes(n) && !(this.tier === 'small' && ADMIN.test(n)));
    if (!rest.length) return '';
    const lines = rest.map((n) => `- ${n}: ${shortLine(this.byName.get(n)!.description, this.limits.line)}`);
    return `## Tool index\nYour memory tools are ready to use. Other tools are listed by name; call ${TOOL_LOAD} with their names to get their full form, then call them.\n${lines.join('\n')}`;
  }

  /** Mark tools as loaded (the oldest leaves when the tier's limit is reached). */
  private load(names: string[]): string[] {
    const added: string[] = [];
    for (const n of names) {
      if (!this.byName.has(n) || this.always().includes(n)) continue;
      this.loadedNames = this.loadedNames.filter((x) => x !== n);
      this.loadedNames.push(n);
      added.push(n);
    }
    while (this.loadedNames.length > this.limits.loaded) this.loadedNames.shift();
    return added;
  }

  /** Similar names, for a call to a tool the agent does not have. */
  private similar(name: string): string[] {
    const g = groupOf(name);
    const words = name.toLowerCase().split(/[_\W]+/).filter((w) => w.length > 2);
    return this.order.filter((n) => groupOf(n) === g || words.some((w) => n.includes(w))).slice(0, 6);
  }

  private describe(names: string[]): string {
    return names.map((n) => { const d = this.full(n); return `${d.name}: ${d.description}\narguments: ${JSON.stringify(d.input_schema)}`; }).join('\n\n');
  }

  /**
   * Run one call: tool_load is answered here; any other tool is checked
   * against its full schema and then run by `run` (the registry).
   */
  async execute(name: string, rawArgs: unknown, run: (name: string, args: Record<string, unknown>) => Promise<ToolResult>): Promise<ToolResult> {
    if (name === TOOL_LOAD) {
      const checked = checkToolArgs(this.loadDef().input_schema, rawArgs);
      if (!checked.ok) return text(`Error: ${checked.error}. Send names (a list of tool names) or group.`, 'invalid_arguments');
      const asked = [...((checked.args.names as string[] | undefined) ?? [])];
      if (typeof checked.args.group === 'string') asked.push(...this.order.filter((n) => groupOf(n) === checked.args.group && !this.always().includes(n)).slice(0, this.limits.perLoad));
      const unknown = asked.filter((n) => !this.byName.has(n));
      const added = this.load(asked.filter((n) => this.byName.has(n)).slice(0, this.limits.perLoad));
      const ready = [...new Set([...added, ...asked.filter((n) => this.always().includes(n))])];
      if (!ready.length) return text(`Error: no tool of that name. ${unknown.length ? `Not found: ${unknown.join(', ')}. ` : ''}Use names from the tool index.`, 'unknown_tool');
      return { content: [{ type: 'text', text: `Loaded; you can call ${ready.length === 1 ? 'it' : 'them'} now.\n\n${this.describe(ready)}${unknown.length ? `\n\nNot found: ${unknown.join(', ')}` : ''}` }], data: { loaded: ready } };
    }
    const def = this.byName.get(name);
    if (!def) {
      // Not one of this agent's offered tools: the registry answers with its own refusal (exec policy, grants,
      // channel rules, "not found"); the model also gets similar names it does have.
      const refused = await run(name, (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>);
      const near = this.similar(name);
      return near.length && refused.error ? { ...refused, content: [...(refused.content ?? []), { type: 'text', text: `Similar tools you have: ${near.join(', ')}.` }] } : refused;
    }
    const checked = checkToolArgs(def.input_schema, rawArgs);
    if (!checked.ok) {
      this.load([name]);
      return text(`Error: ${name} was not run: ${checked.error}. Its arguments: ${JSON.stringify(this.full(name).input_schema)}`, 'invalid_arguments');
    }
    this.load([name]);
    const result = await run(name, checked.args);
    if (!checked.dropped.length) return result;
    return { ...result, content: [...(result.content ?? []), { type: 'text', text: `(Ignored arguments ${name} does not take: ${checked.dropped.join(', ')}.)` }] };
  }
}

/** Weak tool calling: how many calls of one reply run, one after another (the rest are told to wait). */
export const CALLS_PER_STEP: Record<ModelTier, number> = { small: 2, medium: 4, large: 8 };
/** Steps of one local turn per tier (each step can run a few tools). */
export const STEPS_PER_TURN: Record<ModelTier, number> = { small: 12, medium: 24, large: 40 };

export interface PlannedCall { id: string; name: string; args: Record<string, unknown> }

/**
 * Many calls in one reply (P10: qwen3:4b sent 32): exact repeats are dropped,
 * the first `cap` run one after another, the rest are not run and the model
 * is told to ask again for what it still needs, one or two at a time.
 */
export function planCalls<T extends PlannedCall>(calls: readonly T[], cap: number): { run: T[]; skipped: T[] } {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const c of calls) {
    const key = `${c.name}\u0000${JSON.stringify(c.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  return { run: unique.slice(0, cap), skipped: unique.slice(cap) };
}

export const SKIPPED_NOTE = (n: number) => `${n} more tool call${n === 1 ? ' was' : 's were'} not run: only a few calls run per step. Look at these results first, then call again only what you still need.`;
