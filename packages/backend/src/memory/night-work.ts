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
import { chosenWorker, ramTooLow, unloadModel } from './helper-settings.js';

const byProject = (r: NightReport, slug: string) => ((r.byProject ??= {})[slug] ??= { files: 0, summary: false });

export interface NightSettings { enabled: boolean; from: string; to: string }
export interface NightReport {
  night: string; startedAt: string; endedAt: string; stopped: 'done' | 'used' | 'unplugged' | 'hours' | 'error' | 'stopped' | 'low_ram';
  files: number; projects: number; proposals: number; summaries: string[]; keys: number; duplicates: number; seen: boolean;
  /** MEM-PANEL-01: per project (slug): files read and whether a summary was written. */
  byProject?: Record<string, { files: number; summary: boolean }>;
  /** MEM-LIVE-01: what it did, newest first (file names, project slugs, counts; no memory text). */
  events?: NightEvent[];
}
export type NightStep = 'read' | 'summaries' | 'tidy';
export interface NightEvent { at: string; kind: 'start' | 'read' | 'idea' | 'summary' | 'tidy' | 'done' | 'stopped'; text: string; project: string | null }
/** While it runs: the step, the file it is on and how many files it read so far. */
export interface NightNow { step: NightStep | null; file: string | null; project: string | null; read: number; startedAt: string }
const MAX_LIVE_EVENTS = 200, MAX_SAVED_EVENTS = 64;
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

export interface NightDeps { state?: () => Promise<MachineState>; now?: () => Date; steps?: Partial<NightSteps>; /** Tests: is RAM too low (default: real check). */ ramLow?: () => Promise<boolean> }
interface StepHooks {
  onFile?: (f: { project: string | null; file: string; phase: 'reading' | 'read' }) => void;
  onSummary?: (name: string, slug: string) => void;
  shouldStop?: () => boolean;
}
interface NightSteps {
  readFiles(ownerId: string, hooks?: StepHooks): Promise<{ files: number; projects: number; proposals: number; bySlug?: Record<string, number> }>;
  summaries(ownerId: string, now: Date, hooks?: StepHooks): Promise<string[] | { names: string[]; slugs: string[] }>;
  tidy(ownerId: string): Promise<{ keys: number; duplicates: number }>;
}

const DEFAULT_STEPS: NightSteps = {
  async readFiles(ownerId, hooks = {}) {
    let files = 0, projects = 0;
    const bySlug: Record<string, number> = {};
    try {
      const { indexOwner } = await import('./docs/indexer.js');
      const reports = await indexOwner(ownerId, { shouldStop: hooks.shouldStop, onFile: hooks.onFile && ((f) => hooks.onFile!({ project: f.project, file: f.file, phase: f.phase })) });
      const refs = new Map((await sql().read(all<{ id: string; ref_id: string }>("SELECT id, ref_id FROM doc_index_sources WHERE owner_id = ? AND kind = 'project'", ownerId)).catch(() => [])).map((r) => [r.id, r.ref_id]));
      for (const r of reports) {
        files += r.changed ?? 0;
        if ((r.changed ?? 0) > 0) { projects++; const slug = refs.get(r.sourceId); if (slug) bySlug[slug] = (bySlug[slug] ?? 0) + (r.changed ?? 0); }
      }
    } catch { /* the document index is optional */ }
    if (hooks.shouldStop?.()) return { files, projects, proposals: 0, bySlug };
    const before = await pendingProposals(ownerId);
    try { const { runAutomaticImportNow } = await import('./import/automatic-project-import.js'); await runAutomaticImportNow(ownerId); } catch { /* import off or nothing to do */ }
    return { files, projects, proposals: Math.max(0, (await pendingProposals(ownerId)) - before), bySlug };
  },
  async summaries(ownerId, now, hooks = {}) {
    const { projectSummaries, summariesText } = await import('./project-summaries.js');
    const { listProjects } = await import('./scopes/store.js');
    const written: string[] = [];
    const slugs: string[] = [];
    for (const p of (await listProjects(ownerId)).filter((x) => !x.archived && !x.notProject).slice(0, 200)) {
      if (hooks.shouldStop?.()) break;
      const list = (await projectSummaries(ownerId, p.slug, now)).filter((s) => s.period === 'today' || (s.period === 'week' && now.getDay() === 1) || (s.period === 'month' && now.getDate() === 1));
      if (!list.length) continue;
      for (const s of list) {
        const key = s.period === 'today' ? s.from.slice(0, 10) : s.period === 'week' ? `w${s.from.slice(0, 10)}` : s.from.slice(0, 7);
        await sql().tx(function* () { yield* ensure(); yield* run(`INSERT INTO memory_project_summaries (owner_id, slug, period, period_key, text, sessions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (owner_id, slug, period, period_key) DO UPDATE SET text = excluded.text, sessions = excluded.sessions, created_at = excluded.created_at`, ownerId, p.slug, s.period, key, summariesText([s]), s.sessions, now.toISOString()); });
      }
      written.push(p.name);
      slugs.push(p.slug);
      hooks.onSummary?.(p.name, p.slug);
    }
    return { names: written, slugs };
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
/** MEM-PANEL-01: the step a run is on, and owners who asked it to stop (Stop in Memory › Memory helper). */
const progress = new Map<string, NightStep>();
const stopAsked = new Set<string>();
/** MEM-LIVE-01: what a run is doing now, and what it did (newest first). */
const live = new Map<string, NightNow & { events: NightEvent[] }>();
/** MEM-LIVE-01: owners whose night work is due but waits (too little free RAM), and since when. */
export interface NightWaiting { reason: 'low_ram'; since: string }
const waiting = new Map<string, NightWaiting>();

/** Whether tonight's work runs now for this owner, on which step, and the file it is on. */
export function nightRunning(ownerId: string): { running: boolean; step: NightStep | null; now: NightNow | null; waiting: NightWaiting | null } {
  const l = live.get(ownerId);
  return { running: running.has(ownerId), step: progress.get(ownerId) ?? null, now: l ? { step: progress.get(ownerId) ?? null, file: l.file, project: l.project, read: l.read, startedAt: l.startedAt } : null,
    waiting: running.has(ownerId) ? null : waiting.get(ownerId) ?? null };
}
/** What it did: the running list while it works, otherwise the last saved run (newest first). */
export async function nightEvents(ownerId: string): Promise<NightEvent[]> {
  const l = live.get(ownerId);
  if (l) return l.events.slice();
  return (await lastNight(ownerId))?.events ?? [];
}

/** Stop at the end of the current step (Undo = Run now). False when nothing runs. */
export function stopNightWorkFor(ownerId: string): boolean {
  if (!running.has(ownerId)) return false;
  stopAsked.add(ownerId);
  return true;
}

const STOP_TEXT: Record<Exclude<NightReport['stopped'], 'done'>, string> = {
  stopped: 'Stopped when you asked. Run now goes on from here.', used: 'Stopped: you are using the computer', unplugged: 'Stopped: the charger was unplugged',
  hours: 'Stopped: the night hours ended', low_ram: 'Waiting: too little free RAM', error: 'Stopped: something went wrong; it tries again tonight',
};

/** Run tonight's work for one owner (also "Run now"). Stops between steps when it should; saves the report. */
export async function runNightWork(ownerId: string, deps: NightDeps & { force?: boolean } = {}): Promise<NightReport> {
  const prev = running.get(ownerId); if (prev) return prev;
  waiting.delete(ownerId);
  const work = (async () => {
    const now = deps.now ?? (() => new Date()), state = deps.state ?? machineState, steps = { ...DEFAULT_STEPS, ...deps.steps };
    const s = await nightSettings(ownerId), start = now();
    const report: NightReport = { night: nightKey(s, start), startedAt: start.toISOString(), endedAt: start.toISOString(), stopped: 'done', files: 0, projects: 0, proposals: 0, summaries: [], keys: 0, duplicates: 0, seen: false };
    const l = { step: null, file: null, project: null, read: 0, startedAt: start.toISOString(), events: [] as NightEvent[] } as NightNow & { events: NightEvent[] };
    live.set(ownerId, l);
    const say = (kind: NightEvent['kind'], text: string, project: string | null = null) => {
      l.events.unshift({ at: now().toISOString(), kind, text: text.slice(0, 300), project });
      if (l.events.length > MAX_LIVE_EVENTS) l.events.length = MAX_LIVE_EVENTS;
    };
    const hooks: StepHooks = {
      shouldStop: () => stopAsked.has(ownerId),
      onFile: (f) => {
        if (f.phase === 'reading') { l.file = f.file; l.project = f.project; return; }
        l.read++; say('read', `Read ${f.file}`, f.project);
      },
      onSummary: (name, slug) => say('summary', `Summary written: ${name}`, slug),
    };
    say('start', deps.force ? 'Started (Run now)' : 'Started');
    const why = async (): Promise<NightReport['stopped'] | null> => {
      if (stopAsked.has(ownerId)) return 'stopped';
      if (deps.force) return null;
      if (await (deps.ramLow ?? ramTooLow)()) return 'low_ram';
      const m = await state();
      if (m.onPower === false) return 'unplugged';
      if (m.idleSeconds !== null && m.idleSeconds < 60) return 'used';
      if (!inHours(s, now()) && !(m.idleSeconds !== null && m.idleSeconds >= IDLE_SECONDS)) return 'hours';
      return null;
    };
    try {
      for (const step of ['read', 'summaries', 'tidy'] as const) {
        const stop = await why(); if (stop) { report.stopped = stop; break; }
        progress.set(ownerId, step); l.step = step; l.file = null; l.project = null;
        if (step === 'read') {
          const r = await steps.readFiles(ownerId, hooks);
          report.files = r.files; report.projects = r.projects; report.proposals = r.proposals;
          for (const [slug, n] of Object.entries(r.bySlug ?? {})) byProject(report, slug).files += n;
          if (r.proposals > 0) say('idea', `${r.proposals} ${r.proposals === 1 ? 'idea waits' : 'ideas wait'} for you in Needs you`);
        } else if (step === 'summaries') {
          const r = await steps.summaries(ownerId, now(), hooks);
          if (Array.isArray(r)) report.summaries = r;
          else { report.summaries = r.names; for (const slug of r.slugs) byProject(report, slug).summary = true; }
        } else {
          const t = await steps.tidy(ownerId);
          Object.assign(report, t);
          say('tidy', t.keys || t.duplicates ? `Tidied: ${t.keys} hidden ${t.keys === 1 ? 'key' : 'keys'}, ${t.duplicates} ${t.duplicates === 1 ? 'duplicate' : 'duplicates'} found` : 'Tidied: nothing to fix');
        }
        l.file = null; l.project = null;
        if (stopAsked.has(ownerId)) { report.stopped = 'stopped'; break; }
      }
    } catch { report.stopped = 'error'; }
    if (report.stopped === 'done') say('done', `Done: ${report.files} ${report.files === 1 ? 'file' : 'files'} read, ${report.summaries.length} ${report.summaries.length === 1 ? 'summary' : 'summaries'}, ${report.proposals} ${report.proposals === 1 ? 'idea' : 'ideas'}`);
    else say('stopped', STOP_TEXT[report.stopped]);
    report.events = l.events.slice(0, MAX_SAVED_EVENTS);
    progress.delete(ownerId); stopAsked.delete(ownerId);
    // The night writer leaves the RAM when the work ends (RAM limit, MEM-PANEL-01).
    const writer = chosenWorker(); if (writer) await unloadModel(writer).catch(() => false);
    report.endedAt = now().toISOString();
    const quiet = !report.files && !report.proposals && !report.summaries.length && !report.keys && !report.duplicates;
    await sql().tx(function* () {
      yield* ensure();
      yield* run(`INSERT INTO memory_night_work (owner_id, enabled, from_hm, to_hm, last_night, report, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (owner_id) DO UPDATE SET last_night = excluded.last_night, report = excluded.report, updated_at = excluded.updated_at`,
        ownerId, s.enabled ? 1 : 0, s.from, s.to, report.stopped === 'done' ? report.night : s.lastNight, quiet && report.stopped === 'done' ? null : JSON.stringify(report), report.endedAt);
    });
    return report;
  })().finally(() => { running.delete(ownerId); progress.delete(ownerId); stopAsked.delete(ownerId); live.delete(ownerId); });
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
  const due: string[] = [];
  for (const o of owners) { if (nightDue(await nightSettings(o.id), now, m)) due.push(o.id); else waiting.delete(o.id); }
  if (!due.length) return;
  // Too little free RAM: wait for the next tick (no report; nothing is stopped while you chat). The footer says it waits.
  if (await (deps.ramLow ?? ramTooLow)()) {
    for (const id of due) if (!waiting.has(id)) waiting.set(id, { reason: 'low_ram', since: now.toISOString() });
    return;
  }
  for (const id of due) await runNightWork(id, deps);
}
