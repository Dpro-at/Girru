import {useCallback,useEffect,useRef,useState} from 'react';
import type {KeyboardEvent as ReactKeyboardEvent,MouseEvent as ReactMouseEvent} from 'react';
import {createPortal} from 'react-dom';
import type {SessionClient} from './session';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';
import {ContextMenu,IconButton,Notice,Sheet,useMenu} from './desktop-ui';
import type {MenuItem} from './desktop-ui';
import {STORE_PATH,STORE_INSTALL_PATH,STORE_UNINSTALL_PATH,STORE_PRIVATE_PATH,storeJobPath} from './apps-contract.js';
import type {StoreData,StoreItem,StoreChange,StoreJob,PrivateAdd,WorkspaceApp} from './apps-contract.js';
import {WorkspaceApplications} from './WorkspaceApplications';

/** APPS-06 (board Apps6): the four steps of adding an app from the Girru Store. */
const ADD_STEPS:[string,string][]=[['getting','Getting it from the Girru Store'],['checking','Checking it is exactly what was reviewed'],['setting-up','Setting it up in your data folder'],['adding','Adding its page and tools']];
const plainTable=(t:string,app:string)=>t.replace(new RegExp('^'+app.replace(/-/g,'_')+'_'),'').replace(/_/g,' ');
import {initial} from './memory-desktop';
import {skillTitle} from './skill-display';
/** Coding-app add-ons keep their package names; show them as words ("code-review" → "Code review"). */
export const itemName=(x:Pick<StoreItem,'name'|'source'>)=>x.source==='girru'?x.name:skillTitle(x.name);

/** The Store sidebar lists only kinds (SA1 v2); categories are the row at the top of the page. */
export type StoreKind='all'|'app'|'mcp'|'skill'|'specialty';
export const STORE_KINDS:ReadonlyArray<[StoreKind,string,UiIconName]>=[['all','All','store'],['app','Apps','puzzle'],['mcp','MCP servers','server'],['skill','Skills','star'],['specialty','Specialties','layers']];
/** What the page shows: a kind, a category of the row ('all' for every one), and a "See all" shelf. */
export type StoreView={kind:StoreKind;category:string;shelf:'girru'|'new'|null;local?:'claude-code'|'codex'|null;mine?:boolean};
/** SA6: long lists draw this many rows, then the next part as you near the end (or press Show more). */
export const STORE_PART=40;
/** How many rows of a long list are drawn: one part to start, one more each time the end comes near. */
export function useShown(reset:unknown){
 const [shown,setShown]=useState(STORE_PART),end=useRef<HTMLDivElement|null>(null);
 useEffect(()=>setShown(STORE_PART),[reset]);
 useEffect(()=>{const el=end.current;if(!el||typeof IntersectionObserver==='undefined')return;const o=new IntersectionObserver(e=>{if(e.some(x=>x.isIntersecting))setShown(n=>n+STORE_PART);},{rootMargin:'400px'});o.observe(el);return()=>o.disconnect();});
 return {shown,more:()=>setShown(n=>n+STORE_PART),end};
}
/** A private app or a Store app from My apps, as the Store's Remove expects it. */
export const addedItem=(app:Pick<WorkspaceApp,'name'|'sourceId'|'origin'>):StoreItem=>({id:`${app.origin==='private'?'private':'store'}:${app.sourceId}`,kind:'app',source:'girru',name:app.name,summary:'',description:'',icon:'puzzle',maker:'',verified:false,version:null,updated:null,category:'more',permissions:[],worksWith:[],languages:[],state:'installed',present:true,update:null,hash:'0'.repeat(64)});
/** SA5: the coding apps whose add-ons get a place of their own ("On this computer"). */
export const LOCAL_APPS:ReadonlyArray<['claude-code'|'codex',string]>=[['claude-code','Claude Code'],['codex','Codex']];
export type StoreSort='new'|'az';
export type IncludedApp='genvr'|'trading'|'terminal'|'code'|'browser';
/** Where an item comes from, in the words of its chip. */
export const sourceChip=(x:Pick<StoreItem,'id'|'source'>)=>x.source==='girru'?(x.id.startsWith('girru:')?'Made by Girru':'Girru’s registry'):x.source==='codex'?'Codex add-on':'Claude Code add-on';
const TINT:Record<string,string>={marketing:'#E07AB0',sales:'#5FB37A',developer:'#9AA4B2',worlds:'#6FD3C7',trading:'#F0C27A',productivity:'#7AA5FF',more:'#B49AF0'};
const ICONS=new Set<string>(['globe','chart','terminal','code','send','headset','calendar','puzzle','store']);
const includedApp=(x:StoreItem)=>x.state==='included'&&x.kind==='app'?x.id.slice(6) as IncludedApp:null;
/** Search: every kind and source; names that match first, then the rest of the words. */
export const matchStore=(items:StoreItem[],query:string)=>{const q=query.trim().toLowerCase();if(!q)return [];const named=(x:StoreItem)=>itemName(x).toLowerCase().includes(q)||x.name.toLowerCase().includes(q);return [...items.filter(named),...items.filter(x=>!named(x)&&`${x.summary} ${x.maker} ${x.description}`.toLowerCase().includes(q))];};
/** New first (the newest update date; items without one keep the store's order after them), or A–Z by name. */
export const sortStore=(items:StoreItem[],sort:StoreSort)=>sort==='az'?[...items].sort((a,b)=>itemName(a).localeCompare(itemName(b))):items.map((x,i)=>[x,i] as const).sort(([a,i],[b,j])=>(b.updated??'').localeCompare(a.updated??'')||i-j).map(([x])=>x);
/** The items of one view, sorted. */
export function viewItems(data:StoreData,view:StoreView,sort:StoreSort):StoreItem[]{
 // SA5: a coding app's place lists only its add-ons turned on on this computer.
 if(view.local)return sortStore(data.items.filter(x=>x.source===view.local&&x.present),'az');
 const shelf=view.shelf==='girru'?new Set(data.collections.find(c=>c.id==='made-by-girru')?.items??[]):null;
 return sortStore(data.items.filter(x=>(view.kind==='all'||x.kind===view.kind)&&(view.category==='all'||x.category===view.category)&&(!shelf||shelf.has(x.id))),sort);
}

/** One read for the whole Store; read again after Add or Remove. */
export function useStore(client:SessionClient,enabled:boolean,refresh:number){
 const [data,setData]=useState<StoreData|null>(null),[error,setError]=useState(false),[n,setN]=useState(0);
 useEffect(()=>{if(!enabled)return;let stopped=false;setError(false);void client.request({method:'GET',path:STORE_PATH} as never).then(r=>{if(stopped)return;if(r.status!==200){setError(true);return;}setData(r.body as StoreData);}).catch(()=>{if(!stopped)setError(true);});return()=>{stopped=true;};},[client,enabled,refresh,n]);
 return {data,error,reload:useCallback(()=>setN(x=>x+1),[])};
}

/** The item's real icon on its category's colour; its initial when it has none. */
export function StoreIcon({item,size=44}:{item:Pick<StoreItem,'icon'|'name'|'category'>;size?:number}){
 return <span className="st-icon" aria-hidden="true" style={{'--tint':TINT[item.category]??TINT.more,inlineSize:size,blockSize:size,borderRadius:Math.round(size*.26),fontSize:Math.round(size*.42)} as never}>{item.icon&&ICONS.has(item.icon)?<UiIcon name={item.icon as UiIconName} size={Math.round(size*.46)}/>:initial(item.name)}</span>;
}
/** Where it comes from, then Free or Installed (no ratings or install counts until they are real). */
function Chips({item}:{item:StoreItem}){
 return <span className="st-chips"><span className="st-chip" data-tone={item.source}>{sourceChip(item)}</span>
  {item.state==='included'||item.state==='installed'?<span className="st-chip" data-tone="ok"><UiIcon name="check" size={11}/>Installed</span>:item.state==='elsewhere'?(item.present&&<span className="st-chip" data-tone="ok">On this computer</span>):<span className="st-chip">Free</span>}</span>;
}

/**
 * Store (STORE-UI-01, boards SA1–SA4 v2): its own footer section. The sidebar
 * lists only kinds; the category row sits at the top of the page; search is
 * the sidebar field (⌘F) across every kind and source. Opening an item shows
 * its page (SA2); Get opens a short sheet (SA3); updates that need the owner
 * are a toolbar icon with a badge.
 */
export function StoreWorkspace({client,active,sidebarSlot,onOpenApp,request,onPermissions,onAccounts,footerItem,canCode=true,canBrowser=false}:{client:SessionClient;active:boolean;sidebarSlot?:HTMLElement|null;onOpenApp:(id:IncludedApp)=>void;request?:{updates:boolean;n:number;local?:'claude-code'|'codex';mine?:boolean};onPermissions:()=>void;onAccounts:()=>void;footerItem?:(id:string)=>MenuItem|null;canCode?:boolean;canBrowser?:boolean}){
 const owner=client.getSnapshot().user?.role==='owner',store=useStore(client,active&&owner,0),{data,error}=store,onReload=store.reload;
 // SA6 (Mohamed): the owner's Store opens on All, then My apps (what is on this computer), then the kinds; others have My apps only.
 const [view,setView]=useState<StoreView>({kind:'all',category:'all',shelf:null,mine:!owner}),[mineRefresh,setMineRefresh]=useState(0),[folderOpen,setFolderOpen]=useState(false),[folder,setFolder]=useState(''),[sort,setSort]=useState<StoreSort>('new'),[query,setQuery]=useState('');
 const [page,setPage]=useState<string|null>(null),[updatesOpen,setUpdatesOpen]=useState(false),[adding,setAdding]=useState<StoreItem|null>(null),[busy,setBusy]=useState(false),[problem,setProblem]=useState(''),[toast,setToast]=useState<{id:number;text:string;undo:boolean;show?:unknown}|null>(null);
 const [progress,setProgress]=useState<{item:StoreItem;step:string}|null>(null),[removing,setRemoving]=useState<{item:StoreItem;data:{table:string;rows:number}[]}|null>(null);
 const undoRef=useRef<(()=>void)|null>(null),search=useRef<HTMLInputElement>(null),scroll=useRef<HTMLDivElement>(null),{menu,at,close}=useMenu();
 useEffect(()=>{if(request?.updates)setUpdatesOpen(true);if(request?.local||request?.mine){setView({kind:'all',category:'all',shelf:null,local:request.local??null,mine:!!request.mine});setPage(null);setQuery('');}},[request?.n]);
 const show=(next:Partial<StoreView>)=>{setView(v=>({...v,shelf:null,local:null,mine:false,...next}));setPage(null);setQuery('');scroll.current?.scrollTo?.(0,0);};
 const item=page?data?.items.find(x=>x.id===page)??null:null;
 const say=(text:string,undo?:()=>void)=>{undoRef.current=undo??null;setToast({id:Date.now(),text,undo:!!undo});};
 const change=async(path:string,body:object)=>{const r=await client.request({method:'POST',path,body} as never);return r.body as StoreChange;};
 async function add(x:StoreItem){
  setBusy(true);setProblem('');
  try{const r=await change(STORE_INSTALL_PATH,{id:x.id,hash:x.hash});
   if('ok' in r&&r.job){setAdding(null);void follow(x,r.job);}
   else if('ok' in r){setAdding(null);onReload();say(`${itemName(x)} added.`,()=>void remove(x,true));}
   else{setProblem(r.message||'It could not be added.');if(r.code==='changed')onReload();}
  }catch{setProblem('It could not be added. Try again.');}finally{setBusy(false);}
 }
 /** An app from the Girru Store is added by a job: one line under it shows each step (no progress page). */
 async function follow(x:StoreItem,job:string){
  setProgress({item:x,step:'getting'});
  for(let n=0;n<600;n++){
   await new Promise(r=>setTimeout(r,600));
   let j:StoreJob;try{j=(await client.request({method:'GET',path:storeJobPath(job)} as never)).body as StoreJob;}catch{continue;}
   if('code' in j){setProgress(null);say('Girru lost track of adding it. Look in My apps.');return;}
   setProgress({item:x,step:j.step});
   if(j.done){setProgress(null);onReload();say(j.message||(j.ok?`${itemName(x)} added.`:'It could not be added.'));return;}
  }
  setProgress(null);
 }
 async function remove(x:StoreItem,quiet=false,confirm=false){
  try{const r=await change(STORE_UNINSTALL_PATH,confirm?{id:x.id,confirm:true}:{id:x.id});
   // APPS-06: an app that keeps data of its own asks once; Girru saves a copy first.
   if(!('ok' in r)&&r.code==='has_data'&&r.data){setRemoving({item:x,data:r.data});return;}
   setRemoving(null);onReload();
   if('ok' in r&&(x.id.startsWith('store:')||x.id.startsWith('private:'))){if(x.id.startsWith('private:'))setMineRefresh(n=>n+1);say(`${itemName(x)} removed${r.copied?'; a copy of its data is saved':''}.${r.restart==='auto'?' Girru starts again to finish.':' It leaves when Girru starts again.'}`);return;}if(!quiet)say('ok' in r?`${itemName(x)} removed.`:r.message||'It could not be removed.','ok' in r?()=>void change(STORE_INSTALL_PATH,{id:x.id,hash:x.hash}).then(onReload):undefined);}
  catch{say('It could not be removed. Try again.');}
 }
 /** SA6: a private app from a folder on this computer; checked like a Store app, never listed in the Store. */
 async function addFolder(){
  setBusy(true);setProblem('');
  try{const r=(await client.request({method:'POST',path:STORE_PRIVATE_PATH,body:{folder:folder.trim()}} as never)).body as PrivateAdd;
   if('ok' in r){setFolderOpen(false);setFolder('');setMineRefresh(n=>n+1);say(`${r.name} added from a folder.${r.restart==='auto'?' Girru starts again to finish.':' Start Girru again to finish.'}`);}
   else setProblem(r.message||'It could not be added.');
  }catch{setProblem('It could not be added. Try again.');}finally{setBusy(false);}
 }
 /** The one action of an item: Open what comes with Girru, Get what is free, read about the rest. */
 const act=(x:StoreItem)=>{const app=includedApp(x);if(app)onOpenApp(app);else if(x.state==='available'){setProblem('');setAdding(x);}else setPage(x.id);};
 // Skills and specialties that come with Girru have no Open of their own: their page says where they are.
 const actionLabel=(x:StoreItem)=>x.state==='included'&&includedApp(x)?'Open':x.state==='available'?'Get':null;
 const itemMenu=(x:StoreItem):MenuItem[]=>[{label:'Show details',icon:'info',run:()=>setPage(x.id)},...(actionLabel(x)?[{label:actionLabel(x)!,icon:x.state==='included'?'open':'download',run:()=>act(x)} as MenuItem]:[]),...(x.state==='installed'?['sep' as const,{label:'Remove',icon:'trash',run:()=>void remove(x)} as MenuItem]:[])];
 const onKey=(e:ReactKeyboardEvent)=>{if(e.defaultPrevented||(e.currentTarget as HTMLElement).querySelector('.dk-sheet'))return;const mod=e.metaKey||e.ctrlKey,k=e.key.toLowerCase();if(mod&&k==='f'){e.preventDefault();search.current?.focus();}else if(mod&&e.key==='['&&page){e.preventDefault();setPage(null);}else if(mod&&k==='r'){e.preventDefault();onReload();}};
 const open=(x:StoreItem)=>setPage(x.id),ctx=(x:StoreItem)=>(e:ReactMouseEvent)=>at(e,itemMenu(x));
 const kindTitle=STORE_KINDS.find(([k])=>k===view.kind)![1],category=data?.categories.find(c=>c.id===view.category);
 const mine=!!view.mine||!owner,searching=!mine&&!!query.trim(),home=!searching&&!mine&&view.kind==='all'&&view.category==='all'&&!view.shelf&&!view.local;
 const localTitle=LOCAL_APPS.find(([k])=>k===view.local)?.[1]??null;
 const title=item?itemName(item):mine?'My apps':searching?'Search':localTitle?localTitle:view.shelf==='girru'?'Made by Girru':view.shelf==='new'?'New in the store':category?category.title:kindTitle;
 const items=!data?[]:searching?matchStore(data.items,query):viewItems(data,view,view.shelf==='new'?'new':sort);
 const updates=data?.items.filter(x=>x.update)??[];
 const {shown,more,end}=useShown(`${view.kind}|${view.category}|${view.shelf}|${view.local}|${mine}|${query}|${sort}`);
 const nav=<nav className="dk-sidebar store-places" aria-label="Store places">
  <div className="dk-side-top"><label className="dk-search"><UiIcon name="search" size={13}/><input ref={search} type="search" aria-label={mine?'Search my apps':'Search the store'} value={query} onChange={e=>{setQuery(e.target.value);setPage(null);}} placeholder={mine?'Search my apps  ⌘F':'Search the store  ⌘F'}/></label></div>
  {owner&&STORE_KINDS.filter(([k])=>k==='all').map(([k,label,icon])=><button type="button" key={k} className="nav-item dk-place" aria-current={view.kind===k&&!view.local&&!mine&&!searching?'page':undefined} onClick={()=>show({kind:k,category:'all'})}><UiIcon name={icon} size={15}/><span className="dk-place-name">{label}</span></button>)}
  <button type="button" className="nav-item dk-place" aria-current={mine?'page':undefined} onClick={()=>show({mine:true})}><UiIcon name="layers" size={15}/><span className="dk-place-name">My apps</span></button>
  {owner&&STORE_KINDS.filter(([k])=>k!=='all').map(([k,label,icon])=><button type="button" key={k} className="nav-item dk-place" aria-current={view.kind===k&&!view.local&&!mine&&!searching?'page':undefined} onClick={()=>show({kind:k,category:'all'})}><UiIcon name={icon} size={15}/><span className="dk-place-name">{label}</span></button>)}
  {owner&&data&&LOCAL_APPS.some(([src])=>data.items.some(x=>x.source===src))&&<><p className="section-label dk-label st-local-label">On this computer</p>
   {LOCAL_APPS.filter(([src])=>data.items.some(x=>x.source===src)).map(([src,label])=><button type="button" key={src} className="nav-item dk-place" title={`Add-ons turned on in ${label} on this computer`} aria-current={view.local===src&&!searching?'page':undefined} onClick={()=>show({kind:'all',category:'all',local:src})}><UiIcon name="code" size={15}/><span className="dk-place-name">{label}</span></button>)}</>}
 </nav>;
 return <section className="store-workspace" data-inline-sidebar={!sidebarSlot||undefined} aria-label="Store" onKeyDown={onKey}>{active&&sidebarSlot?createPortal(nav,sidebarSlot):!sidebarSlot?nav:null}
 <div className="apps-main st-store">
  <header className="apps-toolbar">{item&&<IconButton icon="arrow-left" label="Back" shortcut="⌘[" onClick={()=>setPage(null)}/>}<h2>{title}</h2>
   {mine?<span className="st-tools"><IconButton icon="refresh" label="Look again" onClick={()=>setMineRefresh(n=>n+1)}/>
    {owner&&<IconButton icon="more" label="More" onClick={e=>at(e,[{label:'Add an app from a folder…',icon:'folder',run:()=>{setProblem('');setFolderOpen(true);}}])}/>}</span>
   :<span className="st-tools"><IconButton icon="refresh" label={updates.length?`Updates that need your OK (${updates.length})`:'Updates'} badge={updates.length||undefined} onClick={()=>setUpdatesOpen(true)}/>
   <IconButton icon="more" label="More" onClick={e=>at(e,[{label:'Check for new apps',icon:'refresh',shortcut:'⌘R',run:onReload},{label:'Updates',icon:'download',run:()=>setUpdatesOpen(true)}])}/></span>}</header>
  {!mine&&!searching&&!view.local&&data&&<div className="st-cat-row" role="toolbar" aria-label="Categories">{[{id:'all',title:'All',icon:'store'},...data.categories].map(c=><button type="button" key={c.id} aria-pressed={view.category===c.id} style={{'--tint':TINT[c.id]??'var(--accent)'} as never} onClick={()=>show({category:c.id})}>{c.id!=='all'&&<UiIcon name={(ICONS.has(c.icon)?c.icon:'puzzle') as UiIconName} size={13}/>}{c.title}</button>)}</div>}
  {mine?<div className="apps-mine">
   <WorkspaceApplications client={client} active={active&&mine} query={query} refresh={mineRefresh} onOpen={id=>onOpenApp(id)} onCode={canCode?()=>onOpenApp('code'):undefined} onBrowser={canBrowser?()=>onOpenApp('browser'):undefined} onPermissions={onPermissions} onAccountConnections={onAccounts} footerItem={footerItem} onRemove={owner?app=>void remove(addedItem(app)):undefined}/>
  </div>
  :<div className="st-scroll" ref={scroll}>
   {error&&!data?<div className="dk-empty st-empty"><p>The store could not be read.</p><button type="button" onClick={onReload}>Try again</button></div>
   :!data?<p className="st-empty" role="status">Reading the store…</p>
   :item?<AppPage item={item} data={data} onAct={act} onRemove={()=>void remove(item)} onCategory={id=>show({category:id})}/>
   :home?<Home data={data} onOpen={open} onAct={act} onMenu={ctx} onShelf={shelf=>{show({});setView(v=>({...v,shelf}));}}/>
   :view.local&&!items.length?<p className="st-empty">No {localTitle} add-ons on this computer. When you turn some on in {localTitle}, they show here.</p>
   :!items.length?<p className="st-empty">{searching?'Nothing in the store matches.':view.kind==='all'||view.kind==='app'?'Nothing in this category yet.':`No ${kindTitle==='MCP servers'?kindTitle:kindTitle.toLowerCase()} in the store yet. They come with the store’s own catalogue.`}</p>
   :<section className="st-list" aria-label={title}>
     {!searching&&!view.shelf&&!view.local&&<header className="st-list-head"><strong>{title}</strong><span className="st-seg" role="radiogroup" aria-label="Order">{(['new','az'] as const).map(s=><button type="button" key={s} role="radio" aria-checked={sort===s} onClick={()=>setSort(s)}>{s==='new'?'New':'A–Z'}</button>)}</span></header>}
     {items.slice(0,shown).map((x,i)=><Row key={x.id} item={x} rank={searching?undefined:i+1} onOpen={open} onAct={act} label={actionLabel(x)} onMenu={ctx(x)}/>)}
     {items.length>shown&&<div ref={end} className="st-more"><button type="button" onClick={more}>Show more</button></div>}
     {searching&&<p className="st-help st-found">{items.length} found. Results from Girru, Claude Code and Codex together; the chip says where each comes from.</p>}
     {view.local&&<p className="st-help">Turned on in {localTitle} itself. Girru shows them here and never copies their keys; turn one off in {localTitle}.</p>}</section>}
   {data&&data.limited.includes('registry')&&!item&&<p className="st-help">Girru’s registry could not be read; the rest of the store is shown.</p>}
   {data&&data.limited.includes('store')&&!item&&<p className="st-offline" role="status"><UiIcon name="refresh" size={13}/>{data.storeAsOf?`No internet — showing the store from ${new Date(data.storeAsOf).toLocaleDateString(undefined,{day:'numeric',month:'short'})}.`:'The Girru Store could not be read; the apps that come with Girru are shown.'}<button type="button" className="link" onClick={onReload}>Try again</button></p>}
  </div>}
  {updatesOpen&&<Sheet title="Updates" onClose={()=>setUpdatesOpen(false)} actions={<button type="button" className="primary" onClick={()=>setUpdatesOpen(false)}>Done</button>}>
   {updates.length?<ul className="st-updates">{updates.map(x=><li key={x.id}><StoreIcon item={x} size={28}/><span><strong>{itemName(x)}</strong><small>{x.version} → {x.update}</small></span><button type="button" onClick={()=>{setUpdatesOpen(false);setPage(x.id);}}>Details</button></li>)}</ul>
   :<div className="st-calm"><UiIcon name="refresh" size={20}/><strong>Everything is up to date.</strong><p>Girru updates apps by itself; you only see the ones that ask for more.</p></div>}
  </Sheet>}
  {adding&&<Sheet title={`Add ${itemName(adding)}?`} onClose={()=>setAdding(null)} actions={<><button type="button" onClick={()=>setAdding(null)}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={()=>void add(adding)}>Add</button></>}>
   <div className="st-sheet-head"><StoreIcon item={adding} size={36}/><span>{adding.maker?`by ${adding.maker}`:sourceChip(adding)}</span></div>
   {adding.permissions.length?<><p>It will be able to:</p><ul className="st-asks">{adding.permissions.map(p=><li key={p}><UiIcon name="shield" size={13}/>{p}</li>)}</ul></>:<p>It does not ask for anything.</p>}
   {problem&&<p className="st-problem" role="alert">{problem}</p>}
  </Sheet>}
  {progress&&<div className="st-progress" role="status" aria-label={`Adding ${itemName(progress.item)}`}><div className="st-progress-head"><StoreIcon item={progress.item} size={28}/><strong>{itemName(progress.item)}</strong><span>Adding…</span></div>
   <ul>{ADD_STEPS.map(([k,label],i)=>{const at=ADD_STEPS.findIndex(([s])=>s===progress.step);return <li key={k} data-state={i<at?'done':i===at?'now':'wait'}><UiIcon name={i<at?'check':i===at?'refresh':'clock'} size={13}/>{label}</li>;})}</ul></div>}
  {removing&&<Sheet title={`Remove ${itemName(removing.item)}?`} onClose={()=>setRemoving(null)} actions={<><button type="button" onClick={()=>setRemoving(null)}>Cancel</button><button type="button" className="primary" onClick={()=>void remove(removing.item,false,true)}><UiIcon name="trash" size={14}/>Save a copy and remove</button></>}>
   <div className="st-sheet-head"><StoreIcon item={removing.item} size={36}/></div>
   <p>Its page, its tools and its code leave Girru. It keeps data of its own: <strong>{removing.data.filter(t=>t.rows>0).map(t=>`${t.rows} ${plainTable(t.table,removing.item.id.slice(removing.item.id.indexOf(':')+1))}`).join(', ')}</strong>.</p>
   <ul className="st-asks"><li><UiIcon name="shield" size={13}/>Girru saves a copy of that data first, then removes it.</li><li><UiIcon name="undo" size={13}/>Add {itemName(removing.item)} again later and the copy comes back.</li><li><UiIcon name="check" size={13}/>Your chats, agents and memory stay as they are.</li></ul>
  </Sheet>}
  {folderOpen&&<Sheet title="Add an app from a folder" onClose={()=>setFolderOpen(false)} actions={<><button type="button" onClick={()=>setFolderOpen(false)}>Cancel</button><button type="button" className="primary" disabled={busy||!folder.trim()} onClick={()=>void addFolder()}>Add app</button></>}>
   <p>For an app you made yourself or got outside the Girru Store. It stays on this computer and is never listed in the Store.</p>
   <label className="st-folder"><span>Folder, inside your home folder</span><input type="text" value={folder} onChange={e=>setFolder(e.target.value)} placeholder="~/Projects/my-app" spellCheck={false} autoFocus onKeyDown={e=>{if(e.key==='Enter'&&folder.trim()&&!busy){e.preventDefault();void addFolder();}}}/></label>
   <ul className="st-asks"><li><UiIcon name="check" size={13}/>Girru checks its app file, its files and that it makes only its own tables.</li><li><UiIcon name="shield" size={13}/>It gets only the permissions you give it, like any app.</li><li><UiIcon name="info" size={13}/>Nobody reviewed it. Add it only if you trust where it came from.</li></ul>
   {problem&&<p className="st-problem" role="alert">{problem}</p>}
  </Sheet>}
  <ContextMenu menu={menu} onClose={close}/>
  <Notice toast={toast} onUndo={()=>{const u=undoRef.current;setToast(null);u?.();}} onDone={id=>setToast(t=>t?.id===id?null:t)}/>
 </div></section>;
}

function Card({item,onOpen,onMenu}:{item:StoreItem;onOpen:(x:StoreItem)=>void;onMenu:(e:ReactMouseEvent)=>void}){
 return <button type="button" className="st-card" onClick={()=>onOpen(item)} onContextMenu={onMenu} title={itemName(item)}><StoreIcon item={item}/><span className="st-card-text"><strong>{itemName(item)}</strong><small>{item.summary||item.maker}</small><Chips item={item}/></span></button>;
}
function Row({item,rank,onOpen,onAct,label,onMenu}:{item:StoreItem;rank?:number;onOpen:(x:StoreItem)=>void;onAct:(x:StoreItem)=>void;label:string|null;onMenu:(e:ReactMouseEvent)=>void}){
 return <div className="st-row" onContextMenu={onMenu}>{rank!==undefined&&<span className="st-rank">{rank}</span>}<button type="button" className="st-row-main" onClick={()=>onOpen(item)}><StoreIcon item={item} size={36}/><span><strong>{itemName(item)}</strong><small>{item.summary||item.maker}</small></span></button><span className="st-chip" data-tone={item.source}>{sourceChip(item)}</span>{label?<button type="button" className="st-get" onClick={()=>onAct(item)}>{label}</button>:item.state==='elsewhere'?(item.present&&<span className="st-chip" data-tone="ok">On this computer</span>):<span className="st-chip" data-tone="ok"><UiIcon name="check" size={11}/>Installed</span>}</div>;
}

function Home({data,onOpen,onAct,onMenu,onShelf}:{data:StoreData;onOpen:(x:StoreItem)=>void;onAct:(x:StoreItem)=>void;onMenu:(x:StoreItem)=>(e:ReactMouseEvent)=>void;onShelf:(s:'girru'|'new')=>void}){
 const featured=data.items.find(x=>x.id===data.featured),find=(id:string)=>data.items.find(x=>x.id===id)!;
 const ours=data.collections.find(c=>c.id==='made-by-girru')?.items??[];
 // New in the store: what was added to the catalogues, not the apps that come with Girru (they have their own shelf).
 const shelves:{id:'girru'|'new';title:string;items:StoreItem[]}[]=[{id:'girru',title:'Made by Girru',items:ours.map(find)},{id:'new',title:'New in the store',items:sortStore(data.items.filter(x=>!ours.includes(x.id)),'new').slice(0,6)}];
 return <>
  {featured&&<section className="st-hero" style={{'--tint':TINT[featured.category]??TINT.more} as never} aria-label="Featured app">
   <div className="st-hero-text"><p className="st-eyebrow">Featured · {sourceChip(featured)}</p><div className="st-hero-name"><StoreIcon item={featured} size={52}/><h3>{itemName(featured)}</h3></div><p>{featured.description||featured.summary}</p>
    <div className="st-hero-actions">{(featured.state==='included'||featured.state==='available')&&<button type="button" className="primary" onClick={()=>onAct(featured)}>{featured.state==='included'?'Open':'Get'}</button>}<Chips item={featured}/><button type="button" className="link-button" onClick={()=>onOpen(featured)}>Details</button></div></div>
   <div className="st-hero-art" aria-hidden="true">{Array.from({length:7},(_,i)=><span key={i}><i/><i/>{i%3===0&&<i/>}</span>)}</div>
  </section>}
  {shelves.filter(s=>s.items.length).map(s=><section key={s.id} className="st-shelf" aria-label={s.title}><header><h3>{s.title}</h3><button type="button" className="link-button" onClick={()=>onShelf(s.id)}>See all</button></header>
   <div className="st-cards">{s.items.map(x=><Card key={x.id} item={x} onOpen={onOpen} onMenu={onMenu(x)}/>)}</div></section>)}
 </>;
}

function AppPage({item,data,onAct,onRemove,onCategory}:{item:StoreItem;data:StoreData;onAct:(x:StoreItem)=>void;onRemove:()=>void;onCategory:(id:string)=>void}){
 const category=data.categories.find(c=>c.id===item.category);
 const facts:[string,string][]=[['Maker',item.maker||'Not given'],['From',sourceChip(item)],...(item.version?[['Version',item.version] as [string,string]]:[]),...(item.update?[['Newer version',item.update] as [string,string]]:[]),...(item.updated?[['Updated',item.updated] as [string,string]]:[]),...(item.languages.length?[['Languages',item.languages.join(', ')] as [string,string]]:[]),['Price','Free']];
 const label=item.state==='included'?'Open':item.state==='available'?'Get':null;
 return <article className="st-app" aria-label={itemName(item)}>
  <header className="st-app-head"><StoreIcon item={item} size={88}/><div><h3>{itemName(item)}</h3>
   <p className="st-maker">{item.verified&&<UiIcon name="shield" size={13}/>}{item.maker||sourceChip(item)}</p>
   <p className="st-meta">{category&&<button type="button" className="link-button" onClick={()=>onCategory(category.id)}>{category.title}</button>}<span className="st-chip" data-tone={item.source}>{sourceChip(item)}</span><span>Free</span></p></div>
   <div className="st-app-actions">{label?<button type="button" className="primary" onClick={()=>onAct(item)}>{label}</button>:item.state==='installed'?<><span className="st-chip" data-tone="ok"><UiIcon name="check" size={11}/>Installed</span><button type="button" onClick={onRemove}>Remove</button></>:item.present?<span className="st-chip" data-tone="ok">On this computer</span>:null}</div></header>
  <div className="st-app-body"><div>
   <section><h4>What it does</h4><p>{item.description||item.summary||'No description given.'}</p>{item.state==='elsewhere'&&<p className="st-help">Add it in {item.source==='codex'?'Codex':'Claude Code'} itself. Girru does not copy its keys.</p>}</section>
   <section><h4>What it asks for</h4>{item.permissions.length?<ul className="st-asks">{item.permissions.map(p=><li key={p}><UiIcon name="shield" size={13}/>{p}</li>)}</ul>:<p className="st-help">Nothing listed.</p>}</section>
  </div><aside>
   <section><h4>Information</h4><dl className="st-facts">{facts.map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></section>
   {item.worksWith.length>0&&<section><h4>Works well with</h4><p>{item.worksWith.join(', ')}</p></section>}
  </aside></div>
 </article>;
}
