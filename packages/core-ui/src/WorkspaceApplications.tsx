import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {SessionClient} from './session';
import {UiIcon} from './ui-icons';
import {TradingInstallView} from './TradingInstallView';
import {ContextMenu,useMenu} from './desktop-ui';
import type {MenuItem} from './desktop-ui';
import {WORKSPACE_APPS_PATH,type WorkspaceApp} from './apps-contract.js';

export const builtinApps=[{id:'trading',name:'Trading preview',icon:'chart',summary:'Local paper practice with fictional money and prices.'},{id:'terminal',name:'Terminal',icon:'terminal',summary:'Command sessions on this computer.'},{id:'genvr',name:'GenVR',icon:'globe',summary:'Virtual worlds and connected experiences.'},{id:'code',name:'Code',icon:'code',summary:'The project editor beside your chats, in the Girru desktop app.'}] as const;
const kinds={builtin:'Built-in',mcp:'MCP connection',api:'Account connection',added:'Added app'};
const states:Record<WorkspaceApp['state'],string>={included:'Included',disabled:'Off',connected:'Connected',connecting:'Connecting…',disconnected:'Disconnected',attention:'Needs attention',not_connected:'Account not connected',expired:'Connect again'};
const icon=(app:WorkspaceApp)=>app.id==='terminal'?'terminal':app.id==='trading'?'chart':app.id==='genvr'?'globe':app.id==='code'?'code':app.id==='browser'?'globe':app.kind==='added'?'puzzle':'layers';
// Status dot only when it says something: green connected, amber needs you.
const dot=(app:WorkspaceApp)=>app.state==='connected'?'ready':['attention','expired','disconnected'].includes(app.state)?'warn':undefined;
type TileHandlers={open:()=>void;onAccountConnections:()=>void;onPermissions:()=>void;footer?:MenuItem|null;canOpen?:boolean;remove?:()=>void};
/** Right-click on a tile (A3): the same actions as its inspector and ⋯ menu, with the same owner-only gates. MCP connections are not apps: they live in Settings › MCP connections. */
export function tileActions(app:Pick<WorkspaceApp,'id'|'kind'|'name'>,{owner}:{owner:boolean;busy?:boolean},h:TileHandlers):MenuItem[]{
 if(app.kind==='mcp')return [];
 // SA6: an added app (from the Store or a folder) has no page of its own: its tools are for agents.
 if(app.kind==='added'&&app.id==='browser')return [{label:'Open Browser',icon:'globe',run:h.open,disabled:h.canOpen===false},...(h.footer?['sep' as const,h.footer]:[])];
 if(app.kind==='added')return owner&&h.remove?[{label:'Agent permissions…',icon:'shield',run:h.onPermissions},'sep',{label:'Remove',icon:'trash',run:h.remove}]:[];
 const items:MenuItem[]=[{label:`Open ${app.name}`,icon:'open',run:h.open,disabled:h.canOpen===false}];
 if(!owner)return items;
 if(app.id==='genvr')items.push({label:'Account connection…',icon:'contact',run:h.onAccountConnections});
 if(app.id==='terminal'||app.id==='genvr')items.push({label:'Agent permissions…',icon:'shield',run:h.onPermissions});
 if(h.footer)items.push('sep',h.footer);
 return items;
}
const publicApp:WorkspaceApp={id:'genvr',name:'GenVR',kind:'api',version:null,summary:'Virtual worlds and connected experiences.',state:'included',sourceId:'genvr',permissions:[],tools:0,removable:false};
/** Code is in the server's app list; it opens only where the desktop app has the editor. */
export const CODE_ELSEWHERE='Opens in the Girru desktop app that has the editor';
const stateOf=(app:WorkspaceApp,canCode:boolean)=>app.id==='trading'?'Included preview':app.id==='code'&&!canCode?'Desktop app only':app.kind==='added'?(app.origin==='private'?'Private':'From the Store'):states[app.state];

/** My apps (AA1): the installed apps as big icons, like a launcher. MCP connections are not listed here (Settings › MCP connections). */
export function WorkspaceApplications({client,active,query,refresh,onOpen,onCode,onBrowser,onAccountConnections,onPermissions,footerItem,onRemove}:{client:SessionClient;active:boolean;query:string;refresh:number;onOpen:(id:'terminal'|'genvr'|'trading')=>void;onCode?:()=>void;onBrowser?:()=>void;onAccountConnections:()=>void;onPermissions:()=>void;footerItem?:(id:string)=>MenuItem|null;onRemove?:(app:WorkspaceApp)=>void}){
 const owner=useSyncExternalStore(client.subscribe,client.getSnapshot,client.getSnapshot).user?.role==='owner';
 const [items,setItems]=useState<WorkspaceApp[]>([]),[phase,setPhase]=useState<'loading'|'ready'|'error'>('loading'),[selected,setSelected]=useState('');
 const {menu:tileMenu,at,close}=useMenu();
 const sequence=useRef(0),list=useRef<HTMLDivElement>(null);
 const load=useCallback(async()=>{
  const seq=++sequence.current;setPhase('loading');
  try{const result=await client.request({method:'GET',path:WORKSPACE_APPS_PATH} as never);if(seq!==sequence.current)return;if(result.status!==200)throw Error('unavailable');setItems((result.body as {items:WorkspaceApp[]}).items.filter(x=>x.kind!=='mcp'));setPhase('ready');}
  catch{if(seq===sequence.current){setItems([]);setPhase('error');}}
 },[client]);
 useEffect(()=>{if(active&&owner)void load();return()=>{sequence.current++;};},[active,owner,load,refresh]);
 const rows=(owner?items:[publicApp]).filter(x=>`${x.name} ${x.summary}`.toLowerCase().includes(query.trim().toLowerCase()));
 const app=(!owner||phase==='ready')?rows.find(x=>x.id===selected):undefined;
 const open=(item:WorkspaceApp)=>{if(item.id==='browser'){onBrowser?.();}else if(item.id==='code'){onCode?.();}else if(item.id==='terminal'||item.id==='trading'||item.id==='genvr')onOpen(item.id);};
 const contextFor=(e:React.MouseEvent|React.KeyboardEvent,x:WorkspaceApp)=>{const items=tileActions(x,{owner},{open:()=>open(x),onAccountConnections,onPermissions,footer:owner?footerItem?.(x.id):null,canOpen:x.id==='browser'?!!onBrowser:x.id!=='code'||!!onCode,remove:onRemove?()=>onRemove(x):undefined});setSelected(x.id);if(items.length)at(e,items);};
 const ordered=rows;
 const move=(e:React.KeyboardEvent<HTMLDivElement>)=>{if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(e.key)||!ordered.length)return;e.preventDefault();const index=ordered.findIndex(x=>x.id===selected),step=e.key==='ArrowDown'||e.key==='ArrowRight'?1:-1,next=e.key==='Home'?0:e.key==='End'?ordered.length-1:Math.max(0,Math.min(ordered.length-1,index+step));setSelected(ordered[next].id);list.current?.querySelectorAll<HTMLButtonElement>('[role=option]')[next]?.focus();};
 const menu=(items:{label:string;run:()=>void;disabled?:boolean}[])=>items.length?<details className="st-menu apps-more"><summary className="tool" aria-label={`More for ${app?.name}`} title="More"><UiIcon name="more" size={15}/></summary><div role="menu">{items.map(x=><button key={x.label} type="button" role="menuitem" aria-label={x.label.replace(/…$/,'')} disabled={x.disabled} onClick={e=>{(e.currentTarget.closest('details') as HTMLDetailsElement|null)?.removeAttribute('open');x.run();}}>{x.label}</button>)}</div></details>:null;
 return <><div className="apps-panes" data-selected={!!app} onKeyDown={e=>{if(e.defaultPrevented)return;if(e.shiftKey&&e.key==='F10'&&selected==='trading'){e.preventDefault();e.currentTarget.querySelector<HTMLElement>('summary[aria-label="Paper setup actions"]')?.click();}}}>
 <div className="apps-list apps-launcher">
 {owner&&phase==='loading'&&<p className="apps-empty" role="status">Reading applications…</p>}
 {owner&&phase==='error'?<div className="apps-empty" role="alert"><p>Applications could not be loaded.</p><button onClick={()=>void load()}>Try again</button></div>:<div ref={list} role="listbox" aria-label="Applications" aria-orientation="horizontal" onKeyDown={move}>{rows.length>0&&<div role="group" aria-label="Installed" className="apps-group"><div className="apps-tiles">{rows.map(x=><button key={x.id} role="option" tabIndex={selected===x.id||!ordered.some(row=>row.id===selected)&&x===ordered[0]?0:-1} aria-selected={selected===x.id} className="apps-tile" data-app={x.id} title="Double-click to open" onClick={()=>setSelected(x.id)} onDoubleClick={()=>open(x)} onContextMenu={e=>contextFor(e,x)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();setSelected(x.id);open(x);}else if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10'&&x.id!=='trading'){contextFor(e,x);}}}><span className="apps-tile-icon" aria-hidden="true"><UiIcon name={icon(x)} size={26}/>{dot(x)&&<i data-state={dot(x)}/>}</span><span className="apps-tile-name">{x.name}</span><small>{stateOf(x,!!onCode)}</small></button>)}</div></div>}</div>}
 {(!owner||phase==='ready')&&!rows.length&&<div className="apps-empty"><p>{query?'No app matches your search.':'No apps installed yet.'}</p></div>}
 </div>
 <aside className="apps-inspector" aria-label="Selected application"><button className="apps-back" onClick={()=>setSelected('')}><UiIcon name="arrow-left" size={15}/>Back to apps</button>
 {app?<><div className="apps-inspector-head"><span className="apps-tile-icon" data-app={app.id} aria-hidden="true"><UiIcon name={icon(app)} size={22}/></span><div><h3>{app.name}</h3><p className="apps-inspector-line">{kinds[app.kind]} · {stateOf(app,!!onCode)}</p></div></div><p>{app.summary}</p>
 {app.kind==='added'?<><div className="apps-actions">{app.id==='browser'&&<button className="primary" disabled={!onBrowser} onClick={()=>onBrowser?.()}><UiIcon name="globe" size={15}/>Open Browser</button>}{owner&&onRemove&&<button onClick={()=>onRemove(app)}><UiIcon name="trash" size={15}/>Remove</button>}{owner&&menu([{label:'Agent permissions…',run:onPermissions}])}</div><p className="fine-print">{app.origin==='private'?'It can only make its own tables and gets only the permissions you give it.':'Its tools are for your agents; give them in Agents › Permissions.'}</p></>
 :app.id==='trading'?<TradingInstallView client={client} active={active} onPreview={()=>onOpen('trading')} onPermissions={onPermissions}/>
 :<div className="apps-actions"><button className="primary" disabled={app.id==='code'&&!onCode} title={app.id==='code'&&!onCode?CODE_ELSEWHERE:undefined} onClick={()=>open(app)}><UiIcon name={icon(app)} size={15}/>Open {app.name}</button>{owner&&menu([...(app.id==='genvr'?[{label:'Account connection…',run:onAccountConnections}]:[]),...(app.id==='terminal'||app.id==='genvr'?[{label:'Agent permissions…',run:onPermissions}]:[])])}</div>}
 {app.id==='code'&&!onCode&&<p className="fine-print">{CODE_ELSEWHERE}.</p>}
 {owner&&<section className="apps-may" aria-label="What it may do"><h4>What it may do</h4>{app.permissions.length?<ul>{app.permissions.map(x=><li key={x}>{x}</li>)}</ul>:<p className="fine-print">Nothing listed.</p>}<p className="fine-print">Adding an app never gives its tools to an agent.</p></section>}
 </>:<p className="apps-empty">Choose an app to open it or see what it may do.</p>}
 </aside></div>
 <ContextMenu menu={tileMenu} onClose={close}/>
 </>;
}
