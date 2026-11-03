import {useEffect,useRef,useState} from 'react';
import type {DragEvent as ReactDragEvent,MouseEvent as ReactMouseEvent} from 'react';
import type {PartDone} from './agent-card';
import type {SessionClient} from './session';
import {ContextMenu,IconButton,Popover,Sheet,useMenu} from './desktop-ui';
import type {MenuItem} from './desktop-ui';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';
import {DocumentEditor} from './DocumentEditor';
import {LIBRARY_BYTES,fileName as validFileName,libraryPath} from './agent-library-contract.js';

type Kind='who'|'mind'|'knowledge';
type Entry={name:string;kind:Kind;size:number;read:boolean};
type Removed={id:string;name:string;removedAt:string|null};
// STORE-MAP-01 P4 (T7a): Who it is is the personality record; `version` is the record's version shown.
type Open={name:string;kind:Kind;content:string;hash:string|null;managed:string|null;redacted:boolean;read:boolean;version?:number};
type Version={id:string;savedAt:string|null;size:number};
const WORDS:Record<Kind,string>={who:'Who it is',mind:'What it keeps in mind',knowledge:''};
const titleOf=(e:{name:string;kind:Kind})=>e.kind==='knowledge'?e.name:WORDS[e.kind];
const iconOf=(e:{name:string;kind:Kind}):UiIconName=>e.kind==='who'?'smile':e.kind==='mind'?'brain':/\.(csv|json)$/i.test(e.name)?'database':'file';
const kb=(n:number)=>n<1024?`${n} B`:`${Math.max(1,Math.round(n/1024))} KB`;
const SAY:Record<string,string>={changed:'This file changed while you were writing. Your text is kept.',too_large:'Files up to 1 MB can be saved.',name_taken:'A file with this name is already there.',invalid_name:'Use a name ending in .md, .txt, .csv or .json (letters, numbers, spaces, - _ . ( )).',not_found:'This file is no longer there.',too_many:'This agent already has 200 files.',forbidden:'Only the owner changes these files.'};
const say=(code?:string)=>SAY[code??'']??'Nothing was saved. Try again.';

/**
 * AF1–AF2: the files an agent reads — Who it is, What it keeps in mind and its
 * Knowledge folder. A file opens in the shared editor and saves as you go,
 * always over the version it read (a changed file is never overwritten
 * silently). Remove goes to Removed files with Restore.
 */
export function AgentFiles({client,agentId,name,onDone,onPersonality}:{client:SessionClient;agentId:string;name:string;onDone:PartDone;onPersonality?:()=>void}){
 const [list,setList]=useState<{files:Entry[];removed:Removed[]}|null|undefined>(),[open,setOpen]=useState<Open|null>(null),[draft,setDraft]=useState(''),[state,setState]=useState<'idle'|'saving'|'saved'|'changed'|'error'>('idle'),[problem,setProblem]=useState(''),[adding,setAdding]=useState(false),[showRemoved,setShowRemoved]=useState(false),[versions,setVersions]=useState<Version[]|null>(null),[dropping,setDropping]=useState(false);
 const menu=useMenu(),timer=useRef<ReturnType<typeof setTimeout>|null>(null),latest=useRef({open:null as Open|null,draft:''});
 latest.current={open,draft};
 const req=async(method:'GET'|'PUT'|'POST',path:string,body?:unknown)=>client.request({method,path,...(body===undefined?{}:{body})} as never);
 const load=async()=>{try{const r=await req('GET',libraryPath(agentId));setList(r.status===200?r.body as {files:Entry[];removed:Removed[]}:null);}catch{setList(null);}};
 async function pick(n:string){
  await flush();setProblem('');setVersions(null);
  try{const r=await req('GET',libraryPath(agentId,'/file',{name:n}));if(r.status!==200){setProblem(say((r.body as {code?:string})?.code));return;}const f=r.body as Open;setOpen(f);setDraft(f.content);setState('idle');}catch{setProblem(say());}
 }
 useEffect(()=>{setOpen(null);setList(undefined);void load().then(()=>void pick('PERSONALITY.md'));return()=>{if(timer.current)clearTimeout(timer.current);};},[agentId]);
 /** Save the draft over the version it was read from; a changed file asks Load latest / Keep mine. */
 async function save(text:string,f:Open,undoable=true){
  setState('saving');
  try{
   const r=await req('PUT',libraryPath(agentId,'/file'),{name:f.name,content:text,expectedHash:f.hash});
   const b=r.body as {hash?:string|null;redacted?:boolean;code?:string;version?:number};
   if(r.status!==200){setState(b?.code==='changed'?'changed':'error');if(b?.code!=='changed')setProblem(say(b?.code));return false;}
   const before=f.content;const next={...f,content:text,hash:b.hash??null,redacted:!!b.redacted,version:b.version??f.version};setOpen(next);setState('saved');
   // The saved text differs from the draft: show what was kept, then say why.
   if(b.redacted)void pick(f.name).then(()=>{setState('saved');setProblem('Values that looked like passwords or keys were hidden.');});
   if(undoable)onDone(`${titleOf(f)} saved`,async()=>{const cur=latest.current.open;if(cur?.name!==f.name)return;if(await save(before,cur,false)){setDraft(before);onDone('Change undone');}});
   void load();return true;
  }catch{setState('error');setProblem(say());return false;}
 }
 async function flush(){if(timer.current){clearTimeout(timer.current);timer.current=null;const {open:f,draft:d}=latest.current;if(f&&d!==f.content)await save(d,f);}}
 function edit(text:string){setDraft(text);if(!open||state==='changed')return;if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>{timer.current=null;const {open:f,draft:d}=latest.current;if(f&&d!==f.content)void save(d,f);},900);}
 async function loadLatest(keepMine:boolean){
  if(!open)return;const mine=draft;
  const r=await req('GET',libraryPath(agentId,'/file',{name:open.name}));if(r.status!==200){setProblem(say());return;}
  const f=r.body as Open;setOpen(f);setState('idle');
  if(keepMine){setDraft(mine);await save(mine,f);}else setDraft(f.content);
 }
 async function setRead(e:Entry,read:boolean){const r=await req('POST',libraryPath(agentId,'/read'),{name:e.name,read});if(r.status===200){void load();onDone(read?`${e.name}: it reads this file`:`${e.name}: no longer read`,async()=>{await req('POST',libraryPath(agentId,'/read'),{name:e.name,read:!read});void load();});}else setProblem(say((r.body as {code?:string})?.code));}
 async function remove(e:Entry){
  const r=await req('POST',libraryPath(agentId,'/remove'),{name:e.name});
  if(r.status!==200){setProblem(say((r.body as {code?:string})?.code));return;}
  const id=(r.body as {id:string}).id;if(open?.name===e.name){setOpen(null);setDraft('');}void load();
  onDone(`${e.name} was removed`,async()=>{await req('POST',libraryPath(agentId,'/restore'),{id});void load();});
 }
 async function restore(x:Removed){const r=await req('POST',libraryPath(agentId,'/restore'),{id:x.id});if(r.status===200){void load();onDone(`${x.name} is back`);}else setProblem(say((r.body as {code?:string})?.code));}
 async function versionsOf(){if(!open)return;const r=await req('GET',libraryPath(agentId,'/versions',{name:open.name}));setVersions(r.status===200?(r.body as {versions:Version[]}).versions:[]);}
 async function useVersion(v:Version){if(!open)return;setVersions(null);const r=await req('GET',libraryPath(agentId,'/version',{name:open.name,id:v.id}));if(r.status!==200){setProblem(say());return;}const text=(r.body as {content:string}).content;setDraft(text);await save(text,open);}
 /** Dropped or picked files from this computer: text only, up to 1 MB each. */
 async function addFiles(items:File[]){
  for(const file of items.slice(0,20)){
   if(!validFileName(file.name)||['PERSONALITY.md','MEMORY.md'].includes(file.name)){setProblem(`${file.name}: ${SAY.invalid_name}`);continue;}
   if(file.size>LIBRARY_BYTES){setProblem(`${file.name} is ${kb(file.size)}. Files up to 1 MB can be added.`);continue;}
   const r=await req('POST',libraryPath(agentId,'/file'),{name:file.name,content:await file.text()});
   if(r.status!==201){setProblem(`${file.name}: ${say((r.body as {code?:string})?.code)}`);continue;}
   if((r.body as {redacted?:boolean}).redacted)setProblem(`${file.name}: values that looked like passwords or keys were hidden.`);
   onDone(`${file.name} added`);
  }
  await load();
 }
 const items=(e:Entry):MenuItem[]=>e.kind!=='knowledge'?[{label:'Copy all',icon:'copy',run:()=>void navigator.clipboard?.writeText(open?.name===e.name?draft:'')}]:[
  {label:e.read?'Stop reading it':'Read it when it answers',icon:e.read?'eye':'check',run:()=>void setRead(e,!e.read)},
  {label:'Copy all',icon:'copy',disabled:open?.name!==e.name,run:()=>void navigator.clipboard?.writeText(draft)},'sep',
  {label:'Remove',icon:'trash',danger:true,shortcut:'⌫',run:()=>void remove(e)}];
 const drop=(e:ReactDragEvent)=>{e.preventDefault();setDropping(false);const fs=[...(e.dataTransfer?.files??[])];if(fs.length)void addFiles(fs);};
 if(list===undefined)return <section className="ag-part af-part" aria-label="Files"><p className="ag-muted" role="status">Reading its files…</p></section>;
 if(list===null)return <section className="ag-part af-part" aria-label="Files"><p className="ag-muted" role="status">Its files could not be read. <button type="button" className="link-button" onClick={()=>void load()}>Try again</button></p></section>;
 const always=list.files.filter(f=>f.kind!=='knowledge'),knowledge=list.files.filter(f=>f.kind==='knowledge');
 const row=(e:Entry)=><button type="button" role="option" key={e.name} aria-selected={open?.name===e.name} className="af-row" onClick={()=>void pick(e.name)} onContextMenu={(ev:ReactMouseEvent)=>{ev.preventDefault();menu.at(ev,items(e));}} onKeyDown={ev=>{if((ev.key==='Delete'||ev.key==='Backspace')&&e.kind==='knowledge'){ev.preventDefault();void remove(e);}}}>
  <span className={`af-tile af-${e.kind}${e.kind==='knowledge'&&!e.read?' af-off':''}`}><UiIcon name={iconOf(e)} size={13}/></span>
  <span className="af-row-text"><span>{titleOf(e)}</span><small>{e.kind==='who'?'PERSONALITY.md · part from Personality':e.kind==='mind'?'MEMORY.md · its own notes':`${e.read?'Read when it answers':'Not read (kept only)'} · ${kb(e.size)}`}</small></span></button>;
 return <section className={`ag-part af-part${dropping?' af-dropping':''}`} aria-label="Files" onDragOver={e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();setDropping(true);}}} onDragLeave={e=>{if(!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node))setDropping(false);}} onDrop={drop}>
  <div className="af-grid">
   <div className="af-list">
    <div className="ag-head-row"><h3>Files</h3><button type="button" className="primary ag-main-button" title="Add a file (or drop files here)" onClick={()=>setAdding(true)}><UiIcon name="plus" size={14}/>Add file</button></div>
    <div role="listbox" aria-label="Its files">
     <h4>Read every time it answers</h4>{always.map(row)}
     <h4>Knowledge</h4>
     {knowledge.length?knowledge.map(row):<div className="ag-empty af-empty"><UiIcon name="folder" size={24}/><p>Give it files to read: notes, price lists, how you like things done.</p><button type="button" onClick={()=>setAdding(true)}>Add file</button></div>}
     {list.removed.length>0&&<button type="button" className="af-row af-removed" aria-expanded={showRemoved} onClick={()=>setShowRemoved(v=>!v)}><span className="af-tile af-off"><UiIcon name="trash" size={13}/></span><span className="af-row-text"><span>Removed files</span><small>{list.removed.length} · restore within 30 days</small></span></button>}
     {showRemoved&&list.removed.map(x=><div key={x.id} className="af-removed-row"><span>{x.name}</span><button type="button" onClick={()=>void restore(x)}>Restore</button></div>)}
    </div>
    <p className="af-drop">Drop files here to add them to Knowledge<br/>Text files: .md .txt .csv .json, up to 1 MB</p>
   </div>
   <div className="af-doc">
    {problem&&<p className="ag-alert" role="alert">{problem}<button type="button" className="link-button" onClick={()=>setProblem('')}>Close</button></p>}
    {open?<>
     <div className="af-doc-head"><span><b>{titleOf(open)}</b><small>{open.kind==='knowledge'?(open.read?'Read when it answers':'Not read when it answers'):`${open.name} · read every time it answers`}</small></span>
      <span className="ag-anchor" data-popover-anchor><IconButton icon="history" label="Earlier versions" disabled={open.kind==='mind'} onClick={()=>void versionsOf()}/>
       <Popover open={versions!==null} onClose={()=>setVersions(null)} label="Earlier versions"><div className="af-versions">{versions?.length?versions.map(v=><button type="button" key={v.id} onClick={()=>void useVersion(v)}><span>{v.savedAt?new Date(v.savedAt).toLocaleString():'Earlier'}</span><small>{kb(v.size)} · Restore</small></button>):<p className="ag-muted">No earlier versions yet.</p>}</div></Popover></span>
      <IconButton icon="more" label="More for this file" onClick={e=>{const entry=list.files.find(f=>f.name===open.name);if(entry)menu.at(e,items(entry));}}/></div>
     {state==='changed'&&<p className="ag-alert af-changed" role="alert"><UiIcon name="alert" size={14}/>{SAY.changed}<button type="button" onClick={()=>void loadLatest(false)}>Load latest</button><button type="button" onClick={()=>void loadLatest(true)}>Keep mine</button></p>}
     {open.kind==='who'&&open.managed&&<details className="af-managed"><summary><UiIcon name="smile" size={14}/><b>Written by Personality</b><small>Show the settings it wrote</small></summary>{onPersonality&&<button type="button" className="link-button" onClick={onPersonality}>Change it in Personality</button>}<pre>{open.managed}</pre></details>}
     {open.redacted&&<p className="af-note"><UiIcon name="lock" size={14}/>Values that looked like passwords or keys are hidden in this file.</p>}
     <DocumentEditor key={open.name+(open.hash??'')} inline title={`${name} · ${titleOf(open)}`} files={[{id:open.name,name:open.name,content:draft}]} maxLength={open.kind==='mind'?32768:LIBRARY_BYTES} onChange={(_,text)=>edit(text)} onClose={()=>{}}/>
     <p className="af-status" role="status">{state==='saving'?'Saving…':state==='saved'?(open.kind==='who'&&open.version?`Saved as version ${open.version} of its personality · ⌘Z undoes`:'Saved · ⌘Z undoes'):state==='error'?'Not saved':' '}{open.kind==='who'&&open.managed?<span>The part written by Personality is not saved from here</span>:null}</p>
    </>:<div className="ag-empty"><UiIcon name="file" size={28}/><p>Select a file to read or change it.</p></div>}
   </div>
  </div>
  {adding&&<AddFileSheet onClose={()=>setAdding(false)} onAdd={async(file,read)=>{setAdding(false);if(file.content!==undefined){const r=await req('POST',libraryPath(agentId,'/file'),{name:file.name,content:file.content,read});if(r.status!==201){setProblem(say((r.body as {code?:string})?.code));return;}onDone(`${file.name} added`);await load();void pick(file.name);}else await addFiles(file.files);}}/>}
  <ContextMenu menu={menu.menu} onClose={menu.close}/>
 </section>;
}

/** AF2a: a new empty file, or files from this computer. */
function AddFileSheet({onClose,onAdd}:{onClose:()=>void;onAdd:(file:{name:string;content:string;files:File[]}|{name:string;content?:undefined;files:File[]},read:boolean)=>void}){
 const [how,setHow]=useState<'new'|'computer'>('new'),[name,setName]=useState('notes.md'),[read,setRead]=useState(true),[picked,setPicked]=useState<File[]>([]);
 const pickRef=useRef<HTMLInputElement>(null);
 const ok=how==='new'?validFileName(name)&&!['PERSONALITY.md','MEMORY.md'].includes(name):picked.length>0;
 return <Sheet title="A file for this agent to read" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!ok} onClick={()=>how==='new'?onAdd({name:name.trim(),content:'',files:[]},read):onAdd({name:'',files:picked},read)}>Add file</button></>}>
  <div className="sa-sheet">
   <div className="sa-starts af-starts" role="radiogroup" aria-label="Where it comes from">
    <button type="button" role="radio" aria-checked={how==='new'} className="sa-start" onClick={()=>setHow('new')}><UiIcon name="file" size={16}/><b>New empty file</b><small>Write it here</small></button>
    <button type="button" role="radio" aria-checked={how==='computer'} className="sa-start" onClick={()=>{setHow('computer');pickRef.current?.click();}}><UiIcon name="download" size={16}/><b>From this computer…</b><small>{picked.length?picked.map(f=>f.name).join(', '):'Pick one or more'}</small></button>
   </div>
   <input ref={pickRef} type="file" multiple accept=".md,.txt,.csv,.json,text/plain,text/markdown,text/csv,application/json" hidden onChange={e=>setPicked([...(e.target.files??[])])}/>
   {how==='new'&&<label className="ag-field">Name<input value={name} maxLength={82} onChange={e=>setName(e.target.value)}/></label>}
   {how==='new'&&<label className="sa-tool"><input type="checkbox" checked={read} onChange={e=>setRead(e.target.checked)}/><span>It reads this file when it answers</span></label>}
   <p className="ag-muted">Text files only (.md .txt .csv .json), up to 1 MB each. Values that look like passwords or keys are hidden before it is saved.</p>
  </div>
 </Sheet>;
}
