/**
 * CP6 “Tasks from other computers” and CP4b “Always allow from … in this project”:
 * what this computer does when another of the owner's computers sends it a task.
 * Stored per owner in `user_prefs`; only the owner changes it (page or MCP, same route).
 * “Allow automatically” still goes through the normal approval record, so every run is
 * recorded the same way; a reviewer quorum or verification can still stop it.
 */
import { getPref, setPrefReviewed } from '../repositories/user-prefs.js';

export type TaskRule = 'ask' | 'auto' | 'refuse';
export const TASK_RULES: readonly TaskRule[] = ['ask', 'auto', 'refuse'];
/** atOnce: tasks from other computers running here at the same time (1–5). column: the Board column allowed tasks land in (null = the first). */
/** takes: CP3 “Takes new tasks” — off means this computer shows as not taking tasks and refuses new ones. */
export interface TaskRules { rule: TaskRule; projects: Record<string, TaskRule>; always: { source: string; projectId: string }[]; atOnce: number; column: string | null; takes: boolean }
export const DEFAULT_AT_ONCE = 3;
const atOnceOk = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 5;
const columnOk = (x: unknown): x is string => typeof x === 'string' && x.trim() === x && x.length >= 1 && x.length <= 60 && !/[\x00-\x1f\x7f]/.test(x);
const ID = { test: (x: string) => /^[A-Za-z0-9_-]{1,128}$/.test(x) && !['__proto__', 'constructor', 'prototype'].includes(x) };
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isRule = (x: unknown): x is TaskRule => (TASK_RULES as readonly unknown[]).includes(x);

/** Any saved value made whole: unknown entries dropped; “ask” when nothing is saved. */
export function taskRules(x: unknown): TaskRules {
  const v = record(x) ? x : {};
  const projects = Object.fromEntries(Object.entries(record(v.projects) ? v.projects : {}).filter(([k, r]) => ID.test(k) && isRule(r)).slice(0, 500)) as Record<string, TaskRule>;
  const always = (Array.isArray(v.always) ? v.always : []).filter((a): a is { source: string; projectId: string } => record(a) && typeof a.source === 'string' && ID.test(a.source) && typeof a.projectId === 'string' && ID.test(a.projectId)).slice(0, 200).map(a => ({ source: a.source, projectId: a.projectId }));
  return { rule: isRule(v.rule) ? v.rule : 'ask', projects, always, atOnce: atOnceOk(v.atOnce) ? v.atOnce : DEFAULT_AT_ONCE, column: columnOk(v.column) ? v.column : null, takes: v.takes !== false };
}

/** One change: the rule for all, one project's exception (null removes it), or one “always allow”. */
export function taskRulesChangeOk(x: unknown): x is { rule?: TaskRule; project?: { id: string; rule: TaskRule | null }; always?: { source: string; projectId: string; on: boolean }; atOnce?: number; column?: string | null; takes?: boolean } {
  if (!record(x) || !Object.keys(x).length || !Object.keys(x).every(k => ['rule', 'project', 'always', 'atOnce', 'column', 'takes'].includes(k))) return false;
  if ('takes' in x && typeof x.takes !== 'boolean') return false;
  if ('atOnce' in x && !atOnceOk(x.atOnce)) return false;
  if ('column' in x && x.column !== null && !columnOk(x.column)) return false;
  if ('rule' in x && !isRule(x.rule)) return false;
  if ('project' in x && !(record(x.project) && Object.keys(x.project).every(k => ['id', 'rule'].includes(k)) && typeof x.project.id === 'string' && ID.test(x.project.id) && (x.project.rule === null || isRule(x.project.rule)))) return false;
  if ('always' in x && !(record(x.always) && Object.keys(x.always).every(k => ['source', 'projectId', 'on'].includes(k)) && typeof x.always.source === 'string' && ID.test(x.always.source) && typeof x.always.projectId === 'string' && ID.test(x.always.projectId) && typeof x.always.on === 'boolean')) return false;
  return true;
}

export async function readTaskRules(ownerId: string) { return taskRules(await getPref(ownerId, 'computer-task-rules')); }
/** The rules after one change, made whole; refused when making it whole would drop an entry (full lists). */
export function applyTaskRulesChange(rules: TaskRules, change: unknown): TaskRules {
  if (!taskRulesChangeOk(change)) throw Error('computer_task_rules_invalid');
  // Project exceptions are edited as a Map: a request-chosen project id is a map key, never a property name on a live object.
  const projects = new Map(Object.entries(rules.projects));
  const next: TaskRules = { rule: rules.rule, projects: {}, always: rules.always.map(a => ({ ...a })), atOnce: rules.atOnce, column: rules.column, takes: rules.takes };
  if (change.rule) next.rule = change.rule;
  if (change.takes !== undefined) next.takes = change.takes;
  if (change.atOnce !== undefined) next.atOnce = change.atOnce;
  if (change.column !== undefined) next.column = change.column;
  if (change.project) { const pid = change.project.id; if (!ID.test(pid)) throw Error('computer_task_rules_invalid'); if (change.project.rule) projects.set(pid, change.project.rule); else projects.delete(pid); }
  next.projects = Object.fromEntries(projects);
  if (change.always) {
    const { source, projectId, on } = change.always;
    next.always = next.always.filter(a => a.source !== source || a.projectId !== projectId);
    if (on) next.always.push({ source, projectId });
  }
  const saved = taskRules(next);
  if (Object.keys(saved.projects).length !== Object.keys(next.projects).length || saved.always.length !== next.always.length) throw Error('computer_task_rules_full');
  return saved;
}
/** Saves one change; with `tighten`, only when no computer and project would be allowed more (checked on the exact value saved). */
export async function changeTaskRules(ownerId: string, change: unknown, tighten = false): Promise<TaskRules> {
  // One reviewed write: the value checked is the value saved, and a change in between is refused.
  const stored = await getPref(ownerId, 'computer-task-rules');
  const rules = taskRules(stored);
  const saved = applyTaskRulesChange(rules, change);
  if (tighten && !isStricter(rules, saved)) throw Error('computer_task_rules_owner_only');
  await setPrefReviewed(ownerId, 'computer-task-rules', saved, stored ?? null);
  return saved;
}

/** What to do with a task from `source` for `projectId`: “always allow” first, then the project's exception, then the rule for all. */
export function decideTask(rules: TaskRules, source: string, projectId: string): TaskRule {
  // “Don't accept” wins: on the project, or for all projects when the project has no exception of its own.
  const base = rules.projects[projectId] ?? rules.rule;
  if (base === 'refuse') return 'refuse';
  if (rules.always.some(a => a.source === source && a.projectId === projectId)) return 'auto';
  return base;
}
const STRICT: Record<TaskRule, number> = { auto: 0, ask: 1, refuse: 2 };
/** True when no computer and project would be allowed more after the change (agents may only tighten). */
export function changeIsStricter(rules: TaskRules, change: unknown): boolean {
  try { return isStricter(rules, applyTaskRulesChange(rules, change)); } catch { return false; }
}
function isStricter(rules: TaskRules, after: TaskRules): boolean {
  // Fewer tasks at once is stricter; moving where tasks land is the owner's choice only.
  if (after.atOnce > rules.atOnce || after.column !== rules.column || after.takes && !rules.takes) return false;
  const projects = new Set([...Object.keys(rules.projects), ...Object.keys(after.projects), ...rules.always.map(a => a.projectId), ...after.always.map(a => a.projectId), '\u0000any']);
  const sources = new Set([...rules.always.map(a => a.source), ...after.always.map(a => a.source), '\u0000any']);
  for (const p of projects) for (const s of sources) if (STRICT[decideTask(after, s, p)] < STRICT[decideTask(rules, s, p)]) return false;
  return true;
}
