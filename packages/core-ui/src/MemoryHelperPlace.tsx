// MEM-PANEL-01 (board v3, approved 2026-11-28): Memory › Memory helper, its own
// place right under Needs you (the footer pill opens it), and Settings › Memory
// › Memory helper with the RAM limit. Three blocks: it finds what you mean, it
// night work (24-hour bar, Run now / Stop), its tools (tiles; the
// selected tile shows its details on the right). One RAM line on top.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { UiIcon } from './ui-icons';
import type { UiIconName } from './ui-icons';
import type { Requester } from './memory-store';
import type { HelperRam, HelperStatus, WorkerCandidate } from './memory-helper-contract.js';
import { stepWord, timeLeft, useMemoryHelper } from './MemoryHelper';
import type { HelperState } from './MemoryHelper';
import { NightWorkController, NightWorkSettings } from './MemoryNightWork';
import type { NightEvent, NightNow, NightReport, NightSettings, NightStep } from './MemoryNightWork';

const GIB = 1024 ** 3;
/** "1 GB", "3.5 GB", "32 GB". */
export const gb = (bytes: number) => { const v = bytes / GIB; return `${v >= 10 || Number.isInteger(Math.round(v * 10) / 10) ? Math.round(v) : (Math.round(v * 10) / 10).toFixed(1)} GB`; };
const mode = (m: HelperRam['mode']) => (m === 'auto' ? 'Automatic' : m === 'light' ? 'Light' : 'Custom');

/** The RAM line: what the models use now, of the computer's RAM, and the limit (a mark on the bar). */
export function RamLine({ ram, onChange }: { ram: HelperRam; onChange?: () => void }) {
  if (!ram.totalBytes) return null;
  const used = Math.min(100, (ram.modelsBytes / ram.totalBytes) * 100), limit = Math.min(100, (ram.limitBytes / ram.totalBytes) * 100);
  return <div className="helper-ram">
    <div className="helper-ram-bar" role="img" aria-label={`Uses ${gb(ram.modelsBytes)} of RAM; RAM limit ${gb(ram.limitBytes)}`}>
      <i className="helper-ram-used" style={{ inlineSize: `${used}%` }}/><i className="helper-ram-limit" style={{ insetInlineStart: `${limit}%` }}/>
    </div>
    <p className="fine-print">Uses <b>{gb(ram.modelsBytes)} of RAM</b> · this computer has {gb(ram.totalBytes)} RAM · RAM limit <b>{gb(ram.limitBytes)}</b> ({mode(ram.mode)})
      {onChange && <> · <button type="button" className="link-button" onClick={onChange}>Change</button></>}</p>
  </div>;
}

const minutes = (hm: string) => { const m = /^(\d\d):(\d\d)$/.exec(hm); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
const parse = (iso: string) => new Date(iso.length === 19 ? `${iso}Z` : iso);
const at = (iso: string) => { const d = parse(iso); return Number.isNaN(d.getTime()) ? null : d.getHours() * 60 + d.getMinutes(); };

/** 24 hours from midnight: the night band (it may cross midnight), when it finished last night, and now. */
export function NightBar({ settings, last, now = new Date() }: { settings: NightSettings; last: NightReport | null; now?: Date }) {
  const pct = (m: number) => `${(m / 1440) * 100}%`;
  const from = minutes(settings.from), to = minutes(settings.to);
  const bands = from < to ? [[from, to]] : [[from, 1440], [0, to]];
  const done = last ? at(last.endedAt) : null;
  return <div className="helper-night" data-off={!settings.enabled || undefined}>
    <div className="helper-night-bar" role="img" aria-label={settings.enabled ? `Works every night from ${settings.from} to ${settings.to}` : 'Night work is off'}>
      {settings.enabled && bands.map(([a, b]) => <i key={a} className="helper-night-band" style={{ insetInlineStart: pct(a), inlineSize: pct(b - a) }}/>)}
      {done !== null && <i className="helper-night-done" style={{ insetInlineStart: pct(done) }} title={`Finished last night at ${parse(last!.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}/>}
      <i className="helper-night-now" style={{ insetInlineStart: pct(now.getHours() * 60 + now.getMinutes()) }} title="Now"/>
    </div>
    <div className="helper-night-scale" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
  </div>;
}

const STEP: Record<NightStep, string> = { read: 'reading the files that changed', summaries: 'writing the summaries', tidy: 'tidying' };
/** One sentence about last night (or now). */
export function lastNightSentence(last: NightReport | null): string {
  if (!last) return 'It has not run yet. Tonight it starts on its own.';
  if (last.stopped === 'low_ram') return 'Last night it waited: the computer had too little free RAM.';
  const parts = [`read ${last.files} ${last.files === 1 ? 'file' : 'files'}`, `wrote ${last.summaries.length} ${last.summaries.length === 1 ? 'summary' : 'summaries'}`];
  return `Last night it ${parts.join(', ')}${last.stopped === 'done' ? '' : ' and stopped early; it goes on the next night'}.`;
}

// ---- MEM-LIVE-01: what night work is doing now, and what it did ----------------------------

const STEPS: ReadonlyArray<{ id: NightStep; name: string }> = [{ id: 'read', name: 'Read files' }, { id: 'summaries', name: 'Write summaries' }, { id: 'tidy', name: 'Tidy' }];
const EVENT_ICON: Record<NightEvent['kind'], UiIconName> = { start: 'play', read: 'file', idea: 'bulb', summary: 'note', tidy: 'eraser', done: 'check', stopped: 'pause' };
const hhmm = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

/** The three steps: done, on it, or still to come. */
export function NightSteps({ step, finished }: { step: NightStep | null; finished: boolean }) {
  const at = finished ? STEPS.length : step ? STEPS.findIndex(x => x.id === step) : 0;
  return <ol className="night-steps" aria-label="Steps">
    {STEPS.map((x, i) => <li key={x.id} data-state={i < at ? 'done' : i === at ? 'now' : 'next'}>
      <span className="night-step-mark" aria-hidden="true">{i < at ? <UiIcon name="check" size={12}/> : <i/>}</span>{x.name}
      <span className="sr-only">{i < at ? ' (done)' : i === at ? ' (now)' : ''}</span></li>)}
  </ol>;
}

/** What it did, newest first. An idea row opens Needs you. */
export function NightEventList({ events, projectName, onOpenNeeds, label }: { events: NightEvent[]; projectName: (slug: string) => string; onOpenNeeds?: () => void; label: string }) {
  return <ul className="night-events" aria-label={label}>
    {events.map((e, i) => <li key={`${e.at}-${i}`} data-kind={e.kind}>
      <time dateTime={e.at}>{hhmm(e.at)}</time>
      <UiIcon name={EVENT_ICON[e.kind]} size={13}/>
      {e.kind === 'idea' && onOpenNeeds ? <button type="button" className="link-button" onClick={onOpenNeeds}>{e.text}</button> : <span className="night-event-text" title={e.text}>{e.text}</span>}
      {e.project && <span className="fine-print night-event-project">{projectName(e.project)}</span>}
    </li>)}
  </ul>;
}

/** While it runs: the file it is on. */
export function NightNowLine({ now, projectName }: { now: NightNow; projectName: (slug: string) => string }) {
  const what = now.step === 'summaries' ? 'Writing the summaries' : now.step === 'tidy' ? 'Tidying' : now.file ? <>Reading <b>{now.file}</b></> : 'Looking for new and changed files';
  return <div className="night-now" role="status">
    <UiIcon name={now.step === 'summaries' ? 'note' : now.step === 'tidy' ? 'eraser' : 'file'} size={15}/>
    <span className="night-now-text">{what}{now.project && now.step === 'read' ? <span className="fine-print"> · {projectName(now.project)}</span> : null}</span>
    <span className="fine-print">{now.read} {now.read === 1 ? 'file' : 'files'} read</span>
  </div>;
}

type Tool = 'search' | 'files' | 'apps' | 'writer';
const TOOLS: ReadonlyArray<{ id: Tool; icon: UiIconName; name: string }> = [
  { id: 'search', icon: 'search', name: 'Search' }, { id: 'files', icon: 'file', name: 'Your files' }, { id: 'apps', icon: 'code', name: 'Coding apps' }, { id: 'writer', icon: 'cpu', name: 'Night writer' },
];

function toolState(t: Tool, st: HelperState, last: NightReport | null): { sub: string; on: boolean } {
  const s = st.status!;
  if (t === 'search') return { sub: s.phase === 'ready' ? 'finds by meaning' : stepWord(s, st.needsYou).word, on: s.phase === 'ready' || s.phase === 'reembedding' };
  if (t === 'files') { const n = Object.keys(last?.byProject ?? {}).length; return { sub: n ? `${n} ${n === 1 ? 'project' : 'projects'} read last night` : 'reads your project files', on: true }; }
  if (t === 'apps') return { sub: 'share this memory', on: true };
  return { sub: s.worker ? (s.worker.phase === 'ready' ? s.worker.model : `${s.worker.model} · ${s.worker.phase === 'downloading' ? 'getting ready' : 'not ready'}`) : 'off', on: !!s.worker && s.worker.phase === 'ready' };
}

const ramOf = (ram: HelperRam | null, model: string) => ram?.loaded.find(m => m.model === model || m.model === `${model}:latest`)?.bytes ?? 0;

function ToolDetails({ tool, st, c, last, projectName, onOpenSettings, onRetry }: {
  tool: Tool; st: HelperState; c: ReturnType<typeof useMemoryHelper>[1]; last: NightReport | null; projectName: (slug: string) => string;
  onOpenSettings?: (pane: 'sources' | 'schedule') => void; onRetry: () => void;
}) {
  const s = st.status!; const [note, setNote] = useState<string | null>(null);
  const rows: Array<[string, string]> = [];
  let what = '', fine = '', actions: ReactNode = null;
  if (tool === 'search') {
    what = 'Finds memories by meaning, in any language';
    rows.push(['Now', stepWord(s, st.needsYou).word], ['Model', s.model], ['Download', s.sizeBytes ? `${Math.round(s.sizeBytes / 1024 ** 2)} MB, once` : 'once']);
    const r = ramOf(st.ram, s.model); if (r) rows.push(['RAM in use', `about ${gb(r)}`]);
    rows.push(['Runs', 'on this computer only, works offline']);
    if (s.readyAt) rows.push(['Ready since', new Date(s.readyAt).toLocaleDateString([], { day: 'numeric', month: 'short' })]);
    if (s.phase === 'downloading') rows.push(['Time left', timeLeft(s, st.rate) ?? 'working it out']);
    if (s.remaining) rows.push(['Memories', `${s.remaining} wait to be updated`]);
    fine = 'Search is always on: without it memory finds things only by exact words.';
    if (s.phase === 'fallback') actions = <button type="button" className="primary" disabled={st.busy} onClick={onRetry}>Try again</button>;
  } else if (tool === 'files') {
    what = 'Reads the documents in your projects at night';
    const list = Object.entries(last?.byProject ?? {}).filter(([, v]) => v.files > 0 || v.summary).sort((a, b) => b[1].files - a[1].files).slice(0, 6);
    rows.push(['Last night', last ? `${last.files} ${last.files === 1 ? 'file' : 'files'} in ${last.projects} ${last.projects === 1 ? 'project' : 'projects'}` : 'not yet']);
    for (const [slug, v] of list) rows.push([projectName(slug), `${v.files} ${v.files === 1 ? 'file' : 'files'}${v.summary ? ' · 1 summary' : ''}`]);
    fine = 'Each project shows what was read in its Files view. Girru only reads; your files never change.';
  } else if (tool === 'apps') {
    what = 'Coding apps read and add to this memory through Girru';
    rows.push(['How', 'the memory bridge in each project folder'], ['What they get', 'the state now, the latest summary, the project index']);
    fine = 'What they write waits for you in Needs you.';
    if (onOpenSettings) actions = <button type="button" onClick={() => onOpenSettings('sources')}>Coding app settings</button>;
  } else {
    what = 'A small local model kept ready for the night work';
    const fit = st.candidates.filter(x => x.fits);
    const next = fit.find(x => !x.chosen) ?? fit[0] ?? null;
    rows.push(['Now', s.worker ? `${s.worker.model}${s.worker.phase === 'ready' ? '' : ` · ${s.worker.phase === 'downloading' ? 'getting ready' : 'not ready'}`}` : 'off · summaries use simple rules']);
    if (!s.worker && next) rows.push(['Would use', `${next.model}, already on this computer`], ['RAM in use', `about ${gb(next.ramBytes)} while it works, 0 after`]);
    if (st.ram) rows.push(['RAM limit', `${gb(st.ram.limitBytes)} (${mode(st.ram.mode)})`]);
    fine = st.settings?.ram.mode === 'light' ? 'Light keeps the night writer off. Choose Automatic or Custom in Settings.'
      : !fit.length ? 'No model on this computer fits in the RAM limit.' : 'It never chats and never leaves this computer. Summaries are still written by simple rules until the next memory step.';
    const save = async (worker: string | null) => setNote(await c.saveSettings({ worker }));
    actions = <>{!s.worker && next && <button type="button" className="primary" disabled={st.busy} onClick={() => void save(next.model)}>Turn on</button>}
      {s.worker && <button type="button" disabled={st.busy} onClick={() => void save(null)}>Turn off</button>}
      {onOpenSettings && <button type="button" onClick={() => onOpenSettings('schedule')}>Choose another…</button>}</>;
  }
  const t = TOOLS.find(x => x.id === tool)!;
  return <aside className="helper-tool-details" aria-label={t.name}>
    <h3><span className="helper-tile-icon"><UiIcon name={t.icon} size={16}/></span>{t.name}</h3>
    <p>{what}</p>
    <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    {fine && <p className="fine-print">{fine}</p>}
    {actions && <div className="actions">{actions}</div>}
    {note && <p className="fine-print" role="status">{note}</p>}
  </aside>;
}

/** Memory › Memory helper. */
export function MemoryHelperPlace({ client, night, projectName = s => s, onOpenNeeds, onOpenSettings, onOpenStore }: {
  client: Requester; night: NightWorkController; projectName?: (slug: string) => string;
  onOpenNeeds?: () => void; onOpenSettings?: (pane: 'sources' | 'schedule') => void; onOpenStore?: () => void;
}) {
  const [st, c] = useMemoryHelper(client, true);
  const ns = useSyncExternalStore(night.subscribe, night.getSnapshot, night.getSnapshot);
  const [tool, setTool] = useState<Tool>('search');
  const [allEvents, setAllEvents] = useState(false);
  useEffect(() => { void night.load(); void night.loadReport(); }, [night]);
  if (st.phase === 'loading') return <p className="dk-side-note" role="status">Loading…</p>;
  if (st.phase === 'off') return <div className="dk-empty"><UiIcon name="brain" size={20}/><p>The memory helper is turned off on this installation. Memory finds things by words.</p></div>;
  if (!st.status) return <div className="dk-empty"><UiIcon name="brain" size={20}/><p>Could not read the memory helper.</p><button type="button" onClick={() => void c.load()}>Try again</button></div>;
  const s: HelperStatus = st.status; const last = ns.last; const ideas = ns.report?.proposals ?? 0;
  const w = stepWord(s, st.needsYou);
  return <div className="helper-place">
    <div className="helper-main">
      <p className="helper-state" data-tone={w.tone}><span className="helper-dot" aria-hidden="true"/>{w.word} · works on this computer only</p>
      {st.ram && <RamLine ram={st.ram} onChange={onOpenSettings ? () => onOpenSettings('schedule') : undefined}/>}
      {st.needsYou && <div className="helper-paused" role="status"><b>Needs you</b>
        <p>{s.reason === 'runtime_missing' ? 'The local runtime is not on this computer, so memory finds things only by exact words for now.' : 'The search part is missing, so memory finds things only by exact words for now.'}</p>
        <button type="button" disabled={st.busy} onClick={() => void c.retry()}>Try again</button></div>}
      <section className="helper-block" aria-label="It finds what you mean">
        <h3>It finds what you mean</h3>
        <p>Ask in your own words, in any language or dialect: it finds the memory that means the same, even when the words are different.</p>
      </section>
      <section className="helper-block" aria-label="Night work">
        <h3>Night work{ns.running ? <span className="fine-print"> · running now{ns.step ? `: ${STEP[ns.step]}` : ''}</span> : null}</h3>
        {ns.running ? <>
          <NightSteps step={ns.now?.step ?? ns.step} finished={false}/>
          {ns.now && <NightNowLine now={ns.now} projectName={projectName}/>}
          {ns.events.length > 0 && <><span className="fine-print">What it is doing</span>
            <NightEventList events={ns.events.slice(0, 8)} projectName={projectName} onOpenNeeds={onOpenNeeds} label="What it is doing"/></>}
        </> : ns.settings && <NightBar settings={ns.settings} last={last}/>}
        {!ns.running && ns.events.length > 0 && <>
          <NightSteps step={null} finished={ns.events[0]?.kind === 'done'}/>
          <span className="fine-print">Last run</span>
          <NightEventList events={allEvents ? ns.events : ns.events.slice(0, 5)} projectName={projectName} onOpenNeeds={onOpenNeeds} label="Last run"/>
          {ns.events.length > 5 && <button type="button" className="link-button" onClick={() => setAllEvents(v => !v)}>{allEvents ? 'Show less' : `Show everything it did (${ns.events.length})`}</button>}
        </>}
        {!ns.running && <p>{lastNightSentence(last)}{ideas > 0 && <> {onOpenNeeds ? <button type="button" className="link-button" onClick={onOpenNeeds}>{ideas} {ideas === 1 ? 'idea waits' : 'ideas wait'} for you</button> : `${ideas} ideas wait for you`}.</>}</p>}
        <div className="actions">
          {ns.running ? <button type="button" disabled={ns.busy} onClick={() => void night.stop()}><UiIcon name="pause" size={12}/>Stop</button>
            : <button type="button" className="primary" disabled={ns.busy} onClick={() => void night.runNow()}>Run now</button>}
          <span className="fine-print">{ns.running ? 'Stop ends after the file it is on. Nothing is lost; Run now goes on from there.' : ns.settings?.enabled === false ? 'Night work is off.' : 'At night only while the computer rests and charges.'}</span>
        </div>
        {ns.notice && <p className="fine-print" role="status">{ns.notice}</p>}
      </section>
      <section className="helper-block" aria-label="Its tools">
        <h3>Its tools</h3>
        <div className="helper-tiles" role="listbox" aria-label="Its tools">
          {TOOLS.map(t => { const x = toolState(t.id, st, last); return <button key={t.id} type="button" role="option" aria-selected={tool === t.id} className="helper-tile" data-on={x.on || undefined} title={t.name} onClick={() => setTool(t.id)}>
            <span className="helper-tile-top"><span className="helper-tile-icon"><UiIcon name={t.icon} size={20}/></span><i className="helper-tile-dot" aria-hidden="true"/></span>
            <b>{t.name}</b><span className="fine-print">{x.sub}</span></button>; })}
        </div>
        {onOpenStore && <button type="button" className="helper-add" onClick={onOpenStore}><UiIcon name="plus" size={13}/>Add a tool</button>}
      </section>
    </div>
    <ToolDetails tool={tool} st={st} c={c} last={last} projectName={projectName} onOpenSettings={onOpenSettings} onRetry={() => void c.retry()}/>
  </div>;
}

/** Settings › Memory › Memory helper: RAM limit, right now, night hours (Night work), night writer. */
export function MemoryHelperSettingsPane({ client, night: given }: { client: Requester; night?: NightWorkController }) {
  const [st, c] = useMemoryHelper(client, true);
  const own = useMemo(() => given ? null : new NightWorkController(client as never), [client, given]);
  useEffect(() => () => own?.dispose(), [own]);
  const night = given ?? own!;
  const [custom, setCustom] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const ram = st.ram, set = st.settings;
  useEffect(() => { if (set?.ram.customGb) setCustom(set.ram.customGb); }, [set?.ram.customGb]);
  if (st.phase === 'off') return <><p className="fine-print">The memory helper is turned off on this installation.</p><NightWorkSettings c={night}/></>;
  if (!ram || !set) return <p className="fine-print">Loading…</p>;
  const totalGb = Math.max(1, Math.floor(ram.totalBytes / GIB));
  const save = async (patch: Parameters<typeof c.saveSettings>[0]) => setNote(await c.saveSettings(patch));
  const pick = (m: HelperRam['mode']) => void save(m === 'custom' ? { ram: { mode: 'custom', customGb: custom ?? Math.max(1, Math.floor(totalGb / 4)) } } : { ram: { mode: m } });
  const choice = (m: HelperRam['mode'], title: string, sub: string) => <label className="helper-choice" data-on={set.ram.mode === m || undefined}>
    <input type="radio" name="helper-ram" checked={set.ram.mode === m} disabled={st.busy} onChange={() => pick(m)}/><span><b>{title}</b><span className="fine-print">{sub}</span></span></label>;
  const fit: readonly WorkerCandidate[] = st.candidates;
  return <div className="mem-settings-body helper-settings">
    <div className="settings-row helper-settings-row"><span><b>RAM limit</b><span className="fine-print">Girru never loads a model bigger than this RAM limit, frees the RAM when the work is done, and waits when this computer has less than {gb(ram.lowFreeBytes)} of RAM free.</span></span>
      <div className="helper-choices" role="radiogroup" aria-label="RAM limit">
        {choice('auto', 'Automatic', `Up to ${gb(Math.floor(ram.totalBytes / 4))} of RAM, a quarter of this computer’s ${gb(ram.totalBytes)} RAM`)}
        {choice('light', 'Light', 'About 1 GB of RAM: search only, the night writer stays off')}
        {choice('custom', 'Custom', 'You choose the most RAM it may use')}
        {set.ram.mode === 'custom' && <label className="helper-custom"><input type="range" min={1} max={totalGb} step={1} value={custom ?? set.ram.customGb ?? 1} disabled={st.busy} aria-label="Most RAM it may use, in GB"
          onChange={e => setCustom(Number(e.target.value))} onPointerUp={() => { if (custom && custom !== set.ram.customGb) void save({ ram: { mode: 'custom', customGb: custom } }); }}
          onKeyUp={() => { if (custom && custom !== set.ram.customGb) void save({ ram: { mode: 'custom', customGb: custom } }); }}/><b>{custom ?? set.ram.customGb} GB</b></label>}
      </div></div>
    <div className="settings-row helper-settings-row"><span><b>Right now</b></span><div><RamLine ram={ram}/>{ram.availableBytes !== null && <p className="fine-print">Free RAM now: <b>{gb(ram.availableBytes)}</b></p>}</div></div>
    <div className="settings-row helper-settings-row"><span><b>Night writer</b><span className="fine-print">A small local model for the night work. Only models already on this computer that fit in the RAM limit can be picked.</span></span>
      <label><select value={set.ram.mode === 'light' ? '' : set.worker ?? ''} disabled={st.busy || set.ram.mode === 'light'} aria-label="Night writer" onChange={e => void save({ worker: e.target.value || null })}>
        <option value="">Off</option>
        {fit.map(x => <option key={x.model} value={x.model} disabled={!x.fits}>{x.model} · about {gb(x.ramBytes)} RAM{x.fits ? '' : ' · does not fit'}</option>)}
      </select></label></div>
    {note && <p className="fine-print" role="status">{note}</p>}
    <NightWorkSettings c={night}/>
  </div>;
}

/** Memory › a project › Files: one quiet line on top, only when last night read or wrote something for it. */
export function ReadLastNightLine({ night, slug, onOpenHelper }: { night: NightWorkController; slug: string; onOpenHelper?: () => void }) {
  const ns = useSyncExternalStore(night.subscribe, night.getSnapshot, night.getSnapshot);
  useEffect(() => { if (!ns.settings) void night.load(); }, [night]);
  const p = ns.last?.byProject?.[slug];
  if (!p || (!p.files && !p.summary)) return null;
  return <p className="helper-lastnight" role="note"><UiIcon name="moon" size={14}/>
    <span>Read last night: <b>{p.files} {p.files === 1 ? 'file' : 'files'}</b>{p.summary ? <> · <b>1 summary</b></> : null}</span>
    {onOpenHelper && <button type="button" className="link-button" onClick={onOpenHelper}><UiIcon name="brain" size={12}/>Memory helper</button>}</p>;
}
