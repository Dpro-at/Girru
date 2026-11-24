import {PreferenceGroup,PreferenceRow} from './Preferences';
import {UiIcon} from './ui-icons';
import {useEffect,useState} from 'react';
import type {SessionClient} from './session';
import {ClaudeCodeIcon,CodexIcon,GeminiIcon} from './brand-icons';
import {PluginsSheet,pluginsLine,useCodingAppPlugins} from './AppsAddons';
import type {CodingApp} from './AppsAddons';
import {useSetupTerminal} from './FirstRunSetup';
import type {AiTool} from './FirstRunSetup';
const APPS=[{id:'subscription:claude',name:'Claude Code',plugins:'claude-code' as CodingApp,Icon:ClaudeCodeIcon,signIn:'Run claude in your terminal to sign in'},{id:'subscription:codex',name:'Codex',plugins:'codex' as CodingApp,Icon:CodexIcon,signIn:'Run codex login in your terminal to sign in'},{id:'subscription:gemini',name:'Google Gemini',plugins:null,Icon:GeminiIcon,signIn:'Antigravity CLI · run agy in your terminal to sign in'}] as const;
/**
 * Each coding app: installed here? signed in? (the same check as first-run setup, /api/first-run/tools).
 * Install and Sign in type a fixed command into Girru's terminal on this page; the row turns ready by itself.
 * Each coding app's plugins open in a sheet (board AP1).
 */
export function ReplyAppsSettings({client,onOpenChat,onOpenStore}:{client:SessionClient;onOpenChat?:()=>void;onOpenStore?:(app:CodingApp)=>void}){
 const [apps,setApps]=useState<string[]|null>(null),[error,setError]=useState(false),[refresh,setRefresh]=useState(0),[sheet,setSheet]=useState<CodingApp|null>(null),plugins=useCodingAppPlugins(client);
 const [tools,setTools]=useState<AiTool[]|null>(null),terminal=useSetupTerminal(client);
 const readTools=()=>client.request({method:'GET',path:'/api/first-run/tools'} as never).then(r=>{if(r.status===200&&Array.isArray((r.body as {tools?:unknown}).tools))setTools((r.body as {tools:AiTool[]}).tools);}).catch(()=>{});
 useEffect(()=>{void readTools();},[client,refresh]);
 // While the terminal is open, look again every few seconds: a row turns ready by itself after install or sign-in.
 useEffect(()=>{if(!terminal.open)return;const t=setInterval(()=>{void readTools();},3000);return()=>clearInterval(t);},[terminal.open]);
 useEffect(()=>{let stopped=false;setError(false);void client.request({method:'GET',path:'/api/models'} as never).then(r=>{if(stopped)return;const b=r.body as {models?:{id:string;provider:string}[]};if(r.status!==200||!Array.isArray(b.models)){setError(true);return;}setApps(b.models.filter(x=>x.provider==='subscription').map(x=>x.id));}).catch(()=>{if(!stopped)setError(true);});return()=>{stopped=true;};},[client,refresh]);
 return <PreferenceGroup title="Coding apps that can answer in Chat" note="Ready means the app is installed here and signed in. Install and Sign in run in Girru's terminal on this page.">{APPS.map(({id,name,plugins:app,Icon,signIn})=>{
   const tool=tools?.find(t=>'subscription:'+t.id===id),line=app&&plugins?pluginsLine(plugins,app):'';
   const ready=tool?tool.installed:!!apps?.includes(id),checking=!tool&&apps===null&&!error;
   const state=tool?(tool.signedIn?'ready':tool.installed?'checking':'off'):error?'error':checking?'checking':ready?'ready':'off';
   const label=tool?(tool.signedIn?'Ready':tool.installed?'Not signed in':'Not on this computer'):error?'Could not check':checking?'Checking…':ready?'Ready':'Not on this computer';
   const note=tool?(tool.signedIn?'Installed · signed in':tool.installed?'Installed · sign in to use it in Chat':tool.needs==='node'?'Not installed · needs Node.js first':tool.install?'Not installed':signIn):ready?'Signs in from your terminal':signIn;
   const action=tool&&!tool.signedIn?(tool.installed?<button type="button" onClick={()=>terminal.type(name,tool.signIn)}>Sign in</button>:tool.install?<button type="button" onClick={()=>terminal.type(name,tool.install!)}><UiIcon name="download" size={13}/>Install</button>:null):null;
   return <div className="preference-row" key={id}><span className="preference-icon"><Icon size={18}/></span><div className="preference-label"><strong>{name}</strong><small>{note}{line&&app&&<> · <button type="button" className="link-button" onClick={()=>onOpenStore?onOpenStore(app):setSheet(app)}>{line}</button></>}</small></div>{action}<span className="preference-status st-state" data-state={state}><i aria-hidden="true"/>{label}</span></div>;})}
  {terminal.pane}
  <PreferenceRow title="Reply source" description="Choose the app used for a conversation in Chat." icon="message"><button type="button" className="tool" title="Refresh coding app availability" aria-label="Refresh coding app availability" onClick={()=>{setApps(null);setTools(null);setRefresh(n=>n+1);}}><UiIcon name="refresh" size={14}/></button>{onOpenChat&&<button type="button" onClick={onOpenChat}>Open Chat</button>}</PreferenceRow>
  {sheet&&plugins&&<PluginsSheet app={sheet} items={plugins} onClose={()=>setSheet(null)}/>}</PreferenceGroup>;
}
