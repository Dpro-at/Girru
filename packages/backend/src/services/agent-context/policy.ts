/**
 * STORE-MAP-01 pilot (CX6): what an entry point may load into an agent's
 * context, decided here and not by the order of prompt sections.
 *
 * Precedence is a rule of the evaluator: system restrictions, then the owner's
 * rules, then the agent's own definition (hired instructions, personality,
 * skills), then data. Memory, pinned facts and handoff notes are always data:
 * renderers frame them as such and they can never relax anything above them.
 */

export type EntryPoint = 'chat' | 'task' | 'coding_app' | 'channel' | 'heartbeat';
export const ENTRY_POINTS: readonly EntryPoint[] = ['chat', 'task', 'coding_app', 'channel', 'heartbeat'];

export const PRECEDENCE = ['system', 'owner_rules', 'definition', 'data'] as const;

export interface ContextPolicy {
  entry: EntryPoint;
  /** Who reads the reply: the owner, or an outside sender (channel). */
  audience: 'owner' | 'outsider';
  /** Load the owner's pinned facts in this context (as data). */
  pinnedFacts: boolean;
  /** Load the project's newest handoff note (as data). */
  handoff: boolean;
  /** Recall from the open drawers (chat recall, tools). */
  memory: boolean;
  precedence: typeof PRECEDENCE;
  /** Why each data part is in or out, for contract tests and the owner. */
  reasons: Record<'pinnedFacts' | 'handoff' | 'memory', string>;
}

/**
 * The policy of an entry point. A task run gets its pinned facts and handoff
 * from its own narrowed scope (task-run-executor), so they are not added
 * again here; an outsider gets no owner memory unless the owner turned
 * outsider memory on.
 */
export function evaluateContextPolicy(entry: EntryPoint, opts: { outsiderMemory?: boolean } = {}): ContextPolicy {
  if (!(ENTRY_POINTS as readonly string[]).includes(entry)) throw new Error(`Unknown entry point ${entry}`);
  const outsider = entry === 'channel';
  // A heartbeat is a short background check: identity, rules and definition only, no owner memory.
  const heartbeat = entry === 'heartbeat';
  const memory = heartbeat ? false : !outsider || !!opts.outsiderMemory;
  const task = entry === 'task';
  return {
    entry,
    audience: outsider ? 'outsider' : 'owner',
    pinnedFacts: memory && !task,
    handoff: memory && !task,
    memory,
    precedence: PRECEDENCE,
    reasons: {
      pinnedFacts: heartbeat ? 'a heartbeat check reads no owner memory' : !memory ? 'an outside sender never gets owner memory' : task ? 'added by the task run from its narrowed scope' : 'the owner’s pinned facts for this project',
      handoff: heartbeat ? 'a heartbeat check reads no owner memory' : !memory ? 'an outside sender never gets owner memory' : task ? 'the task run adds its own task handoff' : 'the newest handoff of the project, from Girru agents and coding tools',
      memory: memory ? 'recall from the open drawers' : heartbeat ? 'a heartbeat check reads no owner memory' : 'an outside sender never gets owner memory',
    },
  };
}
