// MEM-READ-01 MR2: hidden keys in memory.
// A key Girru hid is `[SECRET:<type>:<id>]` in the text (kept encrypted in the key store);
// an older one it could only remove is `[REDACTED:<type>]`. Both show as one lock chip.
// Show (owner only) reveals one value in place; the Needs you row tells the owner once.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { UiIcon } from './ui-icons';
import { WithSwatches } from './desktop-ui';
import { drawerName } from './memory-store';

const KEY = /\[SECRET:([a-z_]+):([a-z0-9]{6,32})\]|\[REDACTED:([a-z_]+)\]/g;

/** The plain word for a kind of key. */
export function keyWord(type: string): 'login' | 'password' | 'key' | 'token' {
  if (type === 'url_credentials' || type === 'basic_auth') return 'login';
  if (type === 'password') return 'password';
  if (/token|jwt|bearer/.test(type)) return 'token';
  return 'key';
}

/** How many keys a text hides, by plain word: "1 login hidden", "2 keys hidden". */
export function hiddenSummary(text: string): string | null {
  const words = [...text.matchAll(KEY)].map(m => keyWord(m[1] ?? m[3]));
  if (!words.length) return null;
  const n = words.length, w = words.every(x => x === words[0]) ? words[0] : 'key';
  return `${n} ${w}${n === 1 ? '' : 's'} hidden`;
}

/** Text with lock chips instead of key references; on a single line in rows. */
export function KeyText({ text, reveal }: { text: string; reveal?: (id: string) => Promise<string | null> }) {
  const parts: Array<string | { type: string; id: string | null }> = [];
  let last = 0;
  for (const m of text.matchAll(KEY)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push({ type: m[1] ?? m[3], id: m[2] ?? null });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((p, i) => typeof p === 'string' ? <WithSwatches key={i} text={p}/> : <KeyChip key={i} type={p.type} id={p.id} reveal={reveal}/>)}</>;
}

function KeyChip({ type, id, reveal }: { type: string; id: string | null; reveal?: (id: string) => Promise<string | null> }) {
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const word = keyWord(type);
  if (shown !== null) return <span className="dk-key-chip dk-key-shown"><UiIcon name="lock" size={11}/><code dir="ltr">{shown}</code>
    <button type="button" className="link-button" onClick={() => setShown(null)}>Hide</button></span>;
  return <span className="dk-key-chip" title={id ? `Hidden ${word}: kept encrypted; agents never get it` : `Removed ${word}: it was not kept`}>
    <UiIcon name="lock" size={11}/>Hidden: {word}
    {id && reveal && <button type="button" className="link-button" disabled={busy} onClick={e => { e.stopPropagation(); setBusy(true); void reveal(id).then(v => { setBusy(false); if (v !== null) setShown(v); }); }}>Show</button>}
  </span>;
}

// ---------------------------------------------------------------- the Needs you row
type Requester = { request(r: { method: string; path: string; body?: unknown }): Promise<{ status: number; body: unknown }> };
export interface HiddenKeysDrawer { drawer: string; count: number; memories: number; kinds: Record<string, number> }
type State = { drawers: HiddenKeysDrawer[]; busy: boolean; done: string | null };

/** Reads and answers the hidden-keys report (owner only). */
export class HiddenKeysController {
  private state: State = { drawers: [], busy: false, done: null };
  private listeners = new Set<() => void>();
  constructor(private readonly client: Requester) {}
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.state;
  private publish(p: Partial<State>) { this.state = { ...this.state, ...p }; for (const l of this.listeners) l(); }
  async load() {
    try {
      const r = await this.client.request({ method: 'GET', path: '/api/memory/scopes/hidden-keys' });
      if (r.status === 200) this.publish({ drawers: (r.body as { drawers: HiddenKeysDrawer[] }).drawers ?? [] });
    } catch { /* the row just stays away */ }
  }
  async answer(drawer: string, answer: 'keep' | 'move'): Promise<boolean> {
    this.publish({ busy: true });
    try {
      const r = await this.client.request({ method: 'POST', path: '/api/memory/scopes/hidden-keys/answer', body: { answer, drawer } });
      if (r.status !== 200) { this.publish({ busy: false }); return false; }
      const moved = (r.body as { moved: number }).moved;
      this.publish({ busy: false, drawers: this.state.drawers.filter(d => d.drawer !== drawer), done: answer === 'move' ? `Moved ${moved} to Connections › Saved keys. Agents may use them only with your approval.` : 'Kept hidden here.' });
      return true;
    } catch { this.publish({ busy: false }); return false; }
  }
  async reveal(id: string): Promise<string | null> {
    try {
      const r = await this.client.request({ method: 'POST', path: `/api/memory/scopes/hidden-keys/${encodeURIComponent(id)}/reveal` });
      return r.status === 200 ? String((r.body as { value: unknown }).value ?? '') : null;
    } catch { return null; }
  }
}

const KIND_ORDER = ['login', 'password', 'key', 'token'] as const;
/** "an SSH login, a Stripe key" is not knowable from counts; say it plainly: "1 login, 2 keys". */
export function kindsLine(kinds: Record<string, number>): string {
  return KIND_ORDER.filter(k => kinds[k]).map(k => `${kinds[k]} ${k}${kinds[k] === 1 ? '' : 's'}`).join(', ');
}

export function HiddenKeysQuestion({ c, onConnections, nameOf }: { c: HiddenKeysController; onConnections?: () => void; /** A project's name (its key may be an id). */ nameOf?: (drawer: string) => string | undefined }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  useEffect(() => { void c.load(); }, [c]);
  if (!s.drawers.length) return s.done ? <p className="dk-inline-ok" role="status">{s.done}</p> : null;
  const q = s.drawers[0];
  const where = q.drawer === 'memory' ? 'your memories' : nameOf?.(q.drawer) ?? (q.drawer.startsWith('project:') ? drawerName(q.drawer).replace(/^Projects? · /, '') : drawerName(q.drawer));
  return <article className="dk-question" aria-label="Hidden keys">
    <h3><UiIcon name="lock" size={15}/>{q.count} {q.count === 1 ? 'key or login was' : 'keys and logins were'} hidden in {where}</h3>
    <p>Found in {q.memories || q.count} {(q.memories || q.count) === 1 ? 'memory' : 'memories'}: {kindsLine(q.kinds)}. They are no longer shown or given to agents. Move them to Connections so agents can use them only with your approval.</p>
    <div className="actions">
      <button type="button" disabled={s.busy} onClick={() => void c.answer(q.drawer, 'keep')}>Keep hidden here</button>
      <button type="button" className="primary" disabled={s.busy} onClick={() => void c.answer(q.drawer, 'move').then(ok => { if (ok) onConnections?.(); })}>Move to Connections…</button>
    </div>
  </article>;
}
