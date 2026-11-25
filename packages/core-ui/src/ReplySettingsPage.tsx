import {useEffect,useState} from 'react';
import {ClaudeCodeIcon,CodexIcon,GeminiIcon,LmStudioIcon,OllamaIcon} from './brand-icons';
import {PluginsSheet,pluginsLine,useCodingAppPlugins} from './AppsAddons';
import type {CodingApp} from './AppsAddons';
import type {AiTool} from './FirstRunSetup';
import {UiIcon} from './ui-icons';
import {modelDisplayName} from './model-names';
import {primaryReplyModels,savePrimaryReply,type PrimaryAgent,type ReplyModel} from './primary-reply';
import type {SessionClient} from './session';

const APPS=[
 {id:'subscription:claude',tool:'claude',name:'Claude Code',description:'Use your existing Claude account.',plugins:'claude-code' as CodingApp,Icon:ClaudeCodeIcon},
 {id:'subscription:codex',tool:'codex',name:'Codex',description:'Use your existing ChatGPT account.',plugins:'codex' as CodingApp,Icon:CodexIcon},
 {id:'subscription:gemini',tool:'gemini',name:'Google Gemini',description:'Install the official Gemini command-line app.',plugins:null,Icon:GeminiIcon},
] as const;

/** Settings-only reply engine page. First-run keeps its own shorter onboarding flow. */
export function ReplySettingsPage({client,onOpenStore,onOpenTerminal}:{client:SessionClient;onOpenStore?:(app:CodingApp)=>void;onOpenTerminal?:()=>void}){
 const [agent,setAgent]=useState<PrimaryAgent|null>(null),[models,setModels]=useState<ReplyModel[]>([]),[tools,setTools]=useState<AiTool[]|null>(null),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[toolBusy,setToolBusy]=useState(false),[notice,setNotice]=useState(''),[refresh,setRefresh]=useState(0),[sheet,setSheet]=useState<CodingApp|null>(null),[localProvider,setLocalProvider]=useState<'ollama'|'lmstudio'>('ollama'),plugins=useCodingAppPlugins(client);
 useEffect(()=>{let stopped=false;setNotice('');void Promise.all([
  client.request({method:'GET',path:'/api/agents'} as never),client.request({method:'GET',path:'/api/models'} as never),client.request({method:'GET',path:'/api/first-run/tools'} as never),
 ]).then(([a,m,t])=>{if(stopped)return;const ab=a.body as {agents?:PrimaryAgent[]},mb=m.body as {models?:ReplyModel[]},tb=t.body as {tools?:AiTool[]};if(a.status!==200||m.status!==200)throw Error();setAgent(ab.agents?.find(x=>x.isPrimary)??null);setModels(primaryReplyModels(mb.models??[]));setTools(t.status===200&&Array.isArray(tb.tools)?tb.tools:[]);setLoaded(true);}).catch(()=>{if(!stopped){setLoaded(true);setNotice('Could not read every reply engine. Try again.');}});return()=>{stopped=true;};},[client,refresh]);
 const choose=async(chosen:string)=>{if(!agent||busy||chosen===agent.model||!models.some(m=>m.id===chosen))return;setBusy(true);setNotice('');try{setAgent(await savePrimaryReply(client,agent,models,chosen));setNotice('Primary reply engine saved. Existing chats keep their own choice.');}catch{setNotice('Could not save. Refresh the page and try again.');}finally{setBusy(false);}};
 const current=agent?.model??'',currentName=models.find(m=>m.id===current)?.label??(modelDisplayName(current)||'Not selected');
 const local=models.filter(m=>m.provider==='local'||m.provider==='ollama'||m.provider==='lmstudio');
 const localForProvider=local.filter(m=>localProvider==='lmstudio'?m.provider==='lmstudio':m.provider==='local'||m.provider==='ollama');
 const stateFor=(id:string)=>{const tool=tools?.find(t=>'subscription:'+t.id===id);return {tool,ready:!!tool?.signedIn,installed:!!tool?.installed};};
 const readyApps=APPS.filter(a=>stateFor(a.id).ready),missingApps=APPS.filter(a=>!stateFor(a.id).ready);
 const changeTool=async(action:'install'|'uninstall')=>{const verb=action==='install'?'Install Google Gemini on this computer?':'Remove Google Gemini from this computer?';if(!window.confirm(verb))return;setToolBusy(true);setNotice('');try{const r=await client.request({method:action==='install'?'POST':'DELETE',path:'/api/first-run/tools/gemini',body:{confirm:true}} as never);if(r.status!==200)throw Error();setNotice(action==='install'?'Google Gemini installed. Sign in to finish.':'Google Gemini removed.');setRefresh(n=>n+1);}catch{setNotice(action==='install'?'Google Gemini could not be installed. Check that Node.js or Homebrew is available.':'Google Gemini could not be removed.');}finally{setToolBusy(false);}};
 const openLocalProvider=()=>{const bridge=window.dproApp?.openLocalModelProvider;if(bridge)void bridge(localProvider);else onOpenTerminal?.();};
 return <div className="reply-settings-page">
  <section className="reply-primary" aria-label="Primary reply engine">
   <div className="reply-primary-copy"><span className="reply-primary-mark"><UiIcon name="sparkle" size={20}/></span><div><h3>Primary reply engine</h3><p>Answers you first and coordinates the other agents. A chat or agent can still use its own engine.</p></div></div>
   <div className="reply-primary-choice"><div><strong>{currentName}</strong><small>{agent?.name??'Main agent'} uses this by default</small></div><select aria-label="Primary reply engine" value={current} disabled={!agent||busy||!loaded} onChange={e=>void choose(e.target.value)}>{!models.some(m=>m.id===current)&&<option value={current}>{currentName}</option>}{models.map(m=><option key={m.id} value={m.id}>{m.label??m.name??m.id}</option>)}</select></div>
   {notice&&<p className="reply-notice" role="status">{notice}</p>}
  </section>

  <section className="reply-section" aria-label="Cloud coding apps"><div className="reply-section-head"><div><h3>Cloud coding apps</h3><p>Use an existing account. Choose the primary reply engine only from the selector above.</p></div><button className="tool" type="button" aria-label="Refresh reply engines" title="Refresh" onClick={()=>setRefresh(n=>n+1)}><UiIcon name="refresh" size={14}/></button></div>
   <div className="reply-engine-list">{readyApps.map(({id,name,description,plugins:app,Icon})=>{const line=app&&plugins?pluginsLine(plugins,app):'',s=stateFor(id);return <div className="reply-engine" key={id}><span className="reply-engine-icon"><Icon size={20}/></span><div className="reply-engine-copy"><strong>{name}</strong><small>{description}{line&&app&&<> · <button className="link-button" type="button" onClick={()=>onOpenStore?onOpenStore(app):setSheet(app)}>{line}</button></>}</small></div><span className="st-state" data-state="ready"><i aria-hidden="true"/>Ready</span>{id==='subscription:gemini'&&s.tool?.removable&&<button type="button" className="danger" disabled={toolBusy} onClick={()=>void changeTool('uninstall')}>Uninstall</button>}</div>;})}
   {missingApps.map(({id,name,description,Icon})=>{const s=stateFor(id),gemini=id==='subscription:gemini';return <div className="reply-engine" key={id}><span className="reply-engine-icon"><Icon size={20}/></span><div className="reply-engine-copy"><strong>{name}</strong><small>{s.installed?'Installed · sign in to finish':description}</small></div><span className="st-state" data-state={s.installed?'warn':'off'}><i aria-hidden="true"/>{s.installed?'Sign in needed':'Not installed'}</span><button type="button" disabled={toolBusy} onClick={gemini&&!s.installed?()=>void changeTool('install'):onOpenTerminal}><UiIcon name={gemini&&!s.installed?'download':'terminal'} size={13}/>{gemini&&!s.installed?'Install':s.installed?'Sign in':'Open Terminal'}</button>{gemini&&s.installed&&s.tool?.removable&&<button type="button" className="danger" disabled={toolBusy} onClick={()=>void changeTool('uninstall')}>Uninstall</button>}</div>;})}</div>
  </section>

  <section className="reply-section" aria-label="Local models"><div className="reply-section-head"><div><h3>Local models</h3><p>Private models that run on this computer. Choose a provider, then manage its models.</p></div></div>
   <div className="reply-provider-row"><div className="reply-provider-picker" role="group" aria-label="Local model provider"><button type="button" aria-pressed={localProvider==='ollama'} onClick={()=>setLocalProvider('ollama')}><OllamaIcon size={17}/>Ollama</button><button type="button" aria-pressed={localProvider==='lmstudio'} onClick={()=>setLocalProvider('lmstudio')}><LmStudioIcon size={17}/>LM Studio</button></div></div>
   <div className="reply-engine-list">{localForProvider.map(m=>{const ProviderIcon=localProvider==='lmstudio'?LmStudioIcon:OllamaIcon;return <div className="reply-engine" key={m.id}><span className="reply-engine-icon"><ProviderIcon size={20}/></span><div className="reply-engine-copy"><strong>{m.label??m.name??m.id}</strong><small>{localProvider==='lmstudio'?'LM Studio':'Ollama'} · installed on this computer</small></div><span className="st-state" data-state="ready"><i aria-hidden="true"/>Ready</span></div>;})}
   {loaded&&!localForProvider.length&&<div className="reply-empty">{localProvider==='lmstudio'?<LmStudioIcon size={20}/>:<OllamaIcon size={20}/>}<span>No {localProvider==='lmstudio'?'LM Studio':'Ollama'} chat models found.</span></div>}
   <div className="reply-engine"><span className="reply-engine-icon">{localProvider==='lmstudio'?<LmStudioIcon size={20}/>:<OllamaIcon size={20}/>}</span><div className="reply-engine-copy"><strong>Manage {localProvider==='lmstudio'?'LM Studio':'Ollama'} models</strong><small>Install or remove models in the provider app, then refresh this page.</small></div><button type="button" onClick={openLocalProvider}><UiIcon name="open" size={13}/>Open {localProvider==='lmstudio'?'LM Studio':'Ollama'}</button></div></div>
  </section>

  {sheet&&plugins&&<PluginsSheet app={sheet} items={plugins} onClose={()=>setSheet(null)}/>}
 </div>;
}
