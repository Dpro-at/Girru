import {useEffect,useState} from 'react';
import type {SessionClient} from './session';
import {useStoreP2} from './store-switches';
import type {PartDone} from './agent-card';
import {TEMPLATES_PATH as P} from './specialty-contract.js';
import {ContextMenu,Sheet,useMenu} from './desktop-ui';
import {UiIcon} from './ui-icons';
import {departmentIcon,departmentTone,tileStyle} from './agent-look';
import {forgetFacts} from './agent-facts';
import {skillTitle} from './skill-display';

type Specialty={id:string;name:string;description?:string;department:string;revision:number;planned?:boolean};
type Skill={id:string;name:string;description?:string};
type Config={primarySkill:string|null;skills:string[]};
const SKILLS='/api/skill-library';
const MAX_SPECIALTIES=10,MAX_SKILLS=50;
async function rpc<T>(client:SessionClient,method:string,path:string,body?:unknown):Promise<T>{const r=await client.request({method,path,...(body===undefined?{}:{body})} as never);if(r.status!==200)throw Error((r.body as {code?:string}|null)?.code??'unavailable');return r.body as T;}

/**
 * SP7: the agent's specialties as tiles and its skills split into "from its
 * specialties" and "extra". Every change applies at once with Undo; skills
 * and specialties never give tools or permissions.
 */
export function AgentSpecialtiesSkills({client,agentId,onDone}:{client:SessionClient;agentId:string;onDone:PartDone}){
 const p2=useStoreP2(client);
 const [ready,setReady]=useState<Specialty[]>([]),[linked,setLinked]=useState<Specialty[]>([]),[configs,setConfigs]=useState<Record<string,Config>>({}),[skills,setSkills]=useState<Skill[]>([]),[selected,setSelected]=useState<string[]>([]),[revision,setRevision]=useState(0);
 const [phase,setPhase]=useState<'loading'|'ready'|'saving'|'error'>('loading'),[notice,setNotice]=useState(''),[reload,setReload]=useState(0),[giving,setGiving]=useState(false),[adding,setAdding]=useState(false);
 const menu=useMenu();
 async function readLinked(){const b=await rpc<{templates:Specialty[]}>(client,'GET',`${P}/assigned/${agentId}`);const c=await Promise.all(b.templates.map(t=>rpc<{config?:Config}>(client,'GET',`${P}/${t.id}`).catch(()=>null)));setLinked(b.templates);setConfigs(Object.fromEntries(b.templates.map((t,i)=>[t.id,c[i]?.config??{primarySkill:null,skills:[]}])));}
 useEffect(()=>{let live=true;setPhase('loading');void Promise.all([rpc<{templates:Specialty[]}>(client,'GET',P),rpc<{skills:Skill[]}>(client,'GET',SKILLS),rpc<{selected:string[];revision:number}>(client,'GET',`${SKILLS}/agents/${agentId}`),readLinked()]).then(([all,catalog,mine])=>{if(!live)return;setReady(all.templates.filter(t=>!t.planned&&t.revision>0));setSkills(catalog.skills);setSelected(mine.selected);setRevision(mine.revision);setPhase('ready');setNotice('');}).catch(()=>{if(live)setPhase('error');});return()=>{live=false;};},[client,agentId,reload]);
 const name=(id:string)=>{const s=skills.find(x=>x.id===id);return s?skillTitle(s.name):'A skill';};
 const inherited=new Map<string,string>();for(const t of linked){const c=configs[t.id];for(const id of [...(c?.primarySkill?[c.primarySkill]:[]),...(c?.skills??[])])if(!inherited.has(id))inherited.set(id,t.name);}
 const extra=selected.filter(id=>!inherited.has(id));
 // A skill given directly that a specialty also brings stays under its specialty, but can still be taken back (S-2).
 const takeBackDirect=(id:string)=>void setSkills_(selected.filter(x=>x!==id),`${name(id)} taken back · it still comes from ${inherited.get(id)}`);
 const directMenu=(id:string)=>[{label:'Take back',icon:'unlink' as const,shortcut:'⌫',disabled:phase==='saving',run:()=>takeBackDirect(id)}];
 async function link(item:Specialty,on:boolean,undo=true){
  if(phase!=='ready')return;setPhase('saving');setNotice('');
  try{await rpc(client,'POST',`${P}/${item.id}/agents`,{agentId,revision:item.revision,linked:on});await readLinked();setPhase('ready');forgetFacts(client,agentId);
   if(undo)onDone(on?`${item.name} given`:`${item.name} taken back`,()=>link(item,!on,false));}
  catch(e){setPhase('ready');setNotice(e instanceof Error&&e.message==='specialty_limit'?`Up to ${MAX_SPECIALTIES} specialties.`:'The change could not be confirmed. Read the specialties again before another change.');}
 }
 async function setSkills_(next:string[],text:string,undo=true){
  if(phase!=='ready')return;const before=selected;setPhase('saving');setNotice('');
  try{const r=await rpc<{revision:number}>(client,'PUT',`${SKILLS}/agents/${agentId}`,{selected:next,revision});setRevision(r.revision);setSelected(next);setPhase('ready');forgetFacts(client,agentId);
   if(undo)onDone(text,()=>setSkillsAgain(before,r.revision));}
  catch(e){setPhase('ready');setNotice(e instanceof Error&&e.message==='version_conflict'?'Skills changed elsewhere. Read them again before another change.':'Skills were not saved.');}
 }
 // Undo runs after a re-render; it uses the revision the save returned.
 async function setSkillsAgain(next:string[],rev:number){try{const r=await rpc<{revision:number}>(client,'PUT',`${SKILLS}/agents/${agentId}`,{selected:next,revision:rev});setRevision(r.revision);setSelected(next);forgetFacts(client,agentId);}catch{setNotice('The undo could not be saved. Read the skills again.');}}
 if(phase==='loading')return <p className="ag-muted" role="status">Reading specialties and skills…</p>;
 if(phase==='error')return <div className="ag-part"><p role="status">Specialties and skills could not be read.</p><button type="button" onClick={()=>setReload(n=>n+1)}>Try again</button></div>;
 const busy=phase==='saving';
 return <div className="ag-part ag-spec">
  {notice&&<p className="ag-alert" role="alert">{notice} <button type="button" className="link-button" onClick={()=>setReload(n=>n+1)}>Read again</button></p>}
  <section aria-label="Specialties"><div className="ag-head-row"><h3>Specialties</h3><small className="ag-muted">up to {MAX_SPECIALTIES} · instructions and skills reach it on its next turn</small><button type="button" className="primary" disabled={busy||linked.length>=MAX_SPECIALTIES} onClick={()=>setGiving(true)}>Give a specialty…</button></div>
   {linked.length?<div className="ag-spec-tiles">{linked.map(t=>{const tone=departmentTone(t.department);return <div key={t.id} className="ag-spec-tile" onContextMenu={e=>menu.at(e,[{label:'Take back',icon:'unlink',shortcut:'⌫',disabled:busy,run:()=>void link(t,false)}])}>
    <span className="ag-tile" style={{...tileStyle(tone),inlineSize:32,blockSize:32}} aria-hidden="true"><UiIcon name={departmentIcon(t.department)} size={16}/></span>
    <span className="ag-spec-text"><b>{t.name}</b><small>{t.department}</small></span>
    <button type="button" className="dk-icon" aria-label={`More for ${t.name}`} title="Take back (Delete)" disabled={busy} onClick={e=>menu.at(e,[{label:'Take back',icon:'unlink',run:()=>void link(t,false)}])} onKeyDown={e=>{if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();void link(t,false);}}}><UiIcon name="more" size={15}/></button></div>;})}</div>:<p className="ag-muted">No specialty yet. A specialty brings its instructions and skills.</p>}
  </section>
  <hr/>
  <section aria-label="Skills"><div className="ag-head-row"><h3>Skills</h3><button type="button" disabled={busy||selected.length>=MAX_SKILLS} onClick={()=>setAdding(true)}>Add skills…</button></div>
   <h4>From its specialties</h4>
   {inherited.size?<div className="ag-chips">{[...inherited].map(([id,from])=>{const direct=selected.includes(id);return <span key={id} className="ag-chip" data-on={direct||undefined} title={direct?`From ${from} · also given directly`:`From ${from}`} onContextMenu={direct?e=>menu.at(e,directMenu(id)):undefined}><UiIcon name="star" size={13}/>{name(id)}<UiIcon name="link" size={12}/>{direct&&<button type="button" className="ag-chip-x" aria-label={`More for ${name(id)}`} title="Also given directly · Take back" disabled={busy} onClick={e=>menu.at(e,directMenu(id))} onKeyDown={e=>{if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();takeBackDirect(id);}}}><UiIcon name="more" size={12}/></button>}</span>;})}</div>:<p className="ag-muted">None yet.</p>}
   <h4>Extra for this agent</h4>
   {extra.length?<div className="ag-chips">{extra.map(id=><span key={id} className="ag-chip" data-on><UiIcon name="star" size={13}/>{name(id)}<button type="button" className="ag-chip-x" aria-label={`Take back ${name(id)}`} title="Take back (Delete)" disabled={busy} onClick={()=>void setSkills_(selected.filter(x=>x!==id),`${name(id)} taken back`)}><UiIcon name="close" size={12}/></button></span>)}</div>:<p className="ag-muted">None.</p>}
   <small className="ag-muted">Skills and specialties never give tools or permissions; those stay in Permissions.{p2?' The agent sees each one’s name and first line until it opens it.':''}</small>
  </section>
  {giving&&<GiveSpecialty all={ready.filter(t=>!linked.some(x=>x.id===t.id))} onClose={()=>setGiving(false)} onPick={t=>{setGiving(false);void link(t,true);}}/>}
  {adding&&<AddSkills skills={skills.filter(x=>!selected.includes(x.id)&&!inherited.has(x.id))} room={MAX_SKILLS-selected.length} onClose={()=>setAdding(false)} onAdd={ids=>{setAdding(false);if(ids.length)void setSkills_([...selected,...ids],ids.length===1?`${name(ids[0])} added`:`${ids.length} skills added`);}}/>}
  <ContextMenu menu={menu.menu} onClose={menu.close}/>
 </div>;
}

function GiveSpecialty({all,onPick,onClose}:{all:Specialty[];onPick:(t:Specialty)=>void;onClose:()=>void}){
 const [query,setQuery]=useState('');const q=query.toLowerCase();
 const shown=all.filter(t=>[t.name,t.department,t.description].some(v=>v?.toLowerCase().includes(q)));
 return <Sheet title="Give a specialty" onClose={onClose} wide actions={<button type="button" onClick={onClose}>Cancel</button>}>
  <label className="dk-search"><UiIcon name="search" size={13}/><input autoFocus type="search" aria-label="Find a specialty" placeholder="Find a specialty" value={query} onChange={e=>setQuery(e.target.value)}/></label>
  <div className="ag-pick-list">{shown.slice(0,80).map(t=>{const tone=departmentTone(t.department);return <button type="button" key={t.id} className="ag-pick" onClick={()=>onPick(t)}><span className="ag-tile" style={{...tileStyle(tone),inlineSize:28,blockSize:28}} aria-hidden="true"><UiIcon name={departmentIcon(t.department)} size={14}/></span><span><b>{t.name}</b><small>{t.description??t.department}</small></span></button>;})}
   {!shown.length&&<p className="ag-muted">No ready specialty matches.</p>}</div>
 </Sheet>;
}
function AddSkills({skills,room,onAdd,onClose}:{skills:Skill[];room:number;onAdd:(ids:string[])=>void;onClose:()=>void}){
 const [query,setQuery]=useState(''),[chosen,setChosen]=useState<string[]>([]);const q=query.toLowerCase();
 const shown=skills.filter(s=>`${s.name} ${skillTitle(s.name)}`.toLowerCase().includes(q)||s.description?.toLowerCase().includes(q));
 return <Sheet title="Add skills" onClose={onClose} wide actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!chosen.length} onClick={()=>onAdd(chosen)}>{chosen.length>1?`Add ${chosen.length} skills`:'Add skill'}</button></>}>
  <label className="dk-search"><UiIcon name="search" size={13}/><input autoFocus type="search" aria-label="Find a skill" placeholder="Find a skill" value={query} onChange={e=>setQuery(e.target.value)}/></label>
  <div className="ag-pick-list">{shown.slice(0,100).map(s=><label key={s.id} className="ag-pick"><input type="checkbox" checked={chosen.includes(s.id)} disabled={!chosen.includes(s.id)&&chosen.length>=room} onChange={e=>setChosen(c=>e.target.checked?[...c,s.id]:c.filter(x=>x!==s.id))}/><span><b>{skillTitle(s.name)}</b>{s.description&&<small>{s.description}</small>}</span></label>)}
   {!shown.length&&<p className="ag-muted">No skill matches.</p>}{shown.length>100&&<p className="ag-muted">Showing 100. Type to narrow.</p>}</div>
 </Sheet>;
}
