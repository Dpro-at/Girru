import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {SessionClient} from './session';import {UiIcon} from './ui-icons';
import {allowedMarket} from './trading-market-contract.js';import {allowedPractice} from './trading-practice-contract.js';
import {allowedTradingPaper} from './trading-paper-contract.js';import {allowedTradingBot} from './trading-bot-contract.js';import {allowedTradingInstall} from './trading-install-contract.js';import {allowedTradingAccountSetup} from './trading-account-setup-contract.js';import {allowedTradingRuntime} from './trading-runtime-contract.js';
import {hostAppResponse} from './store-host-app-contract.js';
type State={installed:boolean;enabled:boolean;ready:boolean;needsRestart:boolean;clientHash:string|null};
type AppMount={unmount:()=>void};
const statusPath='/api/store/apps/trading/status';
/** Reviewed Store renderers run as trusted application code; the client adapter narrows accidental requests, not the JavaScript realm. */
export function StoreTradingView({client,active,sidebarSlot,onBack,onOpenStore,onPermissions}:{client:SessionClient;active:boolean;sidebarSlot?:HTMLElement|null;onBack:()=>void;onOpenStore:()=>void;onPermissions:()=>void}){
 const session=useSyncExternalStore(client.subscribe,client.getSnapshot,client.getSnapshot),[state,setState]=useState<State|null>(null),[notice,setNotice]=useState(''),[failed,setFailed]=useState(false),[statusError,setStatusError]=useState(false),lastHash=useRef<string|null>(null),[busy,setBusy]=useState(false),node=useRef<HTMLDivElement>(null);
 const back=useRef(onBack),permissions=useRef(onPermissions);back.current=onBack;permissions.current=onPermissions;
 useEffect(()=>{if(!active)return;let closed=false;const epoch=session.epoch,owner=session.user?.id;
  const read=async()=>{try{const r=await client.request({method:'GET',path:statusPath} as never);if(closed||client.getSnapshot().epoch!==epoch||client.getSnapshot().user?.id!==owner)return;const value=hostAppResponse(statusPath,r.status,r.body);if(r.status!==200)throw Error('unavailable');if(lastHash.current!==value.clientHash){lastHash.current=value.clientHash;setFailed(false);}setState(value);setStatusError(false);}catch{if(!closed)setStatusError(true);}};
  void read();const timer=setInterval(()=>void read(),5000);return()=>{closed=true;clearInterval(timer);};
 },[client,active,session.epoch,session.user?.id]);
 useEffect(()=>{if(failed||statusError||!active||!state?.installed||!state.enabled||!state.ready||state.needsRestart||!state.clientHash||!node.current)return;
  let closed=false,mounted:AppMount|null=null;const epoch=session.epoch,owner=session.user?.id;
  const current=()=>{const s=client.getSnapshot();return !closed&&s.phase==='authenticated'&&s.user?.role==='owner'&&s.user.id===owner&&s.epoch===epoch;};
  let source:ReturnType<SessionClient['getSnapshot']>|null=null,projected:unknown;
  const port=Object.freeze({getSnapshot:()=>{const s=client.getSnapshot();if(s!==source){source=s;projected=Object.freeze({phase:s.phase,mode:s.mode,epoch:s.epoch,user:s.user?Object.freeze({id:s.user.id,role:s.user.role}):null});}return projected;},subscribe:(fn:()=>void)=>client.subscribe(()=>fn()),request:async(r:{method:string;path:string;body?:unknown},signal?:AbortSignal)=>{
   if(!current()||![allowedMarket,allowedPractice,allowedTradingPaper,allowedTradingBot,allowedTradingInstall,allowedTradingAccountSetup,allowedTradingRuntime].some(allow=>allow(r.method,r.path,r.body)))throw Error('Trading request is outside its scope.');
   return client.request({method:r.method,path:r.path,...(r.body===undefined?{}:{body:r.body})} as never,signal);
  }});
  const css=document.createElement('link');css.rel='stylesheet';css.href='/store-apps/trading/client.css';document.head.append(css);
  const url='/store-apps/trading/client.js?v='+state.clientHash;
  void import(/* webpackIgnore: true */ url).then(module=>{if(!current()||!node.current)return;if(typeof module.mount!=='function')throw Error('Invalid renderer.');mounted=module.mount(node.current,{client:port,active:true,sidebarSlot,onBack:()=>back.current(),onPermissions:()=>permissions.current()});}).catch(()=>{if(!closed)setFailed(true);});
  return()=>{closed=true;mounted?.unmount();css.remove();};
 },[client,active,failed,statusError,sidebarSlot,session.epoch,session.user?.id,state?.installed,state?.enabled,state?.ready,state?.needsRestart,state?.clientHash]);
 async function enable(){if(busy)return;setBusy(true);try{const path='/api/store/apps/trading/activation',r=await client.request({method:'POST',path,body:{enabled:true}} as never);const value=hostAppResponse(path,r.status,r.body);if(r.status!==200)throw Error('unavailable');setNotice(value.restart==='auto'?'Girru is starting again.':'Restart Girru to finish.');setState(s=>s?{...s,enabled:true,needsRestart:true}:s);}catch{setNotice('Trading could not be turned on.');}finally{setBusy(false);}}
 const mounted=state?.installed&&state.enabled&&state.ready&&!state.needsRestart&&state.clientHash&&!failed&&!statusError;
 return mounted?<div ref={node} className="store-app-renderer"/>:<div className="apps-empty"><UiIcon name="chart" size={28}/><h3>{failed||statusError?'Trading is unavailable':!state?'Reading Trading…':!state.installed?'Get Trading':!state.enabled?'Trading is turned off':state.needsRestart?'Restart Girru to finish':'Add Trading again'}</h3><p>{notice||'Practice uses fictional money. Paper setup and automation keep their separate owner verification.'}</p>{state?.installed&&!state.enabled?<button className="primary" disabled={busy} onClick={()=>void enable()}>Turn on Trading</button>:<button className="primary" onClick={onOpenStore}>{state?.installed?'Open in Store':'Get Trading'}</button>}<button onClick={onBack}>Back to apps</button></div>;
}
