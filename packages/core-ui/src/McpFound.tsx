// MCP-ONE-01 (boards MO1, MO2a): where connections come from, and the one "Found, not added" place.
// The list is read again on every visit (Claude, Claude Desktop, Codex, Gemini, Antigravity, project
// .mcp.json files and Store apps), so there is nothing to scan by hand. Adding saves it off; every
// write goes through the owner-only /api/mcp-import routes. Secret values never reach this window.
import {useCallback,useEffect,useRef,useState} from 'react';
import type {KeyboardEvent as ReactKeyboardEvent,MouseEvent as ReactMouseEvent} from 'react';
import type {SessionClient} from './session';
import type {FoundList,FoundRow,FoundSource} from './mcp-import-contract.js';
import type {ConnectorSource} from './connectors-contract.js';
import {UiIcon,type UiIconName} from './ui-icons';
import {ContextMenu,IconButton,Notice,Tile,useMenu,type MenuItem} from './desktop-ui';
import {canRevealFolder,revealFolder} from './chat-actions';

const CODING=['Claude','Claude Desktop','Codex','Gemini','Antigravity'];
const iconOf=(origin:string):UiIconName=>origin==='Store app'?'store':origin==='Girru'?'sparkle':origin==='Project'?'folder':'code';
/** A path with ~ for the home folder, so the line stays short. */
export const shortPath=(file:string)=>file.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\])/,'~');
const dirOf=(file:string)=>file.replace(/[/\\][^/\\]*$/,'')||file;
const words=(issue:string)=>issue==='inline_secret_requires_manual_setup'?'a secret is written inside its command':issue==='url_credentials_require_manual_setup'?'a secret is written inside its address':'it has settings Girru cannot copy safely';
const sourceName=(s:{origin:string;appName?:string|null})=>s.origin==='Store app'&&s.appName?s.appName:s.origin;

/** Small chips that say where a connection came from (Claude, Codex, a Store app…). */
export function SourceChips({sources,max=3}:{sources:readonly {origin:string;appName?:string|null}[];max?:number}){
 const names=[...new Set(sources.map(sourceName))];
 if(!names.length)return null;
 return <span className="mcp-sources" aria-label={`From ${names.join(', ')}`}>{names.slice(0,max).map(n=><span key={n} className="mcp-source-chip"><Tile name={n} size={12}/>{n}</span>)}{names.length>max&&<span className="mcp-source-chip">+{names.length-max}</span>}</span>;
}

/** "Where it comes from" in a connection's inspector: each app and file, with Show in Finder. */
export function WhereItComesFrom({sources}:{sources:readonly (ConnectorSource|FoundSource)[]}){
 const reveal=canRevealFolder(),finder=typeof navigator!=='undefined'&&navigator.platform.startsWith('Win')?'Show in Explorer':'Show in Finder';
 return <section className="mcp-block" aria-label="Where it comes from"><h4>Where it comes from</h4>
  {sources.length?<ul className="mcp-where">{sources.map(s=><li key={`${s.origin}:${s.file}:${s.key}:${s.project??''}`}>
   <UiIcon name={iconOf(s.origin)} size={14}/><span className="mcp-where-text"><strong>{sourceName(s as FoundSource)}</strong>{s.file?<small dir="ltr" title={s.file}>{shortPath(s.file)}{s.key&&s.origin!=='Girru'?` · ${s.key}`:''}</small>:<small>Added by Girru</small>}</span>
   {reveal&&s.file&&<IconButton icon="folder" label={finder} onClick={()=>revealFolder(dirOf(s.file))}/>}
  </li>)}</ul>:<p className="fine-print">Added here by hand.</p>}
  {sources.some(s=>s.file)&&<p className="fine-print">Girru keeps its own copy. The other app’s file is never changed.</p>}
 </section>;
}

async function rpc<T>(client:SessionClient,method:string,path:string,body?:unknown):Promise<T>{const r=await client.request({method,path,...(body===undefined?{}:{body})} as never);if(r.status!==200)throw Error((r.body as {code?:string})?.code??'unavailable');return r.body as T;}

/** The found list for the MCP place and its badge; read when the place becomes active. */
export function useFoundMcp(client:SessionClient,active:boolean){
 const [list,setList]=useState<FoundList|null>(null),[phase,setPhase]=useState<'loading'|'ready'|'error'>('loading');
 const load=useCallback(async()=>{try{setList(await rpc<FoundList>(client,'GET','/api/mcp-import/found'));setPhase('ready');}catch{setPhase('error');}},[client]);
 useEffect(()=>{if(active)void load();},[active,load]);
 return {list,phase,reload:load,fresh:list?.rows.filter(r=>r.state==='new').length??0};
}

const stateWords:Record<FoundRow['state'],string>={new:'Not added',added:'Added',manual:'Set up by hand',hidden:'Hidden'};
const failure=(code:string)=>code==='name_conflict'?'A connection with this name already exists. Add this one by hand with another name.':code==='preview_changed'?'It changed in that app. Look again.':'That did not work. Try again.';

/** MO2a · Found, not added: one list across every place, selected row's details beside it. */
export function McpFoundPlace({client,found,onAdded,onOpen,onAddByHand,query=''}:{client:SessionClient;found:ReturnType<typeof useFoundMcp>;onAdded:()=>void;onOpen:(id:string)=>void;onAddByHand:()=>void;query?:string}){
 const {list,phase,reload}=found;
 const [selected,setSelected]=useState(''),[showHidden,setShowHidden]=useState(false),[keys,setKeys]=useState<'save'|'leave'>('save'),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [toast,setToast]=useState<{id:number;text:string;undo:boolean}|null>(null),undoRef=useRef<(()=>Promise<void>)|null>(null),listRef=useRef<HTMLUListElement>(null),{menu,at,close}=useMenu();
 const q=query.trim().toLowerCase();
 const rows=(list?.rows??[]).filter(r=>(showHidden||r.state!=='hidden')&&`${r.name} ${r.target??''} ${r.sources.map(sourceName).join(' ')}`.toLowerCase().includes(q))
  .sort((a,b)=>(a.state==='added'?1:0)-(b.state==='added'?1:0)||a.name.localeCompare(b.name));
 const girru=(list?.girru??[]).filter(g=>`${g.title} ${g.name}`.toLowerCase().includes(q));
 const row=rows.find(r=>r.key===selected),memory=selected.startsWith('girru:')?girru.find(g=>'girru:'+g.name===selected):undefined;
 useEffect(()=>{if(!selected&&rows[0])setSelected(rows[0].key);},[rows.length]);
 useEffect(()=>{setKeys('save');setNotice('');},[selected]);
 const add=async(r:FoundRow)=>{if(busy)return;setBusy(true);setNotice('');try{const x=await rpc<{id:string;duplicate:boolean}>(client,'POST','/api/mcp-import/found/add',{key:r.key,keepSecrets:keys==='save'});setNotice(x.duplicate?'Already in your connections. This place was added as one more source.':'Added off. Turn it on yourself when you are ready.');await reload();onAdded();}catch(e){setNotice(failure(e instanceof Error?e.message:''));}finally{setBusy(false);}};
 const hide=async(r:FoundRow,hidden:boolean)=>{try{await rpc(client,'POST','/api/mcp-import/found/hide',{key:r.key,hidden});await reload();if(hidden){undoRef.current=async()=>{await rpc(client,'POST','/api/mcp-import/found/hide',{key:r.key,hidden:false});await reload();};setToast({id:Date.now(),text:`${r.name} is hidden.`,undo:true});}}catch{setNotice('That did not work. Try again.');}};
 const undo=async()=>{const run=undoRef.current;undoRef.current=null;setToast(null);if(run)await run();};
 const actions=(r:FoundRow):MenuItem[]=>[...(r.state==='new'?[{label:'Add (off)',icon:'plus' as const,run:()=>void add(r),disabled:busy}]:[]),...(r.state==='added'&&r.serverId?[{label:'Open in connections',icon:'link' as const,run:()=>onOpen(r.serverId!)}]:[]),...(r.state==='manual'?[{label:'Add by hand…',icon:'pencil' as const,run:onAddByHand}]:[]),
  ...(r.state==='hidden'?[{label:'Show again',icon:'eye' as const,run:()=>void hide(r,false)}]:r.state!=='added'?[{label:'Don’t show again',icon:'eye' as const,run:()=>void hide(r,true)}]:[])];
 const more=(e:ReactMouseEvent|ReactKeyboardEvent)=>at(e,[{label:'Look again',icon:'refresh',run:()=>void reload()},'sep',{label:'Show hidden',checked:showHidden,run:()=>setShowHidden(v=>!v)}]);
 const move=(e:ReactKeyboardEvent<HTMLButtonElement>,r:FoundRow|null)=>{
  if(r&&(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10')){at(e,actions(r));return;}
  if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();const all=[...(listRef.current?.querySelectorAll<HTMLButtonElement>('.mcp-row')??[])],i=all.indexOf(e.currentTarget),next=e.key==='Home'?0:e.key==='End'?all.length-1:(i+(e.key==='ArrowDown'?1:-1)+all.length)%all.length;all[next]?.focus();all[next]?.click();
 };
 const coding=[...new Set((list?.rows??[]).flatMap(r=>r.sources.map(s=>s.origin)).filter(o=>CODING.includes(o)))];
 return <section className="mcp-desk mcp-has-detail" aria-label="Found, not added" onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&undoRef.current){e.preventDefault();void undo();}}}>
  <header className="dk-toolbar"><div className="dk-title"><h2>Found, not added</h2><span className="dk-sub">{coding.length?`In ${coding.join(', ')}, your projects and Store apps`:'In your coding apps, your projects and Store apps'}</span></div><span className="dk-toolbar-gap"/>
   <IconButton icon="refresh" label="Look again" disabled={phase==='loading'&&!list} onClick={()=>void reload()}/>
   <IconButton icon="more" label="More" onClick={more}/>
  </header>
  {notice&&<p className="mcp-status" role="status">{notice}</p>}
  <div className="mcp-panes"><div className="mcp-list-pane">
   {!list&&phase==='loading'&&<p className="dk-empty" role="status">Looking…</p>}
   {!list&&phase==='error'&&<div className="dk-empty"><p>The list could not be read.</p><button type="button" onClick={()=>void reload()}>Try again</button></div>}
   {list&&<ul className="mcp-rows" ref={listRef} aria-label="Connections found in other places">
    {girru.map(g=><li key={g.name}><button type="button" className="mcp-row" aria-pressed={selected==='girru:'+g.name} onKeyDown={e=>move(e,null)} onClick={()=>setSelected('girru:'+g.name)}><span className="service-tile mcp-girru-tile" aria-hidden="true"><UiIcon name="brain" size={18}/></span><span className="mcp-row-text"><strong>{g.title}</strong><small>Girru · in {g.apps.join(', ')}</small></span><small className="mcp-state" data-tone="ok"><span className="mcp-dot" aria-hidden="true"/>Girru’s own</small></button></li>)}
    {rows.map(r=><li key={r.key}><button type="button" className="mcp-row" aria-pressed={selected===r.key} onKeyDown={e=>move(e,r)} onClick={()=>setSelected(r.key)} onContextMenu={e=>{setSelected(r.key);at(e,actions(r));}}>
     <Tile name={r.name} size={32}/><span className="mcp-row-text"><strong>{r.name}</strong><SourceChips sources={r.sources}/></span>
     <small className="mcp-state" data-tone={r.state==='added'?'ok':r.state==='manual'?'warn':'off'}><span className="mcp-dot" aria-hidden="true"/>{stateWords[r.state]}</small></button></li>)}
   </ul>}
   {list&&!rows.length&&!girru.length&&<div className="dk-empty"><UiIcon name="search" size={24}/><p>{q?'Nothing found with that name.':'Nothing new. Connections you set up in Claude, Codex, Gemini or Antigravity show here by themselves.'}</p></div>}
  </div>
  <aside className="mcp-inspector" aria-label="Selected found connection">
   {memory?<div className="dk-insp"><div className="dk-insp-head"><span className="service-tile mcp-girru-tile" aria-hidden="true"><UiIcon name="brain" size={20}/></span><div><h3>{memory.title}</h3><p className="fine-print">Girru’s own connection ({memory.name})</p></div></div>
     <p className="mcp-purpose">Girru gives your coding apps its memory through this connection. It is written into {memory.apps.join(', ')}.</p>
     <p className="fine-print">Change where it is written in Memory › Coding apps. It is not added to this list, because Girru runs it itself.</p></div>
   :row?<div className="dk-insp"><div className="dk-insp-head"><Tile name={row.name} size={36}/><div className="mcp-insp-name"><h3>{row.name}</h3><p className="fine-print">{row.transport==='stdio'?'Program on this computer':row.transport?'Web address':'Set up by hand'} · {stateWords[row.state].toLowerCase()}</p></div><span className="dk-insp-icons"><IconButton icon="more" label={`More actions for ${row.name}`} onClick={e=>at(e,actions(row))}/></span></div>
     {row.target&&<dl className="mcp-facts"><div><dt>{row.transport==='stdio'?'Command':'Address'}</dt><dd><code dir="ltr">{row.target}</code></dd></div>{row.secretNames.length>0&&<div><dt>Secrets</dt><dd>{row.secretNames.join(', ')} · values hidden</dd></div>}</dl>}
     {row.state==='manual'&&<div className="mcp-next" data-tone="warn" role="status"><p>Girru cannot copy it: {words(row.issue??'')}. Add it by hand instead.</p><button type="button" className="primary" onClick={onAddByHand}>Add by hand…</button></div>}
     {row.state==='new'&&<div className="mcp-next" data-tone="off"><p>{row.sources.length>1?`Found in ${row.sources.length} places. It is added once, with each place as its source.`:'Adding saves it off. Nothing starts and no agent gets its tools.'}</p>
      {row.secretNames.length>0&&<fieldset className="mcp-key-choice"><legend>Its {row.secretNames.length===1?'secret':'secrets'}</legend>
       <label className="check"><input type="radio" name="mcp-keys" checked={keys==='save'} onChange={()=>setKeys('save')}/>Save in Saved keys</label>
       <label className="check"><input type="radio" name="mcp-keys" checked={keys==='leave'} onChange={()=>setKeys('leave')}/>Leave it, I add it later</label></fieldset>}
      <button type="button" className="primary" disabled={busy} onClick={()=>void add(row)}>{busy?'Adding…':'Add (off)'}</button></div>}
     {row.state==='added'&&row.serverId&&<div className="mcp-next" data-tone="ok"><p>It is in your connections. Each place below is one of its sources.</p><button type="button" onClick={()=>onOpen(row.serverId!)}>Open in connections</button></div>}
     {row.state==='hidden'&&<div className="mcp-next" data-tone="off"><p>Hidden. It stays out of this list until you show it again.</p><button type="button" onClick={()=>void hide(row,false)}>Show again</button></div>}
     <WhereItComesFrom sources={row.sources}/>
    </div>
   :<div className="dk-empty"><UiIcon name="link" size={24}/><p>Select one to see where it was found.</p></div>}
  </aside></div>
  <ContextMenu menu={menu} onClose={close}/>
  <Notice toast={toast} onUndo={()=>void undo()} onDone={id=>setToast(t=>t?.id===id?null:t)}/>
 </section>;
}
