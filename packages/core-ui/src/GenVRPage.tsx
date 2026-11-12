import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CreateSpace, GenVRSidebar, PublishedCards, SpaceCards, SpaceInside, type CreateSpec, type GenVRPlace, type SpaceRow } from './GenVRHome';
import { UiIcon } from './ui-icons';
import { PlaceSection, type SpaceStore } from './GenVRSections';
import { GenVRMarket, type MarketItem } from './GenVRMarket';
import { WhoButton, type Who } from './ChatComposerControls';
import type { SpaceAgent } from './GenVRTeam';
import type { Publication } from './connections-contract.js';
import type { SessionClient } from './session';
import { GENVR_PATH, GENVR_AGENTS, STUDIO_TICKET_PATH, genvrId, validStudioProject, validWorldTurn, changesWorld } from './genvr-contract.js';
type Project=SpaceRow;
/** GENVR-WORLD-01 (board W1): the open world as the Studio tells it, who answers there, and its folder. */
type Place={projectId:string;name:string;tab:string;look:string;kind:string};
type Answerer={id:string;name:string;detail:string;color:string};
type Call={function:{name:string;arguments:Record<string,unknown>}};
type Asking={calls:Call[];who:string;decide:(allow:boolean)=>void};
const TABS=['build','items','avatar','filming','lab'];
const placeOf=(value:unknown):Place|null=>{const c=value as Record<string,unknown>|null;return c&&typeof c==='object'&&genvrId(c.projectId)&&typeof c.name==='string'&&c.name.length<=200&&TABS.includes(c.tab as string)&&typeof c.look==='string'&&c.look.length<=40&&typeof c.kind==='string'&&c.kind.length<=40?{projectId:c.projectId as string,name:c.name,tab:c.tab as string,look:c.look,kind:c.kind}:null;};
/** One tool call in plain words for the approval card: "place item · Oak tree". */
export function callLine(call:Call):string{const a=call.function.arguments;const hint=['name','title','item','itemId','query','text','kind','preset'].map(k=>a[k]).find(v=>typeof v==='string'&&v.trim());return call.function.name.replace(/_/g,' ')+(hint?` · ${String(hint).slice(0,60)}`:'');}
export function GenVRPage({client,active,sidebarSlot}:{client:SessionClient;active:boolean;sidebarSlot?:HTMLElement|null}){
 /* GV1: the section's place in the sidebar, the space we are inside (its settings), and the create page. */
 const [genvrPlace,setGenvrPlace]=useState<GenVRPlace>('spaces'),[insideId,setInsideId]=useState(''),[section,setSection]=useState('basic'),[creating,setCreating]=useState(false);
 const createSpec=useRef<CreateSpec|undefined>(undefined),openingLab=useRef(false);
 const frame=useRef<HTMLIFrameElement>(null),revisions=useRef(new Map<string,number>()),opening=useRef<string | undefined>(undefined);
 const selection=useRef<SpaceAgent[]|undefined>(undefined);
 const [mcp,setMcp]=useState('Preparing local MCP…');
 useEffect(()=>{if(!active)return;if(client.getSnapshot().user?.role!=='owner'){setMcp('Local MCP setup is managed by the workspace owner.');return;}let disposed=false;void client.request({method:'POST',path:'/api/genvr/mcp/bootstrap',body:{}} as never).then(result=>{if(disposed)return;const state=(result.body as {status?:string})?.status;setMcp(result.status!==200?'Local MCP could not be prepared.':state==='ready'?'Local MCP ready · choose tools for each agent in its MCP tab.':state==='blocked'?'Local MCP configured · blocked by the server execution policy or working-folder configuration.':state==='disabled'?'Local MCP disabled · enable it in Settings → MCP when needed.':state==='conflict'?'Local MCP needs review in Settings → MCP.':'Local MCP package unavailable in this build.');}).catch(()=>{if(!disposed)setMcp('Local MCP could not be prepared.');});return()=>{disposed=true;};},[client,active]);
 const [channel,setChannel]=useState(''),[phase,setPhase]=useState('idle'),[notice,setNotice]=useState(''),[stuck,setStuck]=useState(false);
 const leaveTo=useRef<GenVRPlace|null>(null);
 const [projects,setProjects]=useState<Project[]>([]),[listing,setListing]=useState('loading'),[query,setQuery]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{
  if(!active||channel)return;let disposed=false;setListing('loading');
  void client.request({method:'GET',path:GENVR_PATH} as never).then(result=>{
   if(disposed)return;const body=result.body as {projects?:Project[]};if(result.status!==200||!Array.isArray(body?.projects)){setListing('error');return;}
   setProjects(body.projects);setListing('ready');
  }).catch(()=>{if(!disposed)setListing('error');});return()=>{disposed=true;};
 },[client,active,channel,retry]);
 const owner=client.getSnapshot?.().user?.role==='owner';
 const place=useRef<Place|null>(null),opened=useRef(''),turns=useRef(new Map<string,AbortController>()),sendRef=useRef<(value:Record<string,unknown>)=>void>(()=>{});
 const shown=useRef<{folder:string;answerer:string}>({folder:'',answerer:''});
 const [world,setWorld]=useState<Place|null>(null),[answerer,setAnswerer]=useState<Answerer|null>(null),[folder,setFolder]=useState('');
 const [agents,setAgents]=useState<(Who&{primary?:boolean})[]>([]),[picking,setPicking]=useState(false),[asking,setAsking]=useState<Asking|null>(null),[undo,setUndo]=useState<{count:number;text:string}|null>(null),[chatNote,setChatNote]=useState('');
 const showChat=useCallback((next:{folder?:string;answerer?:Answerer|null})=>{sendRef.current({operation:'chat-info',info:{...(next.folder?{folder:next.folder}:{}),...(next.answerer?{answerer:{name:next.answerer.name,detail:next.answerer.detail,color:next.answerer.color}}:{})}});},[]);
 const loadAgents=useCallback(async()=>{if(agents.length)return;try{const r=await client.request({method:'GET',path:'/api/agents'} as never);const rows=(r.body as {agents?:{id:string;name?:string;isPrimary?:boolean;description?:string}[]})?.agents;if(r.status===200&&Array.isArray(rows))setAgents(rows.filter(a=>genvrId(a.id)&&a.id!=='small-local-agent').map(a=>({id:a.id,name:a.name??a.id,primary:a.isPrimary===true,...(typeof a.description==='string'&&a.description.split(/[.\n]/)[0].trim().length<=64?{note:a.description.split(/[.\n]/)[0].trim()}:{})})));}catch{/* the picker stays closed */}},[client,agents.length]);
 async function chooseAgent(id:string){
  const world=place.current;const agentId=id||agents.find(a=>a.primary)?.id;if(!world||!agentId)return;
  try{const r=await client.request({method:'PUT',path:`/api/genvr/worlds/${world.projectId}/agent`,body:{agentId}} as never);const next=(r.body as {answerer?:Answerer})?.answerer;if(r.status!==200||!next)throw Error();shown.current.answerer=next.id;setAnswerer(next);showChat({folder,answerer:next});setChatNote('');}
  catch{setChatNote('Could not change who answers. Try again.');}
 }
 const [published,setPublished]=useState<Publication[]>([]);
 useEffect(()=>{if(!active||channel||client.getSnapshot().user?.role!=='owner')return;let disposed=false;void client.request({method:'GET',path:'/api/connections/genvr/publications'} as never).then(r=>{if(!disposed&&r.status===200)setPublished((r.body as {publications:Publication[]}).publications);}).catch(()=>{});return()=>{disposed=true;};},[client,active,channel,retry]);
 // GV1: with no space, the create page shows (the Studio no longer opens by itself).
 function open(id?:string,create?:CreateSpec,asLab=false){createSpec.current=create;openingLab.current=asLab;selection.current=undefined;opening.current=id;place.current=null;opened.current='';shown.current={folder:'',answerer:''};setWorld(null);setAnswerer(null);setFolder('');setAsking(null);setUndo(null);setChatNote('');setNotice('');setStuck(false);leaveTo.current=null;setPhase('loading');setChannel(crypto.randomUUID());}
 useEffect(()=>{
  if(!channel)return;let disposed=false;
  const send=(value:Record<string,unknown>)=>frame.current?.contentWindow?.postMessage({type:'dpro-genvr',channel,...value},window.location.origin);sendRef.current=send;
  // Board W1: the world that is open gets its folder and Girru project; the chat shows them and who answers.
  const openWorld=async(world:Place)=>{
   const key=world.projectId+'\u0000'+world.name;if(opened.current===key)return;opened.current=key;
   try{const r=await client.request({method:'POST',path:`/api/genvr/worlds/${world.projectId}/open`,body:{name:world.name}} as never);if(disposed)return;const b=r.body as {folder?:string;answerer?:Answerer|null};
    if(r.status!==200||typeof b?.folder!=='string')throw Error();shown.current={folder:b.folder,answerer:b.answerer?.id??''};setFolder(b.folder);setAnswerer(b.answerer??null);showChat({folder:b.folder,answerer:b.answerer??null});}
   catch{if(!disposed){opened.current='';setChatNote('This world’s folder could not be prepared. The chat still works without it.');}}
  };
  const finish=(id:string,value:{content:string;tool_calls:Call[]}|null,error?:string)=>{turns.current.delete(id);send(value?{operation:'model-result',id,ok:true,value}:{operation:'model-result',id,ok:false,error:error??'Girru could not answer.'});};
  // One turn of the Studio chat: answered by the world's agent; world changes wait for the owner.
  const model=async(id:string,value:unknown)=>{
   const world=place.current;
   if(!world||!owner){finish(id,null,'Open a world first.');return;}
   if(!validWorldTurn(value)){finish(id,null,'This conversation is too long or not readable. Start a new chat.');return;}
   const stop=new AbortController();turns.current.get(id)?.abort();turns.current.set(id,stop);
   try{
    const r=await client.request({method:'POST',path:`/api/genvr/worlds/${world.projectId}/turn`,body:value} as never,stop.signal);
    if(disposed||stop.signal.aborted)return;
    const b=r.body as {content?:string;tool_calls?:Call[];answerer?:Answerer;message?:string};
    if(r.status!==200||typeof b?.content!=='string'||!Array.isArray(b.tool_calls)){finish(id,null,typeof b?.message==='string'?b.message:'The agent could not answer. Try again or pick another agent.');return;}
    if(b.answerer&&b.answerer.id!==shown.current.answerer){shown.current.answerer=b.answerer.id;setAnswerer(b.answerer);showChat({folder:shown.current.folder,answerer:b.answerer});}
    if(b.content)send({operation:'model-delta',id,delta:b.content});
    const changing=b.tool_calls.filter(c=>changesWorld(c.function.name));
    if(!changing.length){finish(id,{content:b.content,tool_calls:b.tool_calls});return;}
    const allow=await new Promise<boolean>(decide=>{const end=()=>decide(false);stop.signal.addEventListener('abort',end,{once:true});setAsking({calls:changing,who:b.answerer?.name??'The agent',decide:yes=>{stop.signal.removeEventListener('abort',end);decide(yes);}});});
    setAsking(null);if(disposed||stop.signal.aborted)return;
    if(!allow){const extra=(b.content?'\n\n':'')+'Not now: I left the world as it is.';send({operation:'model-delta',id,delta:extra});finish(id,{content:b.content+extra,tool_calls:[]});return;}
    finish(id,{content:b.content,tool_calls:b.tool_calls});
    setUndo(last=>{const count=(last?.count??0)+changing.length;return {count,text:count===1?callLine(changing[0]):`${count} changes`};});
   }catch{if(!disposed&&!stop.signal.aborted)finish(id,null,'Girru could not reach the agent. Try again.');}
  };
  const receive=async(event:MessageEvent)=>{
   if(disposed||event.source!==frame.current?.contentWindow||event.origin!==window.location.origin||event.data?.type!=='dpro-genvr'||event.data.channel!==channel)return;
   const data=event.data;if(data.operation==='ready'){let privateLibrary:string|undefined;if(client.getSnapshot().user?.role==='owner'){try{const t=await client.request({method:'POST',path:STUDIO_TICKET_PATH,body:{}} as never);if(t.status===200)privateLibrary=(t.body as {ticket:string}).ticket;}catch{/* library stays off */}}if(disposed)return;send({operation:'start',projectId:opening.current,storageNamespace:client.getSnapshot().user?.id,privateLibrary,chat:owner,...(createSpec.current?{create:createSpec.current}:{}),...(openingLab.current?{lab:true}:{})});return;}if(data.operation==='mounted'){setPhase('ready');return;}
   if(data.operation==='unavailable'){setPhase('unavailable');return;}
   if(data.operation==='home'){const to=leaveTo.current;leaveTo.current=null;setChannel('');setPhase('idle');setStuck(false);setNotice('');setGenvrPlace(p=>to??(p==='lab'?'spaces':p));return;}
   if(data.operation==='closed'){if(data.ok){const to=leaveTo.current;leaveTo.current=null;setChannel('');setPhase('idle');setStuck(false);setGenvrPlace(p=>to??(p==='lab'?'spaces':p));}else{leaveTo.current=null;setNotice('The Studio could not save this space. Keep it open and try again, or close it without saving.');setStuck(true);}return;}
   if(data.operation==='context'){const world=owner?placeOf(data.context):null;if(!world)return;place.current=world;setWorld(world);void openWorld(world);return;}
   if(data.operation==='choose-answerer'){if(owner&&place.current){void loadAgents();setPicking(true);}return;}
   if(data.operation==='model'&&typeof data.id==='string'&&/^m\d{1,10}$/.test(data.id)){void model(data.id,data.value);return;}
   if(data.operation==='model-cancel'&&typeof data.id==='string'){turns.current.get(data.id)?.abort();turns.current.delete(data.id);setAsking(null);return;}
   if(typeof data.id!=='string'||!/^\d{1,10}$/.test(data.id))return;
   try{
    if(data.operation==='agents'&&!genvrId(data.value)){send({id:data.id,response:true,ok:true,value:[]});return;}
    if(data.operation==='agents'&&genvrId(data.value)){
     const [saved,roster]=await Promise.all([client.request({method:'GET',path:`${GENVR_PATH}/${data.value}`} as never),client.request({method:'GET',path:GENVR_AGENTS} as never)]);
     if(saved.status!==200||roster.status!==200)throw Error();
     const members=(saved.body as {agents:SpaceAgent[]}).agents,available=(roster.body as {agents:{id:string;name:string;avatar:number|null}[]}).agents;
     const rows=members.flatMap(member=>{const agent=available.find(a=>a.id===member.id);return agent?[{id:agent.id,name:agent.name,avatar:agent.avatar??member.avatar}]:[];});
     if(!disposed)send({id:data.id,response:true,ok:true,value:rows});return;
    }
    if(data.operation==='catalog-list'){
     const items:unknown[]=[],ids=new Set<string>();let after:string|null=null;
     for(let page=0;page<3;page++){const result=await client.request({method:'GET',path:'/api/genvr/market'+(after?'?after='+after:'')} as never);if(result.status!==200)throw Error();const body=result.body as {items:{manifest:{id:string}}[];next:string|null};for(const item of body.items)if(!ids.has(item.manifest.id)){ids.add(item.manifest.id);items.push(item);}if(!body.next||body.next===after)break;after=body.next;}
     if(!disposed)send({id:data.id,response:true,ok:true,value:items});return;
    }
    if(data.operation==='catalog-asset'&&typeof data.value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.value)&&!data.value.includes('..')){
     const result=await client.request({method:'GET',path:'/api/genvr/market/items/'+data.value} as never);if(result.status!==200)throw Error();if(!disposed)send({id:data.id,response:true,ok:true,value:(result.body as {asset:unknown}).asset});return;
    }
    const request=data.operation==='list'?{method:'GET',path:GENVR_PATH}:data.operation==='read'&&genvrId(data.value)?{method:'GET',path:`${GENVR_PATH}/${data.value}`}:
     data.operation==='write'&&validStudioProject(data.value)?{method:'PUT',path:`${GENVR_PATH}/${data.value.id}`,body:{project:data.value,revision:revisions.current.get(data.value.id)??0,...(selection.current?{agents:selection.current}:{})}}:null;
    if(!request){send({id:data.id,response:true,ok:false});return;}const result=await client.request(request as never);if(disposed)return;
    if(result.status!==200){send({id:data.id,response:true,ok:false,conflict:result.status===409});return;}
    const body=result.body as {projects?:unknown;project?:{id:string};revision?:number};
    if(data.operation==='read'&&body.project&&body.revision){revisions.current.set(body.project.id,body.revision);selection.current=undefined;}
    if(data.operation==='write'&&body.revision){revisions.current.set(data.value.id,body.revision);selection.current=undefined;}
    send({id:data.id,response:true,ok:true,value:data.operation==='list'?body.projects:data.operation==='read'?body.project:undefined});
   }catch{if(!disposed)send({id:data.id,response:true,ok:false});}
  };
  // Real application events: new pending approvals appear as Avatar Live notification cards.
  // Deciding stays in Girru (Approvals page, owner only); the card only points there.
  const seen=new Set<string>();let first=true;
  const approvals=client.getSnapshot().user?.role==='owner'?setInterval(()=>{void client.request({method:'GET',path:'/api/approvals?status=pending&limit=100'} as never).then(r=>{
   if(disposed||r.status!==200)return;const rows=(r.body as {approvals?:{id:string;toolName:string;agentId:string|null}[]}).approvals??[];
   for(const a of rows){if(seen.has(a.id))continue;seen.add(a.id);if(first)continue;send({operation:'notify',notification:{type:'approval',title:'Approval waiting',body:`${a.toolName} is waiting for your approval in Girru → Approvals.`,sourceId:a.id,needsApproval:true}});}
   first=false;
  }).catch(()=>{});},15000):undefined;
  window.addEventListener('message',receive);const timer=setTimeout(()=>{if(!disposed)setPhase(current=>current==='loading'?'slow':current);},20000);
  return()=>{disposed=true;clearTimeout(timer);if(approvals)clearInterval(approvals);window.removeEventListener('message',receive);for(const stop of turns.current.values())stop.abort();turns.current.clear();sendRef.current=()=>{};};
 },[client,channel]);
 const spaces=projects.filter(p=>!p.lab),lab=projects.find(p=>p.lab),inside=spaces.find(p=>p.id===insideId)??null;
 async function rename(id:string,title:string){const r=await client.request({method:'GET',path:`${GENVR_PATH}/${id}`} as never);const b=r.body as {project?:Record<string,unknown>;revision?:number};if(r.status!==200||!b.project||typeof b.revision!=='number')throw Error();const w=await client.request({method:'PUT',path:`${GENVR_PATH}/${id}`,body:{project:{...b.project,title},revision:b.revision}} as never);if(w.status!==200)throw Error();setProjects(list=>list.map(p=>p.id===id?{...p,title}:p));}
 /* GV1b sections: one place's settings are read and saved here; GV1c: the market list. */
 const store=useMemo<SpaceStore|null>(()=>!insideId?null:{
  load:async()=>{const r=await client.request({method:'GET',path:`${GENVR_PATH}/${insideId}`} as never);const b=r.body as {project?:Record<string,any>;revision?:number;agents?:{id:string;avatar:number}[]};if(r.status!==200||!b.project||typeof b.revision!=='number')throw Error();return {project:b.project,revision:b.revision,agents:Array.isArray(b.agents)?b.agents:[]};},
  save:async(project,revision,agents)=>{const w=await client.request({method:'PUT',path:`${GENVR_PATH}/${insideId}`,body:{project,revision,...(agents?{agents}:{})}} as never);if(w.status===409)throw Error('conflict');const next=(w.body as {revision?:number})?.revision;if(w.status!==200||typeof next!=='number')throw Error();revisions.current.set(insideId,next);return next;},
  roster:async()=>{const r=await client.request({method:'GET',path:GENVR_AGENTS} as never);const rows=(r.body as {agents?:{id:string;name:string;avatar:number|null}[]})?.agents;if(r.status!==200||!Array.isArray(rows))throw Error();return rows;},
 },[client,insideId]);
 const loadMarket=useCallback(async()=>{const items:MarketItem[]=[],ids=new Set<string>();let after:string|null=null;for(let page=0;page<3;page++){const r=await client.request({method:'GET',path:'/api/genvr/market'+(after?'?after='+after:'')} as never);if(r.status!==200)throw Error();const b=r.body as {items:MarketItem[];next:string|null};for(const item of b.items)if(!ids.has(item.manifest.id)){ids.add(item.manifest.id);items.push(item);}if(!b.next||b.next===after)break;after=b.next;}return items;},[client]);
 /** X and the sidebar always leave: a Studio that is not open yet has nothing to save. */
 const drop=()=>{const to=leaveTo.current;leaveTo.current=null;setStuck(false);setNotice('');setChannel('');setPhase('idle');setGenvrPlace(p=>to??(p==='lab'?'spaces':p));};
 const close=()=>{if(phase!=='ready'){drop();return;}setNotice('');setStuck(false);frame.current?.contentWindow?.postMessage({type:'dpro-genvr',channel,operation:'close'},window.location.origin);};
 const goPlace=(p:GenVRPlace)=>{setInsideId('');setCreating(false);if(channel&&p!=='lab'){leaveTo.current=p;close();return;}setGenvrPlace(p);if(p==='lab')open(lab?.id,undefined,true);};
 const studioTitle=world?.name??projects.find(p=>p.id===opening.current)?.title??createSpec.current?.title??'Studio';
 const nav=<GenVRSidebar place={genvrPlace} onPlace={goPlace} counts={{spaces:spaces.length,published:published.length}} inside={channel?null:inside} section={section} onSection={setSection} onBack={()=>setInsideId('')}/>;
 const mcpProblem=/could not|managed by/i.test(mcp);
 return <div className="genvr-page">{sidebarSlot&&active?createPortal(nav,sidebarSlot):null}
 {channel?<header className="genvr-toolbar genvr-toolbar-slim"><b>{studioTitle}</b><button type="button" className="tool" title="Save and close (⌘W)" aria-label="Save and close" onClick={close}><UiIcon name="close" size={15}/></button></header>:null}
 {mcpProblem&&<p className="fine-print" role="status">{mcp}</p>}
 {notice&&<p role="alert" className="genvr-row-line">{notice}{stuck&&channel?<button type="button" className="link-button" onClick={drop}>Close without saving</button>:null}</p>}
 {!channel?<section className="genvr-library" aria-label="GenVR">
 {listing==='loading'?<p role="status">Loading your spaces…</p>:listing==='error'?<div role="alert"><p>Your spaces could not be loaded.</p><button type="button" onClick={()=>setRetry(value=>value+1)}>Try again</button></div>
  :genvrPlace==='published'?<PublishedCards published={published}/>
  :genvrPlace==='market'?<GenVRMarket load={loadMarket} spaces={spaces} onAdd={id=>open(id)}/>
  :genvrPlace==='lab'?<p role="status">Opening the Motion lab…</p>
  :inside?<SpaceInside key={inside.id} space={inside} section={section} onOpen={()=>open(inside.id)} onRename={title=>rename(inside.id,title)}>{store&&section!=='basic'?<PlaceSection key={section} section={section} store={store} published={published.some(p=>p.title===inside.title)} onChanged={patch=>setProjects(list=>list.map(p=>p.id===inside.id?{...p,...patch}:p))}/>:null}</SpaceInside>
  :creating||spaces.length===0?<CreateSpace first={spaces.length===0} onCreate={spec=>{setCreating(false);open(undefined,spec);}}/>
  :<SpaceCards spaces={spaces} onInside={id=>{setSection('basic');setInsideId(id);}} onOpen={id=>open(id)} onNew={()=>setCreating(true)}/>}
 </section>:<>{phase==='loading'&&<p role="status">Opening GenVR Studio…</p>}{phase==='slow'&&<p role="status">The Studio is taking long to open. It is still trying; close it at the top to go back.</p>}{phase==='unavailable'&&<p role="alert">GenVR is unavailable in this build. Your saved spaces remain in your workspace.</p>}<div className="genvr-stage"><iframe key={channel} ref={frame} title="GenVR Studio" className="genvr-frame" src={`/genvr/studio.html#${channel}`} sandbox="allow-scripts allow-same-origin allow-downloads allow-pointer-lock"/>
 {asking&&<div className="genvr-ask" role="alertdialog" aria-labelledby="genvr-ask-title" aria-describedby="genvr-ask-body"><h3 id="genvr-ask-title">Changes the world</h3><p id="genvr-ask-body">{asking.who} wants to:</p><ul>{asking.calls.slice(0,8).map((call,i)=><li key={i}>{callLine(call)}</li>)}{asking.calls.length>8&&<li>and {asking.calls.length-8} more</li>}</ul>
  <div className="genvr-ask-actions"><button type="button" className="primary" autoFocus onClick={()=>asking.decide(true)}>Allow</button><button type="button" onClick={()=>asking.decide(false)}>Not now</button><span className="fine-print">You can undo after</span></div></div>}
 {undo&&!asking&&<div className="genvr-undo" role="status"><span>Changed the world · {undo.text}</span>{world&&(world.tab==='build'||world.tab==='items')?<button type="button" onClick={()=>{sendRef.current({operation:'undo',count:undo.count});setUndo(null);}}>Undo</button>:<span className="fine-print">Open Build to undo</span>}<button type="button" className="genvr-undo-close" aria-label="Dismiss" onClick={()=>setUndo(null)}>×</button></div>}
 </div>
 {owner&&world&&<div className="genvr-chatbar" aria-label="Chat in this world"><span className="fine-print">Answers here</span>{answerer?<WhoButton team={{id:'',name:agents.find(a=>a.primary)?.name??'Main agent'}} agents={agents} value={answerer.id} label={answerer.name} onChange={id=>void chooseAgent(id)} open={picking} setOpen={next=>{if(next)void loadAgents();setPicking(next);}}/>:<span className="fine-print">No agent yet</span>}
  {folder&&<span className="fine-print genvr-folder" title={folder}>{folder}</span>}{chatNote&&<span role="alert" className="fine-print">{chatNote}</span>}</div>}</>}
 </div>;
}
