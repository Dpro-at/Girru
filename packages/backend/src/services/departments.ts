/**
 * STORE-MAP-01 P3 (FD2, D8, D9): the one list of departments.
 *
 * `departments` is the authority while GIRRU_STORE_P3 is on. Every place that
 * copied a department name (agents, boards, cards, board sources, specialty
 * templates, hire items, meeting decisions, rule targets) keeps its text
 * column for older readers and gains the department's id next to it. A
 * rename or merge changes both in one transaction, so rules keep matching,
 * a board stays the same board, and memory projects follow (their
 * `department_id` already is the id: rows from memory_departments keep it).
 *
 * The backfill (`syncDepartments`) is idempotent: it copies memory's
 * departments, makes one department for each name in use (names that differ
 * only in case are one department, D9), fills the ids, and asks once about a
 * rule that names a department nobody uses.
 */

import { randomUUID } from 'node:crypto';
import { all, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { normName, cleanName, ScopeInputError } from '../memory/scopes/store.js';
import { DEPARTMENTS } from './company-plan.js';

/** The built-in small local agent never belongs to a department (as in agents-config). */
const RESERVED_AGENT_ID = 'small-local-agent';

export interface DepartmentRow {
  id: string;
  name: string;
  letter: string | null;
  color: string | null;
  leadAgentId: string | null;
  version: number;
}

/**
 * Each table that copies a department name, how to reach its rows, whether the
 * copy keeps case, and whether a name in it makes a department (`creates`).
 * Only live users make one (agents, hire items, active board links); boards,
 * cards, specialty templates and meeting decisions follow the list, so a
 * deleted department never comes back from an old copy of its name.
 */
interface Copy { table: string; key: string[]; owned: string; keepCase?: boolean; creates?: boolean }
const COPIES: readonly Copy[] = [
  { table: 'agents_config', key: ['id'], owned: `id != '${RESERVED_AGENT_ID}'`, creates: true },
  { table: 'board_departments', key: ['board_id', 'department'], owned: 'board_id IN (SELECT id FROM boards WHERE owner_id = ?)' },
  { table: 'board_card_departments', key: ['card_id', 'department'], owned: 'card_id IN (SELECT c.id FROM board_cards c JOIN boards b ON b.id = c.board_id WHERE b.owner_id = ?)' },
  { table: 'board_department_sources', key: ['board_id'], owned: 'owner_id = ? AND active = 1', creates: true },
  { table: 'specialty_templates', key: ['id'], owned: '1 = 1', keepCase: true },
  { table: 'team_hire_batch_items', key: ['batch_id', 'seq'], owned: 'batch_id IN (SELECT id FROM team_hire_batches WHERE owner_id = ?)', creates: true },
  { table: 'meeting_decisions', key: ['id'], owned: 'meeting_id IN (SELECT id FROM meetings WHERE owner_id = ?)' },
];
const ownedArgs = (c: Copy, ownerId: string): string[] => (c.owned.includes('?') ? [ownerId] : []);

/** The lower-case key the text columns hold (the same rule as memory's department names). */
export const departmentKey = (name: string): string => normName(name).slice(0, 64);

const LABELS: ReadonlyMap<string, string> = new Map(DEPARTMENTS.map((d) => [d.id, d.label]));

/** The name people see for a key found in a text column: the first-run label, else the text as written. */
function displayName(key: string, seen: string[]): string {
  const label = LABELS.get(key);
  if (label) return label;
  const cased = seen.find((s) => s !== s.toLowerCase());
  if (cased) return cased.trim().replace(/\s+/g, ' ').slice(0, 80);
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function rowOf(r: any): DepartmentRow {
  return { id: r.id, name: r.name, letter: r.letter ?? null, color: r.color ?? null, leadAgentId: r.lead_agent_id ?? null, version: Number(r.version) };
}

export function* companyOwnerStep(): Step<string | null> {
  const r = yield* one<{ id: string }>("SELECT id FROM users WHERE role = 'owner' AND COALESCE(status, 'active') = 'active' ORDER BY created_at ASC, id ASC LIMIT 1");
  return r?.id ?? null;
}

export function* departmentsStep(ownerId: string): Step<DepartmentRow[]> {
  return (yield* all('SELECT * FROM departments WHERE owner_id = ? ORDER BY norm_name, id', ownerId)).map(rowOf);
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export interface SyncReport { copied: number; created: number; filled: number; questions: number }

/** Rule targets (lower-case names) of every department rule, by rule id. */
function* departmentRulesStep(): Step<Array<{ id: string; targets: string[]; ids: string[] | null }>> {
  const rows = yield* all<{ id: string; targets: string; department_ids: string | null }>("SELECT id, targets, department_ids FROM agent_rules WHERE who = 'departments' AND deleted_at IS NULL ORDER BY id");
  const parse = (s: string | null): any[] => { try { const v = JSON.parse(s ?? ''); return Array.isArray(v) ? v : []; } catch { return []; } };
  return rows.map((r) => ({ id: r.id, targets: parse(r.targets).filter((t) => typeof t === 'string'), ids: r.department_ids == null ? null : parse(r.department_ids) }));
}

/** One step of the backfill for the company owner. Safe to run again at every start. */
export function* syncDepartmentsStep(ownerId: string): Step<SyncReport> {
  const report: SyncReport = { copied: 0, created: 0, filled: 0, questions: 0 };
  // 1. memory's departments keep their id (memory_project_scopes points at it).
  for (const m of yield* all<{ id: string; name: string; norm_name: string; created_by: string | null; created_at: string }>('SELECT id, name, norm_name, created_by, created_at FROM memory_departments WHERE owner_id = ? ORDER BY id', ownerId)) {
    if (yield* one('SELECT 1 AS x FROM departments WHERE id = ?', m.id)) continue;
    const same = yield* one<{ id: string }>('SELECT id FROM departments WHERE owner_id = ? AND norm_name = ?', ownerId, departmentKey(m.name));
    if (same) {
      // Made twice while the switch was off: the one list keeps the older id, memory follows it.
      yield* run('UPDATE memory_project_scopes SET department_id = ? WHERE owner_id = ? AND department_id = ?', same.id, ownerId, m.id);
      continue;
    }
    yield* run('INSERT INTO departments (id, owner_id, name, norm_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', m.id, ownerId, m.name, departmentKey(m.name), m.created_by, m.created_at);
    report.copied++;
  }
  // 2. every name a live user has becomes one department (case duplicates are one, D9).
  const seen = new Map<string, string[]>();
  for (const c of COPIES.filter((x) => x.creates)) {
    for (const r of yield* all<{ v: string }>(`SELECT DISTINCT department AS v FROM ${c.table} WHERE department IS NOT NULL AND department <> '' AND ${c.owned}`, ...ownedArgs(c, ownerId))) {
      const k = departmentKey(r.v);
      if (k) seen.set(k, [...(seen.get(k) ?? []), r.v]);
    }
  }
  for (const c of COPIES.filter((x) => !x.creates && x.keepCase)) {
    for (const r of yield* all<{ v: string }>(`SELECT DISTINCT department AS v FROM ${c.table} WHERE department IS NOT NULL AND department <> '' AND ${c.owned}`, ...ownedArgs(c, ownerId))) {
      const k = departmentKey(r.v);
      if (seen.has(k)) seen.get(k)!.push(r.v); // a cased spelling for the name people see
    }
  }
  const known = new Map((yield* all<{ id: string; norm_name: string }>('SELECT id, norm_name FROM departments WHERE owner_id = ?', ownerId)).map((d) => [d.norm_name, d.id]));
  for (const [k, texts] of seen) {
    if (known.has(k)) continue;
    const id = `dept-${randomUUID().slice(0, 12)}`;
    yield* run('INSERT INTO departments (id, owner_id, name, norm_name, created_by) VALUES (?, ?, ?, ?, ?)', id, ownerId, displayName(k, texts), k, 'upgrade');
    known.set(k, id);
    report.created++;
  }
  // 3. ids next to every copied name.
  for (const c of COPIES) {
    for (const r of yield* all<{ v: string }>(`SELECT DISTINCT department AS v FROM ${c.table} WHERE department IS NOT NULL AND department <> '' AND ${c.owned}`, ...ownedArgs(c, ownerId))) {
      const id = known.get(departmentKey(r.v));
      if (!id) continue;
      const u = yield* run(`UPDATE ${c.table} SET department_id = ? WHERE department = ? AND (department_id IS NULL OR department_id <> ?) AND ${c.owned}`, id, r.v, id, ...ownedArgs(c, ownerId));
      report.filled += u.changes;
    }
  }
  // 4. rules: ids for the names that are departments; ask once about the others.
  for (const rule of yield* departmentRulesStep()) {
    const ids = rule.targets.map((t) => known.get(departmentKey(t))).filter((x): x is string => !!x);
    if (JSON.stringify(ids) !== JSON.stringify(rule.ids)) {
      yield* run('UPDATE agent_rules SET department_ids = ? WHERE id = ?', JSON.stringify(ids), rule.id);
      report.filled++;
    }
    for (const t of rule.targets) {
      if (known.has(departmentKey(t))) continue;
      const q = yield* run(`INSERT INTO department_questions (id, owner_id, kind, subject_id, name) VALUES (?, ?, 'rule_target', ?, ?) ON CONFLICT DO NOTHING`, randomUUID(), ownerId, rule.id, t);
      report.questions += q.changes;
    }
  }
  yield* mirrorLegacyStep(ownerId);
  return report;
}

/** The backfill for the company owner (or the owner given, as tests do). */
export async function syncDepartments(ownerId?: string): Promise<SyncReport | null> {
  return sql().tx(function* () {
    const owner = ownerId ?? (yield* companyOwnerStep());
    return owner ? yield* syncDepartmentsStep(owner) : null;
  }, { immediate: true });
}

/**
 * Rows whose copied name has no id, or an id of another name. Empty when the
 * backfill is complete. A follower copy (board, card, template, decision) that
 * names no department at all is not linked by design and not reported.
 */
export function* verifyDepartmentsStep(ownerId: string): Step<Array<{ table: string; department: string; department_id: string | null }>> {
  const bad: Array<{ table: string; department: string; department_id: string | null }> = [];
  const byId = new Map((yield* all<{ id: string; norm_name: string }>('SELECT id, norm_name FROM departments WHERE owner_id = ?', ownerId)).map((d) => [d.id, d.norm_name]));
  for (const c of COPIES) {
    for (const r of yield* all<{ department: string; department_id: string | null }>(`SELECT DISTINCT department, department_id FROM ${c.table} WHERE department IS NOT NULL AND department <> '' AND ${c.owned}`, ...ownedArgs(c, ownerId))) {
      if (!c.creates && !r.department_id && ![...byId.values()].includes(departmentKey(r.department))) continue;
      if (!r.department_id || byId.get(r.department_id) !== departmentKey(r.department)) bad.push({ table: c.table, ...r });
    }
  }
  return bad;
}

/**
 * Keeps memory's old table equal to the one list, so turning the switch off
 * again shows the same departments (the switch stays reversible).
 */
export function* mirrorLegacyStep(ownerId: string): Step<void> {
  const list = yield* all<{ id: string; name: string; norm_name: string; created_by: string | null }>('SELECT id, name, norm_name, created_by FROM departments WHERE owner_id = ?', ownerId);
  const byId = new Map(list.map((d) => [d.id, d]));
  for (const m of yield* all<{ id: string; name: string; norm_name: string }>('SELECT id, name, norm_name FROM memory_departments WHERE owner_id = ?', ownerId)) {
    const d = byId.get(m.id);
    if (!d || d.name !== m.name || d.norm_name !== m.norm_name) yield* run('DELETE FROM memory_departments WHERE owner_id = ? AND id = ?', ownerId, m.id);
  }
  for (const d of list) {
    yield* run('INSERT INTO memory_departments (id, owner_id, name, norm_name, created_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', d.id, ownerId, d.name, d.norm_name, d.created_by);
  }
}

// ---------------------------------------------------------------------------
// Rename, merge (with undo), detach on delete
// ---------------------------------------------------------------------------

/** Writes `to` (and its id) over every copy of department `fromId`; returns what moved, for undo. */
function* moveCopiesStep(ownerId: string, fromId: string, fromKey: string, to: { id: string; name: string; key: string }): Step<Record<string, unknown[]>> {
  const moved: Record<string, unknown[]> = {};
  for (const c of COPIES) {
    const where = `(department_id = ? OR (department_id IS NULL AND LOWER(department) = ?)) AND ${c.owned}`;
    const rows = yield* all<Record<string, unknown>>(`SELECT ${c.key.join(', ')}, department FROM ${c.table} WHERE ${where}`, fromId, fromKey, ...ownedArgs(c, ownerId));
    if (!rows.length) continue;
    moved[c.table] = rows;
    const text = c.keepCase ? to.name : to.key;
    if (c.key.includes('department')) {
      // The name is part of the key: add the new pair, then drop the old one.
      const other = c.key.find((k) => k !== 'department')!;
      for (const r of rows) {
        if (r.department === text) { r.existed = true; yield* run(`UPDATE ${c.table} SET department_id = ? WHERE ${other} = ? AND department = ?`, to.id, r[other] as string, text); continue; }
        r.existed = !!(yield* one(`SELECT 1 AS x FROM ${c.table} WHERE ${other} = ? AND department = ?`, r[other] as string, text));
        yield* run(`INSERT INTO ${c.table} (${other}, department, department_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, r[other] as string, text, to.id);
        yield* run(`DELETE FROM ${c.table} WHERE ${other} = ? AND department = ?`, r[other] as string, r.department as string);
      }
    } else {
      yield* run(`UPDATE ${c.table} SET department = ?, department_id = ? WHERE ${where}`, text, to.id, fromId, fromKey, ...ownedArgs(c, ownerId));
    }
  }
  const rules: unknown[] = [];
  for (const rule of yield* departmentRulesStep()) {
    if (!rule.targets.some((t) => departmentKey(t) === fromKey) && !(rule.ids ?? []).includes(fromId)) continue;
    rules.push({ id: rule.id, targets: rule.targets, ids: rule.ids });
    const targets = [...new Set(rule.targets.map((t) => (departmentKey(t) === fromKey ? to.key : t)))];
    const ids = [...new Set((rule.ids ?? []).map((x) => (x === fromId ? to.id : x)).concat(to.id))];
    yield* run('UPDATE agent_rules SET targets = ?, department_ids = ?, version = version + 1 WHERE id = ?', JSON.stringify(targets), JSON.stringify(ids), rule.id);
  }
  if (rules.length) moved.agent_rules = rules;
  return moved;
}

/** Rename: everything that names the department follows (FD2: "Rename (everything follows)"). */
export async function renameDepartmentEverywhere(ownerId: string, id: string, nameInput: unknown, expectedVersion?: unknown): Promise<DepartmentRow> {
  const name = cleanName(nameInput, 'department');
  return sql().tx(function* () {
    const d = yield* one<any>('SELECT * FROM departments WHERE owner_id = ? AND id = ?', ownerId, id);
    if (!d) throw new ScopeInputError('Department not found', 404, 'not_found');
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(d.version)) throw new ScopeInputError('The department changed in the meantime', 409, 'version_conflict');
    const key = departmentKey(name);
    const taken = yield* one<{ id: string }>('SELECT id FROM departments WHERE owner_id = ? AND norm_name = ?', ownerId, key);
    if (taken && taken.id !== id) throw new ScopeInputError('That department already exists', 409, 'name_taken');
    yield* moveCopiesStep(ownerId, id, d.norm_name, { id, name, key });
    yield* run('UPDATE departments SET name = ?, norm_name = ?, version = version + 1, updated_at = ? WHERE id = ?', name, key, new Date().toISOString(), id);
    yield* mirrorLegacyStep(ownerId);
    return rowOf(yield* one('SELECT * FROM departments WHERE id = ?', id));
  }, { immediate: true });
}

/** Merge `fromId` into `intoId`. Returns the merge id; `undoMerge` puts everything back. */
export async function mergeDepartments(ownerId: string, fromId: string, intoId: string, by: string): Promise<{ mergeId: string; into: DepartmentRow }> {
  if (fromId === intoId) throw new ScopeInputError('Choose another department', 400, 'same_department');
  return sql().tx(function* () {
    const from = yield* one<any>('SELECT * FROM departments WHERE owner_id = ? AND id = ?', ownerId, fromId);
    const into = yield* one<any>('SELECT * FROM departments WHERE owner_id = ? AND id = ?', ownerId, intoId);
    if (!from || !into) throw new ScopeInputError('Department not found', 404, 'not_found');
    const moved = yield* moveCopiesStep(ownerId, fromId, from.norm_name, { id: intoId, name: into.name, key: into.norm_name });
    const projects = yield* all<{ slug: string }>('SELECT slug FROM memory_project_scopes WHERE owner_id = ? AND department_id = ?', ownerId, fromId);
    if (projects.length) moved.memory_project_scopes = projects;
    yield* run('UPDATE memory_project_scopes SET department_id = ? WHERE owner_id = ? AND department_id = ?', intoId, ownerId, fromId);
    yield* run('DELETE FROM departments WHERE id = ?', fromId);
    const mergeId = randomUUID();
    yield* run('INSERT INTO department_merges (id, owner_id, from_id, into_id, from_row, moved, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', mergeId, ownerId, fromId, intoId, JSON.stringify(from), JSON.stringify(moved), by);
    yield* run('UPDATE departments SET version = version + 1, updated_at = ? WHERE id = ?', new Date().toISOString(), intoId);
    yield* mirrorLegacyStep(ownerId);
    return { mergeId, into: rowOf(yield* one('SELECT * FROM departments WHERE id = ?', intoId)) };
  }, { immediate: true });
}

export async function undoMerge(ownerId: string, mergeId: string): Promise<DepartmentRow> {
  return sql().tx(function* () {
    const m = yield* one<any>('SELECT * FROM department_merges WHERE owner_id = ? AND id = ?', ownerId, mergeId);
    if (!m) throw new ScopeInputError('Nothing to undo', 404, 'not_found');
    if (m.undone_at) throw new ScopeInputError('Already undone', 409, 'already_undone');
    const from = JSON.parse(m.from_row);
    if (yield* one('SELECT 1 AS x FROM departments WHERE owner_id = ? AND norm_name = ?', ownerId, from.norm_name)) throw new ScopeInputError('A department with that name exists again', 409, 'name_taken');
    yield* run('INSERT INTO departments (id, owner_id, name, norm_name, letter, color, lead_agent_id, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      from.id, ownerId, from.name, from.norm_name, from.letter ?? null, from.color ?? null, from.lead_agent_id ?? null, Number(from.version) + 1, from.created_by ?? null, from.created_at, new Date().toISOString());
    const moved = JSON.parse(m.moved) as Record<string, Array<Record<string, any>>>;
    const into = yield* one<any>('SELECT * FROM departments WHERE id = ?', m.into_id);
    for (const c of COPIES) {
      for (const r of moved[c.table] ?? []) {
        if (c.key.includes('department')) {
          const other = c.key.find((k) => k !== 'department')!;
          yield* run(`INSERT INTO ${c.table} (${other}, department, department_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, r[other], r.department, from.id);
          // Remove the pair the merge added, unless it was there before the merge.
          if (!r.existed && into) yield* run(`DELETE FROM ${c.table} WHERE ${other} = ? AND department_id = ? AND department = ?`, r[other], m.into_id, c.keepCase ? into.name : into.norm_name);
        } else {
          yield* run(`UPDATE ${c.table} SET department = ?, department_id = ? WHERE ${c.key.map((k) => `${k} = ?`).join(' AND ')}`, r.department, from.id, ...c.key.map((k) => r[k]));
        }
      }
    }
    for (const r of (moved.agent_rules ?? []) as Array<{ id: string; targets: string[]; ids: string[] | null }>) {
      yield* run('UPDATE agent_rules SET targets = ?, department_ids = ?, version = version + 1 WHERE id = ?', JSON.stringify(r.targets), r.ids == null ? null : JSON.stringify(r.ids), r.id);
    }
    for (const p of (moved.memory_project_scopes ?? []) as Array<{ slug: string }>) {
      yield* run('UPDATE memory_project_scopes SET department_id = ? WHERE owner_id = ? AND slug = ?', from.id, ownerId, p.slug);
    }
    yield* run('UPDATE department_merges SET undone_at = ? WHERE id = ?', new Date().toISOString(), mergeId);
    yield* mirrorLegacyStep(ownerId);
    return rowOf(yield* one('SELECT * FROM departments WHERE id = ?', from.id));
  }, { immediate: true });
}

/**
 * Before a department is deleted (inside the delete's transaction): its agents,
 * board links, hire items and decisions get no department, a rule loses the
 * target (a rule left with none is paused), its board moves to Past departments.
 */
export function* detachDepartmentStep(ownerId: string, id: string): Step<{ agents: number; rulesPaused: number }> {
  const d = yield* one<{ norm_name: string }>('SELECT norm_name FROM departments WHERE owner_id = ? AND id = ?', ownerId, id);
  if (!d) return { agents: 0, rulesPaused: 0 };
  let agents = 0;
  for (const c of COPIES) {
    const where = `(department_id = ? OR (department_id IS NULL AND LOWER(department) = ?)) AND ${c.owned}`;
    if (c.table === 'board_department_sources') { yield* run(`UPDATE ${c.table} SET active = 0 WHERE ${where}`, id, d.norm_name, ...ownedArgs(c, ownerId)); continue; }
    if (c.key.includes('department') || c.table === 'specialty_templates') {
      // Boards keep the old name as a past department, templates keep their family; neither points at it any more.
      yield* run(`UPDATE ${c.table} SET department_id = NULL WHERE department_id = ? AND ${c.owned}`, id, ...ownedArgs(c, ownerId));
      continue;
    }
    const u = yield* run(`UPDATE ${c.table} SET department = NULL, department_id = NULL WHERE ${where}`, id, d.norm_name, ...ownedArgs(c, ownerId));
    if (c.table === 'agents_config') agents = u.changes;
  }
  let rulesPaused = 0;
  for (const rule of yield* departmentRulesStep()) {
    if (!rule.targets.some((t) => departmentKey(t) === d.norm_name)) continue;
    const targets = rule.targets.filter((t) => departmentKey(t) !== d.norm_name);
    const ids = (rule.ids ?? []).filter((x) => x !== id);
    yield* run(`UPDATE agent_rules SET targets = ?, department_ids = ?, paused = CASE WHEN ? = 0 THEN 1 ELSE paused END, version = version + 1 WHERE id = ?`, JSON.stringify(targets), JSON.stringify(ids), targets.length, rule.id);
    if (!targets.length) rulesPaused++;
  }
  return { agents, rulesPaused };
}

/** Make sure a name an agent, a hire or a board just used is in the one list; returns its id. */
export function* ensureDepartmentStep(ownerId: string, text: string, by: string): Step<string | null> {
  const key = departmentKey(text);
  if (!key) return null;
  const d = yield* one<{ id: string }>('SELECT id FROM departments WHERE owner_id = ? AND norm_name = ?', ownerId, key);
  if (d) return d.id;
  const id = `dept-${randomUUID().slice(0, 12)}`;
  yield* run('INSERT INTO departments (id, owner_id, name, norm_name, created_by) VALUES (?, ?, ?, ?, ?)', id, ownerId, displayName(key, [text]), key, by);
  yield* mirrorLegacyStep(ownerId);
  return id;
}

/** The questions the upgrade left (D9), unanswered first. */
export function openDepartmentQuestions(ownerId: string) {
  return sql().read(all<{ id: string; kind: string; subject_id: string; name: string }>('SELECT id, kind, subject_id, name FROM department_questions WHERE owner_id = ? AND answered_at IS NULL ORDER BY created_at, id', ownerId));
}

/**
 * Answer a question about a rule target: `departmentId` points the rule at that
 * department; null makes it a rule for all agents ("Leave it for all agents").
 */
export async function answerDepartmentQuestion(ownerId: string, questionId: string, departmentId: string | null): Promise<void> {
  await sql().tx(function* () {
    const qn = yield* one<any>('SELECT * FROM department_questions WHERE owner_id = ? AND id = ? AND answered_at IS NULL', ownerId, questionId);
    if (!qn) throw new ScopeInputError('Nothing to answer', 404, 'not_found');
    const rule = (yield* departmentRulesStep()).find((r) => r.id === qn.subject_id);
    if (rule) {
      const rest = rule.targets.filter((t) => departmentKey(t) !== departmentKey(qn.name));
      if (departmentId) {
        const d = yield* one<{ id: string; norm_name: string }>('SELECT id, norm_name FROM departments WHERE owner_id = ? AND id = ?', ownerId, departmentId);
        if (!d) throw new ScopeInputError('Department not found', 404, 'not_found');
        const ids = [...new Set([...(rule.ids ?? []), d.id])];
        yield* run('UPDATE agent_rules SET targets = ?, department_ids = ?, version = version + 1 WHERE id = ?', JSON.stringify([...new Set([...rest, d.norm_name])]), JSON.stringify(ids), rule.id);
      } else if (!rest.length) {
        yield* run(`UPDATE agent_rules SET who = 'all', targets = '[]', department_ids = '[]', version = version + 1 WHERE id = ?`, rule.id);
      } else {
        yield* run('UPDATE agent_rules SET targets = ?, version = version + 1 WHERE id = ?', JSON.stringify(rest), rule.id);
      }
    }
    yield* run('UPDATE department_questions SET answer = ?, answered_at = ? WHERE id = ?', departmentId ?? 'all', new Date().toISOString(), questionId);
  }, { immediate: true });
}

/** P3: give an agent the id of its department (making the department when the name is new). */
export async function linkAgentDepartment(agentId: string): Promise<void> {
  await sql().tx(function* () {
    const owner = yield* companyOwnerStep();
    const a = yield* one<{ department: string | null }>('SELECT department FROM agents_config WHERE id = ?', agentId);
    if (!owner || !a) return;
    const id = a.department ? yield* ensureDepartmentStep(owner, a.department, 'agent') : null;
    yield* run('UPDATE agents_config SET department_id = ? WHERE id = ?', id, agentId);
  }, { immediate: true });
}

export interface DepartmentOverview extends DepartmentRow {
  agents: Array<{ id: string; name: string }>;
  projects: Array<{ key: string; name: string }>;
}

/** Settings › Departments (FD2a): each department with its agents and projects. Runs the backfill first. */
export async function departmentsOverview(ownerId: string): Promise<{ departments: DepartmentOverview[]; questions: Array<{ id: string; kind: string; subjectId: string; name: string }> }> {
  await syncDepartments();
  return sql().read((function* () {
    const rows = yield* departmentsStep(ownerId);
    const agents = yield* all<{ id: string; name: string; department_id: string }>(`SELECT id, name, department_id FROM agents_config WHERE department_id IS NOT NULL AND id != '${RESERVED_AGENT_ID}' ORDER BY name, id`);
    const projects = yield* all<{ slug: string; name: string | null; department_id: string }>('SELECT slug, name, department_id FROM memory_project_scopes WHERE owner_id = ? AND department_id IS NOT NULL AND archived_at IS NULL ORDER BY slug', ownerId);
    const questions = yield* all<{ id: string; kind: string; subject_id: string; name: string }>('SELECT id, kind, subject_id, name FROM department_questions WHERE owner_id = ? AND answered_at IS NULL ORDER BY created_at, id', ownerId);
    return {
      departments: rows.map((d) => ({
        ...d,
        agents: agents.filter((a) => a.department_id === d.id).map((a) => ({ id: a.id, name: a.name })),
        projects: projects.filter((p) => p.department_id === d.id).map((p) => ({ key: p.slug, name: p.name ?? p.slug })),
      })),
      questions: questions.map((x) => ({ id: x.id, kind: x.kind, subjectId: x.subject_id, name: x.name })),
    };
  })());
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Name, letter, colour and lead in one change, compared against the version the editor saw. */
export async function updateDepartment(ownerId: string, id: string, body: Record<string, unknown>): Promise<DepartmentRow> {
  const allowed = new Set(['name', 'letter', 'color', 'leadAgentId', 'version']);
  if (Object.keys(body).some((k) => !allowed.has(k))) throw new ScopeInputError('Unknown field', 400, 'invalid_input');
  if (body.version === undefined) throw new ScopeInputError('version is required', 400, 'version_required');
  const sets: string[] = [];
  const args: Array<string | null> = [];
  if (body.letter !== undefined) {
    const v = body.letter === null ? null : String(body.letter).trim();
    if (v !== null && [...v].length !== 1) throw new ScopeInputError('A letter is one character', 400, 'invalid_input');
    sets.push('letter = ?'); args.push(v);
  }
  if (body.color !== undefined) {
    if (body.color !== null && !(typeof body.color === 'string' && COLOR.test(body.color))) throw new ScopeInputError('A colour is #rrggbb', 400, 'invalid_input');
    sets.push('color = ?'); args.push(body.color as string | null);
  }
  if (body.leadAgentId !== undefined) {
    if (body.leadAgentId !== null && typeof body.leadAgentId !== 'string') throw new ScopeInputError('The lead must be an agent of this department', 400, 'invalid_lead');
    sets.push('lead_agent_id = ?'); args.push(body.leadAgentId as string | null);
  }
  let version = Number(body.version);
  if (body.name !== undefined) version = (await renameDepartmentEverywhere(ownerId, id, body.name, version)).version;
  return sql().tx(function* () {
    if (typeof body.leadAgentId === 'string' && !(yield* one('SELECT 1 AS x FROM agents_config WHERE id = ? AND department_id = ?', body.leadAgentId, id))) {
      throw new ScopeInputError('The lead must be an agent of this department', 400, 'invalid_lead');
    }
    if (sets.length) {
      const r = yield* run(`UPDATE departments SET ${sets.join(', ')}, version = version + 1, updated_at = ? WHERE owner_id = ? AND id = ? AND version = ?`, ...args, new Date().toISOString(), ownerId, id, version);
      if (r.changes === 0) throw new ScopeInputError('The department changed in the meantime', 409, 'version_conflict');
    }
    const d = yield* one('SELECT * FROM departments WHERE owner_id = ? AND id = ?', ownerId, id);
    if (!d) throw new ScopeInputError('Department not found', 404, 'not_found');
    return rowOf(d);
  }, { immediate: true });
}
