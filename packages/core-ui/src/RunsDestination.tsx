import {ComputerRunsRows} from './ComputerActivity';
import {ComputerExecutionBadge} from './ComputerDevices';
import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {SessionClient} from './session';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';
import {ScheduledJobInspector} from './ScheduledTasks';
import {ScheduleTaskSheet} from './ScheduleTaskSheet';
import type {AgentChoice,ModelOption,Project} from './conversations';
import {ScheduleSheet} from './ScheduleSheet';
import {useStoreP8} from './store-switches';
import {runNotesRef} from './task-links';
import {RunWorkingNotes} from './RunNotes';

/**
 * RUNS-01 (boards RN1–RN5): everything that runs in Girru, in one footer section. The sidebar
 * holds the places (Running now, Waiting, Scheduled, Finished, Failed or stopped) and a filter
 * by agent or project; the list stays quiet; the selected run's details, steps, log, result and
 * why it stopped show in the inspector. Scheduled holds system jobs (the old Settings › Scheduled
 * tasks, every control kept), chat schedules, card schedules and agent check-ins.
 */
export type RunsPlace='running'|'waiting'|'scheduled'|'finished'|'failed';
type RunKind='chat'|'task'|'helper'|'code'|'job'|'handoff';
type RunState='working'|'queued'|'waiting'|'done'|'failed'|'stopped';
type Reason={code:string;title:string;text:string;bug:boolean;detail?:string};
export type RunItem={id:string;kind:RunKind;title:string;state:RunState;reason:Reason|null;agentId:string|null;agentName:string|null;app:string|null;model:string|null;projectId:string|null;projectName:string|null;startedBy:string;startedAt:string|null;endedAt:string|null;needsYou:boolean;parentId:string|null;link:{sessionId?:string;jobId?:string;taskRunId?:string;approvalId?:string}};
type Step={title:string;meta:string;state:'done'|'now'|'wait'|'fail'|'skip'};
type Detail={run:RunItem;subtasks:RunItem[];subNotice:Reason|null;steps:Step[];log:Array<{at:string;text:string}>;result:{text:string|null;tokensIn:number|null;tokensOut:number|null;costCents:number|null};copy:string};
type ScheduleKind='job'|'chatsch'|'cardsch'|'checkin';
type Schedule={id:string;kind:ScheduleKind;title:string;when:string;enabled:boolean;nextRun:string|null;lastRun:string|null;lastResult:'done'|'failed'|'skipped'|null;lastReason:Reason|null;agentId:string|null;agentName:string|null;link:{jobId?:string;sessionId?:string;boardId?:string;cardId?:string;agentId?:string;runId?:string}};

export const RUN_PLACES:ReadonlyArray<{id:RunsPlace;label:string;icon:UiIconName}>=[
 {id:'running',label:'Running now',icon:'play'},{id:'waiting',label:'Waiting',icon:'hourglass'},{id:'scheduled',label:'Scheduled',icon:'calendar'},{id:'finished',label:'Finished',icon:'check'},{id:'failed',label:'Failed or stopped',icon:'alert'}];
const KIND:Record<RunKind|ScheduleKind,{icon:UiIconName;label:string}>={chat:{icon:'message',label:'Chat reply'},task:{icon:'board',label:'Agent task'},helper:{icon:'sub-agent',label:'Small helper'},code:{icon:'code',label:'Coding app'},job:{icon:'server',label:'System job'},handoff:{icon:'handoff',label:'Hand-off'},chatsch:{icon:'message',label:'Chat schedule'},cardsch:{icon:'board',label:'Task'},checkin:{icon:'clock',label:'Agent check-in'}};
const STATE:Record<RunState,{label:string;tone:string}>={working:{label:'Working',tone:'live'},queued:{label:'Next in line',tone:'off'},waiting:{label:'Waits for you',tone:'warn'},done:{label:'Done',tone:'ready'},failed:{label:'Failed',tone:'bad'},stopped:{label:'Stopped',tone:'off'}};
const EMPTY:Record<RunsPlace,string>={running:'Nothing is running. When an agent works, it shows here.',waiting:'Nothing waits for you.',scheduled:'No schedules yet. A schedule runs a task for you at a set time.',finished:'Finished runs show here.',failed:'Nothing failed or stopped.'};
const STARTED:Record<string,string>={you:'You',schedule:'Its schedule',card:'A board card',approval:'Your OK',agent:'An agent',system:'Its schedule',manual:'You (Run now)'};
const LIVE_MS=4000;

const at=(iso:string|null)=>{if(!iso)return '';const d=new Date(iso),now=new Date();const same=d.toDateString()===now.toDateString();return same?d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}):d.toLocaleDateString(undefined,{month:'short',day:'numeric'});};
const since=(iso:string|null)=>{if(!iso)return '';const s=Math.max(0,Math.round((Date.now()-Date.parse(iso))/1000));return s<60?`${s} s`:s<3600?`${Math.round(s/60)} min`:`${Math.round(s/3600)} h`;};
const span=(a:string|null,b:string|null)=>{if(!a)return '';const ms=(b?Date.parse(b):Date.now())-Date.parse(a);const s=Math.max(0,Math.round(ms/1000));return s<60?`${s} s`:s<3600?`${Math.round(s/60)} min`:`${(s/3600).toFixed(1)} h`;};
const full=(iso:string|null)=>iso?new Date(iso).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'—';
/** "Claude Code" and subscription:claude-code are one thing; show the model only when it says more. */
const sameApp=(app:string|null,model:string)=>!!app&&model.replace(/^(subscription|local|ollama):/,'').replace(/[-_]/g,' ').toLowerCase()===app.toLowerCase();
const initial=(name:string|null)=>(name||'?').trim().slice(0,1).toUpperCase();
const hue=(id:string|null)=>{let h=0;for(const c of id??'girru')h=(h*31+c.charCodeAt(0))%360;return h;};
function Face({id,name,size=20}:{id:string|null;name:string|null;size?:number}){return id?<span className="runs-face" title={name??'Agent'} style={{inlineSize:size,blockSize:size,background:`hsl(${hue(id)} 45% 42%)`,fontSize:Math.round(size*.45)}} aria-hidden="true">{initial(name)}</span>:<span className="runs-face runs-face-girru" title="Girru" aria-hidden="true" style={{inlineSize:size,blockSize:size}}><UiIcon name="gear" size={Math.round(size*.6)}/></span>;}
function State({state}:{state:RunState}){const s=STATE[state];return <span className="st-state runs-state" data-state={s.tone}><i aria-hidden="true"/>{s.label}</span>;}

export function RunsDestination({client,active,sidebarSlot,request,agents=[],projects=[],models=[],onOpenChat,onOpenCard,onOpenAgent,onOpenApprovals,onOpenConnections,onOpenComputers}:{onOpenComputers?:()=>void;client:SessionClient;active:boolean;sidebarSlot?:HTMLElement|null;request?:{place:RunsPlace;n:number}|null;agents?:readonly AgentChoice[];projects?:readonly Project[];models?:readonly ModelOption[];onOpenChat:(id:string)=>void;onOpenCard:(boardId:string,cardId:string)=>void;onOpenAgent:(id:string)=>void;onOpenApprovals:()=>void;onOpenConnections?:()=>void}){
 const session=useSyncExternalStore(client.subscribe,client.getSnapshot,client.getSnapshot);
 const owner=session.phase==='authenticated'&&session.user?.role==='owner';
 const p8=useStoreP8(client);
 const [place,setPlace]=useState<RunsPlace>('running');
 useEffect(()=>{if(request)setPlace(request.place);},[request]);
 const [filter,setFilter]=useState<{agent?:string;project?:string}>({});
 const [query,setQuery]=useState(''),[debounced,setDebounced]=useState('');
 useEffect(()=>{const t=setTimeout(()=>setDebounced(query.trim()),250);return()=>clearTimeout(t);},[query]);
 const [runs,setRuns]=useState<RunItem[]|null>(null),[next,setNext]=useState<number|null>(null),[counts,setCounts]=useState({running:0,waiting:0});
 const [schedules,setSchedules]=useState<Schedule[]|null>(null),[showPaused,setShowPaused]=useState<'all'|'on'|'paused'>('all');
 const [selected,setSelected]=useState(''),[error,setError]=useState(''),[tick,setTick]=useState(0),[menu,setMenu]=useState<{x:number;y:number;id:string}|null>(null);
 const [inspector,setInspector]=useState(true),[newSchedule,setNewSchedule]=useState(false),[chatSheet,setChatSheet]=useState<string|null>(null),[notice,setNotice]=useState<{text:string;undo?:()=>void}|null>(null);
 const [seen,setSeen]=useState<{agents:Map<string,string>;projects:Map<string,string>}>({agents:new Map(),projects:new Map()});
 const search=useRef<HTMLInputElement>(null),list=useRef<HTMLDivElement>(null);
 const [unfolded,setUnfolded]=useState<Set<string>>(new Set()),[folded,setFolded]=useState<Set<string>>(new Set());
 const refresh=useCallback(()=>setTick(n=>n+1),[]);
 const scheduled=place==='scheduled';

 // The list of the place (live while something runs or waits).
 useEffect(()=>{if(!active||scheduled)return;let stopped=false;const qs=new URLSearchParams({place});if(filter.agent)qs.set('agent',filter.agent);if(filter.project)qs.set('project',filter.project);if(debounced)qs.set('q',debounced);
  void client.request({method:'GET',path:`/api/runs?${qs}`} as never).then(r=>{if(stopped)return;if(r.status!==200)throw Error();const b=r.body as {runs:RunItem[];next:number|null;counts:{running:number;waiting:number}};setRuns(b.runs);setNext(b.next);setCounts(b.counts);setError('');
   setSeen(s=>{const a=new Map(s.agents),p=new Map(s.projects);for(const x of b.runs){if(x.agentId&&x.agentName)a.set(x.agentId,x.agentName);if(x.projectId&&x.projectName)p.set(x.projectId,x.projectName);}return a.size===s.agents.size&&p.size===s.projects.size?s:{agents:a,projects:p};});
   setSelected(old=>b.runs.some(x=>x.id===old)?old:b.runs[0]?.id??'');}).catch(()=>{if(!stopped)setError('Runs could not be loaded.');});
  return()=>{stopped=true;};},[client,active,place,scheduled,filter,debounced,tick,session.epoch]);
 useEffect(()=>{if(!active)return;const t=setInterval(()=>{if(document.visibilityState!=='hidden')refresh();},place==='running'||place==='waiting'?LIVE_MS:LIVE_MS*4);return()=>clearInterval(t);},[active,place,refresh]);
 useEffect(()=>{setRuns(null);setNext(null);setSelected('');},[place,filter,debounced]);
 async function more(){if(next===null)return;const qs=new URLSearchParams({place,before:String(next)});if(filter.agent)qs.set('agent',filter.agent);if(filter.project)qs.set('project',filter.project);if(debounced)qs.set('q',debounced);
  try{const r=await client.request({method:'GET',path:`/api/runs?${qs}`} as never);if(r.status!==200)throw Error();const b=r.body as {runs:RunItem[];next:number|null};setRuns(old=>[...(old??[]),...b.runs.filter(x=>!(old??[]).some(o=>o.id===x.id))]);setNext(b.next);}catch{setError('Older runs could not be loaded.');}}

 // Scheduled: every kind together.
 useEffect(()=>{if(!active||!scheduled)return;let stopped=false;void client.request({method:'GET',path:'/api/runs/schedules'} as never).then(r=>{if(stopped)return;if(r.status!==200)throw Error();const rows=(r.body as {schedules:Schedule[]}).schedules;setSchedules(rows);setError('');setSelected(old=>rows.some(x=>x.id===old)?old:rows[0]?.id??'');}).catch(()=>{if(!stopped)setError('Schedules could not be loaded.');});return()=>{stopped=true;};},[client,active,scheduled,tick,session.epoch]);
 const shownSchedules=useMemo(()=>(schedules??[]).filter(s=>(showPaused==='all'||(showPaused==='on')===s.enabled)&&(!filter.agent||s.agentId===filter.agent)&&(!debounced||`${s.title} ${s.when} ${s.agentName??''} ${KIND[s.kind].label}`.toLowerCase().includes(debounced.toLowerCase()))),[schedules,showPaused,filter.agent,debounced]);

 // The selected run.
 const [detail,setDetail]=useState<Detail|null>(null),[detailError,setDetailError]=useState(false);
 const run=runs?.find(r=>r.id===selected)??null;
 const live=!!run&&(run.state==='working'||run.state==='waiting'||run.state==='queued');
 useEffect(()=>{if(!active||scheduled||!selected){setDetail(null);return;}let stopped=false;setDetailError(false);
  void client.request({method:'GET',path:`/api/runs/item/${encodeURIComponent(selected)}`} as never).then(r=>{if(stopped)return;if(r.status!==200)throw Error();setDetail(r.body as Detail);}).catch(()=>{if(!stopped)setDetailError(true);});return()=>{stopped=true;};},[client,active,scheduled,selected,live?tick:0]);
 useEffect(()=>{setDetail(d=>d&&d.run.id===selected?d:null);},[selected]);

 const say=(text:string,undo?:()=>void)=>{setNotice({text,undo});};
 useEffect(()=>{if(!notice)return;const t=setTimeout(()=>setNotice(null),6000);return()=>clearTimeout(t);},[notice]);
 const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);say('Details copied.');}catch{say('Copying did not work here.');}};
 const [stopping,setStopping]=useState<RunItem|null>(null);const stopDialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(stopping)stopDialog.current?.showModal();else stopDialog.current?.close();},[stopping]);
 async function stop(r:RunItem){setStopping(null);try{const x=await client.request({method:'POST',path:`/api/runs/item/${encodeURIComponent(r.id)}/stop`,body:{}} as never);if(x.status!==200)throw Error();say(`“${r.title}” is stopping.`);refresh();}catch{say('It could not be stopped. It may have finished already.');refresh();}}
 async function retry(r:RunItem){try{const x=await client.request({method:'POST',path:`/api/runs/item/${encodeURIComponent(r.id)}/retry`,body:{}} as never);if(x.status!==202&&x.status!==200)throw Error();const b=x.body as {run?:string};say('Sent again as a new run.');setPlace('running');if(b.run)setSelected(b.run);}catch{say('It could not be sent again. Open the chat to try there.');}}
 const canStop=(r:RunItem)=>(r.state==='working'||r.state==='queued'||r.state==='waiting')&&(r.kind==='chat'||r.kind==='task'||r.kind==='helper'||r.kind==='code')&&!r.id.startsWith('approval:');
 const canRetry=(r:RunItem)=>r.kind==='chat'&&(r.state==='failed'||r.state==='stopped')&&!r.id.startsWith('approval:');
 const open=(r:RunItem)=>{if(r.link.sessionId)onOpenChat(r.link.sessionId);else if(r.agentId)onOpenAgent(r.agentId);};

 // Board RN6: a sub-task sits under its main task (folded when there are more than 3).
 const ordered=useMemo(()=>{const all=runs??[],ids=new Set(all.map(r=>r.id)),kids=new Map<string,RunItem[]>();for(const r of all)if(r.parentId&&ids.has(r.parentId)){const k=kids.get(r.parentId)??[];k.push(r);kids.set(r.parentId,k);}
  const out:Array<{r:RunItem;depth:number;kids:number}>=[];for(const r of all){if(r.parentId&&ids.has(r.parentId))continue;const k=kids.get(r.id)??[];out.push({r,depth:0,kids:k.length});const open=folded.has(r.id)?false:unfolded.has(r.id)?true:k.length<=3;if(open)for(const c of k)out.push({r:c,depth:1,kids:0});}return out;},[runs,folded,unfolded]);
 const isOpen=(id:string,n:number)=>folded.has(id)?false:unfolded.has(id)?true:n<=3;
 const toggle=(id:string,n:number)=>{const open=isOpen(id,n);setFolded(s=>{const x=new Set(s);open?x.add(id):x.delete(id);return x;});setUnfolded(s=>{const x=new Set(s);open?x.delete(id):x.add(id);return x;});};
 // Keyboard (board RN4c): ⌘F search, ↑↓ move, ↩ open, ⌘R retry, ⌘. stop, ⌘⇧C copy, ⌘N new schedule, ⌥⌘I details, Esc closes the menu.
 const rows:Array<{id:string}>=scheduled?shownSchedules:ordered.map(o=>o.r);
 useEffect(()=>{if(!active)return;const onKey=(e:KeyboardEvent)=>{const mod=e.metaKey||e.ctrlKey,k=e.key.toLowerCase(),typing=e.target instanceof HTMLElement&&(e.target.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName));
  if(document.querySelector('dialog[open]'))return;
  if(e.key==='Escape'&&menu){setMenu(null);return;}
  if(mod&&!e.shiftKey&&k==='f'){e.preventDefault();search.current?.focus();return;}
  if(mod&&e.altKey&&k==='i'){e.preventDefault();setInspector(v=>!v);return;}
  if(mod&&!e.shiftKey&&k==='n'&&scheduled&&owner){e.preventDefault();setNewSchedule(true);return;}
  if(typing)return;
  if(!mod&&(e.key==='ArrowDown'||e.key==='ArrowUp')&&rows.length){e.preventDefault();const i=rows.findIndex(r=>r.id===selected),n=Math.min(rows.length-1,Math.max(0,i+(e.key==='ArrowDown'?1:-1)));setSelected(rows[n].id);return;}
  if(!run||scheduled)return;
  if(!mod&&e.key==='Enter'){e.preventDefault();open(run);}
  else if(mod&&!e.shiftKey&&k==='r'&&canRetry(run)){e.preventDefault();void retry(run);}
  else if(mod&&k==='.'&&canStop(run)){e.preventDefault();setStopping(run);}
  else if(mod&&e.shiftKey&&k==='c'&&detail){e.preventDefault();void copy(detail.copy);}};
  window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);});
 useEffect(()=>{if(!menu)return;const close=()=>setMenu(null);window.addEventListener('click',close);return()=>window.removeEventListener('click',close);},[menu]);
 useEffect(()=>{list.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({block:'nearest'});},[selected]);

 const places=<nav className="dk-sidebar runs-places" aria-label="Runs places">
  <p className="section-label dk-label"><span>Runs</span></p>
  {RUN_PLACES.map(p=>{const n=p.id==='running'?counts.running:p.id==='waiting'?counts.waiting:0;return <button key={p.id} type="button" className="nav-item dk-place" aria-current={place===p.id?'page':undefined} onClick={()=>{setPlace(p.id);setMenu(null);}}><UiIcon name={p.icon} size={15}/><span className="dk-place-name">{p.label}</span>{n?<span className={p.id==='waiting'?'dk-badge-pill':'dk-count'} aria-label={p.id==='waiting'?`${n} waiting for you`:`${n} running`}>{n}</span>:null}</button>;})}
  {seen.agents.size>0&&<><p className="section-label dk-label"><span>Agents</span></p>{[...seen.agents].slice(0,8).map(([id,name])=><button key={id} type="button" className="nav-item dk-place" aria-pressed={filter.agent===id} title={filter.agent===id?'Show every agent':`Only ${name}`} onClick={()=>setFilter(f=>({...f,agent:f.agent===id?undefined:id}))}><Face id={id} name={name} size={18}/><span className="dk-place-name">{name}</span>{filter.agent===id&&<UiIcon name="check" size={12}/>}</button>)}</>}
  {seen.projects.size>0&&<><p className="section-label dk-label"><span>Projects</span></p>{[...seen.projects].slice(0,8).map(([id,name])=><button key={id} type="button" className="nav-item dk-place" aria-pressed={filter.project===id} title={filter.project===id?'Show every project':`Only ${name}`} onClick={()=>setFilter(f=>({...f,project:f.project===id?undefined:id}))}><span className="runs-tile" style={{background:`hsl(${hue(id)} 40% 45%)`}} aria-hidden="true">{initial(name)}</span><span className="dk-place-name">{name}</span>{filter.project===id&&<UiIcon name="check" size={12}/>}</button>)}</>}
 </nav>;

 const placeLabel=RUN_PLACES.find(p=>p.id===place)!.label;
 const sched=scheduled?shownSchedules.find(s=>s.id===selected)??null:null;
 return <section className="runs" aria-label="Runs" data-inspector={inspector?'open':'closed'} data-inline-sidebar={!sidebarSlot||undefined}>
  {sidebarSlot?(active?createPortal(places,sidebarSlot):null):places}
  <div className="runs-main">
   <header className="runs-toolbar"><h2>{placeLabel}</h2>
    <label className="runs-search"><UiIcon name="search" size={13}/><input ref={search} type="search" aria-label={scheduled?'Search schedules':'Search runs'} placeholder={scheduled?'Search schedules':'Search runs'} value={query} onChange={e=>setQuery(e.target.value)}/><kbd>⌘F</kbd></label>
    {scheduled&&<label className="runs-show" title="Show"><UiIcon name="filter" size={13}/><select aria-label="Show schedules" value={showPaused} onChange={e=>setShowPaused(e.target.value as 'all'|'on'|'paused')}><option value="all">All</option><option value="on">On</option><option value="paused">Paused</option></select></label>}
    {scheduled&&owner&&<button type="button" className="primary" title="New schedule (⌘N)" onClick={()=>setNewSchedule(true)}><UiIcon name="plus" size={14}/>New schedule</button>}
    <button type="button" className="tool" aria-label={inspector?'Hide the details':'Show the details'} title={`${inspector?'Hide':'Show'} the details (⌥⌘I)`} aria-pressed={inspector} onClick={()=>setInspector(v=>!v)}><UiIcon name="inspector" size={15}/></button>
   </header>
   {error&&<p role="alert" className="runs-error">{error}</p>}
   {(filter.agent||filter.project)&&<p className="runs-filter-note">Only {[filter.agent&&seen.agents.get(filter.agent),filter.project&&seen.projects.get(filter.project)].filter(Boolean).join(' · ')} <button type="button" className="link" onClick={()=>setFilter({})}>Show all</button></p>}
   {(place==='running'||place==='waiting')&&<ComputerRunsRows waiting={place==='waiting'} onOpen={()=>onOpenComputers?.()}/>}
   <div className="runs-list" ref={list} role="listbox" aria-label={placeLabel}>
    {scheduled?(schedules===null?(!error&&<p role="status" className="fine-print">Loading schedules…</p>):!shownSchedules.length?<Empty place={place} searching={!!debounced||showPaused!=='all'} onClear={()=>{setQuery('');setShowPaused('all');}} onNew={owner?()=>setNewSchedule(true):undefined}/>:
     shownSchedules.map(s=><button key={s.id} type="button" role="option" aria-selected={selected===s.id} aria-current={selected===s.id?'true':undefined} className="runs-row runs-row-two" onClick={()=>setSelected(s.id)}>
      <span className="runs-kind" title={KIND[s.kind].label}><UiIcon name={KIND[s.kind].icon} size={15}/></span>
      <span className="runs-name"><span>{s.title}</span><small>{KIND[s.kind].label} · {s.when}</small></span>
      <Face id={s.agentId} name={s.agentName}/>
      <span className="st-state runs-state" data-state={s.enabled?'ready':'off'}><i aria-hidden="true"/>{s.enabled?'On':'Paused'}</span>
      <span className="runs-when">{s.enabled&&s.nextRun?at(s.nextRun):'—'}</span>
     </button>)):
     runs===null?(!error&&<p role="status" className="fine-print">Loading runs…</p>):!runs.length?<Empty place={place} searching={!!debounced||!!filter.agent||!!filter.project} onClear={()=>{setQuery('');setFilter({});}}/>:
     <>{ordered.map(({r,depth,kids})=><button key={r.id} type="button" role="option" aria-selected={selected===r.id} aria-current={selected===r.id?'true':undefined} className="runs-row" data-depth={depth||undefined} onClick={()=>setSelected(r.id)} onDoubleClick={()=>open(r)} onContextMenu={e=>{e.preventDefault();setSelected(r.id);setMenu({x:e.clientX,y:e.clientY,id:r.id});}}>
      <span className="runs-kind" title={kids?`${KIND[r.kind].label} · ${kids} sub-task${kids===1?'':'s'}`:KIND[r.kind].label}>{kids>0&&<span role="button" tabIndex={-1} className="runs-fold" aria-label={isOpen(r.id,kids)?'Fold the sub-tasks':'Show the sub-tasks'} aria-expanded={isOpen(r.id,kids)} onClick={e=>{e.stopPropagation();toggle(r.id,kids);}}><UiIcon name="chevron" size={11}/></span>}<UiIcon name={KIND[r.kind].icon} size={15}/></span>
      <span className="runs-name"><span>{r.title}</span>{kids>0&&!isOpen(r.id,kids)&&<small>{kids} sub-tasks</small>}{depth===0&&r.parentId&&<small>Sub-task of another run</small>}</span>
      <span className="runs-who">{r.needsYou&&<span className="dk-badge-pill" aria-label="Needs you">1</span>}<Face id={r.agentId} name={r.agentName}/></span>
      <State state={r.state}/>
      <span className="runs-when" title={full(r.startedAt)}>{r.state==='working'?since(r.startedAt):at(r.endedAt??r.startedAt)}</span>
     </button>)}{next!==null&&<button type="button" className="runs-more" onClick={()=>void more()}>Show older runs</button>}</>}
   </div>
  </div>
  {inspector&&<aside className="runs-inspector" aria-label={scheduled?'Selected schedule':'Run details'}>
   <button type="button" className="tool runs-insp-close" aria-label="Close the details" title="Close (Esc)" onClick={()=>setInspector(false)}><UiIcon name="close" size={14}/></button>
   {scheduled?(!sched?<p className="fine-print">Choose a schedule to see when it runs.</p>:
     sched.kind==='job'&&sched.link.jobId?<ScheduledJobInspector client={client} jobId={sched.link.jobId} active={active} onChanged={refresh} onOpenConnections={onOpenConnections} lastRuns={<LastRuns client={client} id={sched.id} tick={tick} onOpen={openRun}/>}/>:
     <OtherSchedule client={client} s={sched} tick={tick} onChanged={refresh} say={say} onOpenRun={openRun} onEditChat={id=>setChatSheet(id)} onOpenChat={onOpenChat} onOpenCard={onOpenCard} onOpenAgent={onOpenAgent}/>):
    !run?<p className="fine-print">{runs?.length?'Choose a run to see its steps and log.':'Details of a run show here.'}</p>:
    <RunInspector notes={p8&&owner&&runNotesRef(run)?<RunWorkingNotes key={run.id} client={client} at={runNotesRef(run)!} live={run.state==='working'} onCopy={t=>void copy(t)}/>:null} run={run} detail={detail?.run.id===run.id?detail:null} failed={detailError} onOpenRun={id=>{const r=runs?.find(x=>x.id===id);if(r)setSelected(id);else openRunAny(id);}} onStop={()=>setStopping(run)} onRetry={()=>void retry(run)} onOpen={()=>open(run)} onApprovals={onOpenApprovals} onAgent={onOpenAgent} onCopy={t=>void copy(t)} canStop={canStop(run)} canRetry={canRetry(run)}/>}
  </aside>}
  {menu&&run&&!scheduled&&<div className="runs-menu" role="menu" style={{left:menu.x,top:menu.y}} onClick={e=>e.stopPropagation()}>
   {run.link.sessionId&&<button role="menuitem" onClick={()=>{setMenu(null);open(run);}}>Open chat<kbd>↩</kbd></button>}
   {canRetry(run)&&<button role="menuitem" onClick={()=>{setMenu(null);void retry(run);}}>Retry<kbd>⌘R</kbd></button>}
   {detail&&<button role="menuitem" onClick={()=>{setMenu(null);void copy(detail.copy);}}>Copy details<kbd>⌘⇧C</kbd></button>}
   {run.agentId&&<button role="menuitem" onClick={()=>{setMenu(null);setFilter(f=>({...f,agent:run.agentId!}));}}>Show this agent’s runs</button>}
   {run.needsYou&&<button role="menuitem" onClick={()=>{setMenu(null);onOpenApprovals();}}>Show in Approvals</button>}
   {canStop(run)&&<button role="menuitem" className="danger" onClick={()=>{setMenu(null);setStopping(run);}}>Stop…<kbd>⌘.</kbd></button>}
  </div>}
  {notice&&<p role="status" className="runs-notice">{notice.text}{notice.undo&&<button type="button" onClick={()=>{notice.undo!();setNotice(null);}}>Undo <kbd>⌘Z</kbd></button>}</p>}
  <dialog ref={stopDialog} className="schedule-confirm" onCancel={()=>setStopping(null)} onClose={()=>setStopping(null)}><h3>Stop “{stopping?.title}”?</h3><p>It stops after the step it is on. This cannot be undone; you can retry it later.</p><div><button autoFocus onClick={()=>setStopping(null)}>Cancel</button><button className="primary" onClick={()=>stopping&&void stop(stopping)}>Stop</button></div></dialog>
  {newSchedule&&owner&&<ScheduleTaskSheet client={client} agents={agents} projects={projects} models={models} onClose={made=>{setNewSchedule(false);refresh();if(made){say('The task is scheduled. It is on the board too.');setSelected(made);}}}/>}
  {chatSheet&&<ScheduleSheet client={client} chatId={chatSheet} onClose={()=>{setChatSheet(null);refresh();}}/>}
 </section>;

 function openRunAny(id:string){setTimeout(()=>setSelected(id),0);}
 function openRun(id:string,state:RunState){setPlace(state==='done'?'finished':state==='working'||state==='queued'?'running':state==='waiting'?'waiting':'failed');setFilter({});setQuery('');setTimeout(()=>setSelected(id),0);}
}

function Empty({place,searching,onClear,onNew}:{place:RunsPlace;searching:boolean;onClear:()=>void;onNew?:()=>void}){
 const icon=RUN_PLACES.find(p=>p.id===place)!.icon;
 return <div className="runs-empty"><UiIcon name={searching?'search':icon} size={24}/><p>{searching?'Nothing here matches.':EMPTY[place]}</p>{searching?<button type="button" onClick={onClear}>Show all</button>:place==='scheduled'&&onNew?<button type="button" className="primary" onClick={onNew}><UiIcon name="plus" size={14}/>New schedule</button>:null}</div>;
}

function Why({reason}:{reason:Reason}){
 const plain=reason.code==='needs_ok'||reason.code==='subtask_stopped',tone=plain||reason.code==='skipped'?'warn':'bad';
 return <div className="runs-why" data-tone={tone}><p className="runs-why-title"><UiIcon name={reason.code==='needs_ok'?'hourglass':reason.code==='timed_out'?'clock':reason.bug?'bug':'alert'} size={15}/>{plain?reason.title:`Why it stopped: ${reason.title.toLowerCase()}`}</p><p>{reason.text}</p></div>;
}

function RunInspector({notes,run,detail,failed,onOpenRun,onStop,onRetry,onOpen,onApprovals,onAgent,onCopy,canStop,canRetry}:{notes?:ReactNode;run:RunItem;detail:Detail|null;failed:boolean;onOpenRun:(id:string)=>void;onStop:()=>void;onRetry:()=>void;onOpen:()=>void;onApprovals:()=>void;onAgent:(id:string)=>void;onCopy:(t:string)=>void;canStop:boolean;canRetry:boolean}){
 const opens=run.link.sessionId?'Open chat':run.agentId?'Open agent':null;
 return <div className="runs-insp">
  <p className="runs-insp-kind">{KIND[run.kind].label} · {STATE[run.state].label}<span className="runs-insp-tools">{detail&&<button type="button" className="tool" aria-label="Copy details" title="Copy details (⌘⇧C)" onClick={()=>onCopy(detail.copy)}><UiIcon name="copy" size={14}/></button>}</span></p>
  <h3>{run.title}</h3><ComputerExecutionBadge sessionId={run.link.sessionId} runId={run.id}/>
  <dl className="runs-facts">
   <dt>Started by</dt><dd>{STARTED[run.startedBy]??'You'}</dd>
   {(run.agentName||run.agentId)&&<><dt>Agent</dt><dd><Face id={run.agentId} name={run.agentName} size={18}/>{run.agentId?<button type="button" className="link" onClick={()=>onAgent(run.agentId!)}>{run.agentName??'Agent'}</button>:run.agentName}</dd></>}
   {(run.app||run.model)&&<><dt>App</dt><dd>{[run.app,run.model&&!sameApp(run.app,run.model)?run.model.replace(/^(subscription|local|ollama):/,''):null].filter(Boolean).join(' · ')}</dd></>}
   {run.projectName&&<><dt>Project</dt><dd><span className="runs-tile" style={{background:`hsl(${hue(run.projectId)} 40% 45%)`}} aria-hidden="true">{initial(run.projectName)}</span>{run.projectName}</dd></>}
   <dt>Time</dt><dd>{run.state==='working'?`Started ${full(run.startedAt)} · running ${span(run.startedAt,null)}`:run.endedAt?`${full(run.startedAt)} · ${span(run.startedAt,run.endedAt)}`:`Started ${full(run.startedAt)}`}</dd>
  </dl>
  {run.reason&&<Why reason={run.reason}/>}
  {run.needsYou&&<div className="runs-actions"><button type="button" className="primary" onClick={onApprovals}><UiIcon name="eye" size={14}/>Review in Approvals…</button></div>}
  {canRetry&&!run.needsYou&&<div className="runs-actions"><button type="button" className="primary" title="Retry (⌘R)" onClick={onRetry}><UiIcon name="refresh" size={14}/>Retry</button>{detail&&<button type="button" onClick={()=>onCopy(detail.copy)}><UiIcon name="copy" size={14}/>Copy details</button>}</div>}
  {failed?<p role="alert" className="fine-print">The details could not be loaded.</p>:!detail?<p role="status" className="fine-print">Loading details…</p>:<>
   {detail.subtasks.length>0&&<section className="runs-sect"><h4>Sub-tasks<span className="runs-insp-tools runs-sub-count">{detail.subtasks.length}{detail.subtasks.some(s=>s.state==='working')?` · ${detail.subtasks.filter(s=>s.state==='working').length} still working`:''}</span></h4><ol className="runs-last">{detail.subtasks.map(s=><li key={s.id}><button type="button" title="Open this sub-task" onClick={()=>onOpenRun(s.id)}><UiIcon name={KIND[s.kind].icon} size={13}/><span>{s.title}</span><Face id={s.agentId} name={s.agentName} size={16}/><State state={s.state}/></button></li>)}</ol></section>}
   {detail.subNotice&&<Why reason={detail.subNotice}/>}
   <section className="runs-sect"><h4>Steps</h4>{!detail.steps.length&&<p className="fine-print">No steps were saved for this run.</p>}<ol className="runs-steps">{detail.steps.map((s,i)=><li key={i} data-state={s.state}><span className="runs-step-dot" aria-hidden="true"><UiIcon name={s.state==='fail'?'close':s.state==='wait'?'hourglass':s.state==='now'?'play':s.state==='skip'?'minus':'check'} size={11}/></span><span><span>{s.title}</span><small>{s.meta}</small></span></li>)}</ol></section>
   <section className="runs-sect"><h4>Log<span className="runs-insp-tools"><button type="button" className="tool" aria-label="Copy the log" title="Copy the log" onClick={()=>onCopy(detail.log.map(l=>`${l.at} ${l.text}`.trim()).join('\n'))}><UiIcon name="copy" size={13}/></button></span></h4>
    <pre className="runs-log">{detail.log.map((l,i)=><span key={i}><b>{l.at}</b>{l.text}{'\n'}</span>)}{run.state==='working'&&<span className="runs-live"><i aria-hidden="true"/>live</span>}</pre></section>
   {notes}
   {!!(detail.result.text||detail.result.tokensIn||detail.result.costCents)&&<section className="runs-sect"><h4>Result</h4>{detail.result.text&&<p className="runs-result">{detail.result.text}</p>}{!!(detail.result.tokensIn||detail.result.tokensOut)&&<p className="fine-print">{(detail.result.tokensIn??0).toLocaleString()} tokens in · {(detail.result.tokensOut??0).toLocaleString()} out{detail.result.costCents?` · ${(detail.result.costCents/100).toFixed(2)} EUR`:''}</p>}</section>}
   {run.reason?.detail&&<details className="runs-tech"><summary><UiIcon name="chevron" size={11}/>Technical details</summary><code>{run.reason.detail}</code></details>}
  </>}
  <div className="runs-actions runs-actions-end">{canStop&&<button type="button" className="danger" title="Stop (⌘.)" onClick={onStop}><UiIcon name="stop" size={14}/>Stop…</button>}{opens&&<button type="button" onClick={onOpen}><UiIcon name="open" size={14}/>{opens}</button>}</div>
 </div>;
}

function LastRuns({client,id,tick,onOpen}:{client:SessionClient;id:string;tick:number;onOpen:(id:string,state:RunState)=>void}){
 const [rows,setRows]=useState<RunItem[]|null>(null);
 useEffect(()=>{let stopped=false;setRows(null);void client.request({method:'GET',path:`/api/runs/schedules/${encodeURIComponent(id)}/runs`} as never).then(r=>{if(!stopped&&r.status===200)setRows((r.body as {runs:RunItem[]}).runs);}).catch(()=>{if(!stopped)setRows([]);});return()=>{stopped=true;};},[client,id,tick]);
 if(rows===null)return <p role="status" className="fine-print">Loading…</p>;
 if(!rows.length)return <p className="fine-print">No runs yet.</p>;
 return <ol className="runs-last">{rows.map(r=><li key={r.id}><button type="button" title="Open this run" onClick={()=>onOpen(r.id,r.state)}><State state={r.state}/><span>{full(r.endedAt??r.startedAt)}{r.reason?` · ${r.reason.title.toLowerCase()}`:''}</span><UiIcon name="chevron" size={11}/></button></li>)}</ol>;
}

/** A chat schedule, a card schedule or an agent check-in in Runs › Scheduled. */
function OtherSchedule({client,s,tick,onChanged,say,onOpenRun,onEditChat,onOpenChat,onOpenCard,onOpenAgent}:{client:SessionClient;s:Schedule;tick:number;onChanged:()=>void;say:(t:string,undo?:()=>void)=>void;onOpenRun:(id:string,state:RunState)=>void;onEditChat:(id:string)=>void;onOpenChat:(id:string)=>void;onOpenCard:(b:string,c:string)=>void;onOpenAgent:(id:string)=>void}){
 const [busy,setBusy]=useState(false);
 const path=s.kind==='chatsch'&&s.link.sessionId?`/api/chat/conversations/${encodeURIComponent(s.link.sessionId)}/schedule`:s.kind==='cardsch'&&s.link.boardId&&s.link.cardId?`/api/boards/${encodeURIComponent(s.link.boardId)}/cards/${encodeURIComponent(s.link.cardId)}/schedule`:null;
 async function setPaused(paused:boolean,undo=false){if(!path||busy)return;setBusy(true);try{const g=await client.request({method:'GET',path} as never);const v=(g.body as {schedule?:Record<string,unknown>})?.schedule;if(g.status!==200||!v)throw Error();
  const body:Record<string,unknown>=s.kind==='chatsch'?{every:v.every,at:v.at,...(v.every==='weekly'?{weekday:v.weekday}:{}),message:v.message,paused}:{every:v.every,at:v.at,...(v.every==='weekly'?{weekday:v.weekday}:{}),...(v.agentId!==undefined?{agentId:v.agentId}:{}),...(v.model!==undefined?{model:v.model}:{}),paused};
  const r=await client.request({method:'PUT',path,body} as never);if(r.status!==200)throw Error();onChanged();if(!undo)say(`“${s.title}” ${paused?'paused':'resumed'}.`,()=>void setPaused(!paused,true));}catch{say('The schedule could not be changed.');}finally{setBusy(false);}}
 useEffect(()=>{if(!path)return;const onKey=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==='p'&&!document.querySelector('dialog[open]')){e.preventDefault();void setPaused(s.enabled);}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);});
 const facts:ReactNode=<dl className="runs-facts">
  <dt>What it does</dt><dd>{s.kind==='chatsch'?'Sends its saved message in the chat again':s.kind==='cardsch'?'Does the task again, from its instructions':'Checks its tasks and works on the ones it has'}</dd>
  {s.agentId&&<><dt>Agent</dt><dd><Face id={s.agentId} name={s.agentName} size={18}/>{s.agentName??'Agent'}</dd></>}
  <dt>When</dt><dd>{s.when}{s.enabled&&s.nextRun?` · next: ${full(s.nextRun)}`:s.enabled?'':' · paused'}</dd>
  {s.lastRun&&<><dt>Last</dt><dd>{full(s.lastRun)}{s.lastResult==='skipped'?' · skipped':s.lastResult==='failed'?' · could not start':''}</dd></>}
 </dl>;
 return <div className="runs-insp">
  <p className="runs-insp-kind">{KIND[s.kind].label} · {s.enabled?'On':'Paused'}</p><h3>{s.title}</h3>{facts}
  {s.lastReason&&<Why reason={s.lastReason}/>}
  <section className="runs-sect"><h4>Last runs</h4><LastRuns client={client} id={s.id} tick={tick} onOpen={onOpenRun}/></section>
  <div className="runs-actions">
   {path&&<button type="button" disabled={busy} title={`${s.enabled?'Pause':'Resume'} (⌘⇧P)`} onClick={()=>void setPaused(s.enabled)}><UiIcon name={s.enabled?'pause':'power'} size={14}/>{s.enabled?'Pause':'Resume'}</button>}
   {s.kind==='chatsch'&&s.link.sessionId&&<><button type="button" onClick={()=>onEditChat(s.link.sessionId!)}><UiIcon name="pencil" size={14}/>Edit…</button><button type="button" onClick={()=>onOpenChat(s.link.sessionId!)}><UiIcon name="open" size={14}/>Open chat</button></>}
   {s.kind==='cardsch'&&s.link.boardId&&s.link.cardId&&<button type="button" title="Edit how it repeats on the card" onClick={()=>onOpenCard(s.link.boardId!,s.link.cardId!)}><UiIcon name="open" size={14}/>Open card</button>}
   {s.kind==='checkin'&&s.link.agentId&&<button type="button" title="Check-ins are changed on the agent page" onClick={()=>onOpenAgent(s.link.agentId!)}><UiIcon name="open" size={14}/>Edit on the agent page</button>}
  </div>
 </div>;
}
