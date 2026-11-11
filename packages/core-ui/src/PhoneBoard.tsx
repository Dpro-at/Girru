/**
 * Phone boards P46–P50: the task board inside the Girru phone app's Tasks tab.
 * One column at a time (chips + swipe), hold a card for Move / Start / Chat /
 * Archive, a sheet for a new task and one for boards and filters. An open card
 * is the computer's own task page. Starting a task runs a model and archiving
 * hides it, so both ask the phone for Face ID first. Board settings, columns,
 * labels, templates and the Table / Workload views stay on the computer.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BoardController, Card } from './board';
import { cardsIn, matches, priorityLabel } from './board';
import { CalendarView } from './BoardViews';
import { TaskPage } from './BoardTaskPage';
import { Sheet } from './desktop-ui';
import { UiIcon } from './ui-icons';
import { phoneConfirm } from './phone-terminal-keys';

const HOLD_MS = 500;
const SWIPE_PX = 60;
const today = () => new Date().toISOString().slice(0, 10);
const shortDate = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function PhoneBoard({ controller, onOpenChat }: { controller: BoardController; onOpenChat: (id: string) => void }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [column, setColumn] = useState(''), [search, setSearch] = useState(false), [calendar, setCalendar] = useState(false);
  const [held, setHeld] = useState<Card | null>(null), [creating, setCreating] = useState(false), [boards, setBoards] = useState(false);
  const drafts = useRef(new Map<string, string>()), touch = useRef<{ x: number; y: number } | null>(null);
  const busy = s.phase === 'loading' || s.phase === 'saving';
  useEffect(() => { if (s.owner && !controller.hasUnsavedDraft()) void controller.load(s.boardId); }, [s.owner, controller]);
  const columns = s.columns.filter(c => c.name !== 'To sort' || s.cards.some(card => card.columnId === c.id));
  const current = columns.find(c => c.id === column) ?? columns[0];
  useEffect(() => { if (current && current.id !== column) setColumn(current.id); }, [current?.id]);
  const shown = (id: string) => cardsIn(s.cards, id).filter(c => !c.archived && matches(c, s.filter));
  const agentName = (id?: string) => s.agents.find(a => a.id === id)?.name;
  const step = (by: number) => { const i = columns.findIndex(c => c.id === current?.id); const next = columns[i + by]; if (next) setColumn(next.id); };

  /** Start and Archive work on the open card; open it first when the owner acts from the board. */
  async function onCard(card: Card, work: () => Promise<unknown>) { if (s.open !== card.id) await controller.openCard(card.id); await work(); }
  async function start(card: Card) {
    setHeld(null); if (!(await phoneConfirm('Start the task'))) return;
    await onCard(card, async () => { const id = await controller.continueTask(); if (id) onOpenChat(id); });
  }
  async function archive(card: Card) {
    setHeld(null); if (!(await phoneConfirm('Archive the task'))) return;
    await onCard(card, () => controller.archiveCard());
  }

  const open = s.cards.find(c => c.id === s.open);
  if (open && s.draft) return <section className="phone-board phone-board-task" aria-label="Task">
    <TaskPage key={open.id} card={open} controller={controller} busy={busy} onOpenChat={onOpenChat} draftCache={drafts.current} onBack={() => controller.closeCard()}/>
  </section>;

  return <section className="phone-board" aria-label="Task board">
    <header className="phone-board-bar">
      <button type="button" className="phone-board-name" onClick={() => setBoards(true)} aria-label={`Board: ${s.name || 'none'}. Change board or filter`}>
        <span className="board-swatch" data-color={s.meta?.color} aria-hidden="true"/><b>{s.name || 'Boards'}</b><UiIcon name="chevron" size={14}/>
      </button>
      <button type="button" className="tool" aria-label="Search cards" aria-pressed={search} onClick={() => { setSearch(v => !v); if (search) controller.setFilter({ text: '' }); }}><UiIcon name="search" size={19}/></button>
      <button type="button" className="tool" aria-label="Calendar" aria-pressed={calendar} onClick={() => setCalendar(v => !v)}><UiIcon name="calendar" size={19}/></button>
      <button type="button" className="tool phone-board-new" aria-label="New task" disabled={busy || !columns.length} onClick={() => setCreating(true)}><UiIcon name="plus" size={19}/></button>
    </header>
    {search && <label className="phone-board-search"><UiIcon name="search" size={15}/><input type="search" aria-label="Search cards" placeholder="Search tasks" autoFocus value={s.filter.text} onChange={e => controller.setFilter({ text: e.target.value })}/></label>}
    {(s.notice || s.phase === 'loading') && <p role="status" className="board-notice">{s.notice ?? 'Reading the board…'}</p>}
    {!s.boardId ? <div className="mcp-empty"><UiIcon name="board" size={28}/><p>{s.owner ? 'No board is open yet.' : 'Only the owner can use the company board.'}</p>{s.owner && <button type="button" disabled={busy} onClick={() => setBoards(true)}>Choose a board</button>}</div>
      : calendar ? <div className="phone-board-calendar"><CalendarView controller={controller}/></div>
      : <>
        <div className="phone-board-columns" role="tablist" aria-label="Columns">{columns.map(c => <button type="button" role="tab" key={c.id} aria-selected={c.id === current?.id} onClick={() => setColumn(c.id)}>{c.name}<span>{shown(c.id).length}</span></button>)}</div>
        <ol className="phone-board-cards" role="tabpanel" aria-label={current?.name}
          onTouchStart={e => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; }}
          onTouchEnd={e => { const from = touch.current, t = e.changedTouches[0]; touch.current = null; if (!from) return; const dx = t.clientX - from.x, dy = t.clientY - from.y; if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1); }}>
          {current && shown(current.id).map(card => <li key={card.id}><PhoneCard card={card} agent={agentName(card.agents[0])} onOpen={() => void controller.openCard(card.id)} onHold={() => setHeld(card)}/></li>)}
          {current && !shown(current.id).length && <li className="phone-board-empty">{s.filter.text || s.filter.agent || s.filter.department ? 'No task here matches the filter.' : `Nothing in ${current.name}.`}</li>}
          {columns.length > 1 && <li className="phone-board-hint">Swipe for the next column. Hold a task to move it.</li>}
        </ol>
      </>}
    {held && <Sheet title={held.title} onClose={() => setHeld(null)}>
      <div className="phone-board-menu" role="menu">
        <span className="phone-board-label">Move to</span>
        <div className="phone-board-columns">{columns.map(c => <button type="button" role="menuitemradio" key={c.id} aria-checked={c.id === held.columnId} disabled={busy} onClick={() => { const id = held.id; setHeld(null); if (c.id !== held.columnId) void controller.move(id, c.id, null); }}>{c.name}</button>)}</div>
        <button type="button" role="menuitem" disabled={busy || !!held.taskFile?.problem} onClick={() => void start(held)}><UiIcon name="play" size={16}/><span>Start now<small>{agentName(held.agents[0]) ?? 'The main agent'} starts on it with its model</small></span><UiIcon name="lock" size={14}/></button>
        {held.conversationId && <button type="button" role="menuitem" onClick={() => { const id = held.conversationId!; setHeld(null); onOpenChat(id); }}><UiIcon name="message" size={16}/><span>Open its chat</span></button>}
        <button type="button" role="menuitem" className="danger" disabled={busy} onClick={() => void archive(held)}><UiIcon name="archive" size={16}/><span>Archive this task<small>You can bring it back on the computer</small></span><UiIcon name="lock" size={14}/></button>
      </div>
    </Sheet>}
    {creating && <NewTask controller={controller} columns={columns} column={current?.id ?? ''} onClose={() => setCreating(false)}/>}
    {boards && <BoardsSheet controller={controller} onClose={() => setBoards(false)}/>}
  </section>;
}

function PhoneCard({ card, agent, onOpen, onHold }: { card: Card; agent?: string; onOpen: () => void; onHold: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), heldNow = useRef(false);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const overdue = !!card.dueDate && card.dueDate < today();
  const dep = card.departments[0];
  return <button type="button" className="phone-card" data-priority={card.priority}
    onPointerDown={() => { heldNow.current = false; clear(); timer.current = setTimeout(() => { heldNow.current = true; onHold(); }, HOLD_MS); }}
    onPointerUp={clear} onPointerLeave={clear} onPointerCancel={clear}
    onContextMenu={e => { e.preventDefault(); clear(); heldNow.current = true; onHold(); }}
    onClick={() => { if (heldNow.current) { heldNow.current = false; return; } onOpen(); }}>
    {dep && <span className="phone-card-dep">{dep}</span>}
    <b dir="auto">{card.title}</b>
    {card.blocked && <span className="phone-card-note">Blocked: see the handoff</span>}
    <span className="phone-card-meta">
      <span>{agent ?? 'Nobody yet'}</span>
      {card.priority !== 'normal' && <span>{priorityLabel[card.priority]}</span>}
      {card.checklist.total > 0 && <span>{card.checklist.done} of {card.checklist.total}</span>}
      {card.dueDate && <span data-overdue={overdue || undefined}>due {shortDate(card.dueDate)}</span>}
    </span>
  </button>;
}

function NewTask({ controller, columns, column, onClose }: { controller: BoardController; columns: readonly { id: string; name: string }[]; column: string; onClose: () => void }) {
  const s = controller.getSnapshot();
  const [title, setTitle] = useState(''), [details, setDetails] = useState(''), [agent, setAgent] = useState(''), [due, setDue] = useState(''), [target, setTarget] = useState(column), [saving, setSaving] = useState(false);
  const close = () => { const el = document.activeElement; if (el instanceof HTMLElement) el.blur(); onClose(); };
  async function add() {
    if (saving || !title.trim()) return; setSaving(true);
    try {
      const before = new Set(controller.getSnapshot().cards.map(c => c.id));
      if (!(await controller.addCard(target, title))) return;
      const made = controller.getSnapshot().cards.find(c => !before.has(c.id));
      // Details, who and due are saved on the new card right away (adding never starts the agent).
      if (made && (details.trim() || agent || due)) {
        await controller.openCard(made.id);
        controller.editDraft({ ...(details.trim() ? { description: details.trim() } : {}), ...(agent ? { agents: [agent] } : {}), ...(due ? { dueDate: due } : {}) });
        await controller.saveCard(true); controller.closeCard();
      }
      close();
    } finally { setSaving(false); }
  }
  return <Sheet title="New task" onClose={close} actions={<><button type="button" onClick={close}>Cancel</button><button type="button" className="primary" disabled={saving || !title.trim() || !target} onClick={() => void add()}>{saving ? 'Adding…' : `Add to ${s.name ?? 'the board'}`}</button></>}>
    <div className="phone-board-form">
      <label>Title<input autoFocus maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs to be done?"/></label>
      <label>Details (optional)<textarea rows={3} maxLength={5000} value={details} onChange={e => setDetails(e.target.value)}/></label>
      <div className="phone-board-two">
        <label>Who does it<select value={agent} onChange={e => setAgent(e.target.value)}><option value="">Nobody yet</option>{s.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>Due<input type="date" value={due} onChange={e => setDue(e.target.value)}/></label>
      </div>
      <label>Column<select value={target} onChange={e => setTarget(e.target.value)}>{columns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <p className="meeting-fine">Adding does not start the agent. Start it from the task.</p>
    </div>
  </Sheet>;
}

function BoardsSheet({ controller, onClose }: { controller: BoardController; onClose: () => void }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const departments = [...new Set(s.cards.flatMap(c => c.departments))].sort();
  const live = s.boards.filter(b => !b.archived && b.departmentActive !== false);
  return <Sheet title="Boards" onClose={onClose} actions={<button type="button" className="primary" onClick={onClose}>Done</button>}>
    <div className="phone-board-form">
      <div className="phone-board-list" role="listbox" aria-label="Boards">{live.map(b => <button type="button" role="option" key={b.id} aria-selected={b.id === s.boardId} onClick={() => { void controller.openBoard(b.id); onClose(); }}><span className="board-swatch" data-color={b.color} aria-hidden="true"/><span>{b.name}</span>{b.id === s.boardId && <UiIcon name="check" size={16}/>}</button>)}</div>
      <label>Show tasks of<select value={s.filter.agent} onChange={e => controller.setFilter({ agent: e.target.value })}><option value="">Everyone</option>{s.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      {departments.length > 0 && <label>Department<select value={s.filter.department} onChange={e => controller.setFilter({ department: e.target.value })}><option value="">All departments</option>{departments.map(d => <option key={d}>{d}</option>)}</select></label>}
      <p className="meeting-fine">New boards, columns, colours and templates are made on the computer.</p>
    </div>
  </Sheet>;
}
