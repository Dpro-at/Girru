import {DocumentEditor} from './DocumentEditor';
import {UiIcon,type UiIconName} from './ui-icons';
import {ServiceLogo,serviceMark} from './ServiceLogo';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SessionClient } from './session';
import type { ChannelEntry } from './agent-connect-contract.js';
import { AGENT_CONNECT_PATH } from './agent-connect-contract.js';

// Channels with no bundled brand mark get a plain glyph from the app's own icon set, never a letter.
const CHANNEL_GLYPHS:Readonly<Record<string,UiIconName>>={a2a:'users',api_server:'server',email:'inbox',sms:'phone',webhook:'link',msgraph_webhook:'link',relay:'wifi',irc:'terminal'};
export function channelGlyph(id:string):UiIconName{return Object.prototype.hasOwnProperty.call(CHANNEL_GLYPHS,id)?CHANNEL_GLYPHS[id]:'message';}
/** A channel's brand mark, or its glyph. */
export function ChannelMark({id,size}:{id:string;size:number}){return serviceMark(id)?<ServiceLogo id={id} size={size}/>:<UiIcon name={channelGlyph(id)} size={size}/>;}

export function ChannelCatalogSelect({ channels, selected, busy, onSelect }: { channels: readonly ChannelEntry[]; selected: string; busy: boolean; onSelect: (id: string) => void }) {
  return <label className="field"><span>Integration ({channels.length})</span><select aria-label="Agent Connect integration" value={selected} disabled={busy} onChange={e => onSelect(e.target.value)}><option value="">Choose an integration</option>{channels.map(c => <option key={c.id} value={c.id}>{c.label}{c.configured ? ' · configured' : ''}</option>)}</select></label>;
}

export function AgentConnectSettings({ client,onOpenStore }: { client: SessionClient;onOpenStore?:()=>void }) {
  const owner = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).user?.role === 'owner';
  const [app,setApp]=useState<{installed:boolean;ready:boolean}|null>(null);
  const [channels, setChannels] = useState<ChannelEntry[]>([]), [selected, select] = useState('');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [configurable, setConfigurable] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [users, setUsers] = useState(''), [conversations, setConversations] = useState('');
  const [environment, setEnvironment] = useState<Record<string, string>>({}), [extraEnv, setExtraEnv] = useState(''), [settings, setSettings] = useState('');
  const [query,setQuery]=useState('');
  const [editor,setEditor]=useState<'environment'|'settings'|null>(null);
  const current = channels.find(c => c.id === selected);
  useEffect(() => {
    if (!owner) return; let disposed = false;
    void client.request({ method: 'GET', path: `${AGENT_CONNECT_PATH}/catalog` } as never).then(r => {
      if (disposed) return; const body = r.body as { channels?: ChannelEntry[]; configurable?: boolean;app?:{installed:boolean;ready:boolean} };
      if (r.status !== 200 || !Array.isArray(body?.channels)) { setPhase('error'); return; }
      setApp(body.app??null);setChannels(body.channels); setConfigurable(body.configurable === true); setPhase('ready');
    }).catch(() => { if (!disposed) setPhase('error'); });
    return () => { disposed = true; };
  }, [client, owner]);
  useEffect(() => {
    setUsers(current?.allowedUsers.join(', ') ?? ''); setConversations(current?.allowedChannels.join(', ') ?? '');
    setEnvironment({}); setExtraEnv(''); setSettings(''); setNotice('');setEditor(null);
  }, [selected]);
  async function save() {
    if (!current || busy) return;
    let body: Record<string, unknown>;
    try {
      const additional = extraEnv.trim() ? JSON.parse(extraEnv) : {};
      if (!additional || typeof additional !== 'object' || Array.isArray(additional)) throw Error();
      body = { allowedUsers: users.split(',').map(x => x.trim()).filter(Boolean), allowedChannels: conversations.split(',').map(x => x.trim()).filter(Boolean),
        environment: { ...additional, ...Object.fromEntries(Object.entries(environment).filter(([,v]) => v !== '')) },
        ...(settings.trim() ? { settings: JSON.parse(settings) } : {}) };
    } catch { setNotice('Check the JSON fields. Use an object of provider settings or variables.'); return; }
    setBusy(true); setNotice('');
    try {
      const r = await client.request({ method: 'PUT', path: `${AGENT_CONNECT_PATH}/${current.id}/config`, body } as never);
      const result = r.body as { saved?: boolean; channel?: Partial<ChannelEntry> };
      if (r.status !== 200 || !result?.saved || !result.channel) { setNotice('Not saved. Check required credentials, trusted IDs and provider-specific settings.'); return; }
      setChannels(items => items.map(c => c.id === current.id ? { ...c, ...result.channel } : c));
      setEnvironment({}); setExtraEnv(''); setSettings(''); setNotice('Configuration saved. No provider connection was started.');
    } catch { setNotice('Save could not be confirmed. Reload settings before trying again.'); }
    finally { setBusy(false); }
  }
  async function activate(channel: ChannelEntry) {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      const r = await client.request({ method: 'PUT', path: `${AGENT_CONNECT_PATH}/${channel.id}/activation`, body: { enabled: !channel.enabled } } as never);
      const result = r.body as { saved?: boolean; channel?: Partial<ChannelEntry> };
      if (r.status !== 200 || !result.saved || !result.channel) { setNotice('Activation could not be saved. Configure the channel first.'); return; }
      setChannels(items => items.map(c => c.id === channel.id ? { ...c, ...result.channel } : c));
      setNotice(result.channel.enabled ? 'Channel enabled. Connection status will update automatically; restart the application if requested.' : 'Channel disabled. Other channels stay unchanged.');
    } catch { setNotice('Activation could not be confirmed. Check the channel status before retrying.'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!owner) return;
    let disposed = false;
    const timer = setInterval(() => {
      void client.request({ method: 'GET', path: `${AGENT_CONNECT_PATH}/catalog` } as never).then(r => {
        const body = r.body as { channels?: ChannelEntry[];configurable?:boolean;app?:{installed:boolean;ready:boolean} };
        if (!disposed && r.status === 200 && Array.isArray(body?.channels)){setChannels(body.channels);setApp(body.app??null);setConfigurable(body.configurable===true);}
      }).catch(() => {});
    }, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [client, owner]);
  if (!owner) return null;
  if(phase==='ready'&&app&&!app.ready)return <section aria-label="Channels" className="channels-settings apps-channels"><div className="channel-no-selection"><UiIcon name="message" size={28}/><h3>{app.installed?'Restart Girru to finish':'Add Agent Connect'}</h3><p>{app.installed?'Your channel settings are kept. Restart Girru to load the app.':'Your messaging channels come from Agent Connect. Your existing settings and history are kept.'}</p>{onOpenStore&&<button className="primary" onClick={onOpenStore}>{app.installed?'Open in Store':'Get Agent Connect'}</button>}</div></section>;
  const line = (c: ChannelEntry) => !c.configured ? 'Not set up' : c.state === 'restart_required' ? 'Restart Girru to finish' : c.enabled ? 'On' : 'Off · set up';
  // The live connection, only while a channel is on (the old header showed it too).
  const liveWords: Record<string, string> = { connected: 'Connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', error: 'Connection error', disconnected: 'Disconnected' };
  const liveState = (c: ChannelEntry) => c.enabled && liveWords[c.state as string] ? ` · ${liveWords[c.state as string]}` : '';
  const dotState = (c: ChannelEntry) => c.enabled ? 'ready' : c.configured ? 'warn' : 'off';
  const keyDone = !!current && (current.hasSecrets || !current.requiredEnv.length), whoDone = !!current && (current.allowedUsers.length > 0 || current.allowedChannels.length > 0);
  return <section aria-label="Channels" className="channels-settings apps-channels"><div className="channel-workspace"><div className="channel-service-list"><p className="apps-help">Where your agents can be reached.</p><label className="channel-service-search"><UiIcon name="search" size={14}/><input type="search" aria-label="Find messaging service" placeholder="Find a service" value={query} onChange={e=>setQuery(e.target.value)}/></label>{phase==='loading'?<p role="status">Reading services…</p>:phase==='error'?<p role="alert">Services could not be loaded. Open Channels again to retry.</p>:<div role="listbox" aria-label="Messaging services">{channels.filter(c=>c.label.toLowerCase().includes(query.toLowerCase())).map(c=><button type="button" role="option" aria-selected={selected===c.id} disabled={busy} key={c.id} onClick={()=>select(c.id)}><span className="channel-tile" aria-hidden="true"><ChannelMark id={c.id} size={17}/></span><span><strong>{c.label}</strong><small>{c.runtime==='node'?'Ready in Agent Connect':'Needs Python'}</small></span><span className="st-state" data-state={dotState(c)}><i aria-hidden="true"/>{line(c)}</span></button>)}</div>}</div><div className="channel-detail-pane"><div className="channel-select-fallback"><ChannelCatalogSelect channels={channels} selected={selected} busy={busy} onSelect={select}/></div>
 {notice&&<p role="status" className="preference-notice">{notice}</p>}{!configurable&&phase==='ready'&&<p role="status">Channels can only be set up in a SQLite workspace.</p>}
 {current?<form className="channel-configuration" aria-label={`${current.label} configuration`} onSubmit={e=>{e.preventDefault();void save();}}><header className="channel-service-head"><span className="channel-tile" aria-hidden="true"><ChannelMark id={current.id} size={22}/></span><div><h3>{current.label}</h3><p>{line(current)}{liveState(current)}{current.configured?'':` · set up ${[keyDone,whoDone].filter(Boolean).length} of 3`}</p></div><button type="button" className={current.enabled?undefined:'primary'} title={`${current.enabled?'Turn off':'Turn on'} ${current.label}`} aria-label={`${current.enabled?'Disable':'Enable'} ${current.label}`} disabled={busy||!configurable||(!current.configured&&!current.enabled)} onClick={()=>void activate(current)}><UiIcon name="power" size={15}/>{current.enabled?'Turn off':'Turn on'}</button></header>
 <ol className="channel-steps">
  <li data-done={keyDone||undefined}><p className="channel-step-title"><span>{keyDone?'✓':1}</span>{current.requiredEnv.length>1?'Keys':'Key'}</p>{current.requiredEnv.length?current.requiredEnv.map(key=><label className="channel-field" key={key}><span>{key}</span><input type="password" autoComplete="off" aria-label={key} maxLength={16384} value={environment[key]??''} placeholder={current.hasSecrets?'Saved · locked. Paste a new one to replace it.':'Paste the key from the service'} onChange={e=>setEnvironment(values=>({...values,[key]:e.target.value}))}/></label>):<p className="fine-print">This service needs no key here; its settings are under Advanced.</p>}<small className="fine-print">Saved keys stay hidden. Saving does not start a connection.</small></li>
  <li data-done={whoDone||undefined}><p className="channel-step-title"><span>{whoDone?'✓':2}</span>Who may write</p><label className="channel-field"><span>People (their ids)</span><input aria-label="Trusted sender IDs" value={users} maxLength={20000} onChange={e=>setUsers(e.target.value)}/></label><label className="channel-field"><span>Chats or groups (their ids)</span><input aria-label="Permitted conversation IDs" value={conversations} maxLength={20000} onChange={e=>setConversations(e.target.value)}/><small>Separate ids with commas. Only these may reach your agents.</small></label></li>
  <li data-done={current.enabled||undefined}><p className="channel-step-title"><span>{current.enabled?'✓':3}</span>Automatic replies</p><p className="fine-print">{current.enabled?'On. The main agent answers there.':'Off. Turn on to let the main agent answer there.'}</p></li>
 </ol>
 <details className="preference-help channel-advanced"><summary>Advanced: extra provider settings (JSON)</summary><div className="channel-document-row"><div><strong>Extra provider variables</strong><small>{extraEnv.trim()?'Draft entered':'Saved values stay hidden'}</small></div><button type="button" disabled={busy} onClick={()=>setEditor('environment')}><UiIcon name="pencil" size={14}/>Edit</button></div>{current.runtime==='python'&&<div className="channel-document-row"><div><strong>Provider settings</strong><small>{settings.trim()?'Draft entered':'JSON object'}</small></div><button type="button" disabled={busy} onClick={()=>setEditor('settings')}><UiIcon name="pencil" size={14}/>Edit</button></div>}<p>{current.prerequisites}</p><p>Provider setup guide: Agent Connect repository / docs/CHANNELS.md.</p><p>Runtime executables, program paths and interpreter variables cannot be set here. Delivery with real accounts has not been checked in this preview.</p></details>
 <footer className="channel-savebar"><span>New channels start with automatic replies off. Sending still follows each agent's permissions.</span><button type="submit" disabled={busy||!configurable}><UiIcon name="check" size={14}/>{busy?'Saving…':'Save'}</button></footer></form>:<div className="channel-no-selection"><UiIcon name="message" size={28}/><h3>Select a messaging service</h3><p>Choose a service to set up its key and who may write.</p></div>}
 </div></div>{editor&&<DocumentEditor title={editor==='environment'?'Extra provider variables':'Provider settings'} files={[{id:editor,name:editor==='environment'?'variables.json':'settings.json',content:editor==='environment'?extraEnv:settings}]} maxLength={32768} onChange={(_,text)=>editor==='environment'?setExtraEnv(text):setSettings(text)} onClose={()=>setEditor(null)}/>}</section>;
}
