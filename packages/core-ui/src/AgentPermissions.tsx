import {useEffect,useState,useSyncExternalStore} from 'react';
import {TOOL_GROUPS,toolGroup} from './agent-card';
import type {AgentCardController,PartDone,Permissions} from './agent-card';
import {permissionCategories} from './hire-contract.js';
import type {Connector} from './connectors-contract.js';
import {Sheet} from './desktop-ui';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';

export const ACTIONS:Record<string,{label:string;icon:UiIconName}>={browser:{label:'Use the browser',icon:'globe'},network:{label:'Reach the internet',icon:'wifi'},message:{label:'Send messages',icon:'send'},delete:{label:'Delete things',icon:'trash'},install:{label:'Install software',icon:'download'},money:{label:'Spend money',icon:'coin'},settings:{label:'Change settings',icon:'gear'}};
const MODES=[['off','Never'],['ask','Ask me'],['allow','Allow']] as const;
type Before={p?:Pick<Permissions,'memoryRead'|'memoryWrite'|'sharedMemory'|'modes'>;g?:readonly string[]};
const snapshot=(card:AgentCardController):Before=>{const s=card.getSnapshot();return {p:s.permissions&&structuredClone({memoryRead:s.permissions.memoryRead,memoryWrite:s.permissions.memoryWrite,sharedMemory:s.permissions.sharedMemory,modes:s.permissions.modes}),g:s.grants&&[...s.grants.granted]};};

/**
 * Saves a permission change at once (expected versions, kept tool limits).
 * Allowing money, installs or deleting asks once; the answer is sent as confirmRisky.
 */
export function usePermissionSave(card:AgentCardController,onDone:PartDone){
 const [asking,setAsking]=useState<{text:string;before:Before;categories:string[]}|null>(null);
 async function save(text:string,before:Before,confirmed:boolean){
  const risky=card.newlyRisky();
  if(risky.length&&!confirmed){setAsking({text,before,categories:risky});return;}
  await card.savePermissions(card.riskyAllowed());
  if(card.getSnapshot().saved==='Permissions saved.')onDone(text,()=>commit(()=>card.restorePermissions(before.p,before.g),'Change undone'));
 }
 function commit(edit:()=>void,text:string){
  const s=card.getSnapshot();if(s.phase==='saving'||!s.permissionDraft||!s.grants)return;
  const before=snapshot(card);edit();if(!card.permissionsChanged())return;void save(text,before,false);
 }
 const ask=asking&&<Sheet title="Let it do this without asking?" onClose={()=>{card.discardPermissions();setAsking(null);}} actions={<><button type="button" onClick={()=>{card.discardPermissions();setAsking(null);}}>Cancel</button><button type="button" className="primary" onClick={()=>{const a=asking;setAsking(null);void save(a.text,a.before,true);}}>Allow</button></>}>
  <p>{asking.categories.map(c=>ACTIONS[c]?.label??c).join(', ')} will run without asking you first. You can set it back to “Ask me” at any time.</p></Sheet>;
 return {commit,ask};
}

/** MC3: what the agent may do (three choices per action) and which connection tools it may use. */
export function AgentPermissions({card,onDone,onOpenMcp}:{card:AgentCardController;onDone:PartDone;onOpenMcp?:()=>void}){
 const s=useSyncExternalStore(card.subscribe,card.getSnapshot,card.getSnapshot);
 const {commit,ask}=usePermissionSave(card,onDone);
 const [servers,setServers]=useState<Connector[]|null>(null),[failed,setFailed]=useState(false),[open,setOpen]=useState<string|null>(null),[retry,setRetry]=useState(0);
 useEffect(()=>{let live=true;setFailed(false);void card.client.request({method:'GET',path:'/api/mcp/servers'} as never).then(r=>{if(!live)return;if(r.status!==200)throw Error();setServers((r.body as {servers:Connector[]}).servers);}).catch(()=>{if(live)setFailed(true);});return()=>{live=false;};},[card,retry]);
 const d=s.permissionDraft,g=s.grants,gd=s.grantDraft??[];
 if(!d||!g)return s.notice?<div className="ag-part"><p role="status">{s.notice}</p><button type="button" onClick={()=>void card.reloadPermissions()}>Read again</button></div>:<p className="ag-muted" role="status">Reading permissions…</p>;
 const busy=s.phase==='saving',reserved=s.agentId==='small-local-agent';
 const builtIn=g.available.filter(t=>!t.name.startsWith('mcp__'));
 return <div className="ag-part ag-perms">
  {s.notice&&<p className="ag-alert" role="alert">{s.notice} <button type="button" className="link-button" onClick={()=>void card.reloadPermissions()}>Load latest</button></p>}
  <section aria-label="What it may do" className="ag-perm-col"><h3>What it may do</h3>
   {permissionCategories.map(c=><div key={c} className="ag-action"><UiIcon name={ACTIONS[c]?.icon??'tool'} size={15}/><span>{ACTIONS[c]?.label??c}</span>
    <span className="dk-segmented" role="radiogroup" aria-label={ACTIONS[c]?.label??c}>{MODES.map(([m,label])=><button type="button" key={m} role="radio" aria-checked={d.modes[c]===m} aria-pressed={d.modes[c]===m} disabled={busy} onClick={()=>commit(()=>card.setMode(c,m),`${ACTIONS[c]?.label??c}: ${label}`)}>{label}</button>)}</span></div>)}
   <small className="ag-muted">“Ask me” sends a request to Approvals each time.</small>
  </section>
  <section aria-label="Connections and tools" className="ag-perm-col"><div className="ag-head-row"><h3>Connections it may use</h3>{onOpenMcp&&<button type="button" className="link-button" onClick={onOpenMcp}>MCP connections</button>}</div>
   {failed?<p role="status">Connections could not be read. <button type="button" className="link-button" onClick={()=>setRetry(n=>n+1)}>Try again</button></p>:!servers?<p className="ag-muted" role="status">Loading connections…</p>:!servers.length?<p className="ag-muted">No connections yet. Add one in MCP connections.</p>:
   servers.map(server=>{const prefix=`mcp__${server.name}__`,tools=g.available.filter(t=>t.name.startsWith(prefix)),usable=tools.filter(t=>t.allowedByServer),on=tools.filter(t=>gd.includes(t.name)),state=!on.length?0:on.length>=usable.length?1:.5;
    return <div key={server.id} className="ag-server"><div className="ag-server-head"><span className="ag-letter" aria-hidden="true">{server.name.slice(0,1).toUpperCase()}</span>
     <button type="button" className="ag-server-name" aria-expanded={open===server.id} disabled={!tools.length} onClick={()=>setOpen(o=>o===server.id?null:server.id)}><span>{server.name}</span><small>{!usable.length?(server.enabled?'no tools found yet':'off · turn it on in MCP connections'):state===1?`all ${usable.length} tools`:state===0?'off':`${on.length} of ${usable.length} tools`}{server.sources?.length?` · from ${[...new Set(server.sources.map(x=>x.origin))].join(', ')}`:''}</small></button>
     <button type="button" role="switch" className="ag-switch" data-state={state===.5?'some':undefined} aria-checked={state===1?true:state===0?false:'mixed'} aria-label={`${server.name} for this agent`} disabled={busy||reserved||(!usable.length&&!on.length)} onClick={()=>commit(()=>card.setTools(tools.map(t=>t.name),state!==1),`${server.name} turned ${state===1?'off':'on'}`)}><i/></button></div>
     {open===server.id&&<div className="ag-chips">{tools.map(t=><label key={t.name} className="ag-chip" data-on={gd.includes(t.name)||undefined} title={t.description}><input type="checkbox" checked={gd.includes(t.name)} disabled={busy||reserved||(!t.allowedByServer&&!gd.includes(t.name))} onChange={()=>commit(()=>card.toggleTool(t.name),`${t.name.slice(prefix.length)} ${gd.includes(t.name)?'off':'on'}`)}/>{t.name.slice(prefix.length)}{t.requiresApproval&&<small>asks first</small>}</label>)}</div>}
    </div>;})}
   <small className="ag-muted">New or changed tools stay off until you turn them on here.</small>
  </section>
  <details className="ag-details ag-wide"><summary>Built-in tools <small>{builtIn.filter(t=>gd.includes(t.name)).length} of {builtIn.length} on</small></summary>
   {TOOL_GROUPS.filter(x=>x!=='Connectors').map(group=>{const tools=builtIn.filter(t=>toolGroup(t.name)===group);if(!tools.length)return null;const on=tools.filter(t=>gd.includes(t.name)).length;
    return <div key={group} className="tool-group"><div className="tool-group-head"><span className="tool-group-name">{group}</span><span className="fine-print">{on} of {tools.length} on</span><button type="button" className="ghost-action" disabled={busy} onClick={()=>commit(()=>card.setTools(tools.map(t=>t.name),on<tools.length),`${group}: ${on<tools.length?'all on':'all off'}`)}>{on<tools.length?'Turn all on':'Turn all off'}</button></div>
     <div className="ag-chips">{tools.map(t=><label key={t.name} className="ag-chip" data-on={gd.includes(t.name)||undefined} title={t.description}><input type="checkbox" checked={gd.includes(t.name)} disabled={busy||(!t.allowedByServer&&!gd.includes(t.name))} onChange={()=>commit(()=>card.toggleTool(t.name),`${t.name} ${gd.includes(t.name)?'off':'on'}`)}/><code>{t.name}</code>{t.requiresApproval&&<small>asks first</small>}{!t.allowedByServer&&<small>off on this server</small>}</label>)}</div></div>;})}
  </details>
  {ask}
 </div>;
}
