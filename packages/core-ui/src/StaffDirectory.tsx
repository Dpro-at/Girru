import type {CardTab} from './agent-card';
import {modelDisplayName} from './model-names';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {KeyboardEvent as ReactKeyboardEvent,MouseEvent as ReactMouseEvent} from 'react';
import type {AgentsController,PublicAgent} from './agents';
import {Avatar,ContextMenu,IconButton,Notice,Popover,Sheet,useMenu} from './desktop-ui';
import type {MenuItem} from './desktop-ui';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';
import {departmentIcon,departmentName,departmentTone,personalityColour,ROLE_CARDS,roleWord,tileStyle} from './agent-look';
import {permissionLine,useAgentFacts,useFaces,forgetFacts,retryFacts} from './agent-facts';
import {PersonalityMark} from './PersonalityLibrary';
import {useLibraryEntries,type Profile} from './personality-library';
import {OrgChart} from './OrgChart';
import {ExportAgentSheet,ImportAgentSheet,useAgentPackages} from './AgentNotes';
import {AddSubAgentSheet} from './AgentSubAgents';
import {canMoveUnder,underOf} from './org-chart';
import {CHART_PREFS_PATH,type ChartPrefs} from './chart-prefs-contract.js';

type Toast={id:number;text:string;undo:boolean}|null;
type View='list'|'chart';
// The chosen view and folded branches: kept while the app runs and saved per person (/api/me/agents-chart; no browser storage).
const kept:{view:View;folded:Set<string>}={view:'list',folded:new Set()};
/** List order: each sub-agent right under the agent it belongs to. */
function withHelpers(list:readonly PublicAgent[]):PublicAgent[]{
 const subs=list.filter(a=>a.subAgentOf&&list.some(b=>b.id===a.subAgentOf));const rest=list.filter(a=>!subs.includes(a));
 return rest.flatMap(a=>[a,...subs.filter(x=>x.subAgentOf===a.id)]);
}
/** A department's icon on its colour tile (sidebar, list, pickers). */
export function DepartmentTile({department,size=18}:{department?:string|null;size?:number}){
 return <span className="ag-tile" aria-hidden="true" style={{...tileStyle(departmentTone(department)),inlineSize:size,blockSize:size}}><UiIcon name={departmentIcon(department)} size={Math.round(size*.62)}/></span>;
}
/** An agent's round avatar with the small face of its personality (the same face the library draws). */
export function AgentFace({agent,face,profile,size=30}:{agent:Pick<PublicAgent,'name'>;face?:string|null;profile?:Profile;size?:number}){
 const colour=personalityColour(face);
 return <span className="ag-face"><Avatar name={agent.name??'?'} size={size}/>{face!==undefined&&(profile?<span className="ag-face-mark" title={face??undefined}><PersonalityMark profile={profile} size={15}/></span>:<span className="ag-face-mark" title={face??'No personality from the library'} style={{color:colour,boxShadow:`0 0 0 1px ${colour}88`}}><UiIcon name="smile" size={10}/></span>)}</span>;
}

/**
 * AG1: the staff as a quiet list (avatar with its personality face, name and
 * job, department tile) and the selected agent on the right with what makes
 * it. Owner actions live in the ⋯ and right-click menus; Remove confirms once.
 */
export function StaffDirectory({controller,department,query='',notice,hired,onOpen,onMemory,onHire,onCompany,onChat}:{controller:AgentsController;department:string;query?:string;notice?:{id:number;text:string}|null;hired?:{id:number;agentId:string;name:string}|null;onDepartment?:(d:string)=>void;onOpen:(id:string,section?:CardTab)=>void;onMemory?:(id:string)=>void;onHire?:()=>void;onCompany?:()=>void;onChat?:(id:string)=>void}){
 const s=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 const owner=!!onHire;
 // STORE-MAP-01 P5c: Export agent… / Import agent… (⇧⌘I) only while agent packages are on.
 const packages=useAgentPackages(controller.client as never,owner),[importing,setImporting]=useState(false),[exporting,setExporting]=useState<{id:string;name:string}|null>(null);
 useEffect(()=>{if(!packages)return;const on=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==='i'&&!document.querySelector('dialog[open]')){e.preventDefault();setImporting(true);}};window.addEventListener('keydown',on);return()=>window.removeEventListener('keydown',on);},[packages]);
 const [role,setRole]=useState('all'),[sort,setSort]=useState('name'),[selected,setSelected]=useState<string|null>(null),[showing,setShowing]=useState(false),[removing,setRemoving]=useState<PublicAgent|null>(null),[toast,setToast]=useState<Toast>(null),[busy,setBusy]=useState(false);
 const [view,setViewState]=useState<View>(kept.view),[folded,setFolded]=useState<Set<string>>(()=>new Set(kept.folded)),[picking,setPicking]=useState(false),[addingTo,setAddingTo]=useState<PublicAgent|null>(null);
 const undo=useRef<(()=>void|Promise<void>)|null>(null);
 // The person's chart choices (Settings-free): read once, each change saved (a short pause first, so zooming is one save).
 const [saved,setSaved]=useState<Pick<ChartPrefs,'mode'|'lines'|'zoom'>|null>(null),pending=useRef<Partial<ChartPrefs>>({}),saveTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 useEffect(()=>{const c=controller.client;if(!c||!onHire)return;let gone=false;
  void c.request({method:'GET',path:CHART_PREFS_PATH} as never).then(r=>{if(gone||r.status!==200)return;const p=(r.body as {chart:ChartPrefs}).chart;setViewState(p.view);kept.view=p.view;const f=new Set(p.folded);setFolded(f);kept.folded=f;setSaved({mode:p.mode,lines:p.lines,zoom:p.zoom});}).catch(()=>{});
  return()=>{gone=true;};},[controller.client,!!onHire]);
 function savePrefs(patch:Partial<ChartPrefs>){
  const c=controller.client;if(!c||!onHire)return;pending.current={...pending.current,...patch};
  if(saveTimer.current)clearTimeout(saveTimer.current);
  saveTimer.current=setTimeout(()=>{const body=pending.current;pending.current={};saveTimer.current=null;void c.request({method:'PUT',path:CHART_PREFS_PATH,body} as never).catch(()=>{});},500);
 }
 const setView=(v:View)=>{setViewState(v);kept.view=v;savePrefs({view:v});};
 const fold=(id:string)=>setFolded(f=>{const n=new Set(f);if(n.has(id))n.delete(id);else n.add(id);kept.folded=n;savePrefs({folded:[...n].slice(0,500)});return n;});
 const rows=useRef<HTMLDivElement>(null);const menu=useMenu(),toolsMenu=useMenu();
 useEffect(()=>{if(notice)setToast({id:notice.id,text:notice.text,undo:false});},[notice?.id]);
 // FR4b: a new hire is selected and the notice offers Undo (removes the agent again).
 useEffect(()=>{if(!hired)return;setSelected(hired.agentId);say(`${hired.name} joined the team`,async()=>{const r=await controller.remove(hired.agentId);setToast({id:Date.now(),text:r.ok?`${hired.name} was removed`:r.notice,undo:false});if(r.ok)setSelected(null);});},[hired?.id]);
 const q=query.trim().toLowerCase();
  const shown=withHelpers(s.agents.filter(a=>(department==='all'||(department==='main'?a.isPrimary:department==='none'?!a.department:a.department===department))&&(role==='all'||a.role===role)&&(!q||[a.name,a.department,roleWord(a.role),a.description].some(x=>x?.toLowerCase().includes(q)))).sort((a,b)=>Number(!!b.isPrimary)-Number(!!a.isPrimary)||(sort==='department'?(a.department??'~').localeCompare(b.department??'~'):sort==='role'?roleWord(a.role).localeCompare(roleWord(b.role)):0)||(a.name??'').localeCompare(b.name??'')));
 const faces=useFaces(controller.client,shown.map(a=>a.id),owner&&!!controller.client),library=useLibraryEntries(controller.client,owner);
 const agent=shown.find(a=>a.id===selected);
 const say=(text:string,run?:()=>void|Promise<void>)=>{undo.current=run??null;setToast({id:Date.now(),text,undo:!!run});};
 const runUndo=()=>{const u=undo.current;undo.current=null;setToast(null);if(u)void u();};
 /** OC2: change who an agent reports to, with Undo (the notice and ⌘Z). */
 async function moveUnder(id:string,target:string|null){
  if(busy)return;setBusy(true);const r=await controller.setReportsTo(id,target);setBusy(false);
  if(r.ok)say(r.notice,async()=>{const back=await controller.setReportsTo(id,r.before??null);setToast({id:Date.now(),text:back.ok?'Change undone':back.notice,undo:false});});else say(r.notice);
 }
 /** Chart › By department: move to another department, with Undo. */
 async function moveToDepartment(id:string,department:string|null){
  if(busy)return;setBusy(true);const r=await controller.setDepartment(id,department);setBusy(false);
  if(r.ok)say(r.notice,async()=>{const back=await controller.setDepartment(id,r.before??null);setToast({id:Date.now(),text:back.ok?'Change undone':back.notice,undo:false});});else say(r.notice);
 }
 // ⌘Z undoes the last move while the staff page is shown (not inside a text field or sheet).
 useEffect(()=>{const on=(e:KeyboardEvent)=>{const t=e.target as HTMLElement|null;if(!(e.metaKey||e.ctrlKey)||e.shiftKey||e.key.toLowerCase()!=='z'||!undo.current||!page.current?.offsetParent)return;if(t&&(t.closest('textarea,[contenteditable="true"],dialog')||(t instanceof HTMLInputElement&&!['radio','checkbox','button'].includes(t.type))))return;e.preventDefault();runUndo();};window.addEventListener('keydown',on);return()=>window.removeEventListener('keydown',on);},[]);
 async function act(kind:'main'|'copy'|'remove',a:PublicAgent){
  if(busy)return;setBusy(true);
  const r=kind==='main'?await controller.setPrimary(a.id):kind==='copy'?await controller.duplicate(a.id):await controller.remove(a.id);
  setBusy(false);say(r.notice);
  if(r.ok&&controller.client)forgetFacts(controller.client,a.id);
  if(r.ok&&kind==='copy'&&r.id)setSelected(r.id);if(r.ok&&kind==='remove')setSelected(null);
 }
 const kids=(a:PublicAgent)=>s.agents.some(x=>x.manager===a.id);
 const items=(a:PublicAgent):MenuItem[]=>[...(owner?[{label:'Open',icon:'contact' as UiIconName,shortcut:'Enter',run:()=>onOpen(a.id)}]:[]),...(onChat?[{label:'Chat',icon:'message' as UiIconName,run:()=>onChat(a.id)}]:[]),
  ...(owner?['sep' as const,{label:'Reports to…',icon:'org' as UiIconName,shortcut:'⌘R',disabled:busy||a.placed==='main'||a.placed==='sub'||a.placed==='none',run:()=>{setSelected(a.id);setPicking(true);}},{label:'Add sub-agent…',icon:'sub-agent' as UiIconName,disabled:a.placed==='sub'||a.placed==='none',run:()=>setAddingTo(a)}]:[]),
  ...(view==='chart'&&kids(a)?[{label:folded.has(a.id)?'Show the agents under it':'Hide the agents under it',icon:'chevron' as UiIconName,shortcut:'Space',run:()=>fold(a.id)}]:[]),
  ...(owner?['sep' as const,{label:'Make main agent',icon:'sparkle' as UiIconName,disabled:!!a.isPrimary||busy,run:()=>void act('main',a)},{label:'Duplicate',icon:'copy' as UiIconName,disabled:busy,run:()=>void act('copy',a)}]:[]),
  ...(onMemory?[{label:'Saved memories',icon:'brain' as UiIconName,run:()=>onMemory(a.id)}]:[]),
  ...(owner&&packages&&controller.client?[{label:'Export agent…',icon:'download' as UiIconName,run:()=>setExporting({id:a.id,name:a.name??'agent'})}]:[]),
  ...(owner?['sep' as const,{label:'Remove agent…',icon:'trash' as UiIconName,danger:true,shortcut:'⌫',disabled:busy,run:()=>setRemoving(a)}]:[])];
 function select(id:string){setSelected(id);}
 // ⌘F and ⌘N work anywhere on the staff page while it is shown and no sheet is open (not only inside the list).
 const page=useRef<HTMLElement>(null);
 useEffect(()=>{const on=(e:KeyboardEvent)=>{if(!(e.metaKey||e.ctrlKey)||e.altKey||e.shiftKey||!page.current?.offsetParent||document.querySelector('dialog[open],[role="dialog"]'))return;const k=e.key.toLowerCase();
  if(k==='f'){e.preventDefault();document.getElementById('ag-staff-search')?.focus();}else if(k==='n'&&onHire){e.preventDefault();onHire();}
  else if(k==='r'&&onHire&&selectedRef.current){e.preventDefault();setPicking(true);}};window.addEventListener('keydown',on);return()=>window.removeEventListener('keydown',on);},[onHire]);
 const selectedRef=useRef<string|null>(null);selectedRef.current=selected;
 function key(e:ReactKeyboardEvent){
  const mod=e.metaKey||e.ctrlKey;
  if(e.key==='Escape'&&!menu.menu)setSelected(null);
 }
 function rowKey(e:ReactKeyboardEvent<HTMLButtonElement>,a:PublicAgent){
  if(e.key==='Enter'){e.preventDefault();onOpen(a.id);}
  if((e.key==='F10'&&e.shiftKey)||e.key==='ContextMenu'){select(a.id);menu.at(e,items(a));}
  if((e.key==='Delete'||e.key==='Backspace')&&owner){e.preventDefault();setRemoving(a);}
 }
 function move(e:ReactKeyboardEvent){if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();const at=shown.findIndex(a=>a.id===selected),n=e.key==='Home'?0:e.key==='End'?shown.length-1:Math.max(0,Math.min(shown.length-1,at+(e.key==='ArrowDown'?1:-1)));if(shown[n]){select(shown[n].id);rows.current?.querySelectorAll<HTMLButtonElement>('[role=option]')[n]?.focus();}}
 const title=department==='all'?'All staff':department==='main'?'Main agent':departmentName(department==='none'?null:department);
 return <section ref={page} className="ag-staff" aria-label="Staff directory" onKeyDown={key}>
 <div className="ag-list-pane">
  <header className="ag-toolbar"><h2>{title}</h2>
   <span className="oc-switch" role="group" aria-label="View"><button type="button" aria-pressed={view==='list'} title="List" onClick={()=>setView('list')}><UiIcon name="list" size={13}/>List</button><button type="button" aria-pressed={view==='chart'} title="Chart: who reports to whom" onClick={()=>setView('chart')}><UiIcon name="org" size={13}/>Chart</button></span>
   <span className="ag-anchor" data-popover-anchor><IconButton icon="filter" label="Show" pressed={showing||role!=='all'||sort!=='name'} onClick={()=>setShowing(v=>!v)}/>
    <Popover open={showing} onClose={()=>setShowing(false)} label="Show"><div className="ag-show"><label>Role<select aria-label="Staff role" value={role} onChange={e=>setRole(e.target.value)}><option value="all">Every role</option>{ROLE_CARDS.map(r=><option key={r.key} value={r.key}>{r.label}</option>)}</select></label><label>Sort by<select aria-label="Sort staff" value={sort} onChange={e=>setSort(e.target.value)}><option value="name">Name</option><option value="department">Department</option><option value="role">Role</option></select></label><button type="button" className="ghost" disabled={s.phase==='listing'} onClick={()=>{if(controller.client)forgetFacts(controller.client);void controller.list();}}><UiIcon name="refresh" size={14}/>Read the team again</button></div></Popover></span>
   {(onCompany||owner&&packages)&&<span className="ag-anchor" data-popover-anchor><IconButton icon="more" label="More team actions" onClick={e=>toolsMenu.at(e,[...(onCompany?[{label:'Plan a bigger company…',icon:'building' as UiIconName,run:onCompany}]:[]),...(owner&&packages?[{label:'Import agent…',icon:'download' as UiIconName,shortcut:'⇧⌘I',run:()=>setImporting(true)}]:[])])}/><ContextMenu menu={toolsMenu.menu} onClose={toolsMenu.close}/></span>}
   {exporting&&controller.client&&<ExportAgentSheet client={controller.client as never} agentId={exporting.id} name={exporting.name} onClose={()=>setExporting(null)} onDone={say}/>}
   {importing&&controller.client&&<ImportAgentSheet client={controller.client as never} onClose={()=>setImporting(false)} onImported={(id,_name,note)=>{setImporting(false);void controller.list().then(()=>setSelected(id));say(note);}}/>}
   {onHire&&<button type="button" className="primary ag-main-button" title="Hire an agent (⌘N)" onClick={onHire}><UiIcon name="plus" size={14}/>Hire agent</button>}
  </header>
  {view==='chart'&&s.agents.length>0?<OrgChart agents={s.agents.filter(a=>department==='all'||department==='main'||(department==='none'?!a.department:a.department===department)||a.placed==='main')} selected={selected} query={query} owner={owner} folded={folded} onFold={fold}
    onSelect={select} onOpen={id=>onOpen(id)} onMenu={(e,a)=>menu.at(e as never,items(a))} onMove={(id,target)=>void moveUnder(id,target)} onDepartment={(id,d)=>void moveToDepartment(id,d)} saved={saved} onPrefs={savePrefs}/>:
  <div className="ag-rows" ref={rows} role="listbox" aria-label="Staff" onKeyDown={move}>
   {shown.map(a=><button type="button" key={a.id} role="option" aria-selected={selected===a.id} tabIndex={selected===a.id||!agent&&shown[0]?.id===a.id?0:-1} className="ag-row" onClick={()=>select(a.id)} onDoubleClick={()=>onOpen(a.id)} onKeyDown={e=>rowKey(e,a)} onContextMenu={(e:ReactMouseEvent)=>{select(a.id);menu.at(e,items(a));}}>
    <AgentFace agent={a} face={owner?faces[a.id]:undefined} profile={owner&&faces[a.id]?library?.find(e=>e.profile.name===faces[a.id])?.profile:undefined}/>
    <span className="ag-row-text"><span className="ag-row-name">{a.subAgentOf&&<UiIcon name="sub-agent" size={12}/>}<bdi>{a.name??'Name unavailable'}</bdi>{a.isPrimary&&<span className="ag-tag">Main agent</span>}</span><span className="ag-row-sub">{a.isPrimary?'Talks to you first':a.subAgentOf?`Sub-agent of ${s.agents.find(x=>x.id===a.subAgentOf)?.name??'its agent'}`:roleWord(a.role)}</span></span>
    <span className="ag-row-dept">{a.department&&<><DepartmentTile department={a.department}/>{departmentName(a.department)}</>}</span>
   </button>)}
   {/* FR4d: only the Main agent so far: one sentence and one action. */}
   {s.phase==='ready'&&s.agents.length===1&&s.agents[0].isPrimary&&onHire&&!q&&<div className="ag-empty ag-empty-alone"><UiIcon name="users" size={28}/><p><b>{s.agents[0].name??'Your Main agent'} works alone so far</b><br/>Hire a colleague for one kind of work. {s.agents[0].name??'Your Main agent'} hands them tasks.</p><button type="button" className="primary" onClick={onHire}>Hire agent</button></div>}
   {!shown.length&&<div className="ag-empty"><UiIcon name="users" size={28}/><p>{s.phase==='listing'||s.phase==='idle'?'Loading the team…':s.phase==='error'?'The team could not be loaded.':s.agents.length?'No one here matches.':'Hire your first agent.'}</p>{s.phase==='error'&&<button type="button" onClick={()=>void controller.list()}>Try again</button>}{s.phase==='ready'&&!s.agents.length&&onHire&&<button type="button" className="primary" onClick={onHire}>Hire agent</button>}</div>}
  </div>}
 </div>
 <aside className="ag-inspector" aria-label="Selected agent">{agent?<Inspector controller={controller} agent={agent} owner={owner} onOpen={onOpen} onChat={onChat} onMenu={e=>menu.at(e,items(agent))} onClose={()=>setSelected(null)}
   picking={picking} onPick={v=>setPicking(v)} onMove={target=>{setPicking(false);void moveUnder(agent.id,target);}}/>:<div className="ag-empty"><UiIcon name="avatar" size={28}/><p>Select a staff member to see what makes it.</p></div>}</aside>
 <ContextMenu menu={menu.menu} onClose={menu.close}/>
 {removing&&<Sheet title={`Remove ${removing.name??'this agent'}?`} onClose={()=>setRemoving(null)} actions={<><button type="button" onClick={()=>setRemoving(null)}>Cancel</button><button type="button" className="primary ag-danger" disabled={busy||!!removing.isPrimary&&s.agents.length>1} onClick={()=>{const a=removing;setRemoving(null);void act('remove',a);}}>Remove</button></>}>
  <p>{removing.isPrimary&&s.agents.length>1?'This is the main agent. Make another agent the main agent first.':'It leaves the team for good. This cannot be undone.'}</p>
  {!removing.isPrimary&&<RemoveEffects agent={removing} agents={s.agents}/>}</Sheet>}
 {addingTo&&controller.client&&<AddSubAgentSheet client={controller.client} agents={controller} parent={addingTo} onClose={()=>setAddingTo(null)} onAdded={(id,text)=>{setAddingTo(null);setSelected(id);say(text,async()=>{const r=await controller.remove(id);setToast({id:Date.now(),text:r.ok?'Change undone':r.notice,undo:false});});}}/>}
 <Notice toast={toast} onUndo={runUndo} onDone={id=>setToast(t=>t?.id===id?null:t)}/>
 </section>;
}

/** What removing an agent does to the chart (said in the one question before it goes). */
function RemoveEffects({agent,agents}:{agent:PublicAgent;agents:readonly PublicAgent[]}){
 const people=agents.filter(a=>a.manager===agent.id&&a.placed!=='sub'),subs=agents.filter(a=>a.subAgentOf===agent.id);
 const up=agents.find(a=>a.id===agent.manager)?.name??'its manager';
 if(!people.length&&!subs.length)return null;
 return <ul className="oc-effects">{people.length>0&&<li>{people.length===1?`${people[0].name??'One agent'} moves`:`${people.length} agents move`} up to {up}.</li>}{subs.length>0&&<li>Its sub-agent{subs.length>1?'s':''} {subs.map(x=>x.name??'helper').join(', ')} {subs.length>1?'are':'is'} removed with it.</li>}</ul>;
}

/** OC2: the short "Reports to" picker (inspector, ⌘R). Agents under it are left out: that would be a circle. */
function ReportsToPicker({agent,agents,onMove,onClose}:{agent:PublicAgent;agents:readonly PublicAgent[];onMove:(target:string|null)=>void;onClose:()=>void}){
 const [q,setQ]=useState('');
 const below=underOf(agent.id,agents);
 const list=agents.filter(a=>a.id!==agent.id&&a.placed!=='sub'&&a.placed!=='none'&&a.id!=='small-local-agent'&&(!q.trim()||(a.name??'').toLowerCase().includes(q.trim().toLowerCase()))).slice(0,60);
 return <div className="oc-picker">
  <label className="dk-search"><UiIcon name="search" size={12}/><input autoFocus type="search" aria-label="Find an agent" placeholder="Find an agent" value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();onClose();}}}/></label>
  <div role="listbox" aria-label="Reports to">{list.map(a=>{const off=below.has(a.id)||!canMoveUnder(agent,a,agents)&&agent.manager!==a.id;
   return <button type="button" role="option" key={a.id} aria-selected={agent.manager===a.id} disabled={off} title={below.has(a.id)?`${a.name??'It'} is under ${agent.name??'this agent'}`:undefined} onClick={()=>onMove(a.id)}><Avatar name={a.name??'?'} size={18}/><span className="oc-pick-name"><bdi>{a.name??'Agent'}</bdi></span>{agent.manager===a.id&&<UiIcon name="check" size={13}/>}{a.placed==='main'&&<small>main agent</small>}</button>;})}</div>
  {agent.placed==='set'&&<button type="button" className="ghost" onClick={()=>onMove(null)}>Let Girru place it</button>}
 </div>;
}

function Inspector({controller,agent,owner,onOpen,onChat,onMenu,onClose,picking,onPick,onMove}:{controller:AgentsController;agent:PublicAgent;owner:boolean;onClose:()=>void;onOpen:(id:string,section?:CardTab)=>void;onChat?:(id:string)=>void;onMenu:(e:ReactMouseEvent)=>void;picking:boolean;onPick:(v:boolean)=>void;onMove:(target:string|null)=>void}){
 const facts=useAgentFacts(controller.client,agent.id,owner&&!!controller.client);
 const all=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot).agents;
 const manager=all.find(a=>a.id===agent.manager),subs=all.filter(a=>a.subAgentOf===agent.id),movableHere=owner&&(agent.placed==='set'||agent.placed==='auto');
 const rows:{icon:UiIconName;title:string;text:string;section:CardTab}[]=facts?[
  {icon:'smile',title:'Personality',text:facts.personality?`${facts.personality.name} · ${facts.personality.linked?'follows library changes':'its own copy'}`:'Its own settings',section:'persona'},
  {icon:'layers',title:'Specialties',text:facts.specialties.map(x=>x.name).join(' · ')||'No specialty yet',section:'skills'},
  {icon:'star',title:'Skills',text:facts.inherited+facts.extra?`${facts.inherited} from its specialties · ${facts.extra} extra`:'No skills yet',section:'skills'},
  {icon:'lock',title:'Permissions',text:permissionLine(facts.modes),section:'permissions'},
  {icon:'cpu',title:'Answers with',text:agent.model?`${modelDisplayName(agent.model)}${agent.provider==='claude'?(modelDisplayName(agent.model).startsWith('Claude')?'':' · Claude'):' · on this computer'}`:'The default model',section:'profile'},
 ]:[];
 return <div className="ag-insp">
  <div className="ag-insp-head"><span className="ag-insp-back"><IconButton icon="arrow-left" label="Back to the list" onClick={onClose}/></span><Avatar name={agent.name??'?'} size={52}/><span><b><bdi>{agent.name??'Agent'}</bdi></b><small>{roleWord(agent.role)} · {departmentName(agent.department)}</small></span></div>
  <div className="ag-insp-actions">{owner&&<button type="button" onClick={()=>onOpen(agent.id)}>Open</button>}{onChat&&<button type="button" onClick={()=>onChat(agent.id)}>Chat</button>}<IconButton icon="more" label="More for this agent" onClick={onMenu}/></div>
  <p className="ag-insp-text" dir="auto">{agent.description||'No responsibilities yet.'}</p>
  <hr/>
  {agent.placed&&agent.placed!=='none'&&agent.placed!=='main'&&<span className="ag-anchor oc-reports" data-popover-anchor>
   <button type="button" className="ag-fact" disabled={!movableHere} title={agent.placed==='sub'?'A sub-agent stays with the agent it belongs to':undefined} onClick={()=>onPick(!picking)}><UiIcon name="arrow-up" size={16}/><span><small>{agent.placed==='sub'?'Sub-agent of':'Reports to'}</small><span>{manager?<><Avatar name={manager.name??'?'} size={14}/> <bdi>{manager.name??'Agent'}</bdi>{agent.placed==='auto'?' · placed by Girru':''}</>:'Nobody yet'}</span></span><UiIcon name="chevron" size={12}/></button>
   <Popover open={picking&&movableHere} onClose={()=>onPick(false)} label="Reports to"><ReportsToPicker agent={agent} agents={all} onMove={onMove} onClose={()=>onPick(false)}/></Popover></span>}
  {owner&&agent.placed!=='sub'&&agent.placed!=='none'&&<button type="button" className="ag-fact" onClick={()=>onOpen(agent.id,'subs')}><UiIcon name="sub-agent" size={16}/><span><small>Sub-agents</small><span>{subs.length?subs.map(x=>x.name??'helper').join(' · '):'None yet'}</span></span><UiIcon name="chevron" size={12}/></button>}
  {!owner?<p className="ag-muted">Only the owner sees and changes how this agent works.</p>:facts===undefined?<p className="ag-muted" role="status">Reading what makes it…</p>:facts===null?<p className="ag-muted" role="status">What makes it could not be read. <button type="button" className="link-button" onClick={()=>retryFacts(controller.client,agent.id)}>Try again</button></p>:
   rows.map(r=><button type="button" key={r.title} className="ag-fact" onClick={()=>onOpen(agent.id,r.section)}><UiIcon name={r.icon} size={16}/><span><small>{r.title}</small><span dir="auto">{r.text}</span></span><UiIcon name="chevron" size={12}/></button>)}
  <small className="ag-hint">Double-click or Enter opens the agent. Right-click for the same actions; ⌘R changes who it reports to.</small>
 </div>;
}
