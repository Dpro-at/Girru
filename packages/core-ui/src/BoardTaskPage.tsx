// TASKPAGE-02 (board TaskPage2): a task opened as its own page in the Board section.
// Middle: who opened it and the description (+ sub-task), the checklist (items given to a
// person or an agent, with dates, reordered by dragging), the task file part, and Activity —
// every move, comment, reply in its chats (with the files each reply changed and their
// diff) and the task file's log, filtered All / Comments / Replies / Changes — then the
// comment box. Side: Continue, people and agents with what they do, status, release,
// relationships, development, labels, files changed, spent, chats, task file, followers.
// Every change saves by itself; Esc goes back to the board.
import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { UiIcon } from './ui-icons';
import type { UiIconName } from './ui-icons';
import { DocumentEditor, MarkdownDocument } from './DocumentEditor';
import { WEEKDAYS, allCardTypes, allPriorities, cardTypeLabel, priorityLabel, repeatWords, roleLabel } from './board';
import type { ActivityItem, BoardColor, BoardController, Card, CardType, Every, FileDiff, Repeat, Role, TaskPageData } from './board';
import { AppLogo, TaskFileSheet, TaskWorkedOn, appOf } from './BoardTaskFile';
import { ROLES } from './board-contract.js';

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => w.slice(0, 1).toUpperCase()).join('') || '?';
const when = (iso: string) => { const d = new Date(iso); if (Number.isNaN(d.getTime())) return iso; const today = new Date().toDateString() === d.toDateString(); return today ? `Today ${d.toTimeString().slice(0, 5)}` : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const colorLabel: Record<BoardColor, string> = { blue: 'Blue', green: 'Green', orange: 'Orange', red: 'Red', purple: 'Purple', pink: 'Pink', teal: 'Teal', gray: 'Gray' };
type Filter = 'all' | 'comments' | 'replies' | 'changes';
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "2 people and 1 agent", leaving out a zero. */
const onIt = (people: TaskPageData['people']) => { const u = people.filter(p => p.kind === 'user').length, a = people.length - u; return [u && count(u, 'person', 'people'), a && count(a, 'agent', 'agents')].filter(Boolean).join(' and '); };
const APPS: ReadonlyArray<{ model: string; name: string }> = [
  { model: '', name: 'Its own model' }, { model: 'subscription:claude', name: 'Claude Code' }, { model: 'subscription:codex', name: 'Codex' }, { model: 'subscription:gemini', name: 'Gemini' },
];

function Face({ name, agent, size = 20 }: { name: string; agent?: boolean; size?: number }) {
  return <span className={`tp-face${agent ? ' agent' : ''}`} style={{ inlineSize: size, blockSize: size, fontSize: Math.round(size * 0.48) }} title={name} aria-hidden="true">{initials(name)}</span>;
}
function Tool({ icon, label, onClick, disabled }: { icon: UiIconName; label: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="tool" aria-label={label} title={label} disabled={disabled} onClick={onClick}><UiIcon name={icon} size={15}/></button>;
}

export function TaskPage({ card, controller, busy, onOpenChat, onBack, draftCache }: { card: Card; controller: BoardController; busy: boolean; onOpenChat?: (id: string) => void; onBack: () => void; draftCache: Map<string, string> }) {
  const s = controller.getSnapshot(), d = s.draft!, page = s.page?.data ?? null;
  const [title, setTitle] = useState(card.title);
  useEffect(() => setTitle(card.title), [card.title]);
  const [editing, setEditing] = useState<'description' | 'comment' | null>(null);
  const [comment, setComment] = useState(draftCache.get(card.id) ?? '');
  useEffect(() => { draftCache.set(card.id, comment); }, [card.id, comment, draftCache]);
  const [filter, setFilter] = useState<Filter>('all'), [showFile, setShowFile] = useState(false);
  const fileDetail = s.task?.phase === 'ready' ? s.task.detail : null;
  const root = useRef<HTMLDivElement>(null);
  const column = s.columns.find(c => c.id === card.columnId);
  const saveTitle = () => { const t = title.normalize('NFKC').replace(/\s+/g, ' ').trim(); if (t && t !== card.title) void controller.saveField({ title: t }); else setTitle(card.title); };
  const send = () => { if (comment.trim()) void controller.addComment(comment).then(ok => { if (ok) setComment(''); }); };
  const people = page?.people ?? [];
  return <div className="tp" ref={root} aria-label={`Task: ${card.title}`} onKeyDown={e => {
    if (e.key === 'Escape' && !editing && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) { e.stopPropagation(); onBack(); }
  }}>
    <div className="tp-main">
      <header className="tp-bar">
        <span className="tp-back"><Tool icon="chevron" label="Back to the board (Esc)" onClick={onBack}/></span>
        <span className="tp-crumb">{s.name}</span><span className="tp-crumb-sep" aria-hidden="true">›</span><span className="tp-crumb now">{card.taskFile?.no ?? 'Task'}</span>
        <span className="tp-bar-tools">
          {card.taskFile && <Tool icon="file" label="Show it in the task file" disabled={!fileDetail} onClick={() => setShowFile(true)}/>}
          {page && page.chats[0] && onOpenChat && <Tool icon="message" label="Open its chat" onClick={() => onOpenChat(page.chats[0].id)}/>}
          <Tool icon="copy" label="Copy the task’s name and number" onClick={() => void navigator.clipboard?.writeText(`${card.taskFile?.no ? `${card.taskFile.no} · ` : ''}${card.title}`)}/>
          <Tool icon="refresh" label="Read the task again" onClick={() => controller.refreshPage()}/>
        </span>
      </header>
      <div className="tp-body">
        <div className="tp-head">
          <input className="tp-title" aria-label="Title" value={title} maxLength={200} disabled={busy} onChange={e => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') { e.stopPropagation(); setTitle(card.title); } }}/>
          <span className="tp-meta"><span className="tp-pill">{column?.name ?? 'Task'}</span>
            <span>{[card.taskFile && `${card.taskFile.no} · project ${card.taskFile.projectName}`, page && `opened by ${page.openedBy.name} ${when(page.openedAt)}`,
              page && people.length > 0 && `${onIt(people)} on it`].filter(Boolean).join(' · ')}</span></span>
        </div>
        <section className="tp-card" aria-label="Description">
          <header>{page && <Face name={page.openedBy.name}/>}<strong>{page?.openedBy.name ?? '…'}</strong><span>opened it{page ? ` ${when(page.openedAt)}` : ''}</span>
            <span className="tp-card-tools"><Tool icon="pencil" label="Edit the description" disabled={busy} onClick={() => setEditing('description')}/></span></header>
          <div className="tp-card-body">{d.description ? <MarkdownDocument text={d.description}/> : <p className="fine-print">No description yet. Say the outcome and when it is done.</p>}
            <SubtaskAdd controller={controller} busy={busy}/></div>
        </section>
        <ChecklistCard controller={controller} busy={busy} page={page}/>
        {card.taskFile && <TaskFileCard controller={controller}/>}
        <div className="tp-activity-head"><h3>Activity</h3>
          <span className="dk-segmented" role="group" aria-label="Show in Activity">{(['all', 'comments', 'replies', 'changes'] as const).map(f =>
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>)}</span></div>
        <Activity controller={controller} filter={filter} onOpenChat={onOpenChat}/>
        <div className="tp-composer">
          <textarea aria-label="Write a comment" placeholder="Write a comment… Markdown, @ to bring in an agent" maxLength={4000} value={comment} disabled={busy}
            onChange={e => setComment(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }}/>
          <footer><Tool icon="compose" label="Open in the long text editor" onClick={() => setEditing('comment')}/><small>Agents on the task read comments; ⌘↩ sends</small>
            <button type="button" disabled={busy || !comment.trim()} onClick={send}>Comment</button></footer>
        </div>
      </div>
    </div>
    <TaskSide card={card} controller={controller} busy={busy} page={page} onOpenChat={onOpenChat}/>
    {showFile && fileDetail && <TaskFileSheet text={fileDetail.text} title={`${fileDetail.no} in ${fileDetail.file}`} onClose={() => setShowFile(false)}/>}
    {editing && <DocumentEditor key={editing} title={editing === 'description' ? 'Task description' : 'Comment draft'} files={[{ id: editing, name: editing === 'description' ? 'Description.md' : 'Comment.md', content: editing === 'description' ? d.description : comment }]}
      maxLength={editing === 'description' ? 5000 : 4000} onChange={(_, text) => editing === 'description' ? controller.editDraft({ description: text }) : setComment(text)}
      onClose={() => { if (editing === 'description') void controller.saveField({ description: controller.getSnapshot().draft?.description ?? '' }); setEditing(null); }}/>}
  </div>;
}

function SubtaskAdd({ controller, busy }: { controller: BoardController; busy: boolean }) {
  const [open, setOpen] = useState(false), [t, setT] = useState('');
  if (!open) return <button type="button" className="tp-soft" disabled={busy} onClick={() => setOpen(true)}><UiIcon name="plus" size={13}/>Add a sub-task</button>;
  return <form className="tp-inline" onSubmit={e => { e.preventDefault(); void controller.addSubtask(t).then(ok => { if (ok) { setT(''); setOpen(false); } }); }}>
    <input autoFocus aria-label="Sub-task title" placeholder="What is the sub-task?" maxLength={200} value={t} onChange={e => setT(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}/>
    <button type="submit" disabled={busy || !t.trim()}>Add</button>
  </form>;
}

/** The checklist: tick, give an item to someone, a date, drag to reorder, add with Enter (“@Name” gives it). */
function ChecklistCard({ controller, busy, page }: { controller: BoardController; busy: boolean; page: TaskPageData | null }) {
  const s = controller.getSnapshot(), items = s.checklist;
  const [text, setText] = useState(''), [pick, setPick] = useState<string | null>(null), [drag, setDrag] = useState<string | null>(null);
  const done = items.filter(i => i.done).length;
  const owners = [...(page?.people ?? []).map(p => ({ kind: p.kind, id: p.id, name: p.name })), ...(page?.team ?? []).filter(u => !page?.people.some(p => p.id === u.id)).map(u => ({ kind: 'user' as const, id: u.id, name: u.name })),
    ...s.agents.filter(a => !page?.people.some(p => p.id === a.id)).map(a => ({ kind: 'agent' as const, id: a.id, name: a.name }))];
  const ownerName = (o: { kind: string; id: string } | null | undefined) => (o ? owners.find(x => x.kind === o.kind && x.id === o.id)?.name ?? (o.kind === 'agent' ? controller.agentName(o.id) : 'Team member') : '');
  const add = () => {
    let t = text.trim(); if (!t) return;
    const at = /@([^@]+)$/.exec(t), who = at ? owners.find(o => o.name.toLowerCase() === at[1].trim().toLowerCase()) : undefined;
    if (who) t = t.slice(0, at!.index).trim();
    setText('');
    void controller.addCheckItem(t).then(ok => {
      if (!ok) { setText(text); return; }
      const last = controller.getSnapshot().checklist.at(-1);
      if (who && last) void controller.updateCheckItem(last.id, { owner: { kind: who.kind, id: who.id } });
    });
  };
  const onDrop = (e: DragEvent, before: string | null) => { e.preventDefault(); if (drag && drag !== before) void controller.updateCheckItem(drag, { beforeItemId: before }); setDrag(null); };
  return <section className="tp-card" aria-label="Checklist">
    <header><UiIcon name="check" size={14}/><strong>Checklist</strong>{items.length > 0 && <span>{done} of {items.length}</span>}</header>
    <div className="tp-card-body">
      {items.length > 0 && <progress className="tp-progress" max={items.length} value={done} aria-label="Checklist progress"/>}
      <ul className="tp-checklist" onDragOver={e => e.preventDefault()} onDrop={e => onDrop(e, null)}>{items.map(i => <li key={i.id} draggable onDragStart={() => setDrag(i.id)} onDragOver={e => e.preventDefault()} onDrop={e => { e.stopPropagation(); onDrop(e, i.id); }} data-done={i.done || undefined}>
        <label className="check"><input type="checkbox" checked={i.done} disabled={busy} onChange={e => void controller.updateCheckItem(i.id, { done: e.target.checked })}/><span>{i.text}</span></label>
        <input type="date" className="tp-due" aria-label={`Due date of ${i.text}`} value={i.dueDate ?? ''} disabled={busy} onChange={e => void controller.updateCheckItem(i.id, { dueDate: e.target.value || null })}/>
        <span className="tp-owner">
          <button type="button" className="tp-owner-btn" aria-label={i.owner ? `${i.text}: ${ownerName(i.owner)}. Give it to someone else` : `Give ${i.text} to someone`} title={i.owner ? ownerName(i.owner) : 'Give it to someone'} onClick={() => setPick(pick === i.id ? null : i.id)}>
            {i.owner ? <Face name={ownerName(i.owner)} agent={i.owner.kind === 'agent'} size={18}/> : <UiIcon name="avatar" size={14}/>}</button>
          {pick === i.id && <select autoFocus aria-label={`Who does ${i.text}`} value={i.owner ? `${i.owner.kind}:${i.owner.id}` : ''} onBlur={() => setPick(null)}
            onChange={e => { const [kind, ...rest] = e.target.value.split(':'); setPick(null); void controller.updateCheckItem(i.id, { owner: kind ? { kind: kind as 'user' | 'agent', id: rest.join(':') } : null }); }}>
            <option value="">Nobody</option>{owners.map(o => <option key={`${o.kind}:${o.id}`} value={`${o.kind}:${o.id}`}>{o.name}{o.kind === 'agent' ? ' (agent)' : ''}</option>)}</select>}
        </span>
        <button type="button" className="tool tp-remove" aria-label={`Remove ${i.text}`} title="Remove the item" disabled={busy} onClick={() => void controller.updateCheckItem(i.id, { remove: true })}><UiIcon name="close" size={13}/></button>
      </li>)}</ul>
      <form className="tp-inline" onSubmit={e => { e.preventDefault(); add(); }}>
        <input aria-label="New checklist item" placeholder="Add an item · Enter adds, @Name gives it to someone" maxLength={300} value={text} onChange={e => setText(e.target.value)}/>
      </form>
    </div>
  </section>;
}

function TaskFileCard({ controller }: { controller: BoardController }) {
  const d = controller.getSnapshot().task?.detail;
  if (!d) return null;
  return <section className="tp-card" aria-label="From the task file">
    <header><UiIcon name="file" size={14}/><strong>From the task file</strong><span>{d.file} · {d.no}</span></header>
    <div className="tp-card-body tp-file">
      {d.problem && <p className="task-file-problem" role="status"><UiIcon name="alert" size={13}/>{d.problem}. Fix that line in the file.</p>}
      <TaskWorkedOn detail={d}/>
      {d.task.left.length > 0 && <span><b>Left</b> {d.task.left.join(' · ')}</span>}
      {d.task.next.length > 0 && <span><b>Next</b> {d.task.next.join(' · ')}</span>}
      {!d.task.left.length && !d.task.next.length && <span className="fine-print">Nothing left in the file.</span>}
    </div>
  </section>;
}

function Activity({ controller, filter, onOpenChat }: { controller: BoardController; filter: Filter; onOpenChat?: (id: string) => void }) {
  const s = controller.getSnapshot(), a = s.activity;
  if (!a || a.phase === 'loading' && !a.items.length) return <p className="fine-print" role="status">Reading what happened…</p>;
  const shown = a.items.filter(x => filter === 'all' || (filter === 'comments' && x.kind === 'comment') || (filter === 'replies' && x.kind === 'reply') || (filter === 'changes' && x.kind === 'reply' && x.change));
  return <div className="tp-line">
    {a.more && <button type="button" className="tp-soft" onClick={() => controller.loadOlder()}>Show older</button>}
    {a.phase === 'error' && <p className="fine-print" role="status">Activity could not be read. Try the refresh button.</p>}
    {!shown.length && a.phase === 'ready' && <p className="fine-print">{filter === 'all' ? 'Nothing yet. Comment, or press Continue.' : `No ${filter} yet.`}</p>}
    {shown.map(x => <ActivityRow key={x.id} x={x} controller={controller} filter={filter} onOpenChat={onOpenChat}/>)}
  </div>;
}
const eventWords = (x: Extract<ActivityItem, { kind: 'event' }>, name: (kind: string, id: string) => string) => {
  if (x.event === 'created') return <>made it{x.detail ? <> in <b>{x.detail}</b></> : ''}</>;
  if (x.event === 'moved' || x.event === 'done') return <>moved it to <b>{x.detail}</b></>;
  if (x.event === 'archived') return <>archived it</>;
  if (x.event === 'restored') return <>brought it back</>;
  if (x.event === 'added' || x.event === 'removed') { const [kind, id, role] = x.detail.split(':'); return x.event === 'added' ? <>put <b>{name(kind, id)}</b> on it ({roleLabel[role as Role] ?? role})</> : <>took <b>{name(kind, id)}</b> off it</>; }
  if (x.event === 'release') return x.detail ? <>put it in release <b>{x.detail}</b></> : <>took it out of its release</>;
  if (x.event === 'waits') return <>made it wait for <b>{x.detail}</b></>;
  if (x.event === 'unwaits') return <>stopped it waiting for <b>{x.detail}</b></>;
  if (x.event === 'subtask') return <>added the sub-task <b>{x.detail}</b></>;
  if (x.event === 'repeats') { if (x.detail === 'never') return <>stopped it repeating</>; const [every, a, b, c] = x.detail.split(':'); const weekly = every === 'weekly'; const at = weekly ? `${b}:${c}` : `${a}:${b}`; return <>made it repeat <b>{repeatWords({ every: every as Every, at, weekday: weekly ? Number(a) : null })}</b>{x.detail.endsWith(':paused') ? ' (paused)' : ''}</>; }
  if (x.event === 'ran') return x.detail === 'started' ? <>ran on schedule</> : x.detail === 'busy' ? <>was due on schedule, but its chat was busy</> : <>could not run on schedule</>;
  return <>{x.event} {x.detail}</>;
};
function ActivityRow({ x, controller, filter, onOpenChat }: { x: ActivityItem; controller: BoardController; filter: Filter; onOpenChat?: (id: string) => void }) {
  const page = controller.getSnapshot().page?.data;
  const name = (kind: string, id: string) => (kind === 'agent' ? controller.agentName(id) : page?.team.find(u => u.id === id)?.name ?? 'Team member');
  if (x.kind === 'event') return <div className="tp-event"><Face name={x.actor.name} agent={x.actor.kind === 'agent'} size={18}/><span><b>{x.actor.name}</b> {eventWords(x, name)}</span><time dateTime={x.at}>{when(x.at)}</time></div>;
  if (x.kind === 'log') return <div className="tp-event"><AppLogo name={x.app} size={16}/><span><b>{x.app}</b> {x.text}</span><time dateTime={x.at}>{when(x.at)}</time></div>;
  if (x.kind === 'comment') return <article className="tp-post"><header><Face name={x.actor.name} agent={x.actor.kind === 'agent'}/><b>{x.actor.name}</b><span>commented</span><time dateTime={x.at}>{when(x.at)}</time></header>
    <div className="tp-post-body"><MarkdownDocument text={x.text}/></div></article>;
  return <>
    {filter !== 'changes' && <article className="tp-post"><header><Face name={x.actor.name} agent/><b>{x.actor.name}</b><span>replied in</span>
      {onOpenChat ? <button type="button" className="link-button" onClick={() => onOpenChat(x.chat.id)}>{x.chat.title || 'its chat'}</button> : <span>{x.chat.title || 'its chat'}</span>}
      {appOf(x.app) && <span className="tp-app"><AppLogo name={x.app} size={12}/>{x.app}</span>}<time dateTime={x.at}>{when(x.at)}</time></header>
      <div className="tp-post-body"><MarkdownDocument text={x.text + (x.more ? '…' : '')}/>
        <small>{x.more && onOpenChat && <button type="button" className="link-button" onClick={() => onOpenChat(x.chat.id)}>Show the whole reply</button>}{x.tokens > 0 && ` ${tokens(x.tokens)} tokens`}</small></div></article>}
    {x.change && <ChangeBlock x={x} controller={controller}/>}
  </>;
}
function ChangeBlock({ x, controller }: { x: Extract<ActivityItem, { kind: 'reply' }>; controller: BoardController }) {
  const c = x.change!, d = controller.getSnapshot().diffs?.[c.messageId];
  const [open, setOpen] = useState(false);
  const toggle = () => { if (!open && d === undefined) void controller.loadDiff(c.messageId); setOpen(!open); };
  return <article className="tp-change" data-undone={c.undone || undefined}>
    <header>{appOf(x.app) ? <AppLogo name={x.app} size={15}/> : <Face name={x.actor.name} agent size={18}/>}<b>{appOf(x.app) ? x.app : x.actor.name}</b>
      <span>{c.undone ? 'changes undone:' : 'changed'} {c.files} {c.files === 1 ? 'file' : 'files'} <i className="tp-add">+{c.added}</i> <i className="tp-del">−{c.removed}</i></span>
      <time dateTime={x.at}>{when(x.at)}</time>
      {!c.undone && <Tool icon="undo" label="Undo these changes" onClick={() => void controller.undoChange(x.chat.id, c.messageId)}/>}
      <Tool icon={open ? 'shrink' : 'diff'} label={open ? 'Hide the changed lines' : 'Show the changed lines'} onClick={toggle}/></header>
    {open && (d === 'loading' || d === undefined ? <p className="fine-print" role="status">Reading the changes…</p> : d === 'error' ? <p className="fine-print" role="status">The changes could not be read (the folder may have moved).</p>
      : <div className="tp-diff">{d.map((f: FileDiff) => <div key={f.path}><span className="tp-diff-file"><UiIcon name="file" size={12}/>{f.path}{f.status === 'A' && <small className="tp-add">new</small>}{f.status === 'D' && <small className="tp-del">deleted</small>}<span><i className="tp-add">+{f.added}</i> <i className="tp-del">−{f.removed}</i></span></span>
          <pre>{f.lines.map((l, n) => <span key={n} data-kind={l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : undefined}>{l}{'\n'}</span>)}{f.more && <span className="fine-print">…</span>}</pre></div>)}</div>)}
  </article>;
}

/** One row of the side: icon · name · value; clicking the value opens its editor in place (TASKPAGE-03). */
function Prop({ icon, label, value, empty, open, onToggle, children, tip }: { icon: UiIconName; label: string; value: ReactNode; empty?: boolean; open: boolean; onToggle: () => void; children?: ReactNode; tip?: string }) {
  return <div className="tp-prop" data-open={open || undefined}>
    <button type="button" className="tp-prop-row" aria-expanded={open} title={tip ?? `Change ${label.toLowerCase()}`} onClick={onToggle}>
      <UiIcon name={icon} size={14}/><span className="tp-prop-label">{label}</span><span className={`tp-prop-value${empty ? ' empty' : ''}`}>{value}</span><span className="tp-prop-chev" aria-hidden="true"><UiIcon name="chevron" size={11}/></span></button>
    {open && children && <div className="tp-prop-edit">{children}</div>}
  </div>;
}
function Group({ title, side, children }: { title: string; side?: ReactNode; children: ReactNode }) {
  return <section className="tp-group" aria-label={title}><header><h4>{title}</h4>{side}</header>{children}</section>;
}
const shortDate = (d: string) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const nextWords = (iso: string) => { const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; const days = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
  const t = d.toTimeString().slice(0, 5); return days === 0 ? `today ${t}` : days === 1 ? `tomorrow ${t}` : d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }); };

function RepeatEditor({ controller, busy, current, onDone }: { controller: BoardController; busy: boolean; current: Repeat | null; onDone: () => void }) {
  const s = controller.getSnapshot();
  const [every, setEvery] = useState<Every | 'never'>(current?.every ?? 'daily');
  const [at, setAt] = useState(current?.at ?? '09:00'), [weekday, setWeekday] = useState(current?.weekday ?? 1);
  const [agent, setAgent] = useState(current?.agentId ?? s.cards.find(c => c.id === s.open)?.agents[0] ?? ''), [model, setModel] = useState(current?.model ?? '');
  const save = (paused = current?.paused ?? false) => void controller.setSchedule(every === 'never' ? null : { every, at: every === 'hourly' ? `00:${at.slice(3) || '00'}` : at, weekday, agentId: agent || null, model, paused }).then(ok => { if (ok) onDone(); });
  return <div className="tp-repeat">
    <span className="dk-segmented" role="group" aria-label="How often">{(['never', 'hourly', 'daily', 'weekly'] as const).map(k =>
      <button key={k} type="button" aria-pressed={every === k} onClick={() => setEvery(k)}>{k === 'never' ? 'Never' : k === 'hourly' ? 'Every hour' : k === 'daily' ? 'Every day' : 'Every week'}</button>)}</span>
    {every !== 'never' && <>
      {every === 'weekly' && <span className="tp-days" role="group" aria-label="Weekday">{WEEKDAYS.map((d, n) => <button key={d} type="button" aria-pressed={weekday === n} onClick={() => setWeekday(n)}>{d}</button>)}</span>}
      <label className="tp-kv">{every === 'hourly' ? 'At minute' : 'At'}{every === 'hourly'
        ? <select aria-label="Minute of the hour" value={at.slice(3)} onChange={e => setAt(`00:${e.target.value}`)}>{['00', '05', '10', '15', '20', '30', '40', '45', '50'].map(m => <option key={m} value={m}>:{m}</option>)}</select>
        : <input type="time" aria-label="Time" value={at} onChange={e => setAt(e.target.value || '09:00')}/>}</label>
      <label className="tp-kv">Runs as<span className="tp-runs"><select aria-label="Agent who runs it" value={agent} onChange={e => setAgent(e.target.value)}>{!agent && <option value="">Main agent</option>}{s.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select aria-label="App it uses" value={model} onChange={e => setModel(e.target.value)}>{APPS.map(a => <option key={a.model} value={a.model}>{a.name}</option>)}</select></span></label>
      <small className="fine-print">Each run starts a chat that continues this task, with its rules and Mode. A run shows in Activity; a run that needs you waits in Approvals.</small>
      {current && <small className="fine-print"><UiIcon name="clock" size={12}/> Next run: {current.paused ? 'paused' : nextWords(current.nextRun)}{current.lastRun ? ` · last: ${nextWords(current.lastRun)}${current.lastResult === 'busy' ? ', its chat was busy' : current.lastResult === 'failed' ? ', it could not run' : ''}` : ''}</small>}
    </>}
    <footer>{current && every !== 'never' && <button type="button" disabled={busy} onClick={() => save(!current.paused)}><UiIcon name={current.paused ? 'play' : 'pause'} size={12}/>{current.paused ? 'Resume' : 'Pause'}</button>}
      <span className="tp-repeat-end"><button type="button" onClick={onDone}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={() => save()}>Save</button></span></footer>
  </div>;
}

function TaskSide({ card, controller, busy, page, onOpenChat }: { card: Card; controller: BoardController; busy: boolean; page: TaskPageData | null; onOpenChat?: (id: string) => void }) {
  const s = controller.getSnapshot(), d = s.draft!;
  const t = s.task?.phase === 'ready' ? s.task.detail : null;
  const lastApp = t?.log[0]?.app ?? t?.workedOn.at(-1)?.app ?? '';
  const [agent, setAgent] = useState(card.agents[0] ?? ''), [model, setModel] = useState(''), [picked, setPicked] = useState(false);
  useEffect(() => { if (!picked) setModel(APPS.find(a => a.model && appOf(lastApp)?.id === a.model)?.model ?? ''); }, [lastApp, picked]);
  const [release, setRelease] = useState(page?.release ?? '');
  useEffect(() => setRelease(page?.release ?? ''), [page?.release]);
  const [open, setOpen] = useState<string | null>(null), [more, setMore] = useState(false), [menu, setMenu] = useState(false), [work, setWork] = useState(false);
  const toggle = (k: string) => setOpen(open === k ? null : k);
  const people = page?.people ?? [];
  const column = s.columns.find(c => c.id === card.columnId);
  const toSort = column?.name === 'To sort';
  const sortable = [...new Set(s.boards.filter(b => b.kind === 'department' && b.departmentActive !== false).map(b => b.departments[0]).filter(Boolean))].sort();
  const others = s.cards.filter(c => c.id !== card.id && !page?.waitsFor.some(w => w.id === c.id));
  const me = controller.myId();
  const agentName = agent ? controller.agentName(agent) : 'Main agent', appName = APPS.find(a => a.model === model)?.name ?? 'Its own model';
  const sched = s.schedule ?? null;
  const tokensAll = (page?.spent ?? []).reduce((n, x) => n + x.tokens, 0);
  return <aside className="tp-side" aria-label="About this task">
    {!card.taskFile?.finished && !toSort && <div className="tp-continue">
      <span className="tp-split"><button type="button" className="primary" disabled={busy || !!card.taskFile?.problem} title={card.taskFile?.problem ? 'Fix the task’s line in the file first' : 'A new chat that goes on with this task and writes back what it did'}
        onClick={() => void controller.continueTask(agent || undefined, model || undefined).then(id => { if (id) onOpenChat?.(id); })}><UiIcon name="play" size={13}/>Continue</button>
        <button type="button" className="tp-split-more" aria-label="Who continues and with which app" title="Who continues and with which app" aria-expanded={more} onClick={() => setMore(!more)}><UiIcon name="chevron" size={12}/></button></span>
      {more ? <span className="tp-runs"><select aria-label="Agent who continues" value={agent} disabled={busy} onChange={e => setAgent(e.target.value)}>{!agent && <option value="">Main agent</option>}{s.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select aria-label="App it uses" value={model} disabled={busy} onChange={e => { setPicked(true); setModel(e.target.value); }}>{APPS.map(a => <option key={a.model} value={a.model}>{a.name}</option>)}</select></span>
        : <span className="tp-who"><Face name={agentName} agent size={16}/>{agentName}<i aria-hidden="true">·</i>{appOf(appName) ? <AppLogo name={appName} size={12}/> : null}{appName}{lastApp && <small>last used</small>}</span>}
    </div>}
    <Group title="Details">
      <Prop icon="pin" label="Status" value={<><i className="tp-dot"/>{column?.name ?? '—'}</>} open={open === 'status'} onToggle={() => toggle('status')}>
        <select autoFocus aria-label="Column" value={card.columnId} disabled={busy} onChange={e => { setOpen(null); void controller.move(card.id, e.target.value, null); }}>{s.columns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Prop>
      <Prop icon="alert" label="Priority" value={<><span className={`tp-prio p-${d.priority}`}>{d.priority === 'urgent' ? '▲▲' : d.priority === 'high' ? '▲' : d.priority === 'low' ? '▼' : '–'}</span>{priorityLabel[d.priority]}</>} open={open === 'priority'} onToggle={() => toggle('priority')}>
        <select autoFocus aria-label="Priority" value={d.priority} disabled={busy} onChange={e => { setOpen(null); void controller.saveField({ priority: e.target.value as never }); }}>{allPriorities.map(p => <option key={p} value={p}>{priorityLabel[p]}</option>)}</select></Prop>
      <Prop icon="users" label="Department" value={toSort ? 'To sort' : card.departments.join(', ') || 'Add…'} empty={!toSort && !card.departments.length} open={open === 'dept'} onToggle={() => toggle('dept')}>
        {toSort && sortable.length ? <select autoFocus aria-label="Send to department" value="" disabled={busy} onChange={e => { if (e.target.value) { setOpen(null); void controller.sortTask(e.target.value); } }}><option value="">Send to…</option>{sortable.map(x => <option key={x}>{x}</option>)}</select>
          : <small className="fine-print">The board’s department. Move the task to another department’s board from ⋯.</small>}</Prop>
      <Prop icon="calendar" label="Dates" value={d.startDate || d.dueDate ? `${shortDate(d.startDate) || '…'} → ${shortDate(d.dueDate) || '…'}` : 'Add…'} empty={!d.startDate && !d.dueDate} open={open === 'dates'} onToggle={() => toggle('dates')}>
        <label className="tp-kv">Start<input type="date" value={d.startDate} disabled={busy} onChange={e => void controller.saveField({ startDate: e.target.value })}/></label>
        <label className="tp-kv">Due<input type="date" value={d.dueDate} disabled={busy} onChange={e => void controller.saveField({ dueDate: e.target.value })}/></label></Prop>
      <Prop icon="star" label="Release" value={page?.release || 'Add…'} empty={!page?.release} open={open === 'release'} onToggle={() => toggle('release')}>
        <input autoFocus aria-label="Release" placeholder="e.g. Nabu" maxLength={60} value={release} disabled={busy || !page} onChange={e => setRelease(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setOpen(null); void controller.setRelease(release); } }} onBlur={() => { if ((release.trim() || null) !== (page?.release ?? null)) void controller.setRelease(release); }}/></Prop>
      <Prop icon="refresh" label="Repeats" tip="How often it runs by itself: never, every hour, every day, every week" value={sched ? <><span className="tp-repeat-word">{repeatWords(sched)}</span><small>{sched.paused ? 'paused' : `next ${nextWords(sched.nextRun)}`}</small></> : 'Never'} empty={!sched} open={open === 'repeat'} onToggle={() => toggle('repeat')}>
        <RepeatEditor controller={controller} busy={busy} current={sched} onDone={() => setOpen(null)}/></Prop>
    </Group>
    <Group title="People" side={<small>{people.length || ''}</small>}>
      <ul className="tp-people">{people.map(p => <li key={`${p.kind}:${p.id}`}><Face name={p.name} agent={p.kind === 'agent'} size={22}/><span className="tp-person">{p.name}</span>
        <select className="tp-role" aria-label={`What ${p.name} does`} value={p.role} disabled={busy} onChange={e => void controller.setPerson(p.kind, p.id, e.target.value as Role)}>{(ROLES as readonly Role[]).map(r => <option key={r} value={r}>{roleLabel[r]}</option>)}</select>
        <button type="button" className="tool tp-off" aria-label={`Take ${p.name} off the task`} title="Take off the task" disabled={busy} onClick={() => void controller.setPerson(p.kind, p.id, null)}><UiIcon name="close" size={12}/></button></li>)}</ul>
      <span className="tp-add-row"><select aria-label="Add a person or an agent" value="" disabled={busy || !page} onChange={e => { const [kind, ...rest] = e.target.value.split(':'); if (kind) void controller.setPerson(kind as 'user' | 'agent', rest.join(':'), 'does'); }}>
        <option value="">+ Add a person or an agent</option>
        <optgroup label="People">{(page?.team ?? []).filter(u => !people.some(p => p.kind === 'user' && p.id === u.id)).map(u => <option key={u.id} value={`user:${u.id}`}>{u.name}</option>)}</optgroup>
        <optgroup label="Agents">{s.agents.filter(a => !people.some(p => p.kind === 'agent' && p.id === a.id)).map(a => <option key={a.id} value={`agent:${a.id}`}>{a.name}</option>)}</optgroup></select>
        {me && !people.some(p => p.kind === 'user' && p.id === me) && <button type="button" className="link-button" disabled={busy || !page} onClick={() => void controller.setPerson('user', me, 'does')}>Take it myself</button>}</span>
    </Group>
    <Group title="Labels">
      <span className="board-labels">{card.labels.map(id => { const l = s.labels.find(x => x.id === id); return l ? <span key={id} className="board-label" data-color={l.color}>{l.name}</span> : null; })}
        <button type="button" className="tp-chip-add" aria-expanded={open === 'labels'} onClick={() => toggle('labels')}>+ Label</button></span>
      {open === 'labels' && <div className="tp-prop-edit">
        <span className="board-labels pick">{s.labels.map(l => <button key={l.id} type="button" className="board-label" data-color={l.color} aria-pressed={d.labels.includes(l.id)} disabled={busy}
          onClick={() => void controller.saveField({ labels: d.labels.includes(l.id) ? d.labels.filter(x => x !== l.id) : [...d.labels, l.id] })}>{l.name}</button>)}</span>
        <label className="tp-kv">Type<select value={d.type} disabled={busy} onChange={e => void controller.saveField({ type: e.target.value as CardType })}>{allCardTypes.map(x => <option key={x} value={x}>{cardTypeLabel[x]}</option>)}</select></label>
        <label className="tp-kv">Cover<select value={d.cover ?? ''} disabled={busy} onChange={e => void controller.saveField({ cover: (e.target.value || null) as BoardColor | null })}><option value="">None</option>{s.colors.map(c => <option key={c} value={c}>{colorLabel[c]}</option>)}</select></label>
      </div>}
    </Group>
    <Group title="Links" side={others.length > 0 && <button type="button" className="tool" aria-label="Make it wait for another task" title="Make it wait for another task" aria-expanded={open === 'link'} onClick={() => toggle('link')}><UiIcon name="plus" size={12}/></button>}>
      {open === 'link' && <select autoFocus aria-label="Waits for" value="" disabled={busy || !page} onChange={e => { if (e.target.value) { setOpen(null); void controller.setLink(e.target.value, true); } }}><option value="">Waits for…</option>{others.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select>}
      {page?.parent && <span className="tp-link"><UiIcon name="list" size={13}/>Part of <button type="button" className="link-button" onClick={() => void controller.reveal(page.parent!.boardId, page.parent!.id)}>{page.parent.title}</button></span>}
      {page?.waitsFor.map(w => <span key={w.id} className="tp-link" data-done={w.done || undefined}><UiIcon name="clock" size={13}/>Waits for <button type="button" className="link-button" onClick={() => void controller.reveal(w.boardId, w.id)}>{w.title}</button>
        <button type="button" className="tool tp-off" aria-label={`Stop waiting for ${w.title}`} title="Stop waiting for it" disabled={busy} onClick={() => void controller.setLink(w.id, false)}><UiIcon name="close" size={12}/></button></span>)}
      {page?.blocks.map(w => <span key={w.id} className="tp-link"><UiIcon name="alert" size={13}/>Holds up <button type="button" className="link-button" onClick={() => void controller.reveal(w.boardId, w.id)}>{w.title}</button></span>)}
      {page && page.subtasks.length > 0 && <><span className="tp-link"><UiIcon name="check" size={13}/>Sub-tasks<span className="tp-link-end"><progress max={page.subtasks.length} value={page.subtasks.filter(x => x.done).length} aria-label="Sub-tasks done"/>{page.subtasks.filter(x => x.done).length} of {page.subtasks.length}</span></span>
        <ul className="tp-subtasks">{page.subtasks.map(x => <li key={x.id} data-done={x.done || undefined}><button type="button" className="link-button" onClick={() => void controller.reveal(x.boardId, x.id)}>{x.title}</button></li>)}</ul></>}
      {page?.development && <span className="tp-link"><UiIcon name="branch" size={13}/>{page.development.branch}<span className="tp-link-end">{page.development.pr
        ? <a href={page.development.pr.url} target="_blank" rel="noreferrer" data-checks={page.development.pr.checks ?? undefined}>PR #{page.development.pr.number}{page.development.pr.checks === 'passing' ? ' ✓' : page.development.pr.checks === 'failing' ? ' ✗' : ''}</a> : 'no PR yet'}</span></span>}
      {page && !page.parent && !page.waitsFor.length && !page.blocks.length && !page.subtasks.length && !page.development && <small className="fine-print">No links yet.</small>}
    </Group>
    <Group title="Work" side={page && (page.files.count > 0 || page.spent.length > 0 || page.chats.length > 0) && <button type="button" className="link-button" aria-expanded={work} onClick={() => setWork(!work)}>{work ? 'Less' : 'Details'}</button>}>
      <span className="tp-link"><UiIcon name="file" size={13}/>Files changed<span className="tp-link-end">{page?.files.count ? <>{page.files.count} · <i className="tp-add">+{page.files.added}</i> <i className="tp-del">−{page.files.removed}</i></> : 'none'}</span></span>
      {work && page && page.files.paths.length > 0 && <small className="fine-print tp-paths">{page.files.paths.join(' · ')}</small>}
      <span className="tp-link"><UiIcon name="coin" size={13}/>Tokens<span className="tp-link-end">{tokensAll ? `${tokens(tokensAll)} · ${page?.spent.some(x => x.paid) ? 'some paid' : 'on your subscription'}` : 'none'}</span></span>
      {work && page?.spent.map(x => <span key={x.model} className="tp-link sub">{appOf(x.app) ? <AppLogo name={x.app} size={12}/> : <UiIcon name="cpu" size={12}/>}{x.app}<span className="tp-link-end">{tokens(x.tokens)}</span></span>)}
      <span className="tp-link"><UiIcon name="message" size={13}/>Chats<span className="tp-link-end">{page?.chats.length ?? 0}</span></span>
      {work && page?.chats.map(c => <button key={c.id} type="button" className="tp-chat" disabled={!onOpenChat} onClick={() => onOpenChat?.(c.id)}><UiIcon name="message" size={12}/>{c.title || 'Untitled chat'}</button>)}
      {card.taskFile && <span className="tp-link"><UiIcon name={card.taskFile.problem ? 'alert' : 'file'} size={13}/>Task file<span className="tp-link-end">{card.taskFile.no} · {card.taskFile.problem ? 'a line to fix' : 'up to date'}</span></span>}
    </Group>
    <div className="tp-follow"><span className="tp-faces">{people.slice(0, 6).map(p => <Face key={`${p.kind}:${p.id}`} name={p.name} agent={p.kind === 'agent'} size={22}/>)}</span>
      <button type="button" aria-pressed={!!page?.following} disabled={busy || !page} onClick={() => void controller.setFollow(!page?.following)}><UiIcon name="eye" size={13}/>{page?.following ? 'Following' : 'Follow'}</button>
      <span className="tp-menu"><Tool icon="more" label="More: archive" onClick={() => setMenu(!menu)}/>{menu && <span role="menu"><button role="menuitem" type="button" disabled={busy} onClick={() => { setMenu(false); void controller.archiveCard(); }}><UiIcon name="archive" size={13}/>Archive this task</button></span>}</span></div>
  </aside>;
}
