/**
 * CP6 “Tasks from other computers” and CP4b “Always allow from … in this project”:
 * what this computer does when another of the owner's computers sends it a task.
 * Stored per owner in `user_prefs`; only the owner changes it (page or MCP, same route).
 * “Allow automatically” still goes through the normal approval record, so every run is
 * recorded the same way; a reviewer quorum or verification can still stop it.
 */
import { getPref, setPref } from '../repositories/user-prefs.js';

export type TaskRule = 'ask' | 'auto' | 'refuse';
export const TASK_RULES: readonly TaskRule[] = ['ask', 'auto', 'refuse'];
export interface TaskRules { rule: TaskRule; projects: Record<string, TaskRule>; always: { source: string; projectId: string }[] }
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isRule = (x: unknown): x is TaskRule => (TASK_RULES as readonly unknown[]).includes(x);

/** Any saved value made whole: unknown entries dropped; “ask” when nothing is saved. */
export function taskRules(x: unknown): TaskRules {
  const v = record(x) ? x : {};
  const projects = Object.fromEntries(Object.entries(record(v.projects) ? v.projects : {}).filter(([k, r]) => ID.test(k) && isRule(r)).slice(0, 500)) as Record<string, TaskRule>;
  const always = (Array.isArray(v.always) ? v.always : []).filter((a): a is { source: string; projectId: string } => record(a) && typeof a.source === 'string' && ID.test(a.source) && typeof a.projectId === 'string' && ID.test(a.projectId)).slice(0, 200).map(a => ({ source: a.source, projectId: a.projectId }));
  return { rule: isRule(v.rule) ? v.rule : 'ask', projects, always };
}

/** One change: the rule for all, one project's exception (null removes it), or one “always allow”. */
export function taskRulesChangeOk(x: unknown): x is { rule?: TaskRule; project?: { id: string; rule: TaskRule | null }; always?: { source: string; projectId: string; on: boolean } } {
  if (!record(x) || !Object.keys(x).length || !Object.keys(x).every(k => ['rule', 'project', 'always'].includes(k))) return false;
  if ('rule' in x && !isRule(x.rule)) return false;
  if ('project' in x && !(record(x.project) && Object.keys(x.project).every(k => ['id', 'rule'].includes(k)) && typeof x.project.id === 'string' && ID.test(x.project.id) && (x.project.rule === null || isRule(x.project.rule)))) return false;
  if ('always' in x && !(record(x.always) && Object.keys(x.always).every(k => ['source', 'projectId', 'on'].includes(k)) && typeof x.always.source === 'string' && ID.test(x.always.source) && typeof x.always.projectId === 'string' && ID.test(x.always.projectId) && typeof x.always.on === 'boolean')) return false;
  return true;
}

export async function readTaskRules(ownerId: string) { return taskRules(await getPref(ownerId, 'computer-task-rules')); }
export async function changeTaskRules(ownerId: string, change: unknown): Promise<TaskRules> {
  if (!taskRulesChangeOk(change)) throw Error('computer_task_rules_invalid');
  const rules = await readTaskRules(ownerId);
  if (change.rule) rules.rule = change.rule;
  if (change.project) { if (change.project.rule) rules.projects[change.project.id] = change.project.rule; else delete rules.projects[change.project.id]; }
  if (change.always) {
    const { source, projectId, on } = change.always;
    rules.always = rules.always.filter(a => a.source !== source || a.projectId !== projectId);
    if (on) rules.always.push({ source, projectId });
  }
  const saved = taskRules(rules);
  if (change.project?.rule && !(change.project.id in saved.projects) || change.always?.on && saved.always.length >= 200 && !saved.always.some(a => a.source === change.always!.source && a.projectId === change.always!.projectId)) throw Error('computer_task_rules_full');
  await setPref(ownerId, 'computer-task-rules', saved);
  return saved;
}

/** What to do with a task from `source` for `projectId`: “always allow” first, then the project's exception, then the rule for all. */
export function decideTask(rules: TaskRules, source: string, projectId: string): TaskRule {
  const project = rules.projects[projectId];
  if (project === 'refuse') return 'refuse';
  if (rules.always.some(a => a.source === source && a.projectId === projectId)) return 'auto';
  return project ?? rules.rule;
}
