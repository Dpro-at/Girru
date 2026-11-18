/**
 * Night work (MEM-READ-01 MR9; builds MEM-PERIODS-01 and the night librarian on what exists).
 *
 * On by default, 01:00–06:00, while the computer is idle and on its charger. Each
 * night, in this order, stopping on its own when the computer is used, leaves the
 * charger or the hours end (it continues the next night):
 *   1. Read new and changed files: the project document index and the existing
 *      batch import with its cursor (project notes, other agents' memory files).
 *   2. Learn from the day: the same import turns new notes into proposals that
 *      wait in Needs you — nothing goes live alone.
 *   3. Write the summaries: today per project with work (on Monday the week, on the
 *      1st the month), from the handoffs (MR6), kept in memory_project_summaries.
 *   4. Tidy: hide keys found in memories (MR2); count duplicates for the owner.
 *      It never forgets anything on its own.
 * One morning report row in Needs you; a quiet night makes no row. A computer that
 * is off at night does it the next time it is idle for 20 minutes. No paid calls:
 * only the local memory helper ever reads text. Night work replaces the
 * "every 15/30/60 minutes" import choice while it is on.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { all, one, run, sql } from '../repositories/sql-steps.js';

export interface NightSettings { enabled: boolean; from: string; to: string }
export interface NightReport {
  night: string; startedAt: string; endedAt: string; stopped: 'done' | 'used' | 'unplugged' | 'hours' | 'error';
  files: number; projects: number; proposals: number; summaries: string[]; keys: number; duplicates: number; seen: boolean;
}
export interface MachineState { idleSeconds: number | null; onPower: boolean | null }

const DEFAULTS: NightSettings = { enabled: true, from: '01:00', to: '06:00' };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const IDLE_SECONDS = 20 * 60;

function* ensure() {
  yield* run(`CREATE TABLE IF NOT EXISTS memory_night_work (owner_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, from_hm TEXT NOT NULL DEFAULT '01:00', to_hm TEXT NOT NULL DEFAULT '06:00',
    last_night TEXT, report TEXT, updated_at TEXT NOT NULL)`);
  yield* run(`CREATE TABLE IF NOT EXISTS memory_project_summaries (owner_id TEXT NOT NULL, slug TEXT NOT NULL, period TEXT NOT NULL, period_key TEXT NOT NULL, text TEXT NOT NULL, sessions INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, PRIMARY KEY (owner_id, slug, period, period_key))`);
}

export async function nightSettings(ownerId: string): Promise<NightSettings & { lastNight: string | null }> {
  const r = await sql().tx(function* () { yield* ensure(); return yield* one<{ enabled: number; from_hm: string; to_hm: string; last_night: string | null }>('SELECT enabled, from_hm, to_hm, last_night FROM memory_night_work WHERE owner_id = ?', ownerId); });
  return r ? { enabled: Number(r.enabled) === 1, from: r.from_hm, to: r.to_hm, lastNight: r.last_night } : { ...DEFAULTS, lastNight: null };
}

export async function setNightSettings(ownerId: string, input: unknown): Promise<NightSettings> {
  const b = input as Record<string, unknown>;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['enabled', 'from', 'to'].includes(k))) throw new NightInputError('Use enabled, from and to');
  const cur = await nightSettings(ownerId);
  const next: NightSettings = { enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled, from: typeof b.from === 'string' ? b.from : cur.from, to: typeof b.to === 'string' ? b.to : cur.to };
  if (!HHMM.test(next.from) || !HHMM.test(next.to) || next.from === next.to) throw new NightInputError('Hours are HH:MM and differ');
  const at = new Date().toISOString();
  await sql().tx(function* () {
    yield* ensure();
    yield* run(`INSERT INTO memory_night_work (owner_id, enabled, from_hm, to_hm, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (owner_id) DO UPDATE SET enabled = excluded.enabled, from_hm = excluded.from_hm, to_hm = excluded.to_hm, updated_at = excluded.updated_at`, ownerId, next.enabled ? 1 : 0, next.from, next.to, at);
  });
  return next;
}
export class NightInputError extends Error {}

const minutes = (hm: string) => { const m = HHMM.exec(hm)!; return Number(m[1]) * 60 + Number(m[2]); };
/** True inside the hours (the window may cross midnight, e.g. 22:00–06:00). */
export function inHours(s: Pick<NightSettings, 'from' | 'to'>, now: Date): boolean {
  const t = now.getHours() * 60 + now.getMinutes(), a = minutes(s.from), b = minutes(s.to);
  return a < b ? t >= a && t < b : t >= a || t < b;
}
/** The night a moment belongs to: the date the window started (local), YYYY-MM-DD. */
export function nightKey(s: Pick<NightSettings, 'from' | 'to'>, now: Date): string {
  const d = new Date(now);
  if (minutes(s.from) > minutes(s.to) && now.getHours() * 60 + now.getMinutes() < minutes(s.to)) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whether tonight's work should start now. Unknown idle/power counts as allowed only inside the hours. */
export function nightDue(s: NightSettings & { lastNight: string | null }, now: Date, m: MachineState): boolean {
  if (!s.enabled || m.onPower === false) return false;
  const key = nightKey(s, now);
  if (inHours(s, now)) return s.lastNight !== key && (m.idleSeconds === null || m.idleSeconds >= 60);
  // Off at night: the next time it is idle for 20 minutes (and the last night was missed).
  const yesterday = nightKey(s, new Date(now.getTime() - 24 * 3600_000));
  return s.lastNight !== key && s.lastNight !== yesterday && m.idleSeconds !== null && m.idleSeconds >= IDLE_SECONDS;
}

const exec = (cmd: string, args: string[]) => new Promise<string>((resolve) => { execFile(cmd, args, { timeout: 4000, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? '' : String(out))); });
/** Idle seconds and charger state of this computer, as far as it says (null = unknown). */
export async function machineState(): Promise<MachineState> {
  if (process.env.GIRRU_NIGHT_STATE) { try { const v = JSON.parse(process.env.GIRRU_NIGHT_STATE); return { idleSeconds: v.idleSeconds ?? null, onPower: v.onPower ?? null }; } catch { /* fall through */ } }
  if (process.platform === 'darwin') {
    const [ioreg, batt] = await Promise.all([exec('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4']), exec('/usr/bin/pmset', ['-g', 'batt'])]);
    const ns = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg)?.[1];
    return { idleSeconds: ns ? Math.floor(Number(ns) / 1e9) : null, onPower: batt ? /AC Power/.test(batt) : null };
  }
  if (process.platform === 'linux') {
    try { const dirs = await fs.readdir('/sys/class/power_supply'); for (const d of dirs) { const online = await fs.readFile(`/sys/class/power_supply/${d}/online`, 'utf8').catch(() => ''); if (online.trim()) return { idleSeconds: null, onPower: online.trim() === '1' }; } } catch { /* unknown */ }
    return { idleSeconds: null, onPower: null };
  }
  return { idleSeconds: null, onPower: null };
}

export interface NightDeps { state?: () => Promise<MachineState>; now?: () => Date; steps?: Partial<NightSteps> }
interface NightSteps {
  readFiles(ownerId: string): Promise<{ files: number; projects: number; proposals: number }>;
  summaries(ownerId: string, now: Date): Promise<string[]>;
  tidy(ownerId: string): Promise<{ keys: number; duplicates: number }>;
}

const DEFAULT_STEPS: NightSteps = {
  async readFiles(ownerId) {
    let files = 0, projects = 0;
    try {
      const { indexOwner } = await import('./docs/indexer.js');
      const reports = await indexOwner(ownerId);
      for (const r of reports) { files += r.changed ?? 0; if ((r.changed ?? 0) > 0) projects++; }
    } catch { /* the document index is optional */ }
    const before = await pendingProposals(ownerId);
    try { const { runAutomaticImportNow } = await import('./import/automatic-project-import.js'); await runAutomaticImportNow(ownerId); } catch { /* import off or nothing to do */ }
    return { files, projects, proposals: Math.max(0, (await pendingProposals(ownerId)) - before) };
  },
  async summaries(ownerId, now) {
    const { projectSummaries, summariesText } = await import('./project-summaries.js');
    const { listProjects } = await import('./scopes/store.js');
    const written: string[] = [];
    for (const p of (await listProjects(ownerId)).filter((x) => !x.archived && !x.notProject).slice(0, 200)) {
      const list = (await projectSummaries(ownerId, p.slug, now)).filter((s) => s.period === 'today' || (s.period === 'week' && now.getDay() === 1) || (s.period === 'month' && now.getDate() === 1));
      if (!list.length) continue;
      for (const s of list) {
        const key = s.period === 'today' ? s.from.slice(0, 10) : s.period === 'week' ? `w${s.from.slice(0, 10)}` : s.from.slice(0, 7);
        await sql().tx(function* () { yield* ensure(); yield* run(`INSERT INTO memory_project_summaries (owner_id, slug, period, period_key, text, sessions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (owner_id, slug, period, period_key) DO UPDATE SET text = excluded.text, sessions = excluded.sessions, created_at = excluded.created_at`, ownerId, p.slug, s.period, key, summariesText([s]), s.sessions, now.toISOString()); });
      }
      written.push(p.name);
    }
    return written;
  },
  async tidy(ownerId) {
    const { hideKeysInSavedMemories } = await import('./hidden-keys.js');
    const keys = (await hideKeysInSavedMemories(ownerId).catch(() => ({ keys: 0 }))).keys;
    // Duplicates are counted for the owner, never joined or forgotten on their own.
    const dup = await sql().read(one<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT content FROM memories WHERE user_id = ? GROUP BY drawer_kind, drawer_key, content HAVING COUNT(*) > 1) d`, ownerId)).catch(() => null);
    return { keys, duplicates: Number(dup?.n ?? 0) };
  },
};

async function pendingProposals(ownerId: string): Promise<number> {
  return Number((await sql().read(one<{ n: number }>("SELECT COUNT(*) AS n FROM memory_file_proposals WHERE user_id = ? AND status = 'pending'", ownerId)).catch(() => null))?.n ?? 0);
}

const running = new Map<string, Promise<NightReport>>();

/** Run tonight's work for one owner (also "Run now"). Stops between steps when it should; saves the report. */
export async function runNightWork(ownerId: string, deps: NightDeps & { force?: boolean } = {}): Promise<NightReport> {
  const prev = running.get(ownerId); if (prev) return prev;
  const work = (async () => {
    const now = deps.now ?? (() => new Date()), state = deps.state ?? machineState, steps = { ...DEFAULT_STEPS, ...deps.steps };
    const s = await nightSettings(ownerId), start = now();
    const report: NightReport = { night: nightKey(s, start), startedAt: start.toISOString(), endedAt: start.toISOString(), stopped: 'done', files: 0, projects: 0, proposals: 0, summaries: [], keys: 0, duplicates: 0, seen: false };
    const why = async (): Promise<NightReport['stopped'] | null> => {
      if (deps.force) return null;
      const m = await state();
      if (m.onPower === false) return 'unplugged';
      if (m.idleSeconds !== null && m.idleSeconds < 60) return 'used';
      if (!inHours(s, now()) && !(m.idleSeconds !== null && m.idleSeconds >= IDLE_SECONDS)) return 'hours';
      return null;
    };
    try {
      for (const step of ['read', 'summaries', 'tidy'] as const) {
        const stop = await why(); if (stop) { report.stopped = stop; break; }
        if (step === 'read') Object.assign(report, await steps.readFiles(ownerId));
        else if (step === 'summaries') report.summaries = await steps.summaries(ownerId, now());
        else Object.assign(report, await steps.tidy(ownerId));
      }
    } catch { report.stopped = 'error'; }
    report.endedAt = now().toISOString();
    const quiet = !report.files && !report.proposals && !report.summaries.length && !report.keys && !report.duplicates;
    await sql().tx(function* () {
      yield* ensure();
      yield* run(`INSERT INTO memory_night_work (owner_id, enabled, from_hm, to_hm, last_night, report, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (owner_id) DO UPDATE SET last_night = excluded.last_night, report = excluded.report, updated_at = excluded.updated_at`,
        ownerId, s.enabled ? 1 : 0, s.from, s.to, report.stopped === 'done' ? report.night : s.lastNight, quiet && report.stopped === 'done' ? null : JSON.stringify(report), report.endedAt);
    });
    return report;
  })().finally(() => running.delete(ownerId));
  running.set(ownerId, work);
  return work;
}

/** The morning report for Needs you (null after Done, or after a quiet night). */
export async function nightReport(ownerId: string): Promise<NightReport | null> {
  const r = await sql().tx(function* () { yield* ensure(); return yield* one<{ report: string | null }>('SELECT report FROM memory_night_work WHERE owner_id = ?', ownerId); });
  if (!r?.report) return null;
  try { const v = JSON.parse(r.report) as NightReport; return v.seen ? null : v; } catch { return null; }
}
export async function dismissNightReport(ownerId: string): Promise<void> {
  const r = await nightReport(ownerId); if (!r) return;
  await sql().tx(function* () { yield* run('UPDATE memory_night_work SET report = ? WHERE owner_id = ?', JSON.stringify({ ...r, seen: true }), ownerId); });
}
/** The last night, for Settings ("Last night: 01:04–02:37 · 214 files read · stopped when done"). */
export async function lastNight(ownerId: string): Promise<NightReport | null> {
  const r = await sql().tx(function* () { yield* ensure(); return yield* one<{ report: string | null }>('SELECT report FROM memory_night_work WHERE owner_id = ?', ownerId); });
  try { return r?.report ? JSON.parse(r.report) as NightReport : null; } catch { return null; }
}

/** Whether night work owns the imports for this owner (the 15/30/60-minute timer then leaves them alone). */
export async function nightWorkOn(ownerId: string): Promise<boolean> { return (await nightSettings(ownerId)).enabled; }

// ---------------------------------------------------------------- the clock
let timer: ReturnType<typeof setInterval> | undefined;
export function startNightWork(): void {
  if (timer) return;
  timer = setInterval(() => { void tick().catch(() => {}); }, 5 * 60_000);
  timer.unref();
}
export function stopNightWork(): void { clearInterval(timer); timer = undefined; }
export async function tick(deps: NightDeps = {}): Promise<void> {
  const owners = await sql().read(all<{ id: string }>("SELECT id FROM users WHERE role = 'owner' AND status = 'active'"));
  const m = await (deps.state ?? machineState)(), now = (deps.now ?? (() => new Date()))();
  for (const o of owners) if (nightDue(await nightSettings(o.id), now, m)) await runNightWork(o.id, deps);
}
