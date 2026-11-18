import {useCallback,useEffect,useRef,useState} from 'react';
import type {SessionClient} from './session';
import type {PublicAgent} from './agents';
import {UiIcon} from './ui-icons';
import {Notice,Sheet} from './desktop-ui';
import {PreferenceGroup} from './Preferences';
import {DepartmentTile} from './StaffDirectory';
import {departmentName as shownName} from './agent-look';
import {DEPARTMENT_RENAME_PATH,DEPARTMENTS_PATH,departmentName as validDepartment} from './departments-contract.js';
import type {DepartmentEntry,DepartmentQuestion} from './departments-contract.js';
import {useStoreP3} from './store-switches';
import {Avatar,Tile,useMenu,ContextMenu,IconButton} from './desktop-ui';

type Toast={id:number;text:string;undo:boolean}|null;
/** The department value as the agent page saves it: lowercase, single spaces. */
export const cleanDepartment=(s:string)=>s.trim().toLowerCase().replace(/\s+/g,' ');
/** Departments in use, each with its agents, sorted by name; agents without one come last. */
export function groupDepartments(agents:readonly PublicAgent[]){
 const map=new Map<string,PublicAgent[]>();
 for(const a of agents)if(a.department)map.set(a.department,[...(map.get(a.department)??[]),a]);
 return {departments:[...map].sort(([a],[b])=>a.localeCompare(b)).map(([name,list])=>({name,agents:list})),none:agents.filter(a=>!a.department)};
}

/**
 * Settings › Departments (owner): the only place departments are listed. A
 * department is the agents' own department value, so renaming one moves all
 * its agents; moving one agent changes only that agent. A new department is
 * made by moving agents into it. Changes save at once and can be undone.
 * Agents can do the same through MCP (agents: departments, rename_department,
 * set_department).
 */
export function DepartmentsSettings({client,onAgent}:{client:SessionClient;onAgent?:(id:string)=>void}){
 // STORE-MAP-01 P3 (FD2a): one list of departments for agents and projects, by id.
 return useStoreP3(client)?<OneDepartmentList client={client} onAgent={onAgent}/>:<AgentDepartments client={client} onAgent={onAgent}/>;
}

function AgentDepartments({client,onAgent}:{client:SessionClient;onAgent?:(id:string)=>void}){
 const [agents,setAgents]=useState<PublicAgent[]|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false);
 const [renaming,setRenaming]=useState<{from:string;to:string}|null>(null),[creating,setCreating]=useState<{name:string;ids:string[]}|null>(null);
 const [toast,setToast]=useState<Toast>(null),[problem,setProblem]=useState('');const undo=useRef<(()=>Promise<void>)|null>(null);
 const load=useCallback(async()=>{setError(false);try{const r=await client.request({method:'GET',path:'/api/agents'} as never);if(r.status!==200)throw Error();setAgents([...(r.body as {agents:PublicAgent[]}).agents]);}catch{setError(true);}},[client]);
 useEffect(()=>{void load();},[load]);
 const say=(text:string,back?:()=>Promise<void>)=>{undo.current=back??null;setToast({id:Date.now(),text,undo:!!back});};
 const rename=async(from:string,to:string,quiet=false)=>{
  const target=cleanDepartment(to);if(!validDepartment(target)){setProblem('Use lowercase letters, numbers, spaces, - or _ (up to 64).');return false;}
  if(target===from){setRenaming(null);return true;}
  const merged=!!agents?.some(a=>a.department===target);
  setBusy(true);setProblem('');
  try{const r=await client.request({method:'POST',path:DEPARTMENT_RENAME_PATH,body:{from,to:target}} as never);if(r.status!==200)throw Error((r.body as {code?:string})?.code??'unavailable');
   setRenaming(null);await load();
   if(!quiet)say(merged?`${shownName(from)} joined ${shownName(target)}.`:`${shownName(from)} is now ${shownName(target)}.`,merged?undefined:async()=>{await rename(target,from,true);say(`${shownName(from)} is back.`);});
   return true;}
  catch(e){setProblem(e instanceof Error&&e.message==='not_found'?'That department has no agents any more. The list is read again.':'The department was not renamed. Try again.');void load();return false;}
  finally{setBusy(false);}
 };
 // One agent at a time with the version it was read at; a changed agent stops the move and the list is read again.
 const move=async(list:PublicAgent[],department:string|null)=>{
  const done:{agent:PublicAgent;before:string|null}[]=[];setBusy(true);setProblem('');
  try{for(const a of list){const r=await client.request({method:'PUT',path:`/api/agents/${encodeURIComponent(a.id)}`,body:{expectedVersion:a.version,department}} as never);if(r.status!==200)throw Error(r.status===409?'changed':'unavailable');done.push({agent:a,before:a.department??null});}return done;}
  catch(e){setProblem(e instanceof Error&&e.message==='changed'?'Someone changed an agent meanwhile. The list is read again; try once more.':'Not every agent was moved. Try again.');return done;}
  finally{setBusy(false);await load();}
 };
 const moveOne=async(a:PublicAgent,value:string)=>{
  if(value==='__new'){setCreating({name:'',ids:[a.id]});return;}
  const to=value||null;if(to===(a.department??null))return;
  const done=await move([a],to);
  if(done.length)say(`${a.name??'The agent'} moved to ${shownName(to)}.`,async()=>{const fresh=await client.request({method:'GET',path:`/api/agents/${encodeURIComponent(a.id)}`} as never);const now=(fresh.body as {agent?:PublicAgent})?.agent;if(now)await move([now],done[0].before);});
 };
 const create=async()=>{if(!creating||!agents)return;const name=cleanDepartment(creating.name);if(!validDepartment(name)){setProblem('Use lowercase letters, numbers, spaces, - or _ (up to 64).');return;}
  const list=agents.filter(a=>creating.ids.includes(a.id));const done=await move(list,name);setCreating(null);if(done.length)say(`${shownName(name)} has ${done.length===1?'1 agent':`${done.length} agents`}.`);};
 if(error)return <div className="dept-empty" role="alert"><p>Departments could not be read.</p><button type="button" onClick={()=>void load()}>Try again</button></div>;
 if(!agents)return <p className="dept-empty" role="status">Reading departments…</p>;
 const {departments,none}=groupDepartments(agents);
 const choices=departments.map(d=>d.name);
 const agentRow=(a:PublicAgent)=><li key={a.id} className="dept-agent"><button type="button" className="link-button" title="Open the agent" disabled={!onAgent} onClick={()=>onAgent?.(a.id)}><bdi>{a.name??'Name unavailable'}</bdi>{a.isPrimary&&<span className="ag-tag">Main agent</span>}</button>
  <select aria-label={`Department of ${a.name??'this agent'}`} value={a.department??''} disabled={busy} onChange={e=>void moveOne(a,e.target.value)}>{choices.map(d=><option key={d} value={d}>{shownName(d)}</option>)}<option value="">No department</option><option value="__new">New department…</option></select></li>;
 return <>
  <PreferenceGroup title="Departments" note="A department groups agents and shows as a chip on their row. Rename one to move all its agents; choose another department on an agent to move only that one.">
   <div className="dept-toolbar"><button type="button" disabled={busy||!agents.length} onClick={()=>{setProblem('');setCreating({name:'',ids:[]});}}><UiIcon name="plus" size={14}/>New department…</button></div>
   {problem&&<p className="dept-problem" role="alert">{problem}</p>}
   {!departments.length&&<p className="dept-empty">No department yet. Make one and move agents into it.</p>}
   <ul className="dept-list" aria-label="Departments">{departments.map(d=><li key={d.name} className="dept-item">
    <div className="dept-head"><DepartmentTile department={d.name} size={26}/>
     {renaming?.from===d.name?<form className="dept-rename" onSubmit={e=>{e.preventDefault();void rename(d.name,renaming.to);}}><input aria-label={`New name for ${shownName(d.name)}`} autoFocus maxLength={64} value={renaming.to} disabled={busy} onChange={e=>setRenaming({from:d.name,to:e.target.value})} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();setRenaming(null);}}}/><button type="submit" className="primary" disabled={busy||!renaming.to.trim()}>Rename</button><button type="button" disabled={busy} onClick={()=>setRenaming(null)}>Cancel</button></form>
     :<><span className="dept-name"><strong>{shownName(d.name)}</strong><small>{d.agents.length===1?'1 agent':`${d.agents.length} agents`}</small></span><button type="button" className="tool" title="Rename (moves every agent in it)" aria-label={`Rename ${shownName(d.name)}`} disabled={busy} onClick={()=>{setProblem('');setRenaming({from:d.name,to:d.name});}}><UiIcon name="pencil" size={14}/></button></>}
    </div>
    <ul className="dept-agents">{d.agents.map(agentRow)}</ul>
   </li>)}
   {none.length>0&&<li className="dept-item" data-none><div className="dept-head"><DepartmentTile department={null} size={26}/><span className="dept-name"><strong>No department</strong><small>{none.length===1?'1 agent':`${none.length} agents`}</small></span></div><ul className="dept-agents">{none.map(agentRow)}</ul></li>}
   </ul>
  </PreferenceGroup>
  {creating&&<Sheet title="New department" onClose={()=>setCreating(null)} actions={<><button type="button" onClick={()=>setCreating(null)}>Cancel</button><button type="button" className="primary" disabled={busy||!creating.name.trim()||!creating.ids.length} onClick={()=>void create()}>Make department</button></>}>
   <label className="dk-field">Name<input autoFocus maxLength={64} value={creating.name} onChange={e=>setCreating({...creating,name:e.target.value})} placeholder="for example research"/></label>
   <p className="fine-print">A department exists while an agent is in it. Choose who moves into it.</p>
   <ul className="dept-pick" aria-label="Agents to move">{agents.map(a=><li key={a.id}><label><input type="checkbox" checked={creating.ids.includes(a.id)} onChange={e=>setCreating({...creating,ids:e.target.checked?[...creating.ids,a.id]:creating.ids.filter(x=>x!==a.id)})}/><bdi>{a.name??'Name unavailable'}</bdi><small>{shownName(a.department)}</small></label></li>)}</ul>
  </Sheet>}
  <Notice toast={toast} onUndo={()=>{const u=undo.current;undo.current=null;setToast(null);if(u)void u();}} onDone={id=>setToast(t=>t?.id===id?null:t)}/>
 </>;
}

const LOOKS=['#2F8A5B','#B5487A','#B07A1E','#1E7FA0','#6E4BC2','#8A5A2E','#3F6FD8','#A33A3A'] as const;
type Del={id:string;name:string;effects:{projects:number;agents:number;pinnedFacts:number;accessRules:number};previewHash:string};
const count=(n:number,one:string,many:string)=>n===1?`1 ${one}`:`${n} ${many}`;

/**
 * STORE-MAP-01 P3 (FD2a): Settings › Departments as the one list. A department
 * groups agents and projects; renaming or merging it follows everywhere (rules,
 * boards, specialties, hire, memory) because places keep its id. The selected
 * department shows in the inspector. A merge can be undone; deleting asks once
 * and says what moves where.
 */
function OneDepartmentList({client,onAgent}:{client:SessionClient;onAgent?:(id:string)=>void}){
 const [list,setList]=useState<DepartmentEntry[]|null>(null),[questions,setQuestions]=useState<DepartmentQuestion[]>([]),[error,setError]=useState(false);
 const [selected,setSelected]=useState<string|null>(null),[busy,setBusy]=useState(false),[problem,setProblem]=useState('');
 const [creating,setCreating]=useState<string|null>(null),[renaming,setRenaming]=useState<string|null>(null),[merging,setMerging]=useState<string|null>(null),[deleting,setDeleting]=useState<Del|null>(null);
 const [toast,setToast]=useState<Toast>(null);const undo=useRef<(()=>Promise<void>)|null>(null);const {menu,at:open,close}=useMenu();
 const req=useCallback((method:string,path:string,body?:unknown)=>client.request({method,path,...(body===undefined?{}:{body})} as never),[client]);
 const load=useCallback(async()=>{setError(false);try{const r=await req('GET',DEPARTMENTS_PATH);if(r.status!==200)throw Error();const b=r.body as {departments:DepartmentEntry[];questions:DepartmentQuestion[]};setList(b.departments);setQuestions(b.questions);setSelected(id=>id&&b.departments.some(d=>d.id===id)?id:b.departments[0]?.id??null);}catch{setError(true);}},[req]);
 useEffect(()=>{void load();},[load]);
 const say=(text:string,back?:()=>Promise<void>)=>{undo.current=back??null;setToast({id:Date.now(),text,undo:!!back});};
 const act=async(fn:()=>Promise<{status:number;body:unknown}>,okText?:string,back?:()=>Promise<void>)=>{
  setBusy(true);setProblem('');
  try{const r=await fn();if(r.status!==200){const reason=(r.body as {reason?:string})?.reason;setProblem(reason==='name_taken'?'That department already exists.':reason==='version_conflict'?'The department changed meanwhile. The list is read again; try once more.':'That did not work. Try again.');return null;}
   if(okText)say(okText,back);return r.body;}
  catch{setProblem('That did not work (no connection).');return null;}
  finally{setBusy(false);await load();}
 };
 const d=list?.find(x=>x.id===selected)??null;
 const patch=(x:DepartmentEntry,body:Record<string,unknown>,text?:string)=>act(()=>req('PATCH',`${DEPARTMENTS_PATH}/${encodeURIComponent(x.id)}`,{version:x.version,...body}),text);
 const create=async()=>{const name=(creating??'').trim();if(!name)return;const out=await act(()=>req('POST',DEPARTMENTS_PATH,{name}),`${name} is ready.`) as {department?:{id:string}}|null;setCreating(null);if(out?.department)setSelected(out.department.id);};
 const merge=async(from:DepartmentEntry,into:DepartmentEntry)=>{setMerging(null);
  const out=await act(()=>req('POST',`${DEPARTMENTS_PATH}/${encodeURIComponent(from.id)}/merge`,{into:into.id})) as {mergeId?:string}|null;
  if(out?.mergeId){const mergeId=out.mergeId;setSelected(into.id);say(`${from.name} joined ${into.name}.`,async()=>{await act(()=>req('POST',`${DEPARTMENTS_PATH}/merges/${encodeURIComponent(mergeId)}/undo`),`${from.name} is back.`);setSelected(from.id);});}
 };
 const askDelete=async(x:DepartmentEntry)=>{const out=await act(()=>req('POST',`${DEPARTMENTS_PATH}/${encodeURIComponent(x.id)}/delete-preview`)) as Omit<Del,'id'>|null;if(out)setDeleting({...out,id:x.id});};
 const doDelete=async()=>{if(!deleting)return;const x=deleting;setDeleting(null);await act(()=>req('POST',`${DEPARTMENTS_PATH}/${encodeURIComponent(x.id)}/delete`,{expectedPreviewHash:x.previewHash}),`${x.name} was deleted.`);};
 const answer=(q:DepartmentQuestion,departmentId:string|null)=>act(()=>req('POST',`${DEPARTMENTS_PATH}/questions/${encodeURIComponent(q.id)}`,{departmentId}),'The rule was updated.');
 if(error)return <div className="dept-empty" role="alert"><p>Departments could not be read.</p><button type="button" onClick={()=>void load()}>Try again</button></div>;
 if(!list)return <p className="dept-empty" role="status">Reading departments…</p>;
 const tile=(x:{name:string;letter:string|null;color:string|null},size=22)=>x.color||x.letter?<span className="dept-look" style={{inlineSize:size,blockSize:size,background:x.color??undefined}} aria-hidden="true">{x.letter??x.name.charAt(0).toUpperCase()}</span>:<DepartmentTile department={x.name.toLowerCase()} size={size}/>;
 const itemMenu=(x:DepartmentEntry)=>[{label:'Rename',run:()=>{setSelected(x.id);setRenaming(x.name);}},{label:'Merge into another department…',run:()=>setMerging(x.id),disabled:list.length<2},{label:'Delete…',run:()=>void askDelete(x),danger:true}];
 return <div className="specialty-workspace dept-one has-inspector">
  <div className="specialty-window-toolbar dept-toolbar-one"><span className="dept-toolbar-note">One list for agents and projects. Renaming or merging follows everywhere.</span>
   <button type="button" className="primary" disabled={busy} onClick={()=>{setProblem('');setCreating('');}}><UiIcon name="plus" size={14}/>New department</button>
  </div>
  {problem&&<p className="specialty-notice" role="alert">{problem}</p>}
  {questions.map(q=><div key={q.id} className="specialty-notice dept-question" role="status"><span>A rule names “{q.name}”, which no agent or project uses.</span>
   <select aria-label={`Department for the rule that names ${q.name}`} defaultValue="" disabled={busy} onChange={e=>{if(e.target.value)void answer(q,e.target.value);}}><option value="" disabled>Choose a department…</option>{list.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select>
   <button type="button" disabled={busy} onClick={()=>void answer(q,null)}>Leave it for all agents</button></div>)}
  <div className="specialty-panes">
   <div className="specialty-list-pane">
    {!list.length&&<p className="dept-empty">No department yet. Make one, then add agents and projects to it.</p>}
    <ul className="specialty-quiet-list" aria-label="Departments">{list.map(x=><li key={x.id}>
     <button type="button" className="specialty-row" aria-pressed={x.id===selected} onClick={()=>setSelected(x.id)} onContextMenu={e=>{e.preventDefault();setSelected(x.id);open(e,itemMenu(x));}}>
      {tile(x,28)}<span className="specialty-row-copy"><strong>{x.name}</strong></span>
      <span className="specialty-row-people">{x.agents.slice(0,4).map(a=><Avatar key={a.id} name={a.name||'?'} size={22}/>)}</span>
      <span className="dept-projects">{x.projects.slice(0,3).map(p=><Tile key={p.key} name={p.name} size={16}/>)}</span>
     </button></li>)}</ul>
   </div>
   {d?<aside className="specialty-inspector" aria-label="Selected department">
    <header className="specialty-inspector-header"><div className="specialty-title-line">{tile(d,44)}
     {renaming!==null?<form className="dept-rename" onSubmit={e=>{e.preventDefault();const name=renaming.trim();setRenaming(null);if(name&&name!==d.name)void patch(d,{name},`${d.name} is now ${name}. Rules, boards and projects follow.`);}}>
       <input aria-label={`New name for ${d.name}`} autoFocus maxLength={80} value={renaming} onChange={e=>setRenaming(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();setRenaming(null);}}}/><button type="submit" className="primary">Rename</button></form>
     :<div><h3>{d.name}</h3><small>{count(d.agents.length,'agent','agents')} · {count(d.projects.length,'project','projects')}</small></div>}
     <span className="dept-insp-tools"><IconButton icon="pencil" label="Rename (everything follows)" onClick={()=>setRenaming(d.name)} disabled={busy}/><IconButton icon="more" label="More" onClick={e=>open(e,itemMenu(d))}/></span>
    </div></header>
    <details open><summary><UiIcon name="palette" size={14}/>Look<UiIcon name="chevron" size={12}/></summary><div className="specialty-detail-body">
     <div className="dept-swatches" role="radiogroup" aria-label="Colour">{LOOKS.map(c=><button key={c} type="button" role="radio" aria-checked={d.color===c} aria-label={`Colour ${c}`} className="dept-swatch" style={{background:c}} disabled={busy} onClick={()=>void patch(d,{color:c})}/>)}</div>
     <label>Letter<input maxLength={1} defaultValue={d.letter??''} key={d.id+d.version} onBlur={e=>{const v=e.target.value.trim();if(v!==(d.letter??''))void patch(d,{letter:v||null});}}/></label>
    </div></details>
    <details open><summary><UiIcon name="users" size={14}/>Agents<UiIcon name="chevron" size={12}/></summary><div className="specialty-detail-body">
     {d.agents.length?d.agents.map(a=><div key={a.id} className="specialty-linked-agent"><Avatar name={a.name||'?'} size={22}/><div><strong>{a.name}</strong>{d.leadAgentId===a.id&&<small>Lead</small>}</div><button type="button" disabled={!onAgent} onClick={()=>onAgent?.(a.id)}>Open</button></div>):<p>No agent yet. Choose this department on an agent's page.</p>}
     {d.agents.length>0&&<label>Lead<select value={d.leadAgentId??''} disabled={busy} onChange={e=>void patch(d,{leadAgentId:e.target.value||null})}><option value="">No lead</option>{d.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
    </div></details>
    <details open><summary><UiIcon name="folder" size={14}/>Projects<UiIcon name="chevron" size={12}/></summary><div className="specialty-detail-body">
     {d.projects.length?d.projects.map(p=><div key={p.key} className="specialty-linked-agent"><Tile name={p.name} size={18}/><div><strong>{p.name}</strong></div></div>):<p>No project yet. Move a project here from Memory (⋯ › Move to another department…).</p>}
    </div></details>
   </aside>:<div className="specialty-selection-empty"><p>Select a department to see its agents and projects.</p></div>}
  </div>
  {creating!==null&&<Sheet title="New department" onClose={()=>setCreating(null)} actions={<><button type="button" onClick={()=>setCreating(null)}>Cancel</button><button type="button" className="primary" disabled={busy||!creating.trim()} onClick={()=>void create()}>Make department</button></>}>
   <label className="dk-field">Name<input autoFocus maxLength={80} value={creating} onChange={e=>setCreating(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void create();}} placeholder="for example Research"/></label>
   <p className="fine-print">Any language. Agents and projects join it from their own pages.</p>
  </Sheet>}
  {merging&&(()=>{const from=list.find(x=>x.id===merging);if(!from)return null;return <Sheet title={`Merge ${from.name} into…`} onClose={()=>setMerging(null)} actions={<button type="button" onClick={()=>setMerging(null)}>Cancel</button>}>
   <p className="fine-print">{from.name} has {count(from.agents.length,'agent','agents')} and {count(from.projects.length,'project','projects')}. They, its rules and its board move; you can undo it.</p>
   <ul className="dept-pick" aria-label="Merge into">{list.filter(x=>x.id!==from.id).map(x=><li key={x.id}><button type="button" className="specialty-row" disabled={busy} onClick={()=>void merge(from,x)}>{tile(x)}<span className="specialty-row-copy"><strong>{x.name}</strong></span></button></li>)}</ul>
  </Sheet>;})()}
  {deleting&&<Sheet title={`Delete ${deleting.name}?`} onClose={()=>setDeleting(null)} actions={<><button type="button" onClick={()=>setDeleting(null)}>Cancel</button><button type="button" className="danger" disabled={busy} onClick={()=>void doDelete()}>Delete</button></>}>
   <p>{[deleting.effects.agents?`${count(deleting.effects.agents,'agent','agents')} will have no department`:'',deleting.effects.projects?`${count(deleting.effects.projects,'project','projects')} move to General`:'',deleting.effects.pinnedFacts?`${count(deleting.effects.pinnedFacts,'pinned fact','pinned facts')} go`:''].filter(Boolean).join('; ')||'No agent or project is in it'}. A rule left without a department is paused; its board moves to Past departments.</p>
  </Sheet>}
  <ContextMenu menu={menu} onClose={close}/>
  <Notice toast={toast} onUndo={()=>{const u=undo.current;undo.current=null;setToast(null);if(u)void u();}} onDone={id=>setToast(t=>t?.id===id?null:t)}/>
 </div>;
}
