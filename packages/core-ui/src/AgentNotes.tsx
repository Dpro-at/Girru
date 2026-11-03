// STORE-MAP-01 P5 (boards P5a–P5c, approved 2026-11-03). Every part asks the
// server first and shows nothing new while GIRRU_STORE_P5 is off (404).
//  P5a AgentNotesRow: the agent's own notes as one row on top of its memories,
//      with an inspector (Edit over the version read, History, ⌘Z).
//  P5b NotesOutsideChip: MEMORY.md changed outside Girru → quiet chip, Review…,
//      a sheet with Girru's notes → the file, "Use it" or "Keep Girru's".
//  P5c Export agent… (⇧⌘E) and Import agent… (⇧⌘I) with the preview.
import {useEffect,useRef,useState} from 'react';
import type {PartDone} from './agent-card';
import type {SessionClient} from './session';
import {IconButton,Sheet} from './desktop-ui';
import {UiIcon} from './ui-icons';
import {ago,oneLine} from './memory-store';
import {NOTES_BYTES,PACKAGES_STATUS_PATH,notesPath,packagePath} from './agent-notes-contract.js';
import type {NotesOutside,NotesVersion,PackagePlan} from './agent-notes-contract.js';

type Req=(method:'GET'|'PUT'|'POST',path:string,body?:unknown)=>Promise<{status:number;body:unknown}>;
const reqOf=(client:SessionClient):Req=>async(method,path,body)=>client.request({method,path,...(body===undefined?{}:{body})} as never) as Promise<{status:number;body:unknown}>;
const code=(b:unknown)=>(b as {code?:string}|null)?.code;
const CHANGE:Record<string,string>={baseline:'first copy',create:'created',update:'changed',import:'imported'};
const who=(by:string)=>by==='owner'?'you':by==='agent'||by.startsWith('agent:')?'the agent':'Girru';

/** P5a: its own notes as one row above its memories, opening an inspector with History. */
export function AgentNotesRow({client,agentId,name,onDone}:{client:SessionClient;agentId:string;name:string;onDone:PartDone}){
 const req=reqOf(client);
 const [notes,setNotes]=useState<{content:string;hash:string}|null>(null),[open,setOpen]=useState(false),[editing,setEditing]=useState(false),[draft,setDraft]=useState('');
 const [history,setHistory]=useState<NotesVersion[]|null>(null),[clash,setClash]=useState(false),[busy,setBusy]=useState(false),[problem,setProblem]=useState('');
 const latest=useRef<{content:string;hash:string}|null>(null);latest.current=notes;
 async function load(){
  const st=await req('GET',notesPath(agentId,'/status')).catch(()=>null);
  if(st?.status!==200||!(st.body as {imported?:boolean}).imported){setNotes(null);return;}
  const r=await req('GET',notesPath(agentId));if(r.status===200){const b=r.body as {content:string;hash:string};setNotes({content:b.content,hash:b.hash});}
 }
 async function loadHistory(){const r=await req('GET',notesPath(agentId,'/history'));setHistory(r.status===200?(r.body as {versions:NotesVersion[]}).versions:[]);}
 useEffect(()=>{setOpen(false);setEditing(false);void load();},[agentId]);
 useEffect(()=>{if(open)void loadHistory();},[open,notes?.hash]);
 /** Save over the version read; a newer version asks Load latest / Keep mine. */
 async function save(text:string,over:{content:string;hash:string},undoable=true):Promise<boolean>{
  setBusy(true);setProblem('');
  try{
   const r=await req('PUT',notesPath(agentId),{content:text,expectedHash:over.hash});
   if(r.status!==200){if(code(r.body)==='memory_not_written')setClash(true);else setProblem('Nothing was saved. Try again.');return false;}
   const b=r.body as {content:string;hash:string;redacted:boolean};setNotes({content:b.content,hash:b.hash});setEditing(false);
   if(b.redacted)setProblem('Values that looked like passwords or keys were hidden.');
   if(undoable)onDone(`${name}’s notes saved`,async()=>{const cur=latest.current;if(cur&&await save(over.content,cur,false))onDone('Change undone');});
   return true;
  }catch{setProblem('Nothing was saved. Try again.');return false;}finally{setBusy(false);}
 }
 async function settleClash(keepMine:boolean){
  setClash(false);const mine=draft;await load();
  const r=await req('GET',notesPath(agentId));if(r.status!==200)return;const now=r.body as {content:string;hash:string};
  if(keepMine)await save(mine,now);else{setDraft(now.content);setEditing(false);}
 }
 if(!notes)return null;
 return <section className="ag-notes" aria-label="Its own notes">
  <h3 className="ag-notes-head">Its own notes</h3>
  <div className="dk-row ag-notes-row" role="button" tabIndex={0} aria-expanded={open} onClick={()=>setOpen(v=>!v)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setOpen(v=>!v);}}}>
   <span className="dk-row-icon"><UiIcon name="brain" size={14}/></span>
   <span className="dk-row-text"><span className="dk-row-main" dir="auto">{oneLine(notes.content)||'Nothing written yet.'}</span><span className="dk-row-sub">What it keeps in mind · MEMORY.md is a copy of this note · only {name} and you read it</span></span>
  </div>
  {open&&<aside className="dk-insp ag-notes-insp" aria-label="Its own notes">
   {problem&&<p className="ag-alert" role="alert">{problem}</p>}
   {editing?<form className="dk-edit" onSubmit={e=>{e.preventDefault();void save(draft,notes);}}>
    <textarea aria-label="Its notes" dir="auto" rows={8} value={draft} maxLength={NOTES_BYTES} autoFocus onChange={e=>setDraft(e.target.value)}
     onKeyDown={e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();void save(draft,notes);}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setEditing(false);}}}/>
    <div className="actions"><button type="button" onClick={()=>setEditing(false)}>Cancel</button><button type="submit" className="primary" disabled={busy||draft===notes.content}>Save</button></div>
    <p className="fine-print">Saved as a new version over the one you read; History keeps the old one. ⌘Z undoes.</p>
   </form>:<p className="dk-insp-text ag-notes-text" dir="auto">{notes.content||'Nothing written yet.'}</p>}
   {!editing&&<div className="dk-insp-icons"><IconButton icon="pencil" label="Edit" shortcut="↩" onClick={()=>{setDraft(notes.content);setEditing(true);}}/><IconButton icon="close" label="Close" shortcut="esc" onClick={()=>setOpen(false)}/></div>}
   <dl className="dk-facts"><dt>Where</dt><dd>Its own drawer · never shared with other agents</dd><dt>History</dt><dd>{history===null?'…':`${history.length} ${history.length===1?'version':'versions'}`}</dd></dl>
   {history&&history.length>0&&<ol className="ag-mem-history">{history.map(v=><li key={v.version}><span className="fine-print">{ago(v.createdAt)} · {CHANGE[v.change]??v.change} by {who(v.by)}</span><span dir="auto">{v.content?oneLine(v.content):'—'}</span>
    {v.content!==null&&v.content!==notes.content&&<button type="button" className="link-button" disabled={busy} onClick={()=>void save(v.content!,notes)}>Use this version</button>}</li>)}</ol>}
  </aside>}
  {clash&&<Sheet title="The notes changed while you were editing" onClose={()=>setClash(false)} actions={<><button type="button" onClick={()=>void settleClash(false)}>Load latest</button><button type="button" className="primary" onClick={()=>void settleClash(true)}>Keep mine</button></>}>
   <p>{name} or another window saved a newer version. Your text is kept until you choose.</p></Sheet>}
 </section>;
}

/** P5b: a quiet chip when MEMORY.md was changed outside Girru; nothing happens until the owner picks. */
export function NotesOutsideChip({client,agentId,onDone,onSettled}:{client:SessionClient;agentId:string;onDone:PartDone;onSettled:()=>void}){
 const req=reqOf(client);
 const [changed,setChanged]=useState(false),[outside,setOutside]=useState<NotesOutside|null>(null),[busy,setBusy]=useState(false),[problem,setProblem]=useState('');
 const status=async()=>{const r=await req('GET',notesPath(agentId,'/status')).catch(()=>null);setChanged(r?.status===200&&(r.body as {outsideChange?:boolean}).outsideChange===true);};
 useEffect(()=>{void status();},[agentId]);
 async function review(){setProblem('');const r=await req('GET',notesPath(agentId,'/outside'));if(r.status!==200){setProblem('MEMORY.md could not be read.');return;}const o=(r.body as {outside:NotesOutside|null}).outside;if(!o){setChanged(false);return;}setOutside(o);}
 async function pick(p:'use'|'keep'){
  if(!outside)return;setBusy(true);
  const r=await req('POST',notesPath(agentId,'/outside'),{pick:p,fileHash:outside.fileHash});setBusy(false);
  if(r.status!==200){if(code(r.body)==='changed'){setProblem('MEMORY.md changed again. Here is the newest file.');void review();}else setProblem('Nothing was changed. Try again.');return;}
  const before=outside.notes;setOutside(null);setChanged(false);onSettled();
  if(p==='use')onDone('Its notes now use the MEMORY.md text',async()=>{const cur=await req('GET',notesPath(agentId));if(cur.status===200){await req('PUT',notesPath(agentId),{content:before,expectedHash:(cur.body as {hash:string}).hash});onSettled();}});
  else onDone('MEMORY.md was written back from its notes');
 }
 if(!changed)return null;
 return <>
  <p className="af-note af-outside" role="status"><UiIcon name="alert" size={14}/>MEMORY.md was changed outside Girru. Its notes stay as they are until you choose.<button type="button" className="link-button" onClick={()=>void review()}>Review…</button></p>
  {problem&&!outside&&<p className="ag-alert" role="alert">{problem}</p>}
  {outside&&<Sheet wide title="MEMORY.md changed outside Girru" onClose={()=>setOutside(null)} actions={<><button type="button" onClick={()=>setOutside(null)}>Decide later</button><button type="button" disabled={busy} onClick={()=>void pick('keep')}>Keep Girru’s</button><button type="button" className="primary" disabled={busy} onClick={()=>void pick('use')}>Use it</button></>}>
   {problem&&<p className="ag-alert" role="alert">{problem}</p>}
   <div className="ag-notes-compare">
    <div><h4>Its notes in Girru (before)</h4><pre dir="auto">{outside.notes||'—'}</pre></div>
    <div><h4>MEMORY.md now (after)</h4><pre dir="auto">{outside.file||'—'}</pre></div>
   </div>
   <p className="ag-muted"><b>Use it</b> saves the file text as the next version of its notes (⌘Z goes back). <b>Keep Girru’s</b> writes the file again from its notes. Values that look like passwords or keys are hidden before saving.</p>
  </Sheet>}
 </>;
}

/** P5c: whether agent packages are on (the switch); null while asking. */
export function useAgentPackages(client:SessionClient|undefined,owner=true){
 const [on,setOn]=useState<boolean|null>(null);
 useEffect(()=>{if(!client||!owner){setOn(false);return;}let live=true;void reqOf(client)('GET',PACKAGES_STATUS_PATH).then(r=>{if(live)setOn(r.status===200&&(r.body as {on?:boolean}).on===true);},()=>{if(live)setOn(false);});return()=>{live=false;};},[client,owner]);
 return on;
}

const fileOf=(name:string)=>`${name.replace(/[^\p{L}\p{N} _-]+/gu,'').trim()||'agent'}.girru-agent.json`;
/** P5c Export agent…: says once what goes in, then saves the package as a file (nothing is written by the server). */
export function ExportAgentSheet({client,agentId,name,onClose,onDone}:{client:SessionClient;agentId:string;name:string;onClose:()=>void;onDone:PartDone}){
 const [busy,setBusy]=useState(false),[problem,setProblem]=useState('');
 async function save(){
  setBusy(true);setProblem('');
  const r=await reqOf(client)('GET',packagePath(agentId)).catch(()=>null);setBusy(false);
  if(r?.status!==200){setProblem(`${name} could not be exported. Try again.`);return;}
  const url=URL.createObjectURL(new Blob([JSON.stringify(r.body,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=fileOf(name);document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  onClose();onDone(`${name} exported as ${fileOf(name)}`);
 }
 return <Sheet title={`Export ${name}`} onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={()=>void save()}>Export…</button></>}>
  <div className="ag-import">
   <p>Saves <b>{fileOf(name)}</b> to the folder you pick.</p>
   <p><b>Goes in:</b> who it is (personality text and adjustments), its instructions, its job (specialties), skill names and its knowledge files, with values that look like passwords or keys hidden.</p>
   <p><b>Never goes in:</b> permissions, tool grants, accounts and keys, its own notes, memory and history.</p>
   {problem&&<p className="ag-alert" role="alert">{problem}</p>}
  </div>
 </Sheet>;
}

const SAY_IMPORT:Record<string,string>={invalid_package:'This file is not a Girru agent package.',not_an_agent_package:'This file is not a Girru agent package.',schema_version:'This package uses a format this Girru does not know.',newer_package:'This package was made by a newer Girru. Update Girru, then import it.',
 hash_mismatch:'This package was changed after it was made, so it is not imported.',secret_found:'This package holds a password or key. Remove it from the file, then import again.',too_large:'Packages up to 4 MB can be imported.',too_many_files:'This package has too many knowledge files.',
 preview_changed:'The file changed after the preview. Here is the new preview.',already_imported:'This package was imported before.'};
/** P5c Import agent…: pick a file → preview (comes in / left out / this computer lacks) → import over the hash previewed. */
export function ImportAgentSheet({client,onClose,onImported}:{client:SessionClient;onClose:()=>void;onImported:(agentId:string,name:string,note:string)=>void}){
 const req=reqOf(client),pickRef=useRef<HTMLInputElement>(null);
 const [pkg,setPkg]=useState<unknown>(null),[plan,setPlan]=useState<PackagePlan|null>(null),[problem,setProblem]=useState(''),[busy,setBusy]=useState(false),[fileName,setFileName]=useState('');
 useEffect(()=>{pickRef.current?.click();},[]);
 async function preview(p:unknown){
  setBusy(true);setProblem('');
  const r=await req('POST','/api/agent-packages/preview',{package:p}).catch(()=>null);setBusy(false);
  if(r?.status!==200){setPlan(null);setProblem(SAY_IMPORT[code(r?.body)??'']??'The package could not be read.');return;}
  setPlan(r.body as PackagePlan);
 }
 async function pick(f:File|undefined){
  if(!f)return;setFileName(f.name);setPlan(null);
  if(f.size>4*1024*1024){setProblem(SAY_IMPORT.too_large);return;}
  try{const p=JSON.parse(await f.text());setPkg(p);await preview(p);}catch{setProblem(SAY_IMPORT.invalid_package);}
 }
 async function doImport(again=false){
  if(!plan)return;setBusy(true);
  const r=await req('POST','/api/agent-packages/import',{package:pkg,expectedPackageHash:plan.packageHash,...(again?{again:true}:{})}).catch(()=>null);setBusy(false);
  if(r?.status!==200){const c=code(r?.body)??'';setProblem(SAY_IMPORT[c]??'Nothing was imported. Try again.');if(c==='preview_changed')void preview(pkg);return;}
  const b=r.body as {agentId:string;refused:unknown[];missing:unknown[]};
  // The new agent may get another name when this one is taken, so the notice does not repeat the package's name.
  onImported(b.agentId,plan.agent.name,b.missing.length?`The imported agent joined the team. ${b.missing.length} ${b.missing.length===1?'part is':'parts are'} not on this computer.`:'The imported agent joined the team.');
 }
 const kb=(n:number)=>n<1024?`${n} B`:`${Math.max(1,Math.round(n/1024))} KB`;
 return <Sheet wide title="Import an agent" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button>
  {plan?.alreadyImported?<button type="button" className="primary" disabled={busy} onClick={()=>void doImport(true)}>Import again as a new agent</button>:<button type="button" className="primary" disabled={!plan||busy} onClick={()=>void doImport()}>Import as a new agent</button>}</>}>
  <input ref={pickRef} type="file" accept=".json,application/json" hidden onChange={e=>void pick(e.target.files?.[0])}/>
  <div className="ag-import">
   <p className="ag-muted">{fileName?<><b>{fileName}</b> · </>:null}<button type="button" className="link-button" onClick={()=>pickRef.current?.click()}>{fileName?'Choose another file…':'Choose a package file…'}</button></p>
   {problem&&<p className="ag-alert" role="alert">{problem}</p>}
   {busy&&!plan&&<p className="ag-muted" role="status">Reading the package…</p>}
   {plan&&<>
    {plan.alreadyImported&&<p className="af-note" role="status"><UiIcon name="alert" size={14}/>This exact package was imported before. Importing it again makes a second agent.</p>}
    <div className="ag-import-cols">
     <section><h4><UiIcon name="check" size={13}/>Comes in</h4><ul>
      <li><b>{plan.agent.emoji} {plan.agent.name}</b>{plan.agent.description?` · ${oneLine(plan.agent.description)}`:''}</li>
      {plan.personality.text&&<li>Its personality</li>}{plan.instructions&&<li>Its instructions</li>}
      {plan.specialties.map(s=><li key={`s${s.name}`}>Specialty: {s.name}</li>)}{plan.skills.map(s=><li key={`k${s.name}`}>Skill: {s.name}</li>)}
      {plan.knowledge.map(k=><li key={`f${k.name}`}>{k.name} · {kb(k.bytes)}{k.read?'':' · kept only'}</li>)}
     </ul></section>
     <section><h4><UiIcon name="lock" size={13}/>Left out</h4><ul>
      <li>Permissions and tool grants: you set them after the import</li><li>Keys, passwords and connections</li><li>Its notes and history</li>
      {plan.refused.map(r=><li key={r.field}>{r.field} · {r.why}</li>)}
     </ul></section>
     <section><h4><UiIcon name="alert" size={13}/>This computer lacks</h4>{plan.missing.length?<ul>{plan.missing.map(m=><li key={`${m.kind}${m.name}`}>{m.kind==='skill'?'Skill':'Specialty'}: {m.name} · not downloaded</li>)}</ul>:<p className="ag-muted">Nothing. Everything it needs is here.</p>}</section>
    </div>
    <p className="ag-muted">A new agent is made from this package. It starts with no permissions; nothing in the package can grant them.</p>
   </>}
  </div>
 </Sheet>;
}
