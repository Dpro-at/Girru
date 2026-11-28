// MEM-READ-01 MR9: Settings › Memory › Night work, and the morning report row in Needs you.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { UiIcon } from './ui-icons';

type Requester = { request(r: { method: string; path: string; body?: unknown }): Promise<{ status: number; body: unknown }> };
export type NightSettings = { enabled: boolean; from: string; to: string };
export type NightReport = { night: string; startedAt: string; endedAt: string; stopped: 'done' | 'used' | 'unplugged' | 'hours' | 'error' | 'stopped' | 'low_ram'; files: number; projects: number; proposals: number; summaries: string[]; keys: number; duplicates: number;
  /** MEM-PANEL-01: per project slug, files read and whether a summary was written. */ byProject?: Record<string, { files: number; summary: boolean }> };
export type NightStep = 'read' | 'summaries' | 'tidy';
/** MEM-LIVE-01: what it does now, and what it did (newest first). */
export type NightNow = { step: NightStep | null; file: string | null; project: string | null; read: number; startedAt: string };
export type NightEvent = { at: string; kind: 'start' | 'read' | 'idea' | 'summary' | 'tidy' | 'done' | 'stopped'; text: string; project: string | null };
type State = { settings: NightSettings | null; last: NightReport | null; report: NightReport | null; busy: boolean; notice: string | null; running: boolean; step: NightStep | null;
  now: NightNow | null; events: NightEvent[]; /** When this page saw it finish (ms), for "Just finished". */ finishedAt: number | null };

export class NightWorkController {
  private state: State = { settings: null, last: null, report: null, busy: false, notice: null, running: false, step: null, now: null, events: [], finishedAt: null };
  #idleMs = 0;
  #watch: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  private listeners = new Set<() => void>();
  constructor(private readonly client: Requester) {}
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.state;
  private publish(p: Partial<State>) { this.state = { ...this.state, ...p }; for (const l of this.listeners) l(); }
  async load() {
    try {
      const r = await this.client.request({ method: 'GET', path: '/api/memory/scopes/night' });
      if (r.status === 200) {
        const b = r.body as { settings: NightSettings; last: NightReport | null; running?: boolean; step?: NightStep | null; now?: NightNow | null; events?: NightEvent[] };
        const wasRunning = this.state.running, prevLast = this.state.last;
        this.publish({ settings: b.settings, last: b.last, running: b.running === true, step: b.step ?? null, now: b.now ?? null, events: b.events ?? [],
          ...(wasRunning && b.running !== true ? { finishedAt: Date.now() } : {}) });
        // It finished: say so, and say it plainly when there was nothing new (no report is kept then).
        if (wasRunning && b.running !== true) this.publish({ notice: b.last && b.last !== prevLast && JSON.stringify(b.last) !== JSON.stringify(prevLast) ? 'Done.' : 'Done. Nothing new to read.' });
        // While it runs, read again every 2 seconds so the step and Stop stay right.
        clearTimeout(this.#watch);
        if (!this.#disposed && (b.running || this.#idleMs)) this.#watch = setTimeout(() => void this.load(), b.running ? 2_000 : this.#idleMs);
      }
    } catch {
      clearTimeout(this.#watch);
      if (!this.#disposed && this.#idleMs) this.#watch = setTimeout(() => void this.load(), this.#idleMs);
    }
  }
  /** Keep reading while it rests too (the footer: it may start on its own at night). */
  watch(idleMs: number) { this.#disposed = false; this.#idleMs = idleMs; void this.load(); }
  async loadReport() {
    try { const r = await this.client.request({ method: 'GET', path: '/api/memory/scopes/night/report' }); if (r.status === 200) this.publish({ report: (r.body as { report: NightReport | null }).report }); } catch { /* no row */ }
  }
  async save(p: Partial<NightSettings>): Promise<boolean> {
    this.publish({ busy: true, notice: null });
    try {
      const r = await this.client.request({ method: 'PUT', path: '/api/memory/scopes/night', body: p });
      if (r.status !== 200) { this.publish({ busy: false, notice: 'Not saved. Hours are like 01:00 and must differ.' }); return false; }
      this.publish({ busy: false, settings: (r.body as { settings: NightSettings }).settings, notice: 'Saved.' });
      return true;
    } catch { this.publish({ busy: false, notice: 'Not saved (no connection).' }); return false; }
  }
  /** Run now: tonight's work at once (it does not wait for the hours or the charger). */
  async runNow() {
    this.publish({ busy: true, notice: null });
    try { const r = await this.client.request({ method: 'POST', path: '/api/memory/scopes/night/run' }); this.publish({ busy: false, running: r.status === 200 || this.state.running, notice: r.status === 200 ? 'Started. It stops on its own when it is done.' : 'Did not start.' }); }
    catch { this.publish({ busy: false, notice: 'Did not start (no connection).' }); }
    await this.load();
  }
  /** Stop: it ends after the file it is on; Run now goes on later. */
  async stop() {
    this.publish({ busy: true, notice: null });
    try { const r = await this.client.request({ method: 'POST', path: '/api/memory/scopes/night/stop' }); const stopped = r.status === 200 && (r.body as { stopped?: boolean }).stopped === true; this.publish({ busy: false, notice: stopped ? 'It stops after the file it is on.' : 'Nothing is running.' }); }
    catch { this.publish({ busy: false, notice: 'Not stopped (no connection).' }); }
    await this.load();
  }
  dispose() { this.#disposed = true; clearTimeout(this.#watch); this.listeners.clear(); }
  async done() {
    try { await this.client.request({ method: 'POST', path: '/api/memory/scopes/night/report/done' }); } catch { /* the row goes anyway */ }
    this.publish({ report: null });
  }
}

/** Few words for the footer pill while night work runs, or just after (MEM-LIVE-01). */
export function nightPillWord(ns: { running: boolean; now: NightNow | null; events: NightEvent[]; finishedAt: number | null }, nowMs = Date.now()): string | null {
  if (ns.running) {
    const n = ns.now;
    if (!n || !n.step) return 'Night work: starting';
    if (n.step === 'read') return `Night work: reading, ${n.read} ${n.read === 1 ? 'file' : 'files'} read`;
    return n.step === 'summaries' ? 'Night work: writing summaries' : 'Night work: tidying';
  }
  const top = ns.events[0];
  if (ns.finishedAt !== null && nowMs - ns.finishedAt < 60_000 && top && (top.kind === 'done' || top.kind === 'stopped')) return top.text.slice(0, 80);
  return null;
}

const time = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
const STOPPED: Record<NightReport['stopped'], string> = { done: 'stopped when done', used: 'stopped when the computer was used', unplugged: 'stopped when it left the charger', hours: 'stopped at the end of the hours', error: 'stopped after an error', stopped: 'stopped when you asked', low_ram: 'waited: too little free RAM' };
export function lastNightLine(r: NightReport | null): string {
  if (!r) return 'No night yet.';
  return `Last night: ${time(r.startedAt)}–${time(r.endedAt)} · ${r.files} ${r.files === 1 ? 'file' : 'files'} read · ${STOPPED[r.stopped]}`;
}

/** Settings › Memory › Night work: one switch, the hours, what it does, last night, Run now. */
export function NightWorkSettings({ c }: { c: NightWorkController }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  useEffect(() => { void c.load(); }, [c]);
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  useEffect(() => { if (s.settings) { setFrom(s.settings.from); setTo(s.settings.to); } }, [s.settings?.from, s.settings?.to]);
  if (!s.settings) return <p className="fine-print">Loading night work…</p>;
  return <section className="mem-night" aria-label="Night work">
    <label className="settings-row"><span><b>Work on memory at night</b><span className="fine-print">While the computer is idle and charging</span></span>
      <input type="checkbox" role="switch" checked={s.settings.enabled} disabled={s.busy} onChange={e => void c.save({ enabled: e.target.checked })}/></label>
    <div className="settings-row mem-night-hours"><span>Hours</span>
      <span><label>From <input type="time" value={from} disabled={!s.settings.enabled || s.busy} onChange={e => setFrom(e.target.value)} onBlur={() => { if (from !== s.settings!.from) void c.save({ from }); }}/></label>
        <label> to <input type="time" value={to} disabled={!s.settings.enabled || s.busy} onChange={e => setTo(e.target.value)} onBlur={() => { if (to !== s.settings!.to) void c.save({ to }); }}/></label></span></div>
    <ol className="mem-night-steps">
      <li><b>Read new and changed files</b> in your projects, a batch at a time, from where it stopped.</li>
      <li><b>Learn from the day's chats and tasks:</b> short facts, each with the words it rests on. They wait for you in Needs you.</li>
      <li><b>Write the summaries:</b> today per project; on Monday the week; on the 1st the month.</li>
      <li><b>Tidy:</b> hide keys it finds and count duplicates. It never forgets anything on its own.</li>
    </ol>
    <p className="fine-print">{lastNightLine(s.last)} · {s.running ? <button type="button" className="link-button" disabled={s.busy} onClick={() => void c.stop()}>Stop</button> : <button type="button" className="link-button" disabled={s.busy} onClick={() => void c.runNow()}>Run now</button>}</p>
    <p className="fine-print">Stops on its own when you use the computer, it leaves the charger, or the hours end; continues the next night. A computer that is off at night does it the next time it is idle for 20 minutes. Everything runs on this computer; no paid calls.</p>
    {s.notice && <p className="fine-print" role="status">{s.notice}</p>}
  </section>;
}

/** Memory › Needs you: the morning report, one row. A quiet night makes no row. */
export function NightReportRow({ c, onReview }: { c: NightWorkController; onReview?: () => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  useEffect(() => { void c.loadReport(); }, [c]);
  const r = s.report;
  if (!r) return null;
  const lines = [
    r.files > 0 && `Read ${r.files} new ${r.files === 1 ? 'file' : 'files'}${r.projects ? ` in ${r.projects} ${r.projects === 1 ? 'project' : 'projects'}` : ''}`,
    r.proposals > 0 && `${r.proposals} new ${r.proposals === 1 ? 'fact waits' : 'facts wait'} for you`,
    r.summaries.length > 0 && `Wrote today's summary for ${r.summaries.slice(0, 3).join(' and ')}${r.summaries.length > 3 ? ` and ${r.summaries.length - 3} more` : ''}`,
    r.duplicates > 0 && `Found ${r.duplicates} ${r.duplicates === 1 ? 'duplicate' : 'duplicates'} (nothing joined on its own)`,
    r.keys > 0 && `Hid ${r.keys} ${r.keys === 1 ? 'key' : 'keys'} found in memories`,
    r.stopped !== 'done' && `It ${STOPPED[r.stopped]}; the rest continues the next night`,
  ].filter(Boolean) as string[];
  return <article className="dk-question" aria-label="This morning">
    <h3><UiIcon name="moon" size={15}/>This morning</h3>
    <ul className="mem-night-report">{lines.map(l => <li key={l}>{l}</li>)}</ul>
    <div className="actions"><button type="button" onClick={() => void c.done()}>Done</button>{r.proposals > 0 && <button type="button" className="primary" onClick={() => { void c.done(); onReview?.(); }}>Review the {r.proposals} {r.proposals === 1 ? 'fact' : 'facts'}</button>}</div>
  </article>;
}
