// MODELS-01-INSTALL (boards M1–M6, approved 2026-11-03): the memory helper
// installs itself in the background. No step and no choice: during setup one
// quiet pill in the bottom bar of every step (M1–M2), after setup a footer
// pill next to Settings until it is ready (M3), and a "Memory helper" row in
// Settings › Memory › Health in every state (M4–M6). If it fails, memory keeps
// basic recall and says so calmly; "needs you" only after repeated failures or
// when the local runtime is missing. Main screens never name the model or the
// runtime; only the Health details do (for support).
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Store } from './memory-store';
import type { Requester } from './memory-store';
import { MEMORY_HELPER_PATH, MEMORY_HELPER_RETRY_PATH } from './memory-helper-contract.js';
import type { HelperReply, HelperStatus } from './memory-helper-contract.js';
import { Popover } from './desktop-ui';
import { UiIcon } from './ui-icons';

export type HelperState = Readonly<{
  /** `off`: the switch is off or this person may not see it (404/403); nothing shows. */
  phase: 'loading' | 'ready' | 'off' | 'error';
  status: HelperStatus | null; needsYou: boolean;
  /** Bytes per second, smoothed (for "about N minutes"). */
  rate: number | null; busy: boolean;
}>;

/** Sent after a try now, so every place showing the helper reads it again. */
const HELPER_CHANGED = 'girru:memory-helper';
const ACTIVE = new Set(['waiting', 'checking', 'starting_runtime', 'downloading', 'verifying', 'reembedding']);

export class MemoryHelperController extends Store<HelperState> {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #last: { at: number; bytes: number } | null = null;
  constructor(client: Requester, private readonly watchWhenReady = false) {
    super({ phase: 'loading', status: null, needsYou: false, rate: null, busy: false }, client);
  }
  async load(): Promise<void> {
    let r;
    try { r = await this.req('GET', MEMORY_HELPER_PATH); } catch { r = null; }
    if (this.disposed) return;
    if (!r || (r.status !== 200 && r.status !== 404 && r.status !== 403)) { this.publish({ phase: this.getSnapshot().status ? 'ready' : 'error' }); this.#next(10_000); return; }
    if (r.status !== 200) { this.publish({ phase: 'off', status: null }); return; }
    const { status, row } = r.body as HelperReply;
    this.publish({ phase: 'ready', status, needsYou: row.state === 'needs_you', rate: this.#rate(status) });
    this.#next(ACTIVE.has(status.phase) ? 1_500 : status.phase === 'fallback' ? 30_000 : this.watchWhenReady ? 60_000 : null);
  }
  /** "Try now" / "Try again": the job goes on where it stopped. */
  async retry(): Promise<void> {
    this.publish({ busy: true });
    try { await this.req('POST', MEMORY_HELPER_RETRY_PATH); } catch { /* the next read shows the state */ }
    this.publish({ busy: false });
    // The other places (footer pill, Health row) read again too, so they never disagree for long.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(HELPER_CHANGED));
    await this.load();
  }
  override dispose() { clearTimeout(this.#timer); super.dispose(); }
  #next(ms: number | null) { clearTimeout(this.#timer); if (ms !== null && !this.disposed) this.#timer = setTimeout(() => void this.load(), ms); }
  #rate(s: HelperStatus): number | null {
    const now = Date.now(), prev = this.#last, old = this.getSnapshot().rate;
    if (s.phase !== 'downloading') { this.#last = null; return null; }
    this.#last = { at: now, bytes: s.completedBytes };
    if (!prev || s.completedBytes <= prev.bytes || now <= prev.at) return old;
    const fresh = (s.completedBytes - prev.bytes) / ((now - prev.at) / 1000);
    return old ? old * 0.7 + fresh * 0.3 : fresh;
  }
}

/** One controller per place; it reads now and keeps reading while the helper works. */
export function useMemoryHelper(client: Requester, watchWhenReady = false): [HelperState, MemoryHelperController] {
  const c = useMemo(() => new MemoryHelperController(client, watchWhenReady), [client, watchWhenReady]);
  useEffect(() => {
    void c.load();
    const back = () => { if (c.getSnapshot().phase !== 'off') void c.load(); };
    const again = () => { void c.load(); };
    window.addEventListener('focus', back); window.addEventListener(HELPER_CHANGED, again);
    return () => { window.removeEventListener('focus', back); window.removeEventListener(HELPER_CHANGED, again); c.dispose(); };
  }, [c]);
  return [useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot), c];
}

// ---- Words (one place, so every surface says the same) -----------------------------

const mb = (b: number) => Math.round(b / (1024 * 1024));
/** "about 3 minutes", or null while the speed is not known yet. */
export function timeLeft(s: HelperStatus, rate: number | null): string | null {
  if (s.phase !== 'downloading' || !rate || rate <= 0 || s.sizeBytes <= s.completedBytes) return null;
  const min = Math.max(1, Math.round((s.sizeBytes - s.completedBytes) / rate / 60));
  return min <= 1 ? 'about a minute' : min >= 90 ? `about ${Math.round(min / 60)} hours` : `about ${min} minutes`;
}
/** "in 5 minutes" / "at 16:30" for the next try by itself. */
export function nextTry(s: HelperStatus, now = Date.now()): string | null {
  const t = s.nextTryAt ? Date.parse(s.nextTryAt) : NaN;
  if (!Number.isFinite(t)) return null;
  const min = Math.round((t - now) / 60000);
  if (min <= 1) return 'in a minute';
  if (min < 60) return `in ${min} minutes`;
  return `at ${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
/** The owner chose basic recall, or the runtime is not on this computer: nothing will happen, so nothing shows on the main screens. */
export const chosenBasic = (s: HelperStatus) => s.phase === 'fallback' && (s.reason === 'hash_chosen' || s.reason === 'not_loopback');

/** The pill's words (setup bottom bar and footer). */
export function pillWords(s: HelperStatus): string {
  switch (s.phase) {
    case 'ready': return 'Memory helper ready';
    case 'downloading': return s.sizeBytes ? `Memory helper · ${s.percent ?? 0}% of ${mb(s.sizeBytes)} MB` : 'Memory helper · downloading';
    case 'reembedding': return 'Memory helper · updating memories';
    case 'fallback': return 'Memory helper · basic recall for now';
    default: return 'Memory helper · getting ready';
  }
}

/** The Health row (M4–M6): the line under the name and the word on the right. */
export function rowWords(s: HelperStatus, needsYou: boolean): { line: string; word: string; tone: 'ok' | 'attention' | 'problem' } {
  const tried = s.attempts > 1 ? ` · tried ${s.attempts} times` : '';
  if (needsYou) return { line: s.reason === 'runtime_missing' ? 'Basic recall for now · the local runtime is not on this computer' : `Basic recall for now${tried}`, word: 'Needs you', tone: 'problem' };
  switch (s.phase) {
    case 'ready': return { line: 'Understands meaning in every language · on this computer', word: s.remaining > 0 ? `Ready, ${s.remaining} to update` : 'Ready', tone: 'ok' };
    case 'downloading': return { line: s.sizeBytes ? `Downloading · ${mb(s.completedBytes)} of ${mb(s.sizeBytes)} MB` : 'Downloading', word: `Downloading ${s.percent ?? 0}%`, tone: 'ok' };
    case 'reembedding': return { line: 'Memories saved with basic recall are updated in the background', word: 'Updating memories', tone: 'ok' };
    case 'fallback':
      if (s.reason === 'hash_chosen') return { line: 'Memory finds by words only (your choice)', word: 'Basic recall (chosen)', tone: 'ok' };
      if (s.reason === 'not_loopback') return { line: 'The local runtime is set to another computer', word: 'Basic recall', tone: 'ok' };
      return { line: `Basic recall for now${tried}`, word: 'Basic recall for now', tone: 'attention' };
    default: return { line: 'Checking this computer', word: 'Getting ready', tone: 'ok' };
  }
}

// ---- The pill and its popover (M1–M3) --------------------------------------------------

function Progress({ s }: { s: HelperStatus }) {
  return <progress className="helper-progress" aria-label="Memory helper download" max={Math.max(1, s.sizeBytes)} value={Math.min(s.completedBytes, s.sizeBytes)}/>;
}

/** The popover the pill opens (M1): what it is, how far, and after a failure what happens next. */
export function HelperDetails({ st, onRetry }: { st: HelperState; onRetry: () => void }) {
  const s = st.status; if (!s) return null;
  const size = s.sizeBytes ? `${mb(s.sizeBytes)} MB` : 'about 640 MB';
  const failed = s.phase === 'fallback' && !chosenBasic(s);
  const when = nextTry(s);
  return <div className="helper-details">
    <h4><UiIcon name="brain" size={14}/>Memory helper</h4>
    {s.phase === 'ready'
      ? <p>Ready. Memory understands what you mean, in every language, on this computer only.</p>
      : <p>Girru {failed ? 'gets' : 'is downloading'} the part that helps it understand what you mean, in every language ({size}, once). It runs on this computer only. Memory already works; it gets better when this is done.</p>}
    {s.phase === 'downloading' && <><Progress s={s}/><p className="fine-print" role="status">{mb(s.completedBytes)} of {mb(s.sizeBytes)} MB{timeLeft(s, st.rate) ? ` · ${timeLeft(s, st.rate)}` : ''}</p></>}
    {s.phase === 'reembedding' && <p className="fine-print" role="status">Updating the memories saved so far…</p>}
    {failed && <div className="helper-paused" role="status">
      <b>{s.reason === 'runtime_missing' ? 'Waiting for the local runtime' : 'Download paused'}</b>
      <p>{s.reason === 'runtime_missing'
        ? 'The local runtime is not on this computer yet. Memory works meanwhile with basic recall.'
        : `${s.error === 'network' || s.error === 'stalled' ? 'No connection right now. ' : ''}Girru tries again by itself${when ? ` ${when}` : ''} and goes on where it stopped. Memory works meanwhile with basic recall.`}</p>
      <button type="button" disabled={st.busy} onClick={onRetry}>Try now</button>
    </div>}
  </div>;
}

function Pill({ st, c, place }: { st: HelperState; c: MemoryHelperController; place: 'setup' | 'footer' }) {
  const [open, setOpen] = useState(false);
  const s = st.status!;
  const ready = s.phase === 'ready';
  const words = pillWords(s);
  return <span className="helper-anchor" data-place={place}>
    <button type="button" data-popover-anchor className={place === 'footer' ? 'status-item helper-pill' : 'helper-pill'} data-state={ready ? 'ready' : st.needsYou ? 'needs-you' : s.phase === 'fallback' ? 'paused' : 'working'}
      aria-expanded={open} aria-haspopup="dialog" title={st.needsYou ? `${words} · needs you` : words} aria-label={st.needsYou ? `${words}, needs you` : words} onClick={() => setOpen(v => !v)}>
      {ready ? <UiIcon name="check" size={12}/> : <span className="helper-dot" aria-hidden="true"/>}
      <span>{words}</span>
    </button>
    <Popover open={open} onClose={() => setOpen(false)} label="Memory helper"><HelperDetails st={st} onRetry={() => void c.retry()}/></Popover>
  </span>;
}

/** The current step's bottom bar (its .setup-actions); every step has one, the newest one wins. */
function useSetupBar(): Element | null {
  const [bar, setBar] = useState<Element | null>(null);
  useEffect(() => {
    const root = document.querySelector('.first-run-setup');
    if (!root) return;
    const find = () => { const all = root.querySelectorAll('.setup-actions'); setBar(all.length ? all[all.length - 1] : null); };
    find();
    const mo = new MutationObserver(find);
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  return bar;
}

/** M1–M2: the pill in the bottom bar of every setup step; setup never waits for it. */
export function SetupHelperPill({ client }: { client: Requester }) {
  const [st, c] = useMemoryHelper(client, false);
  const bar = useSetupBar();
  if (st.phase !== 'ready' || !st.status || chosenBasic(st.status)) return null;
  const pill = <Pill st={st} c={c} place="setup"/>;
  return bar ? createPortal(pill, bar) : <div className="setup-helper-bar">{pill}</div>;
}

/** M3: after setup, the footer pill next to Settings; gone once the helper is ready. */
export function FooterHelperPill({ client }: { client: Requester }) {
  const [st, c] = useMemoryHelper(client, false);
  if (st.phase !== 'ready' || !st.status || st.status.phase === 'ready' || chosenBasic(st.status)) return null;
  return <Pill st={st} c={c} place="footer"/>;
}

// ---- Settings › Memory › Health (M4–M6) -----------------------------------------------------

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/** The "Memory helper" row, in every state; the details open under it (the pane's inspector). */
export function MemoryHelperRow({ client }: { client: Requester }) {
  const [st, c] = useMemoryHelper(client, true);
  const [open, setOpen] = useState(false);
  const s = st.status;
  if (st.phase === 'off' || st.phase === 'loading' && !s) return null;
  if (!s) return <section className="mem-card helper-health" aria-label="Memory helper"><p className="fine-print">Could not read the memory helper. <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p></section>;
  const w = rowWords(s, st.needsYou);
  const failed = s.phase === 'fallback' && !chosenBasic(s);
  const size = s.sizeBytes ? `${mb(s.sizeBytes)} MB` : '';
  const line = (k: string, v: string) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>;
  return <section className="mem-card helper-health" aria-label="Memory helper">
    <button type="button" className="mem-check helper-row" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <span className="mem-dot" data-health={w.tone}/>
      <span className="mem-check-label">Memory helper<small className="fine-print">{w.line}</small></span>
      <span className="helper-word" data-tone={w.tone}>{w.word}<UiIcon name={open ? 'chevron-down' : 'chevron'} size={12}/></span>
    </button>
    {open && <div className="helper-inspector" aria-label={`Memory helper · ${w.word}`}>
      <dl>
        {s.phase === 'ready' && [
          line('What it is', 'The search model that finds memories by meaning, in any language'),
          line('Model', `${s.model}${size ? ` · ${size}` : ''}`),
          line('Runs', 'on this computer only (127.0.0.1), works offline'),
          line('Ready since', day(s.readyAt)),
          line('Memories', s.remaining > 0 ? `${s.remaining} wait to be updated` : 'all updated to it'),
          line('Memory worker', s.worker ? `${s.worker.model} · ${s.worker.phase}` : 'later (not yet chosen)'),
        ]}
        {s.phase === 'downloading' && [
          line('Downloaded', `${mb(s.completedBytes)} of ${mb(s.sizeBytes)} MB`),
          line('Time left', timeLeft(s, st.rate) ?? 'working it out'),
          line('Meanwhile', 'basic recall'),
        ]}
        {failed && [
          line('What happened', s.reason === 'runtime_missing' ? 'The local runtime is not on this computer' : `The download stopped ${s.attempts === 1 ? 'once' : `${s.attempts} times`}${s.error === 'network' || s.error === 'stalled' ? ' (no connection)' : s.error === 'disk_full' ? ' (the disk is full)' : ''}`),
          ...(s.completedBytes ? [line('Downloaded', `${mb(s.completedBytes)} of ${mb(s.sizeBytes)} MB, kept`)] : []),
          line('Next try', nextTry(s) ? `by itself ${nextTry(s)}` : 'at the next start'),
          line('Meanwhile', 'memory saves and finds by words (basic recall)'),
          ...(s.remaining ? [line('Memories', `${s.remaining} wait to be updated`)] : []),
          line('Model', `${s.model}${size ? ` · ${size}` : ''}`),
        ]}
        {!failed && !['ready', 'downloading'].includes(s.phase) && [line('Now', w.line), line('Model', `${s.model}${size ? ` · ${size}` : ''}`)]}
      </dl>
      {s.phase === 'ready' && <p className="fine-print">Nothing to do. Girru checks it at every start and downloads it again by itself if it goes missing.</p>}
      {s.phase === 'downloading' && <p className="fine-print">Nothing to do; Girru tells you nothing more unless it keeps failing.</p>}
      {failed && <><p className="fine-print">Try again goes on where it stopped. If your network blocks downloads, Girru keeps working with basic recall.</p>
        <div className="actions"><button type="button" className="primary" disabled={st.busy} onClick={() => void c.retry()}>Try again</button></div></>}
    </div>}
  </section>;
}
