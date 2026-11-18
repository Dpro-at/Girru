import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {AgentsController,PublicAgent} from './agents';
import type {PartDone} from './agent-card';
import type {SessionClient} from './session';
import {Avatar,ContextMenu,IconButton,Sheet,useMenu} from './desktop-ui';
import type {MenuItem} from './desktop-ui';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';
import {TEMPLATES_PATH} from './specialty-contract.js';

type GrantsView={version:number;grants:{tool:string}[];available?:{name:string;description:string;requiresApproval:boolean;allowedByServer:boolean;execClass:boolean}[]};
type Work={id:string;kind:'helper'|'quick';agentId:string|null;status:'running'|'waiting'|'finished'|'failed';summary:string|null;sessionId:string|null;createdAt:string|null};
const QUICK=['quick_helper','quick_helper_result'],TEAM=['team_list','team_delegate','team_results'];
/** A tool name in plain words ("memory_search" → "Memory search"). */
export const toolWords=(name:string)=>{const t=name.replace(/^mcp(?::[^:]+:|__[a-z0-9-]+__)/,'').replace(/[_:.-]+/g,' ').trim();return t?t[0].toUpperCase()+t.slice(1):name;};
const when=(iso:string|null)=>{if(!iso)return '';const d=new Date(iso);if(Number.isNaN(d.getTime()))return '';const today=new Date().toDateString()===d.toDateString();return today?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):d.toLocaleDateString([],{month:'short',day:'numeric'});};
const STATE:Record<Work['status'],{word:string;icon:UiIconName;tone:string}>={running:{word:'Working',icon:'play',tone:'sa-run'},waiting:{word:'Waits for you',icon:'alert',tone:'sa-wait'},finished:{word:'Finished',icon:'check',tone:'sa-done'},failed:{word:'Did not finish',icon:'close',tone:'sa-fail'}};

async function readGrants(client:Pick<SessionClient,'request'>,id:string):Promise<GrantsView|null>{
 try{const r=await client.request({method:'GET',path:`/api/agents/${id}/tool-grants`} as never);return r.status===200?r.body as GrantsView:null;}catch{return null;}
}
async function writeGrants(client:Pick<SessionClient,'request'>,id:string,g:GrantsView,next:string[],extra:{parentAgentId?:null}={}):Promise<boolean>{
 try{const r=await client.request({method:'PUT',path:`/api/agents/${id}/tool-grants`,body:{grants:[...new Set(next)],expectedVersion:g.version,keepScopes:true,...extra}} as never);return r.status===200;}catch{return false;}
}

/**
 * SA1: an agent's sub-agents — helpers that work only for it and never get
 * more than it may do — the quick helper switch, and the work it gave them.
 */
export function AgentSubAgents({client,agentId,agents,onDone,onOpenAgent}:{client:SessionClient;agentId:string;agents:AgentsController;onDone:PartDone;onOpenAgent?:(id:string)=>void}){
 const n=useSyncExternalStore(agents.subscribe,agents.getSnapshot,agents.getSnapshot);
 const me=n.agents.find(a=>a.id===agentId);
 const subs=n.agents.filter(a=>a.subAgentOf===agentId),people=n.agents.filter(a=>a.manager===agentId&&a.placed!=='sub');
 const [grants,setGrants]=useState<GrantsView|null|undefined>(),[work,setWork]=useState<Work[]|null|undefined>(),[picked,setPicked]=useState<string|null>(null),[adding,setAdding]=useState(false),[removing,setRemoving]=useState<PublicAgent|null>(null),[busy,setBusy]=useState(false);
 const menu=useMenu();
 const loadGrants=()=>readGrants(client,agentId).then(setGrants);
 const loadWork=async()=>{try{const r=await client.request({method:'GET',path:`/api/agents/${agentId}/sub-agent-work`} as never);setWork(r.status===200?(r.body as {work:Work[]}).work:null);}catch{setWork(null);}};
 useEffect(()=>{setGrants(undefined);setWork(undefined);void loadGrants();void loadWork();if(!n.agents.length)void agents.list();},[agentId]);
 // Running work is read again every few seconds while the part is open.
 useEffect(()=>{if(!work?.some(w=>w.status==='running'))return;const t=setInterval(()=>void loadWork(),5000);return()=>clearInterval(t);},[work]);
 if(me?.placed==='sub')return <section className="ag-part sa-part" aria-label="Sub-agents"><h3>Sub-agents</h3><p className="ag-muted">{me.name??'This agent'} is itself a sub-agent of {n.agents.find(a=>a.id===me.subAgentOf)?.name??'another agent'}. A sub-agent cannot have sub-agents of its own.</p></section>;
 const granted=new Set(grants?.grants.map(g=>g.tool)??[]);
 const has=(list:string[])=>list.every(t=>granted.has(t));
 const serverOff=(t:string)=>grants?.available?.find(x=>x.name===t)?.allowedByServer===false;
 async function switchTools(list:string[],on:boolean,word:string){
  if(!grants||busy)return;setBusy(true);
  const before=[...granted],next=on?[...before,...list]:before.filter(t=>!list.includes(t));
  const ok=await writeGrants(client,agentId,grants,next);setBusy(false);
  if(!ok){onDone('Nothing was changed. Read again and try once more.');void loadGrants();return;}
  const fresh=await readGrants(client,agentId);setGrants(fresh);
  onDone(`${word} ${on?'on':'off'}`,async()=>{const g=await readGrants(client,agentId);if(g&&await writeGrants(client,agentId,g,before))setGrants(await readGrants(client,agentId));});
 }
 async function makeFull(a:PublicAgent){
  const g=await readGrants(client,a.id);
  if(!g||!await writeGrants(client,a.id,g,g.grants.map(x=>x.tool),{parentAgentId:null})){onDone(`${a.name??'It'} is still a sub-agent. Try again.`);return;}
  await agents.list();onDone(`${a.name??'It'} is now a normal team member`);
 }
 async function stop(w:Work){
  try{const r=await client.request({method:'POST',path:`/api/agents/${agentId}/sub-agent-work/${w.id}/stop`} as never);onDone(r.status===200?'The quick helper stops':'It had already finished');}catch{onDone('Nothing was sent.');}
  void loadWork();
 }
 const items=(a:PublicAgent):MenuItem[]=>[...(onOpenAgent?[{label:'Open',icon:'contact' as UiIconName,run:()=>onOpenAgent(a.id)}]:[]),{label:'Make a full agent…',icon:'user-plus',run:()=>void makeFull(a)},'sep',{label:'Remove sub-agent…',icon:'trash',danger:true,run:()=>setRemoving(a)}];
 const selected=work?.find(w=>w.id===picked);
 const teamOff=(subs.length>0||people.length>0)&&grants&&!has(TEAM);
 return <section className="ag-part sa-part" aria-label="Sub-agents">
  <div className="ag-head-row"><h3>Sub-agents</h3><button type="button" className="primary ag-main-button" disabled={!me} onClick={()=>setAdding(true)}><UiIcon name="plus" size={14}/>Add sub-agent</button></div>
  <h4>Its helpers</h4>
  {subs.length?<div className="sa-helpers">{subs.map(a=><div key={a.id} className="sa-helper" onContextMenu={e=>{e.preventDefault();menu.at(e,items(a));}}>
    <Avatar name={a.name??'?'} size={32}/><span className="sa-helper-text"><b><bdi>{a.name??'Helper'}</bdi></b><small>{[a.description?.split('\n')[0]?.slice(0,80),a.provider==='ollama'?'on this computer':a.model].filter(Boolean).join(' · ')}</small></span>
    <span className="sa-state">{work?.some(w=>w.agentId===a.id&&w.status==='running')?'Working':'Ready'}</span>
    <IconButton icon="more" label={`More for ${a.name??'this helper'}`} onClick={e=>menu.at(e,items(a))}/>
   </div>)}</div>:<p className="ag-muted">No helpers yet. A helper works only for {me?.name??'this agent'}, and never gets more than it may do.</p>}
  {teamOff&&<p className="sa-note"><UiIcon name="info" size={14}/><span>{me?.name??'This agent'} cannot give work yet.{serverOff('team_delegate')?' This computer does not let agents run work for others.':''}</span>{!serverOff('team_delegate')&&<button type="button" disabled={busy} onClick={()=>void switchTools(TEAM,true,'Giving work')}>Let it give work</button>}</p>}
  <label className="sa-quick"><span className="sa-quick-icon"><UiIcon name="pulse" size={15}/></span><span className="sa-helper-text"><b>Quick helper</b><small>For light work (look up, sum up, sort, draft) it may start a short-lived helper on this computer's own model. Read only, at most two at a time.</small></span>
   <input type="checkbox" role="switch" aria-label="Allow a quick helper" checked={!!grants&&has(QUICK)} disabled={!grants||busy} onChange={e=>void switchTools(QUICK,e.target.checked,'Quick helper')}/></label>
  {grants===null&&<p className="ag-muted" role="status">What it may use could not be read. <button type="button" className="link-button" onClick={()=>void loadGrants()}>Try again</button></p>}
  <h4>Work given to sub-agents</h4>
  {work===undefined?<p className="ag-muted" role="status">Reading the work…</p>:work===null?<p className="ag-muted" role="status">The work could not be read. <button type="button" className="link-button" onClick={()=>void loadWork()}>Try again</button></p>:!work.length?<p className="ag-muted">Nothing yet. When {me?.name??'it'} gives a helper work, it shows here.</p>:
   <div className="sa-work" role="listbox" aria-label="Work given to sub-agents">{work.map(w=>{const st=STATE[w.status],who=w.kind==='quick'?'Quick helper':n.agents.find(a=>a.id===w.agentId)?.name??'A helper';
    return <button type="button" role="option" key={w.id} aria-selected={picked===w.id} className="sa-work-row" onClick={()=>setPicked(picked===w.id?null:w.id)}>
     <span className={`sa-dot ${st.tone}`}><UiIcon name={st.icon} size={12}/></span>
     <span className="sa-helper-text"><span>{w.summary??(w.status==='waiting'?'Waits for you to allow a step':w.status==='running'?'Working on it…':'No answer text')}</span><small>{who}{w.createdAt?` · ${when(w.createdAt)}`:''}</small></span>
     <span className="sa-state">{st.word}</span></button>;})}</div>}
  {selected&&<div className="sa-detail" aria-label="Selected work">
   <p><b>{STATE[selected.status].word}</b> · {selected.kind==='quick'?'Quick helper on this computer':n.agents.find(a=>a.id===selected.agentId)?.name??'A helper'}</p>
   {selected.summary&&<p dir="auto">{selected.summary}</p>}
   <p className="ag-muted">{selected.kind==='quick'?'Read only. Stops after 5 minutes.':'Stops after 4 minutes or 8 actions; it cannot hand work on.'} A finished answer is the helper's report, not proof.</p>
   {selected.kind==='quick'&&selected.status==='running'&&<button type="button" onClick={()=>void stop(selected)}><UiIcon name="stop" size={12}/>Stop</button>}
  </div>}
  {adding&&me&&<AddSubAgentSheet client={client} agents={agents} parent={me} onClose={()=>setAdding(false)} onAdded={(id,text)=>{setAdding(false);onDone(text,async()=>{await agents.remove(id);});}}/>}
  {removing&&<Sheet title={`Remove ${removing.name??'this helper'}?`} onClose={()=>setRemoving(null)} actions={<><button type="button" onClick={()=>setRemoving(null)}>Cancel</button><button type="button" className="primary ag-danger" onClick={()=>{const a=removing;setRemoving(null);void agents.remove(a.id).then(r=>onDone(r.notice));}}>Remove</button></>}><p>It leaves for good. This cannot be undone.</p></Sheet>}
  <ContextMenu menu={menu.menu} onClose={menu.close}/>
 </section>;
}

/**
 * SA1 sheet: a helper for one agent. Filled for you — the name from its job,
 * "Copy of it", the tools that do not need approval. Only the agent's own
 * tools are offered; the server checks it again.
 */
export function AddSubAgentSheet({client,agents,parent,onClose,onAdded}:{client:SessionClient;agents:AgentsController;parent:PublicAgent;onClose:()=>void;onAdded:(id:string,notice:string)=>void}){
 const [name,setName]=useState(''),[startsAs,setStartsAs]=useState<'copy'|'specialty'|'empty'>('copy'),[specialty,setSpecialty]=useState(''),[description,setDescription]=useState(''),[tools,setTools]=useState<string[]>([]),[offer,setOffer]=useState<GrantsView['available']|null>(),[specialties,setSpecialties]=useState<{id:string;name:string}[]>([]),[busy,setBusy]=useState(false),[problem,setProblem]=useState('');
 const first=useRef(true);
 useEffect(()=>{void readGrants(client,parent.id).then(g=>{if(!g){setOffer(null);return;}const mine=new Set(g.grants.map(x=>x.tool));const list=(g.available??[]).filter(t=>mine.has(t.name));
   setOffer(list);if(first.current){first.current=false;setTools(list.filter(t=>!t.requiresApproval&&!t.execClass&&![...QUICK,...TEAM].includes(t.name)).map(t=>t.name));}});
  void client.request({method:'GET',path:TEMPLATES_PATH} as never).then(r=>{if(r.status===200)setSpecialties(((r.body as {templates?:{id:string;name:string}[]}).templates??[]).slice(0,500));}).catch(()=>{});},[client,parent.id]);
 const ready=!busy&&offer!==undefined&&(startsAs!=='specialty'||!!specialty);
 async function add(){
  if(!ready)return;setBusy(true);setProblem('');
  const r=await agents.addSubAgent(parent.id,{startsAs,tools,...(name.trim()?{name:name.trim()}:{}),...(startsAs==='specialty'?{specialtyId:specialty}:{}),...(startsAs==='empty'&&description.trim()?{description:description.trim()}:{})});
  setBusy(false);if(r.ok&&r.id)onAdded(r.id,r.notice);else setProblem(r.notice);
 }
 const starts:{key:'copy'|'specialty'|'empty';title:string;text:string;icon:UiIconName}[]=[{key:'copy',title:'Copy of it',text:'Same job and personality',icon:'copy'},{key:'specialty',title:'A specialty',text:'One from Library',icon:'layers'},{key:'empty',title:'Empty',text:'Write its job yourself',icon:'file'}];
 return <Sheet title={`A helper for ${parent.name??'this agent'}`} onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!ready} onClick={()=>void add()}>{busy?'Adding…':'Add sub-agent'}</button></>}>
  <div className="sa-sheet">
   <label className="ag-field">Name<input value={name} maxLength={60} placeholder="Girru picks a new name when left empty" onChange={e=>setName(e.target.value)}/></label>
   <span className="ag-field">Starts as</span>
   <div className="sa-starts" role="radiogroup" aria-label="Starts as">{starts.map(s=><button type="button" role="radio" aria-checked={startsAs===s.key} key={s.key} className="sa-start" onClick={()=>setStartsAs(s.key)}><UiIcon name={s.icon} size={16}/><b>{s.title}</b><small>{s.text}</small></button>)}</div>
   {startsAs==='specialty'&&<label className="ag-field">Specialty<select value={specialty} onChange={e=>setSpecialty(e.target.value)}><option value="">Choose one…</option>{specialties.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
   {startsAs==='empty'&&<label className="ag-field">Its job<textarea rows={3} maxLength={1000} value={description} onChange={e=>setDescription(e.target.value)} placeholder="What it does for its agent"/></label>}
   <span className="ag-field">What it may do (only what {parent.name??'its agent'} itself may do)</span>
   {offer===undefined?<p className="ag-muted" role="status">Reading what {parent.name??'it'} may use…</p>:offer===null?<p className="ag-muted" role="status">What it may use could not be read.</p>:!offer.length?<p className="ag-muted">{parent.name??'This agent'} has no tools to share yet.</p>:
    <div className="sa-tools">{offer.map(t=><label key={t.name} className="sa-tool" title={t.description}><input type="checkbox" checked={tools.includes(t.name)} onChange={()=>setTools(v=>v.includes(t.name)?v.filter(x=>x!==t.name):[...v,t.name])}/><span>{toolWords(t.name)}</span>{(t.requiresApproval||t.execClass)&&<small>asks you each time</small>}</label>)}</div>}
   <p className="ag-muted">It can never do more than {parent.name??'its agent'}. What its agent must ask you, it must ask too.</p>
   {problem&&<p className="ag-alert" role="alert">{problem}</p>}
  </div>
 </Sheet>;
}
