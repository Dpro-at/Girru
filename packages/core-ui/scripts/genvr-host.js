let mountStudio;
const channel=location.hash.slice(1),pending=new Map();let studio,sequence=0;
const send=value=>parent.postMessage({type:'dpro-genvr',channel,...value},location.origin);
function request(operation,value){const id=String(++sequence);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Studio storage did not respond. Keep this project open and retry saving.'));},30000);pending.set(id,{resolve,reject,timer});send({id,operation,value});});}
window.addEventListener('message',async event=>{
 if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='dpro-genvr'||event.data.channel!==channel)return;
 const data=event.data;
 if(data.response){const work=pending.get(data.id);if(!work)return;pending.delete(data.id);clearTimeout(work.timer);data.ok?work.resolve(data.value):work.reject(Error(data.conflict?'This project changed elsewhere. Export your edits before reopening it.':'Studio storage is unavailable. Keep this project open and retry saving.'));}
 if(data.operation==='start'&&!studio){
  try{
   if(typeof data.storageNamespace!=='string'||!data.storageNamespace)throw Error();
   await isolateBrowserCache(data.storageNamespace);
   const sdk=await import('/genvr/dist/studio.js');mountStudio=sdk.mountStudio;
   // GV1 B: Girru's create page made the choices; the package makes the space, Girru saves it, the Studio opens on it.
   let projectId=data.projectId;if(data.create)projectId=await createFromSpec(data.create);
   const host=await studioHost(typeof data.privateLibrary==='string'&&/^[a-f0-9]{64}$/.test(data.privateLibrary)?data.privateLibrary:null);
   // A space opens as it is: the example film is only for the Studio opened without a space (Mohamed, 2026-11-12).
   studio=mountStudio(document.getElementById('studio'),{filmExample:typeof projectId==='string'||data.lab===true?false:'/film-examples/island-languages.genvrfilm',forceWebGL:true,
    // Girru keeps the place list: My projects (after saving) goes back to it; Motion lab opens the lab itself.
    onHome:()=>send({operation:'home'}),desktopLayout:true,...(typeof data.placeItem==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.placeItem)&&typeof projectId==='string'?{placeItem:data.placeItem}:{}),...(data.lab===true&&typeof projectId!=='string'?{openLab:true}:{}),initialProjectId:projectId,...host,...(data.chat===true?hostChat():{}),agents:id=>request('agents',id),catalog:{list:()=>request('catalog-list'),asset:id=>request('catalog-asset',id)},storage:{list:()=>request('list'),read:id=>request('read',id),write:project=>request('write',project)}});
   send({operation:'mounted'});
  }catch{send({operation:'unavailable'});}
 }
 if(data.operation==='notify'&&studio&&data.notification&&typeof data.notification==='object'){
  // Through the authenticated loopback bridge, like a live MCP present_avatar call.
  const token=document.querySelector('meta[name="genvr-studio-token"]')?.content;const n=data.notification;
  if(token&&n.type==='approval'&&typeof n.title==='string'&&typeof n.body==='string')void fetch('/studio-bridge/call',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({tool:'present_avatar',arguments:{event:{kind:'notification',notification:{type:'approval',title:n.title.slice(0,200),body:n.body.slice(0,500),...(typeof n.sourceId==='string'?{sourceId:n.sourceId.slice(0,200)}:{}),needsApproval:true}}}})}).catch(()=>{});
 }
 // Board W1: Girru's own chat. The parent streams the answer, sends what the chat shows, and asks to undo
 // (the Studio's own Ctrl/Cmd+Z on the Build and Items tabs, sent from an element so its key handler reads it).
 if(data.operation==='model-delta'&&typeof data.id==='string'&&typeof data.delta==='string'&&data.delta.length<=65536){models.get(data.id)?.onDelta(data.delta);}
 if(data.operation==='chat-info'&&studio?.setChat&&data.info&&typeof data.info==='object'&&JSON.stringify(data.info).length<=1000000){try{studio.setChat(data.info);}catch{/* an older Studio without the chat option */}}
 if(data.operation==='undo'&&Number.isInteger(data.count)&&data.count>0&&data.count<=50){for(let i=0;i<data.count;i++)document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:!/Mac/.test(navigator.platform),metaKey:/Mac/.test(navigator.platform),bubbles:true,cancelable:true}));}
 if(data.operation==='close'){try{send({operation:'closed',ok:await studio?.dispose()===true});}catch{send({operation:'closed',ok:false});}}
});
send({operation:'ready'});

// Board W1: Girru answers the Studio chat. Tools still run in the Studio; Girru only gets the
// conversation and the tool list, and gives back text and tool calls.
const models=new Map(),MODEL_BYTES=2*1024*1024,MODEL_MS=10*60*1000;
const PLACE_TABS=['build','items','avatar','filming','lab'];
/** The folder button opens the folder only where Girru can show it (the desktop app). */
function canOpenFolder(){try{return typeof parent.dproApp?.revealFolder==='function';}catch{return false;}}
function hostChat(){
 return {
  onContext:context=>{if(!context||typeof context!=='object'||typeof context.projectId!=='string'||typeof context.name!=='string')return;send({operation:'context',context:{projectId:context.projectId.slice(0,100),name:context.name.slice(0,200),tab:PLACE_TABS.includes(context.tab)?context.tab:'build',look:String(context.look??'').slice(0,40),kind:String(context.kind??'').slice(0,40)}});},
  // GV1e: the Studio chat is the place's Girru chat: Open in Chat goes to Girru Chat; earlier lines come with chat-info.
  chat:{chooseAnswerer:()=>send({operation:'choose-answerer'}),openChat:()=>send({operation:'open-chat'}),...(window.parent&&canOpenFolder()?{openFolder:()=>send({operation:'open-folder'})}:{})},
  model:(messages,onDelta,signal,_onQueue,tools)=>new Promise((resolve,reject)=>{
   const value={messages,tools:Array.isArray(tools)?tools:[]};let text;try{text=JSON.stringify(value);}catch{reject(Error('This conversation cannot be sent to Girru.'));return;}
   if(text.length>MODEL_BYTES){reject(Error('This conversation is too long for Girru. Start a new chat.'));return;}
   const id='m'+(++sequence);
   const finish=()=>{models.delete(id);clearTimeout(timer);signal?.removeEventListener('abort',abort);};
   const abort=()=>{finish();send({operation:'model-cancel',id});reject(Object.assign(Error('Stopped.'),{name:'AbortError'}));};
   const timer=setTimeout(()=>{finish();send({operation:'model-cancel',id});reject(Error('Girru did not answer in time. Try again.'));},MODEL_MS);
   if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
   models.set(id,{onDelta:delta=>{try{onDelta(delta);}catch{}},resolve:result=>{finish();resolve(result);},reject:error=>{finish();reject(error);}});
   send({id,operation:'model',value:JSON.parse(text)});
  }),
 };
}
// The final answer of a model request: {content, tool_calls}, checked before the Studio sees it.
window.addEventListener('message',event=>{
 if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='dpro-genvr'||event.data.channel!==channel||event.data.operation!=='model-result')return;
 const data=event.data,work=typeof data.id==='string'?models.get(data.id):undefined;if(!work)return;
 if(!data.ok){work.reject(Error(typeof data.error==='string'?data.error.slice(0,300):'Girru could not answer.'));return;}
 const v=data.value;const calls=Array.isArray(v?.tool_calls)?v.tool_calls:[];
 if(!v||typeof v.content!=='string'||v.content.length>200000||calls.length>20||!calls.every(c=>c&&typeof c==='object'&&c.function&&typeof c.function.name==='string'&&/^[a-z_]{1,64}$/.test(c.function.name))){work.reject(Error('Girru sent an answer the Studio cannot read.'));return;}
 work.resolve({content:v.content,tool_calls:calls.map(c=>({function:{name:c.function.name,arguments:c.function.arguments&&typeof c.function.arguments==='object'&&!Array.isArray(c.function.arguments)?c.function.arguments:{}}}))});
});

// Adapt the SDK's platform exit link to this local host without navigating away.
document.addEventListener('click',event=>{
 const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;
 if(!anchor)return;const target=new URL(anchor.href,location.origin);
 if(target.origin===location.origin&&/^\/places\/[a-zA-Z0-9_-]+$/.test(target.pathname)){
  event.preventDefault();event.stopPropagation();void (async()=>{try{send({operation:'closed',ok:await studio?.dispose()===true});}catch{send({operation:'closed',ok:false});}})();
 }
},true);

// Studio film/media caches stay in this frame's account namespace. Project
// snapshots use the authenticated host storage above, never this browser cache.
async function isolateBrowserCache(account){
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(account));
 const prefix='dpro-genvr-'+Array.from(new Uint8Array(digest)).map(n=>n.toString(16).padStart(2,'0')).join('')+':';
 const factory=window.indexedDB;
 const scoped=new Proxy(factory,{get(target,key){
  if(key==='open')return(name,version)=>version===undefined?target.open(prefix+name):target.open(prefix+name,version);
  if(key==='deleteDatabase')return name=>target.deleteDatabase(prefix+name);
  if(key==='databases')return async()=> (await target.databases()).filter(row=>row.name?.startsWith(prefix)).map(row=>({...row,name:row.name.slice(prefix.length)}));
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 Object.defineProperty(window,'indexedDB',{value:scoped});
 const store=window.localStorage;
 Object.defineProperty(window,'localStorage',{value:new Proxy(store,{get(target,key){
  if(key==='getItem')return name=>target.getItem(prefix+name);
  if(key==='setItem')return(name,value)=>target.setItem(prefix+name,value);
  if(key==='removeItem')return name=>target.removeItem(prefix+name);
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }})});
}

// Compatibility for the frozen SDK until the reviewed host API version is consumed.

// Live bridge (live MCP + local voice) and, for the owner, the private library.
// The token is injected into this frame's shell by the local application server.
async function studioHost(ticket){
 const token=document.querySelector('meta[name="genvr-studio-token"]')?.content;
 if(!token||!/^[a-f0-9]{64}$/.test(token))return {};
 const call=async(route,body,raw)=>{const r=await fetch('/studio-library/'+route,{method:'POST',headers:{Authorization:'Bearer '+token,'X-Studio-Library':ticket,'Content-Type':'application/json'},body:JSON.stringify(body??{})});if(!r.ok){let m='Library request failed.';try{m=(await r.json()).error||m;}catch{}throw Error(m);}return raw?r.arrayBuffer():r.json();};
 const options={liveBridge:{url:location.origin,token}};
 if(!ticket)return options;
 const listeners=new Set(),changed=()=>{for(const l of listeners)try{l();}catch{}};
 options.userLibrary={scope:'dpro-owner',storage:{
  list:async()=>(await call('list')).assets,
  get:async id=>{const all=(await call('list')).assets;const metadata=all.find(a=>a.id===id);if(!metadata)return null;return {metadata,data:await call('get',{id},true)};},
  put:async asset=>{const meta=btoa(unescape(encodeURIComponent(JSON.stringify(asset.metadata)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');const r=await fetch('/studio-library/put',{method:'POST',headers:{Authorization:'Bearer '+token,'X-Studio-Library':ticket,'Content-Type':'application/octet-stream','X-Library-Metadata':meta},body:asset.data});if(!r.ok){let m='Saving the library item failed.';try{m=(await r.json()).error||m;}catch{}throw Error(m);}changed();},
  remove:async id=>{await call('remove',{id});changed();},
  assignment:async(projectId,target)=>(await call('assignment',{projectId,target})).assetId,
  assign:async(projectId,target,assetId)=>{await call('assign',{projectId,target,assetId});changed();},
  subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
  close(){listeners.clear();},
 }};
 try{const {motions}=await call('motions');if(motions.length)options.motionLibrary={entries:motions.map(m=>({id:m.id,name:m.name,category:m.category,loop:m.loop,load:()=>call('motion',{id:m.id},true)}))};}catch{/* no private motion library on this computer */}
 return options;
}

const CREATE_STYLES=['realistic','blocky','anime','voxel'],CREATE_SIZES=['small','medium','large','huge','max'],CREATE_DEVICES=['phone','tablet','computer','tv','vr'];
/** GV1 B: a new private space from the create page: empty land of the chosen size, look and play settings. */
async function createFromSpec(spec){
 if(!spec||typeof spec!=='object'||typeof spec.title!=='string'||!spec.title.trim()||spec.title.length>120||!CREATE_STYLES.includes(spec.style)||!CREATE_SIZES.includes(spec.sizeTier)||!['free','side'].includes(spec.view)||!['landscape','portrait','any'].includes(spec.orientation)||!Array.isArray(spec.devices)||!spec.devices.length||!spec.devices.every(d=>CREATE_DEVICES.includes(d)))throw Error('create');
 const {createStudioProject,readStudioProject}=await import('/genvr/dist/studio-project.js');
 const play={orientation:spec.orientation,view:spec.view,moves:[],devices:CREATE_DEVICES.filter(d=>spec.devices.includes(d))};
 const made=createStudioProject(spec.style,'empty',play);
 const project=readStudioProject({...made,title:spec.title.trim(),world:{...made.world,sizeTier:spec.sizeTier}});
 await request('write',project);
 return project.id;
}
