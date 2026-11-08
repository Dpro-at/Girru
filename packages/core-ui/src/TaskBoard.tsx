import {ComputerExecutionBadge} from './ComputerDevices';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DragEvent, ReactNode } from 'react';
import {createPortal} from 'react-dom';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';
import { cardTypeLabel, cardsIn, matches, priorityLabel, repeatWords } from './board';
import type { BoardColor, BoardController, BoardSummary, Card, CardType, Column } from './board';
import { Icon } from './icons';
import { CalendarView, TableView, ViewSwitch, WorkloadView } from './BoardViews';
import { TaskFileMark, TaskHandoffMark } from './BoardTaskFile';
import { TaskPage } from './BoardTaskPage';
import type { MemoryTarget } from './BoardTaskLinks';
import type { BoardView } from './BoardViews';

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => w.slice(0, 1).toUpperCase()).join('') || '?';
const DRAG_TYPE = 'application/x-dpro-card';

const kindLabel = { company: 'Whole company', department: 'Department', shared: 'Shared' } as const;
const typeMark: Record<CardType, UiIconName> = {task:'check',idea:'sun',bug:'alert',milestone:'pin',request:'message'};
const colorLabel: Record<BoardColor, string> = { blue: 'Blue', green: 'Green', orange: 'Orange', red: 'Red', purple: 'Purple', pink: 'Pink', teal: 'Teal', gray: 'Gray' };

/** The company's boards: a list of boards (company, per department, shared), the open board's columns, and a card panel. */
export function TaskBoard({controller,active=false,onOpenChat,onOpenMemory,sidebarSlot}:{controller:BoardController;active?:boolean;onOpenChat?:(id:string)=>void;onOpenMemory?:(to:MemoryTarget)=>void;sidebarSlot?:HTMLElement|null}){
 const s=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 const [mode,setMode]=useState<'board'|'new'|'settings'|'column'|'task'>('board'),[view,setView]=useState<BoardView>('board'),[menu,setMenu]=useState(false),[filters,setFilters]=useState(false),[newColumn,setNewColumn]=useState(''),[title,setTitle]=useState(''),[target,setTarget]=useState('');
 const search=useRef<HTMLInputElement>(null),popup=useRef<HTMLDivElement>(null),commentDrafts=useRef(new Map<string,string>());
 useEffect(()=>{if(!s.owner)commentDrafts.current.clear();},[s.owner]);
 const busy=s.phase==='loading'||s.phase==='saving',departments=[...new Set(s.cards.flatMap(c=>c.departments))].sort(),openCard=s.cards.find(c=>c.id===s.open);
 // TASKLOG-01: the projects whose task files fill this board, the apps that worked on its tasks.
 const fileProjects=[...new Set(s.cards.flatMap(c=>c.taskFile?[c.taskFile.projectName]:[]))].sort(),fileProblems=s.cards.filter(c=>c.taskFile?.problem).length,apps=[...new Set(s.cards.flatMap(c=>c.taskFile?.apps??[]))].sort();
 useEffect(()=>{if(active&&s.owner&&!controller.hasUnsavedDraft())void controller.load(s.boardId);},[active,s.owner,controller]);
 useEffect(()=>{if(!menu)return;const close=(e:PointerEvent)=>{if(!popup.current?.contains(e.target as Node))setMenu(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[menu]);
 const rail=<BoardRail controller={controller} onNew={()=>setMode('new')} onPick={id=>{setMode('board');void controller.openBoard(id);}} busy={busy}/>;
 return <section aria-label="Task board" className={`board board-desktop ${openCard?'board-page-open':''} ${sidebarSlot?'board-portal':''}`} data-color={s.meta?.color} onKeyDown={e=>{if(!active)return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){e.preventDefault();search.current?.focus();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='n'){e.preventDefault();setMode('task');}if(e.key==='Escape')setMenu(false);}}>
 {sidebarSlot?(active?createPortal(rail,sidebarSlot):null):rail}
 <div className="board-main">{openCard&&s.draft?<TaskPage key={openCard.id} card={openCard} controller={controller} busy={busy} onOpenChat={onOpenChat} onOpenMemory={onOpenMemory} draftCache={commentDrafts.current} onBack={()=>controller.closeCard()}/>:<><header className="board-commandbar"><span className="board-swatch" data-color={s.meta?.color} aria-hidden="true"/><h2>{s.name||'Boards'}</h2>{fileProjects.length>0&&<span className="task-file-board" title={`Tasks on this board come from the task file of ${fileProjects.join(', ')} (.girru/tasks.md). Changes here are written back to it.`}><UiIcon name="file" size={13}/>Task file: {fileProjects.join(', ')}{fileProblems>0&&<span className="task-file-badge" title={`${fileProblems} tasks have a line to fix in the file`}>{fileProblems}</span>}</span>}<span className="dk-segmented board-kind" role="group" aria-label="Show tasks">{(['all','tasks','scheduled'] as const).map(k=><button key={k} type="button" aria-pressed={(s.filter.kind??'all')===k} onClick={()=>controller.setFilter({kind:k})}>{k==='all'?'All':k==='tasks'?'Tasks':'Scheduled'}</button>)}</span><label className="mcp-search"><UiIcon name="search" size={14}/><input ref={search} type="search" aria-label="Search cards" placeholder="Search tasks" value={s.filter.text} onChange={e=>controller.setFilter({text:e.target.value})}/></label><ViewSwitch view={view} onChange={setView}/><button className={openCard?'':'primary'} disabled={busy||!s.columns.length} onClick={()=>{setTitle('');setTarget(s.columns[0]?.id??'');setMode('task');}}><UiIcon name="plus" size={16}/>New task</button><button className="mcp-command" aria-label="Filter tasks" title="Filter tasks by agent, department or app" aria-pressed={filters} onClick={()=>setFilters(v=>!v)}><UiIcon name="sliders" size={17}/></button><div className="mcp-menu" ref={popup}><button className="mcp-command" aria-label="Board actions" title="Board actions" aria-expanded={menu} onClick={()=>setMenu(v=>!v)}><UiIcon name="more" size={18}/></button>{menu&&<div role="menu"><button role="menuitem" disabled={busy} onClick={()=>{setMode('new');setMenu(false);}}>New board…</button><button role="menuitem" disabled={busy||!s.boardId} onClick={()=>{setMode('column');setMenu(false);}}>Add column…</button><button role="menuitem" disabled={busy||!s.meta} onClick={()=>{setMode('settings');setMenu(false);}}>Board settings…</button><button role="menuitem" disabled={busy} onClick={()=>{setMenu(false);void controller.load(s.boardId);}}>Reload board</button><button role="menuitem" onClick={()=>{setMenu(false);controller.setFilter({text:'',agent:'',department:''});}}>Clear filters</button></div>}</div></header>
 {filters&&<div className="board-filterbar" role="search"><label>Assigned agent<select aria-label="Filter by agent" value={s.filter.agent} onChange={e=>controller.setFilter({agent:e.target.value})}><option value="">All agents</option>{s.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Department<select aria-label="Filter by department" value={s.filter.department} onChange={e=>controller.setFilter({department:e.target.value})}><option value="">All departments</option>{departments.map(d=><option key={d}>{d}</option>)}</select></label>{apps.length>0&&<label>App<select aria-label="Filter by app" value={s.filter.app??''} onChange={e=>controller.setFilter({app:e.target.value})}><option value="">All apps</option>{apps.map(a=><option key={a}>{a}</option>)}</select></label>}<button onClick={()=>controller.setFilter({agent:'',department:'',app:''})}>Clear filters</button></div>}
 {(s.notice||s.phase==='loading')&&<p role="status" className="board-notice">{s.notice??'Reading the board…'}</p>}
 {s.boardId&&<RelatedTasks controller={controller}/>}
 {!s.boardId?<div className="mcp-empty"><UiIcon name="board" size={28}/><p>{s.owner?'Open a board to organise tasks and assign work.':'Only the owner can use the company board.'}</p>{s.owner&&<button disabled={busy} onClick={()=>void controller.load()}>Open the boards</button>}</div>:<div className="board-view-content" id="board-view-content" role="tabpanel" aria-labelledby={`board-view-${view}`}>{view==='board'&&<div className="board-columns">{s.columns.filter(col=>col.name!=='To sort'||s.cards.some(c=>c.columnId===col.id)).map(col=><BoardColumn key={col.id} col={col} controller={controller} busy={busy}/>)}{!s.columns.length&&<div className="mcp-empty"><p>Add a column to start organising tasks.</p><button onClick={()=>setMode('column')}>Add column</button></div>}</div>}{view==='table'&&<TableView controller={controller} busy={busy}/>}{view==='calendar'&&<CalendarView controller={controller}/>}{view==='workload'&&<WorkloadView controller={controller}/>}</div>}
 </>}</div>
 {mode!=='board'&&<BoardSheet title={mode==='new'?'New board':mode==='settings'?'Board settings':mode==='column'?'Add column':'New task'} onClose={()=>{if(!busy)setMode('board');}}>{mode==='new'?<NewBoardForm controller={controller} busy={busy} onDone={()=>setMode('board')}/>:mode==='settings'&&s.meta?<BoardSettings controller={controller} busy={busy} onDone={()=>setMode('board')}/>:mode==='column'?<form className="board-form" onSubmit={e=>{e.preventDefault();void controller.addColumn(newColumn).then(ok=>{if(ok){setNewColumn('');setMode('board');}});}}><label>Column name<input autoFocus value={newColumn} maxLength={60} onChange={e=>setNewColumn(e.target.value)}/></label><button className="primary" disabled={busy||!newColumn.trim()}>Add column</button>{s.notice&&<p role="status">{s.notice}</p>}</form>:<form className="board-form" onSubmit={e=>{e.preventDefault();void controller.addCard(target||s.columns[0]?.id,title).then(ok=>{if(ok){setTitle('');setMode('board');}});}}><label>Task title<input autoFocus value={title} maxLength={200} onChange={e=>setTitle(e.target.value)} placeholder="What needs to be done?"/></label><label>Status<select value={target||s.columns[0]?.id} onChange={e=>setTarget(e.target.value)}>{s.columns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><p className="fine-print">Create the task, then open it to add its description, assignees, dates and checklist.</p><button className="primary" disabled={busy||!title.trim()||!s.columns.length}>Create task</button>{s.notice&&<p role="status">{s.notice}</p>}</form>}</BoardSheet>}
 </section>;
}
function RelatedTasks({controller}:{controller:BoardController}){
 const s=controller.getSnapshot(),[query,setQuery]=useState('');const rows=(s.overview?.tasks??[]).filter(t=>`${t.title} ${t.boardName} ${t.status}`.toLowerCase().includes(query.trim().toLowerCase()));
 return <details className="board-related" open={s.meta?.kind==='company'}><summary><UiIcon name="board" size={14}/>{s.meta?.kind==='company'?'Across departments':'Related department tasks'}<button className="tool" aria-label="Refresh related tasks" title="Refresh related tasks" disabled={s.phase==='loading'||s.phase==='saving'} onClick={e=>{e.preventDefault();e.stopPropagation();void controller.refreshOverview();}}><UiIcon name="reconnect" size={14}/></button></summary><div><p>Opens the original task and its board. Status and comments stay in one place.</p>{s.overviewError?<p role="status">Related tasks could not be loaded. Refresh to try again.</p>:!s.overview?<p role="status">Reading related tasks…</p>:<>{s.overview.tasks.length>8&&<input type="search" aria-label="Search related tasks" placeholder="Search related tasks" value={query} onChange={e=>setQuery(e.target.value)}/>}<ul>{rows.map(t=><li key={t.cardId}><button onClick={()=>void controller.reveal(t.boardId,t.cardId)}><strong>{t.title}</strong><span>{t.boardName} · {t.status}</span></button></li>)}</ul>{!rows.length&&<p>{query?'No related tasks match.':s.meta?.kind==='company'?'Tasks from department and shared boards appear here.':'Tasks linked to this department from other boards appear here.'}</p>}{s.overview.limited&&<p>Showing the latest 500 of {s.overview.total} tasks. Open individual boards for all their work.</p>}</>}</div></details>;
}
function BoardSheet({title,children,onClose}:{title:string;children:ReactNode;onClose:()=>void}){const dialog=useRef<HTMLDialogElement>(null);useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);return <dialog ref={dialog} className="mcp-sheet board-sheet" aria-label={title} onKeyDown={e=>e.stopPropagation()} onCancel={e=>{e.preventDefault();onClose();}}><header><h2>{title}</h2><button className="tool" aria-label={`Close ${title}`} onClick={onClose}><UiIcon name="close" size={17}/></button></header><div className="mcp-sheet-body">{children}</div></dialog>;}

/** Boards grouped: whole company, each department, shared by departments. */
function BoardRail({ controller, onNew, onPick, busy }: { controller: BoardController; onNew: () => void; onPick: (id: string) => void; busy: boolean }) {
  const s = controller.getSnapshot();
  const company = s.boards.filter(b => b.kind === 'company');
  const past=s.boards.filter(b=>b.managedDepartment&&b.departmentActive===false);
  const byDep = new Map<string, BoardSummary[]>();
  for (const b of s.boards.filter(x => x.kind === 'department'&&x.departmentActive!==false)) byDep.set(b.departments[0], [...(byDep.get(b.departments[0]) ?? []), b]);
  const shared = s.boards.filter(b => b.kind === 'shared');
  const item = (b: BoardSummary) => <li key={b.id}>
    <button type="button" className="board-rail-item" aria-current={b.id === s.boardId ? 'page' : undefined} disabled={busy} onClick={() => onPick(b.id)} title={b.description || b.name}>
      <span className="board-swatch small" data-color={b.color} aria-hidden="true"/><span className="board-rail-name">{b.name.charAt(0).toUpperCase()+b.name.slice(1)}</span>{(b.toSort??0)>0&&<span className="task-file-badge" title={`${b.toSort} tasks from project files wait in To sort: drag each to its board`}>{b.toSort}</span>}{b.cards>0&&<span className="board-count">{b.cards}</span>}
    </button>
  </li>;
  return <nav className="board-rail" aria-label="Boards">
    <button type="button" className="board-new" disabled={busy} onClick={onNew}><UiIcon name="plus" size={15}/>New board</button>
    {company.length > 0 && <><p className="board-rail-label">Whole company</p><ul>{company.map(item)}</ul></>}
    {[...byDep.keys()].sort().map(dep => <div key={dep}><p className="board-rail-label">{dep}</p><ul>{byDep.get(dep)!.map(item)}</ul></div>)}
    {shared.length > 0 && <><p className="board-rail-label">Shared by departments</p><ul>{shared.map(item)}</ul></>}{past.length>0&&<><p className="board-rail-label">Past departments</p><ul>{past.map(item)}</ul></>}
  </nav>;
}

function ColorPicker({ value, onChange, colors }: { value: BoardColor; onChange: (c: BoardColor) => void; colors: readonly BoardColor[] }) {
  return <div className="board-colors" role="radiogroup" aria-label="Board colour">{colors.map(c =>
    <label key={c} className="board-color" title={colorLabel[c]}>
      <input type="radio" name="board-color" aria-label={colorLabel[c]} checked={value === c} onChange={() => onChange(c)}/>
      <span className="board-swatch" data-color={c} aria-hidden="true"/>
    </label>)}
  </div>;
}

function DepartmentsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [dep, setDep] = useState('');
  const add = () => { const d = dep.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(); if (d && !value.includes(d) && value.length < 12) onChange([...value, d]); setDep(''); };
  return <div className="board-panel-deps">
    <span className="board-chips">{value.map(x => <span key={x} className="board-chip">{x} <button type="button" aria-label={`Remove ${x}`} onClick={() => onChange(value.filter(v => v !== x))}><UiIcon name="close" size={13}/></button></span>)}
      {value.length === 0 && <span className="fine-print">None — the board is for the whole company.</span>}</span>
    <div className="board-inline"><input aria-label="Add a department" placeholder="e.g. marketing" maxLength={64} value={dep} onChange={e => setDep(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}/><button type="button" disabled={!dep.trim()} onClick={add}>Add</button></div>
  </div>;
}

function NewBoardForm({ controller, busy, onDone }: { controller: BoardController; busy: boolean; onDone: () => void }) {
  const s = controller.getSnapshot();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState(s.templates[0]?.id ?? 'kanban');
  const [color, setColor] = useState<BoardColor>('blue');
  const [deps, setDeps] = useState<string[]>([]);
  return <form className="board-form" aria-label="New board" onSubmit={e => { e.preventDefault(); void controller.createBoard({ name, description, template, color, departments: deps }).then(ok => { if (ok) onDone(); }); }}>
    <h2>New board</h2>
    {s.notice && <p role="status" className="board-notice">{s.notice}</p>}
    <label>Name<input value={name} maxLength={80} placeholder="e.g. Marketing content" onChange={e => setName(e.target.value)}/></label>
    <label>Description <small className="fine-print">(optional)</small><input value={description} maxLength={500} onChange={e => setDescription(e.target.value)}/></label>
    <fieldset className="board-templates"><legend>Start from a template</legend>
      {s.templates.map(t => <label key={t.id} className="board-template" data-on={template === t.id || undefined}>
        <input type="radio" name="board-template" checked={template === t.id} onChange={() => setTemplate(t.id)}/>
        <span><strong>{t.name}</strong><small>{t.description}</small><span className="board-template-cols">{t.columns.map(c => <span key={c}>{c}</span>)}</span></span>
      </label>)}
    </fieldset>
    <fieldset className="board-fieldset"><legend>Colour</legend><ColorPicker value={color} onChange={setColor} colors={s.colors}/></fieldset>
    <fieldset className="board-fieldset"><legend>Departments</legend><p className="fine-print">One department makes it that team's board; several make it a shared board.</p><DepartmentsInput value={deps} onChange={setDeps}/></fieldset>
    <div className="hire-actions"><button type="submit" className="primary" disabled={busy || !name.trim()}>Create board</button><button type="button" disabled={busy} onClick={onDone}>Cancel</button></div>
  </form>;
}

function BoardSettings({ controller, busy, onDone }: { controller: BoardController; busy: boolean; onDone: () => void }) {
  const m = controller.getSnapshot().meta!;
  const colors = controller.getSnapshot().colors;
  const [name, setName] = useState(m.name);
  const [description, setDescription] = useState(m.description);
  const [color, setColor] = useState<BoardColor>(m.color);
  const [deps, setDeps] = useState<string[]>([...m.departments]);
  const [confirmArchive, setConfirmArchive] = useState(false);
  return <form className="board-form" aria-label="Board settings" onSubmit={e => { e.preventDefault(); void controller.updateBoard({ name, description, color, departments: deps }).then(ok => { if (ok) onDone(); }); }}>
    <h2>Board settings</h2>
    {controller.getSnapshot().notice && <p role="status" className="board-notice">{controller.getSnapshot().notice}</p>}
    <label>Name<input value={name} maxLength={80} onChange={e => setName(e.target.value)}/></label>
    <label>Description<input value={description} maxLength={500} onChange={e => setDescription(e.target.value)}/></label>
    <fieldset className="board-fieldset"><legend>Colour</legend><ColorPicker value={color} onChange={setColor} colors={colors}/></fieldset>
    <fieldset className="board-fieldset" disabled={m.managedDepartment}><legend>Departments</legend>{m.managedDepartment&&<p className="fine-print">Linked to the company department. Rename the department at its source; this board keeps its tasks and customised columns.</p>}<DepartmentsInput value={deps} onChange={setDeps}/></fieldset>
    <div className="hire-actions"><button type="submit" className="primary" disabled={busy}>Save</button><button type="button" disabled={busy} onClick={onDone}>Cancel</button></div>
    <fieldset className="board-fieldset danger"><legend>Archive this board</legend>
      <p className="fine-print">The board and its cards are kept but hidden from the list and from agents.</p>
      <label className="check"><input type="checkbox" checked={confirmArchive} onChange={e => setConfirmArchive(e.target.checked)}/> I want to archive “{m.name}”</label>
      <button type="button" disabled={busy || !confirmArchive} onClick={() => void controller.updateBoard({ archived: true }).then(ok => { if (ok) onDone(); })}>Archive board</button>
    </fieldset>
  </form>;
}

function BoardColumn({ col, controller, busy }: { col: Column; controller: BoardController; busy: boolean }) {
  const s = controller.getSnapshot();
  const cards = cardsIn(s.cards, col.id).filter(c => matches(c, s.filter));
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent, before: string | null) => {
    e.preventDefault(); e.stopPropagation(); setOver(false);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (id) void controller.move(id, col.id, before);
  };
  return <section className="board-column" aria-label={col.name} data-over={over || undefined}
    onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={e => drop(e, null)}>
    <header className="board-column-head">
      {renaming === null
        ? <><h3>{col.name}</h3><span className="board-count">{cards.length}</span>
          <button type="button" className="board-ghost" aria-label={`Rename ${col.name}`} disabled={busy} onClick={() => setRenaming(col.name)}><UiIcon name="pencil" size={13}/></button></>
        : <form className="board-rename" onSubmit={e => { e.preventDefault(); void controller.renameColumn(col.id, renaming).then(ok => { if (ok) setRenaming(null); }); }}>
          <input aria-label="Column name" value={renaming} maxLength={60} autoFocus onChange={e => setRenaming(e.target.value)}/>
          <button type="submit" disabled={busy}>Save</button><button type="button" onClick={() => setRenaming(null)}>Cancel</button>
        </form>}
    </header>
    <ol className="board-cards">
      {cards.map(card => <li key={card.id} onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault(); }} onDrop={e => drop(e, card.id)}>
        <CardTile card={card} controller={controller}/>
      </li>)}
    </ol>
    {adding
      ? <form className="board-new-card" onSubmit={e => { e.preventDefault(); const text = title; if (!text.trim()) return;
        // Clear at once so the next title can be typed while this one saves; put it back if it was not added.
        setTitle(''); void controller.addCard(col.id, text).then(ok => { if (!ok) setTitle(cur => cur || text); }); }}>
        <input aria-label={`New card in ${col.name}`} placeholder="What needs to be done? (Enter adds, Esc closes)" maxLength={200} value={title} autoFocus
          onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } if (e.key === 'Escape') setAdding(false); }}/>
        <div className="board-new-actions"><button type="submit" className="primary" disabled={busy || !title.trim()}>Add card</button><button type="button" onClick={() => { setAdding(false); setTitle(''); }}>Cancel</button></div>
      </form>
      : <button type="button" className="board-add-card" disabled={busy} onClick={() => setAdding(true)}><UiIcon name="plus" size={14}/>Add task</button>}
  </section>;
}

function CardTile({ card, controller }: { card: Card; controller: BoardController }) {
  const overdue = card.dueDate !== null && card.dueDate < new Date().toISOString().slice(0, 10);
  return <article className="board-card" data-priority={card.priority} data-repeat={card.repeat ? true : undefined} draggable
    onDragStart={e => { e.dataTransfer.setData(DRAG_TYPE, card.id); e.dataTransfer.effectAllowed = 'move'; }}>
    {card.cover && <span className="board-cover" data-color={card.cover} aria-hidden="true"/>}
    <button type="button" className="board-card-open" onClick={() => void controller.openCard(card.id)} aria-label={`Open ${cardTypeLabel[card.type].toLowerCase()} ${card.title}`}>
      {card.labels.length > 0 && <span className="board-labels">{card.labels.map(id => { const l = controller.getSnapshot().labels.find(x => x.id === id); return l ? <span key={id} className="board-label" data-color={l.color}>{l.name}</span> : null; })}</span>}
      {card.departments.length > 0 && <span className="board-chips">{card.departments.map(d => <span key={d} className="board-chip">{d}</span>)}</span>}
      <span className="board-card-title">{card.type !== 'task' && <span className={`board-type t-${card.type}`} title={cardTypeLabel[card.type]}><UiIcon name={typeMark[card.type]} size={13}/> {cardTypeLabel[card.type]}</span>}{card.title}</span>
      <ComputerExecutionBadge sessionId={card.conversationId} cardId={card.id}/><span className="board-card-meta">
        {card.priority !== 'normal' && <span className={`board-priority p-${card.priority}`}>{priorityLabel[card.priority]}</span>}
        {card.startDate && <span className="board-due">From {card.startDate}</span>}
        {card.dueDate && <span className={overdue ? 'board-due overdue' : 'board-due'}>Due {card.dueDate}</span>}
        {card.checklist.total > 0 && <span className={card.checklist.done === card.checklist.total ? 'board-check complete' : 'board-check'} aria-label={`Checklist ${card.checklist.done} of ${card.checklist.total}`}><UiIcon name="check" size={12}/>{card.checklist.done}/{card.checklist.total}</span>}
        {card.comments > 0 && <span className="board-comments" aria-label={`${card.comments} comments`}><Icon name="message-circle"/>{card.comments}</span>}
        {card.taskFile && <TaskFileMark mark={card.taskFile}/>}
        <TaskHandoffMark count={card.handoffCount} blocked={card.blocked}/>
        {card.repeat && <span className="board-repeat" title={card.repeat.paused ? 'Repeats, paused' : `Repeats: ${repeatWords(card.repeat)}`}><UiIcon name="refresh" size={11}/>{repeatWords(card.repeat)}{card.repeat.paused ? ' · paused' : ''}{card.repeat.lastResult === 'failed' ? ' · last run failed' : ''}</span>}
        <span className="board-avatars">{card.agents.slice(0, 4).map(a => <span key={a} className="board-avatar" title={controller.agentName(a)}>{initials(controller.agentName(a))}</span>)}
          {card.agents.length > 4 && <span className="board-avatar more">+{card.agents.length - 4}</span>}</span>
      </span>
    </button>
  </article>;
}
