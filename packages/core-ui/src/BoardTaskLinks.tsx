// STORE-MAP-01 P8 (board P8a): the parts of the task page that make the task number
// T-n the link hub — the "Linked to T-n" group in the side (task notes, handoffs,
// chats, task file), the T-n list that opens from the crumb (⌘⇧L), and the "Latest
// handoff" card in the middle (newest first; older ones folded; blockers editable,
// files touched read only). Shown only while the backend's P8 switch is on.
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { UiIcon } from './ui-icons';
import type { UiIconName } from './ui-icons';
import { AppLogo, TaskWorkedOn, appOf } from './BoardTaskFile';
import type { TaskDetail, TaskMark } from './board';
import { ago } from './memory-store';
import { countLine, handedWords, handoffLine, linksText, whoWords } from './task-links';
import type { TaskLinksController } from './task-links';
import type { TaskHandoff, TaskLinks } from './task-links-contract.js';

/** Where a link opens: a memory place (task notes) or Memory › Handoffs. */
export type MemoryTarget = { scope: string } | { handoffs: true };

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => w.slice(0, 1).toUpperCase()).join('') || '?';
const agoWords = (iso: string) => { const a = ago(iso); return !a ? '' : a === 'now' ? 'just now' : /^\d/.test(a) ? `${a} ago` : a; };
function Face({ name, size = 16 }: { name: string; size?: number }) {
  return <span className="tp-face agent" style={{ inlineSize: size, blockSize: size, fontSize: Math.round(size * 0.48) }} title={name} aria-hidden="true">{initials(name)}</span>;
}
function Tool({ icon, label, onClick, disabled, expanded }: { icon: UiIconName; label: string; onClick: () => void; disabled?: boolean; expanded?: boolean }) {
  return <button type="button" className="tool" aria-label={label} title={label} disabled={disabled} aria-expanded={expanded} onClick={onClick}><UiIcon name={icon} size={14}/></button>;
}

/** "Omar through Codex" with the agent's face and the app's mark. */
export function Who({ h }: { h: TaskHandoff }) {
  const via = h.app && whoWords(h) !== h.agentName ? h.app : null;
  return <span className="tp-handoff-who"><Face name={h.agentName}/><b>{h.agentName}</b>{via && <> through {appOf(via) && <AppLogo name={via} size={12}/>}{via}</>}</span>;
}

// ---------------------------------------------------------------------------
// Side: "Linked to T-n"
// ---------------------------------------------------------------------------

export function LinkedGroup({ links, mark, title, onOpenMemory, onOpenChat, onShowFile, onShowHandoff }: {
  links: TaskLinks; mark: TaskMark | null | undefined; title: string;
  onOpenMemory?: (to: MemoryTarget) => void; onOpenChat?: (id: string) => void; onShowFile?: () => void; onShowHandoff: () => void;
}) {
  const [all, setAll] = useState(false);
  const n = links.taskNo ?? mark?.no ?? null;
  const newest = links.handoffs[0];
  const chats = all ? links.chats : links.chats.slice(0, 3);
  const notes = links.notesPlace;
  const place = notes?.place;
  return <section className="tp-group tp-linked" aria-label={n ? `Linked to ${n}` : 'Linked'}>
    <header><h4>Linked to {n ? <span className="task-number">{n}</span> : 'this task'}</h4>
      <Tool icon="copy" label={`Copy the links of ${n ?? 'this task'}`} onClick={() => void navigator.clipboard?.writeText(linksText(links, title))}/></header>
    <span className="tp-link"><UiIcon name="brain" size={13}/>Task notes<span className="tp-link-end">{notes && notes.count > 0 ? `${notes.count} ${notes.count === 1 ? 'thing' : 'things'} agents remember` : 'None yet'}
      {place && onOpenMemory && <button type="button" className="tool" aria-label={`Open the task notes in Memory${n ? ` › Tasks › ${n}` : ''}`} title={`Open in Memory${n ? ` › Tasks › ${n}` : ''}`} onClick={() => onOpenMemory({ scope: place })}><UiIcon name="open" size={12}/></button>}</span></span>
    <button type="button" className="tp-link tp-link-button" disabled={!newest} onClick={onShowHandoff} title={newest ? 'Show the latest handoff' : undefined}><UiIcon name="handoff" size={13}/>Handoffs<span className="tp-link-end">{countLine(links.handoffs.length, newest?.at)}
      {links.blocked && <span className="dk-chip dk-state" data-tone="warn" title={newest?.blockers.length ? `Blocked: ${newest.blockers.join('; ')}` : 'Blocked'}>Blocked</span>}</span></button>
    <span className="tp-link"><UiIcon name="message" size={13}/>Chats<span className="tp-link-end">{links.chats.length ? `${links.chats.length} · newest ${agoWords(links.chats[0].at) || 'today'}` : 'None yet'}</span></span>
    {chats.map(c => <button key={c.id} type="button" className="tp-chat tp-linked-chat" disabled={!onOpenChat} onClick={() => onOpenChat?.(c.id)}><UiIcon name="message" size={12}/><span>{c.title || 'Untitled chat'}</span>{c.at && <small>{agoWords(c.at)}</small>}</button>)}
    {links.chats.length > 3 && <button type="button" className="link-button tp-linked-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show ${links.chats.length - 3} more`}</button>}
    {(links.taskFile || mark) && <button type="button" className="tp-link tp-link-button" disabled={!onShowFile} onClick={onShowFile} title={onShowFile ? 'Show it in the task file' : undefined}>
      <UiIcon name={mark?.problem ? 'alert' : 'file'} size={13}/>Task file<span className="tp-link-end">{(links.taskFile?.path ?? '.girru/tasks.md').replace('.girru/', '')}{links.taskFile?.line ? `:${links.taskFile.line}` : ''} · {mark?.problem ? 'a line to fix' : 'up to date'}</span></button>}
  </section>;
}

/** The T-n list from the crumb or ⌘⇧L: arrows move, Enter opens, Esc closes. */
export function LinkedList({ links, onClose, onOpenMemory, onOpenChat, onShowFile, onShowHandoff }: {
  links: TaskLinks; onClose: () => void; onOpenMemory?: (to: MemoryTarget) => void; onOpenChat?: (id: string) => void; onShowFile?: () => void; onShowHandoff: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus(); }, []);
  const place = links.notesPlace?.place, newest = links.handoffs[0];
  const items: Array<{ key: string; icon: UiIconName; label: string; side: string; run?: () => void }> = [
    { key: 'notes', icon: 'brain', label: 'Task notes', side: links.taskNo ? `Memory › Tasks › ${links.taskNo}` : 'Memory › Tasks', run: place && onOpenMemory ? () => onOpenMemory({ scope: place }) : undefined },
    { key: 'handoff', icon: 'handoff', label: 'Latest handoff', side: newest ? `${whoWords(newest)} · ${agoWords(newest.at)}` : 'none yet', run: newest ? onShowHandoff : undefined },
    ...links.chats.map(c => ({ key: `chat:${c.id}`, icon: 'message' as UiIconName, label: c.title || 'Untitled chat', side: 'chat', run: onOpenChat ? () => onOpenChat(c.id) : undefined })),
    ...(links.taskFile ? [{ key: 'file', icon: 'file' as UiIconName, label: 'Task file', side: links.taskFile.path, run: onShowFile }] : []),
  ];
  const move = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
  };
  return <div className="tp-linked-list" role="menu" aria-label={`Linked to ${links.taskNo ?? 'this task'}`} ref={box} onKeyDown={move}>
    <p className="fine-print">Linked to {links.taskNo ?? 'this task'} · arrows move, Enter opens, Esc closes</p>
    {items.map(it => <button key={it.key} type="button" role="menuitem" disabled={!it.run} onClick={() => { onClose(); it.run?.(); }}>
      <UiIcon name={it.icon} size={14}/><span>{it.label}</span><small>{it.side}</small></button>)}
  </div>;
}

// ---------------------------------------------------------------------------
// Middle: "Latest handoff"
// ---------------------------------------------------------------------------

const TONE: Record<string, string | undefined> = { Done: 'ok', Left: 'warn', Next: undefined, Blockers: 'bad', 'Files touched': undefined, 'Questions for you': 'bad' };
function Field({ label, items, mono, children }: { label: string; items: readonly string[]; mono?: boolean; children?: ReactNode }) {
  return <div className="tp-handoff-field"><span data-tone={TONE[label]} className={label === 'Next' ? 'mem-link-text' : undefined}>{label}</span>
    {children ?? <span className={mono ? 'tp-handoff-files' : undefined} dir="auto">{items.map((t, i) => <span key={i}>{t}</span>)}</span>}</div>;
}

/** One handoff: who (and from whom), when, from which chat, then its fields. */
function HandoffBlock({ h, c, onOpenChat, canEdit }: { h: TaskHandoff; c: TaskLinksController; onOpenChat?: (id: string) => void; canEdit: boolean }) {
  const [edit, setEdit] = useState<string | null>(null);
  const s = c.getSnapshot();
  const handed = handedWords(h);
  return <div className="tp-handoff">
    <span className="tp-handoff-meta">{handed && <b>{handed}</b>}{handed && <i aria-hidden="true">·</i>}<Who h={h}/>{h.at && <><i aria-hidden="true">·</i><time dateTime={h.at}>{agoWords(h.at)}</time></>}
      {h.conversationId && <><i aria-hidden="true">·</i>from the chat {onOpenChat ? <button type="button" className="link-button" onClick={() => onOpenChat(h.conversationId!)}>{h.conversationTitle || 'its chat'}</button> : <span>{h.conversationTitle || 'its chat'}</span>}</>}</span>
    {h.done.length > 0 && <Field label="Done" items={h.done}/>}
    {h.left.length > 0 && <Field label="Left" items={h.left}/>}
    {h.next.length > 0 && <Field label="Next" items={h.next}/>}
    {(h.blockers.length > 0 || edit !== null || canEdit) && <Field label="Blockers" items={h.blockers}>
      {edit !== null ? <form className="tp-handoff-edit" onSubmit={e => { e.preventDefault(); void c.saveBlockers(h.id, edit).then(ok => { if (ok) setEdit(null); }); }}>
        <textarea autoFocus rows={3} aria-label="Blockers, one per line" placeholder="One blocker per line. Leave empty when nothing blocks it." value={edit} onChange={e => setEdit(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setEdit(null); } if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }}/>
        <span className="tp-handoff-edit-end"><button type="button" onClick={() => setEdit(null)}>Cancel</button><button type="submit" disabled={s.busy}>Save</button></span>
      </form> : <span className="tp-handoff-blockers" dir="auto">{h.blockers.length ? h.blockers.map((t, i) => <span key={i}>{t}</span>) : <span className="fine-print">None</span>}
        {canEdit && <Tool icon="pencil" label="Edit the blockers" disabled={s.busy} onClick={() => setEdit(h.blockers.join('\n'))}/>}</span>}
    </Field>}
    {h.files.length > 0 && <Field label="Files touched" items={h.files} mono/>}
    {h.questions.length > 0 && <Field label="Questions for you" items={h.questions}/>}
  </div>;
}

export function LatestHandoffCard({ c, links, detail, onOpenChat, onOpenMemory, focus }: {
  c: TaskLinksController; links: TaskLinks; detail: TaskDetail | null; onOpenChat?: (id: string) => void; onOpenMemory?: (to: MemoryTarget) => void; focus?: number;
}) {
  const [shown, setShown] = useState<string | null>(null), [older, setOlder] = useState(false), [menu, setMenu] = useState(false);
  const card = useRef<HTMLElement>(null);
  useEffect(() => { if (focus) card.current?.scrollIntoView({ block: 'nearest' }); }, [focus]);
  const s = c.getSnapshot();
  const list = links.handoffs;
  const open = list.find(h => h.id === shown) ?? list[0] ?? null;
  const rest = list.filter(h => h !== open);
  const fileLine = detail && (detail.task.left.length || detail.task.next.length) ? (detail.task.left.length ? `Left: ${detail.task.left[0]}` : `Next: ${detail.task.next[0]}`) : '';
  const copy = (h: TaskHandoff) => void navigator.clipboard?.writeText([`${whoWords(h)}${h.at ? ` · ${h.at}` : ''}`, ...(['done', 'left', 'next', 'blockers', 'files'] as const).filter(k => h[k].length).map(k => `${k === 'files' ? 'Files touched' : k[0].toUpperCase() + k.slice(1)}: ${h[k].join('; ')}`)].join('\n'));
  const olderCount = rest.length + (fileLine && list.length ? 1 : 0);
  return <section className="tp-card" aria-label="Latest handoff" ref={card} onContextMenu={open ? e => { e.preventDefault(); setMenu(true); } : undefined}>
    <header><UiIcon name="handoff" size={14}/><strong>Latest handoff</strong>
      <span className="tp-card-tools">
        {onOpenMemory && <Tool icon="history" label={`All handoffs${links.taskNo ? ` of ${links.taskNo}` : ''} in Memory › Handoffs`} onClick={() => onOpenMemory({ handoffs: true })}/>}
        {open && <span className="tp-menu"><Tool icon="more" label="More: copy, open in Memory to edit" expanded={menu} onClick={() => setMenu(!menu)}/>{menu && <span role="menu" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); } }}>
          <button role="menuitem" type="button" onClick={() => { setMenu(false); copy(open); }}><UiIcon name="copy" size={13}/>Copy this handoff</button>
          {onOpenMemory && <button role="menuitem" type="button" onClick={() => { setMenu(false); onOpenMemory({ handoffs: true }); }}><UiIcon name="open" size={13}/>Open in Memory to edit</button>}</span>}</span>}
      </span></header>
    <div className="tp-card-body tp-file">
      {detail?.problem && <p className="task-file-problem" role="status"><UiIcon name="alert" size={13}/>{detail.problem}. Fix that line in the file.</p>}
      {detail && <TaskWorkedOn detail={detail}/>}
      {open ? <HandoffBlock key={open.id} h={open} c={c} onOpenChat={onOpenChat} canEdit={open === list[0]}/>
        : fileLine ? <>
          <span className="fine-print">From the task file</span>
          {detail!.task.left.length > 0 && <span><b>Left</b> {detail!.task.left.join(' · ')}</span>}
          {detail!.task.next.length > 0 && <span><b>Next</b> {detail!.task.next.join(' · ')}</span>}
        </> : <p className="fine-print">No handoff yet. Agents write one when they stop.</p>}
      {olderCount > 0 && <>
        <button type="button" className="tp-soft tp-handoff-fold" aria-expanded={older} onClick={() => setOlder(!older)}><UiIcon name="chevron" size={12}/>{olderCount} older {olderCount === 1 ? 'handoff' : 'handoffs'}</button>
        {older && <ul className="tp-handoff-older">
          {rest.map(h => { const handed = handedWords(h); return <li key={h.id}><button type="button" onClick={() => { setShown(h.id); setOlder(false); }} title="Show this handoff">
            <UiIcon name="handoff" size={13}/><span>{handed ? <b>{handed}</b> : whoWords(h)}{handoffLine(h) ? ` · ${handoffLine(h)}` : ''}</span><time dateTime={h.at}>{agoWords(h.at)}</time></button></li>; })}
          {fileLine && list.length > 0 && <li><span className="tp-handoff-older-file"><UiIcon name="file" size={13}/><span>From the task file · {fileLine}</span></span></li>}
        </ul>}
      </>}
      {open && open !== list[0] && <button type="button" className="link-button" onClick={() => setShown(null)}>Back to the newest handoff</button>}
      {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
      {s.saved && <p className="fine-print" role="status">{s.saved}</p>}
    </div>
  </section>;
}

/** Activity › All also lists "wrote a handoff" and "handed this to" (control map row 11). */
export function handoffEvents(links: TaskLinks | null): Array<{ id: string; at: string; node: ReactNode }> {
  if (!links) return [];
  return links.handoffs.filter(h => h.at).map(h => {
    const handed = handedWords(h);
    return { id: `handoff:${h.id}`, at: h.at, node: <div className="tp-event" key={`handoff:${h.id}`}>
      <Face name={handed ? h.fromAgentName ?? 'Agent' : h.agentName} size={18}/>
      <span>{handed ? <><b>{h.fromAgentName ?? 'An agent'}</b> handed this to <b>{h.agentName}</b></> : <><b>{h.agentName}</b> wrote a handoff{h.blockers.length ? <span className="fine-print"> · Blocked: {h.blockers[0]}</span> : null}</>}</span>
      <time dateTime={h.at}>{agoWords(h.at)}</time></div> };
  });
}
