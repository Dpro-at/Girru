// STORE-MAP-01 P9b (boards P9b-1 to P9b-3): "How sure" in the memory inspector
// (three bars and one chip, no numbers), the quiet list chips (only Verified
// and Not checked), and two views of Memory › Needs you: Corrected after use
// (main action Mark as checked, Undo ⌘Z) and Open questions (Save the answer,
// Forget the question without a confirmation, Undo).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { UiIcon } from './ui-icons';
import { Avatar, IconButton } from './desktop-ui';
import { ago, drawerName } from './memory-store';
import { LEVEL } from './memory-trust';
import type { MemoryTrustController, NeedsView } from './memory-trust';
import type { CorrectedItem, OpenQuestion, TrustView } from './memory-trust-contract.js';

type Names = Readonly<Record<string, string>>;
const useTrust = (c: MemoryTrustController) => useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent ?? '');
export const VERIFY_SHORTCUT = isMac ? '⌘⇧V' : 'Ctrl+Shift+V';
const agentName = (names: Names, id: string | null | undefined) => (id ? names[id] ?? 'An agent' : 'An agent');

/** Three bars: how sure, drawn (never a number). */
export function SureBars({ level }: { level: TrustView['level'] }) {
  const n = LEVEL[level].bars;
  return <span className="dk-sure" data-level={level} role="img" aria-label={`How sure: ${LEVEL[level].band.toLowerCase()}`}>{[1, 2, 3].map(i => <span key={i} data-on={i <= n || undefined}/>)}</span>;
}
/** The one chip a level may have (Verified, Not checked); "heard once" has none. */
export function TrustChip({ t }: { t: TrustView | undefined }) {
  if (!t || !LEVEL[t.level].chip) return null;
  return <span className="dk-chip dk-sure-chip" data-level={t.level}><UiIcon name={t.level === 'verified' ? 'check' : 'alert'} size={11}/>{LEVEL[t.level].chip}</span>;
}

/** The inspector rows "How sure", "Why" and "Heard from" (board P9b-1). */
export function HowSureRows({ t, names }: { t: TrustView | undefined; names: Names }) {
  if (!t) return <><dt>How sure</dt><dd>…</dd></>;
  const who = t.heardFrom.map(h => (h.kind === 'you' ? 'you' : h.kind === 'agent' ? agentName(names, h.agentId) : h.kind === 'chat' ? 'a chat' : h.kind === 'tool' ? 'a coding app' : h.kind === 'channel' ? 'a channel' : h.kind === 'import' ? 'an import' : 'Girru'));
  return <>
    <dt>How sure</dt><dd className="dk-sure-row"><SureBars level={t.level}/>{LEVEL[t.level].band}<TrustChip t={t}/></dd>
    <dt>Why</dt><dd>{t.byOwner ? 'You marked it as verified' : LEVEL[t.level].word}</dd>
    {who.length > 0 && <><dt>Heard from</dt><dd><span className="dk-avatars">{who.slice(0, 4).map((w, i) => <Avatar key={`${w}-${i}`} name={w === 'you' ? 'You' : w}/>)}</span>{who.join(', ')}</dd></>}
  </>;
}

/** Needs you's three views (a segmented control of 3; board P9b-2). */
export function NeedsViews({ c, waiting }: { c: MemoryTrustController; waiting: number }) {
  const s = useTrust(c);
  const opts: Array<[NeedsView, string, number]> = [['decide', 'To decide', waiting], ['corrected', 'Corrected after use', s.waiting.corrected], ['questions', 'Open questions', s.waiting.questions]];
  return <div className="dk-segmented" role="group" aria-label="Needs you views">
    {opts.map(([v, label, n]) => <button key={v} type="button" aria-pressed={s.view === v} onClick={() => c.setView(v)}>{label}{n > 0 && <span className="dk-count">{n}</span>}</button>)}
  </div>;
}

// ---------------------------------------------------------------- corrected after use

function correctedLine(i: CorrectedItem, names: Names) {
  const who = agentName(names, i.replies[0]?.agentId);
  const n = i.replyCount;
  const when = i.changedAt && i.replies[0]?.at ? Math.max(0, Math.round((new Date(i.changedAt).getTime() - new Date(i.replies[0].at).getTime()) / 86_400_000)) : null;
  const replies = `${n} ${n === 1 ? 'reply' : 'replies'}`;
  if (i.how === 'replaced') return `A newer fact replaced it after ${who} used it in ${replies}`;
  return when ? `You changed it ${when} ${when === 1 ? 'day' : 'days'} after ${who} used it in ${replies}` : `You changed it after ${who} used it in ${replies}`;
}

export function CorrectedView({ c, names }: { c: MemoryTrustController; names: Names }) {
  const s = useTrust(c);
  useEffect(() => { if (s.corrected === null) void c.loadCorrected(); }, [c, s.corrected]);
  if (s.corrected === null) return <p className="dk-empty" role="status">Reading what you corrected…</p>;
  if (!s.corrected.length) return <div className="dk-empty"><UiIcon name="check" size={20}/><p>Nothing to check. When you change a fact an agent already used, it shows here with the replies that used the old one.</p></div>;
  const list = s.corrected;
  const keys = (e: React.KeyboardEvent) => {
    const at = list.findIndex(i => i.memoryId === s.selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const next = list[Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]; if (next) c.select(next.memoryId); }
    else if (e.key === 'Enter' && s.selected && !s.busy) { const i = list[at]; if (i && !i.checked) { e.preventDefault(); void c.check(i.memoryId); } }
  };
  return <div className="dk-list" role="listbox" aria-label="Corrected after use" tabIndex={0} onKeyDown={keys}>
    {s.notice && <p className="dk-inline-notice" role="alert">{s.notice}</p>}
    {list.map(i => <div key={i.memoryId} className="dk-row" role="option" aria-selected={s.selected === i.memoryId} data-done={i.checked || undefined} onClick={() => c.select(i.memoryId)}>
      <span className="dk-row-icon"><Avatar name={agentName(names, i.replies[0]?.agentId)}/></span>
      <span className="dk-row-text"><span className="dk-row-main" dir="auto">“{i.was}” <UiIcon name="arrow-right" size={11}/> {i.now}</span><span className="dk-row-sub">{correctedLine(i, names)}</span></span>
      {i.checked ? <span className="dk-chip dk-state" data-tone="ok"><UiIcon name="check" size={11}/>Checked</span> : <span className="dk-chip dk-state" data-tone="warn">Check {i.replyCount} {i.replyCount === 1 ? 'reply' : 'replies'}</span>}
    </div>)}
  </div>;
}

export function CorrectedInspector({ c, names, onOpenChat }: { c: MemoryTrustController; names: Names; onOpenChat?: (id: string) => void }) {
  const s = useTrust(c);
  const i = s.corrected?.find(x => x.memoryId === s.selected);
  if (!i) return null;
  const users = [...new Set(i.replies.map(r => r.agentId ?? ''))];
  const first = i.replies.find(r => r.sessionId);
  return <div className="dk-insp">
    <div className="dk-insp-head"><UiIcon name="history" size={18}/><div><h3 dir="auto">{i.now}</h3><p className="fine-print">{drawerName(i.drawer)}</p></div></div>
    <dl className="dk-facts">
      <dt>Was</dt><dd dir="auto" className="dk-was">“{i.was}”</dd>
      <dt>Now</dt><dd dir="auto">“{i.now}” · {i.how === 'replaced' ? 'a newer fact' : 'you'}{i.changedAt ? `, ${ago(i.changedAt)}` : ''}</dd>
      <dt>Used before</dt><dd><span className="dk-avatars">{users.slice(0, 4).map(u => <Avatar key={u} name={agentName(names, u)}/>)}</span>{users.map(u => agentName(names, u)).join(', ')}, {i.replyCount} {i.replyCount === 1 ? 'reply' : 'replies'}</dd>
    </dl>
    <section className="dk-who"><h4>Replies that used the old fact</h4>
      <ul>{i.replies.map(r => <li key={r.runId}>
        <UiIcon name={r.sessionId ? 'message' : 'clock'} size={13}/>
        {r.sessionId && onOpenChat ? <button type="button" className="link-button" onClick={() => onOpenChat(r.sessionId!)}>{r.title ? `Chat “${r.title}”` : 'A chat'}</button> : <span>{r.sessionId ? (r.title ? `Chat “${r.title}”` : 'A chat') : 'A run'}</span>}
        <span className="fine-print">{new Date(r.at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
      </li>)}</ul>
      {i.replyCount > i.replies.length && <p className="fine-print">and {i.replyCount - i.replies.length} more</p>}
      <p className="fine-print">Open a reply to see what was said. Nothing is changed by itself: Girru only shows where the old fact went.</p>
    </section>
    <div className="actions">
      {first && onOpenChat && <button type="button" onClick={() => onOpenChat(first.sessionId!)}>Open the first reply</button>}
      {i.checked ? <button type="button" disabled={s.busy} onClick={() => void c.check(i.memoryId, false)}>Not checked yet</button>
        : <button type="button" className="primary" disabled={s.busy} onClick={() => void c.check(i.memoryId)}>Mark as checked</button>}
    </div>
  </div>;
}

// ---------------------------------------------------------------- open questions

const daysLeft = (q: OpenQuestion) => Math.max(0, Math.ceil((new Date(q.endsAt).getTime() - Date.now()) / 86_400_000));
function questionState(q: OpenQuestion): { tone: 'warn' | 'ok' | 'muted'; text: string } {
  if (q.status === 'resolved') return { tone: 'ok', text: 'Answered' };
  if (q.status === 'expired') return { tone: 'muted', text: 'Ended' };
  const left = daysLeft(q);
  return left <= 2 ? { tone: 'warn', text: `Ends in ${left} ${left === 1 ? 'day' : 'days'}` } : { tone: 'warn', text: 'Waiting' };
}

export function QuestionsView({ c, names }: { c: MemoryTrustController; names: Names }) {
  const s = useTrust(c);
  useEffect(() => { if (s.questions === null) void c.loadQuestions(); }, [c, s.questions]);
  if (s.questions === null) return <p className="dk-empty" role="status">Reading the questions…</p>;
  if (!s.questions.length) return <div className="dk-empty"><UiIcon name="check" size={20}/><p>No open questions. When an agent finds nothing reliable in memory, it asks you once and the question waits here.</p></div>;
  const list = s.questions;
  const keys = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('textarea, input')) return;
    const at = list.findIndex(q => q.id === s.selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const next = list[Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]; if (next) c.select(next.id); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selected && !s.busy) { e.preventDefault(); void c.forget(s.selected); }
  };
  return <div className="dk-list" role="listbox" aria-label="Open questions" tabIndex={0} onKeyDown={keys}>
    {s.notice && <p className="dk-inline-notice" role="alert">{s.notice}</p>}
    {list.map(q => { const st = questionState(q); const who = agentName(names, q.agentId); return <div key={q.id} className="dk-row" role="option" aria-selected={s.selected === q.id} data-done={q.status !== 'open' || undefined} onClick={() => c.select(q.id)}>
      <span className="dk-row-icon"><UiIcon name="message" size={14}/></span>
      <span className="dk-row-text"><span className="dk-row-main" dir="auto">{q.question}</span>
        <span className="dk-row-sub">{who} asked {q.status === 'open' && daysLeft(q) > 2 ? 'once' : ago(q.askedAt)} · {q.status === 'resolved' ? 'you answered' : q.status === 'expired' ? 'nobody answered' : 'waiting for you'}</span></span>
      <span className="dk-chip dk-state" data-tone={st.tone === "muted" ? "mute" : st.tone}>{st.text}</span>
    </div>; })}
  </div>;
}

export function QuestionInspector({ c, names, drawers }: { c: MemoryTrustController; names: Names; drawers: ReadonlyArray<{ id: string; name: string }> }) {
  const s = useTrust(c);
  const q = s.questions?.find(x => x.id === s.selected);
  const [text, setText] = useState('');
  const [drawer, setDrawer] = useState('owner');
  useEffect(() => { setText(''); }, [q?.id]);
  if (!q) return null;
  const who = agentName(names, q.agentId);
  const open = q.status === 'open';
  const save = () => { if (text.trim() && !s.busy) void c.answer(q.id, text.trim(), drawer === 'owner' ? undefined : drawer); };
  return <div className="dk-insp">
    <div className="dk-insp-head"><UiIcon name="message" size={18}/><div><h3 dir="auto">{q.question}</h3></div></div>
    <dl className="dk-facts">
      <dt>Asked by</dt><dd><Avatar name={who}/>{who} · once, {ago(q.askedAt)}</dd>
      <dt>Why</dt><dd>Nothing reliable is stored about it</dd>
      {open ? <><dt>Ends</dt><dd>in {daysLeft(q)} {daysLeft(q) === 1 ? 'day' : 'days'} if nobody answers</dd></> : <><dt>State</dt><dd>{q.status === 'resolved' ? 'Answered' : 'Ended without an answer'}</dd></>}
    </dl>
    {open && <form className="dk-edit" onSubmit={e => { e.preventDefault(); save(); }}>
      <label className="dk-field">Your answer<textarea dir="auto" rows={3} maxLength={2000} value={text} onChange={e => setText(e.target.value)} placeholder="Write it as you would tell the agent"
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }}/></label>
      <label className="dk-field-inline">Keep in<select value={drawer} onChange={e => setDrawer(e.target.value)}>{drawers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <p className="fine-print">Your answer is saved as a memory you said (High, verified), and {who} gets it the next time it asks. Agents ask the same thing only once.</p>
      {s.notice && <p className="dk-inline-notice" role="alert">{s.notice}</p>}
      <div className="actions"><button type="button" disabled={s.busy} onClick={() => void c.forget(q.id)}>Forget the question</button><button type="submit" className="primary" disabled={s.busy || !text.trim()}>Save the answer</button></div>
    </form>}
    {!open && <div className="actions"><IconButton icon="trash" label="Forget the question" shortcut="⌫" onClick={() => void c.forget(q.id)}/></div>}
  </div>;
}
