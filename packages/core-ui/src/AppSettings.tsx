import {VoiceSettings} from './VoiceSettings';
import {FooterSettings} from './FooterSettings';
import {ChatNoticeSettings} from './ChatNoticeSettings';
import {PrimaryReplySettings} from './PrimaryReplySettings';
import {WorkspacePackSettings} from './WorkspacePackSettings';
import {ScheduledTasks} from './ScheduledTasks';
import {PreferenceGroup,PreferenceRow} from './Preferences';
import {AccountSettings} from './SettingsAccount';
import {ReplyAppsSettings} from './ReplyAppsSettings';
import {SavedKeys} from './SavedKeys';
import {AgentPermissionsGrid} from './AgentPermissionsGrid';
import {PermissionsSettings,VerificationSettings as SignInAndReviewers} from './SecuritySettings';
import {ReviewerPoliciesSettings} from './ReviewerPoliciesSettings';
import {ConnectionsSettings} from './ConnectionsSettings';
import {AgentConnectSettings} from './AgentConnectSettings';
import {UpdateSettings} from './UpdateSettings';
import {DepartmentsSettings} from './DepartmentsSettings';
import {SpecialtyUpdates} from './SpecialtyUpdates';
import {SettingsBackups} from './SettingsBackups';
import {AppUpdateSettings,appUpdateBridge} from './AppUpdateSettings';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionClient } from './session';
import { useAppInfo } from './app-navigation';
import type { ThemePreference } from './app-navigation';
import { MemorySettings, MEMORY_PANES } from './MemorySettings';
import type { MemorySettingsPane } from './MemorySettings';
import { UiIcon } from './ui-icons';
import { McpSection } from './ToolSections';
import type { UiIconName } from './ui-icons';
/** Places that are sections of their own; their Settings rows open them. MCP connections stays in Settings with its places nested, like Memory. */
type Tool='mcp'|'library';
type Place='voice'|'general'|'account'|'replies'|'move'|'permissions'|'verification'|'approval-rules'|'keys'|'accounts'|'channels'|'memory'|'schedules'|'departments'|'apps'|Tool|'backups'|'about';
/** Old names ('models', 'sharing', 'connections') still open their places. */
export type SettingsTab=Place|'models'|'sharing'|'connections';
type Row={value:Place;label:string;icon:UiIconName;words:string;note?:string;jump?:boolean};
// Search finds settings inside the pages, not only page names.
const ROWS:Record<Place,Row>={
 voice:{value:'voice',label:'Voice',icon:'speaker',words:'voice speech audio generate clone saved voices microphone text to speech local models main agent',note:'Your voice library, speech models and Main Agent voice.'},
 general:{value:'general',label:'General',icon:'sun',words:'theme appearance light dark system footer sections icons language english notifications notify done',note:'Appearance, the footer and notifications. Changes save by themselves.'},
 account:{value:'account',label:'Account',icon:'contact',words:'two-step sign-in authenticator recovery codes password sign out everywhere devices sessions email role',note:'Your identity, two-step sign-in and the devices signed in.'},
 replies:{value:'replies',label:'Models and replies',icon:'cpu',words:'models tools main agent primary model ollama local coding apps claude code codex gemini antigravity answer chat reply source',note:'Choose where your agents get their replies.'},
 move:{value:'move',label:'Share settings',icon:'archive',words:'move another computer export import file agents personalities specialties skills bring in take',note:'Move your general setup to another installation using a file. Keys, accounts, conversations, memories and private project files are excluded.'},
 permissions:{value:'permissions',label:'Permissions',icon:'sliders',words:'what agents may do actions tools memory allow ask never browser internet messages delete install money coverage',note:'What each agent may do, use and remember.'},
 verification:{value:'verification',label:'Verification',icon:'check',words:'sign-in methods password passkeys reviewers who can authorize two-person',note:'Sign-in methods and review responsibilities.'},
 'approval-rules':{value:'approval-rules',label:'Approval rules',icon:'shield',words:'rules people must agree quorum activate withdraw',note:'When several people must agree before an action runs.'},
 keys:{value:'keys',label:'Saved keys',icon:'key',words:'secrets tokens passwords key store older chats',note:'Keys you pasted in chats, kept encrypted on this computer.'},
 accounts:{value:'accounts',label:'Accounts',icon:'contact',words:'connections accounts genvr world account connect disconnect test publication',note:'Accounts connected to this workspace.'},
 channels:{value:'channels',label:'Channels',icon:'message',words:'messaging services telegram discord whatsapp trusted senders conversations automatic replies',note:'Messaging services and trusted senders.'},
 mcp:{value:'mcp',label:'MCP connections',icon:'tool',words:'mcp connections connectors tools servers add import coding apps genvr-local',note:'Tools your agents reach through MCP servers.'},
 memory:{value:'memory',label:'Memory',icon:'database',words:MEMORY_PANES.map(p=>p.label).join(' ')+' memory rules sources access',note:'Memory rules, sources and access.'},
 schedules:{value:'schedules',label:'Scheduled tasks',icon:'clock',words:'schedules cron run now pause permission code recent runs',note:'Workspace schedules and recent outcomes.'},
 departments:{value:'departments',label:'Departments',icon:'building',words:'departments teams groups rename move agents new department',note:'The departments of your agents.'},
 apps:{value:'apps',label:'My apps',icon:'layers',words:'applications my apps store add-ons catalogue private',jump:true},
 library:{value:'library',label:'Library',icon:'book',words:'personalities specialties skills library',jump:true},
 backups:{value:'backups',label:'Backups',icon:'shield',words:'backup back up restore daily copy save data folder keep undo',note:'Your data, saved every day by itself.'},
 about:{value:'about',label:'About and updates',icon:'info',words:'version updates check connection installation log folder',note:'Version and installation details.'},
};
/**
 * Settings: one window with every place of the old Settings again, grouped
 * Application / Security / Connections / Workspace / About. Accounts, Channels,
 * MCP connections and Departments live only here. MCP connections, like Memory,
 * shows its places nested under its row. Places that are their own section
 * (Apps, Library) are jump rows that open it.
 * Permissions, Verification and Approval rules show the same components as Approvals.
 * In the signed-in window the places are the sidebar (the shell gives a slot;
 * Memory has its own sub-places); without a slot (signed out, tests) the same
 * places sit on the left of the page.
 */
export function AppSettings({ onOpenStore, signedIn, preference, onTheme, onAccount, onAgents, client, aboutOnly = false, initialTab = 'general', initialMemoryPane = 'rules', sidebarSlot, active = true, onOpenMemory, onOpenChat, onOpenApps, onOpenTool, onOpenGenvr, onApprovals, onBoard, onAgent, mcpOpenId }: { onOpenStore?: (local: 'claude-code' | 'codex') => void; signedIn: boolean; preference: ThemePreference; onTheme: (v: ThemePreference) => void; onAccount: () => void; onAgents?: () => void; client?: SessionClient; aboutOnly?: boolean; initialTab?: SettingsTab; initialMemoryPane?: MemorySettingsPane; sidebarSlot?: HTMLElement | null; active?: boolean; onOpenMemory?: () => void; onOpenChat?: () => void; onOpenApps?: () => void; onOpenTool?: (tool: Tool) => void; onOpenGenvr?: () => void; onApprovals?: () => void; onBoard?: () => void; onAgent?: (id: string) => void; mcpOpenId?: string }) {
  const named=(t:SettingsTab):Place=>t==='models'?'replies':t==='sharing'?'move':t==='connections'?'accounts':t;
  const [query,setQuery]=useState('');const search=useRef<HTMLInputElement>(null);
  const info=useAppInfo();const [tab,setTab]=useState<Place>(named(initialTab));
  const [pane,setPane]=useState<MemorySettingsPane>(initialMemoryPane);
  const [permAgent,setPermAgent]=useState<string|undefined>();
  const [mcpNav,setMcpNav]=useState<HTMLDivElement|null>(null);
  const [contentUpdates,setContentUpdates]=useState(false);
  useEffect(()=>{setTab(named(initialTab));},[initialTab]);useEffect(()=>{setPane(initialMemoryPane);},[initialMemoryPane]);
  const user=signedIn?client?.getSnapshot().user:undefined,owner=user?.role==='owner',live=signedIn&&!!client;
  const ownerOnly=(keys:Place[])=>owner?keys:[];
  const groups:{name:string;keys:Place[]}[]=live?[
    {name:'Application',keys:['general','account','replies',...ownerOnly(['voice','move'])]},
    {name:'Security',keys:[...ownerOnly(['permissions']),...(user?.role!=='guest'?['verification' as const]:[]),...ownerOnly(['approval-rules']),'keys']},
    {name:'Connections',keys:ownerOnly(['accounts','channels',...(client?['mcp' as const]:[]),'memory'])},
    {name:'Workspace',keys:[...ownerOnly(['departments','schedules']),...(onOpenApps?['apps' as const]:[]),...(onOpenTool?ownerOnly(['library']):[])]},
    {name:'',keys:[...ownerOnly(['backups']),'about']},
  ]:[{name:'Application',keys:['general','account','replies']},{name:'',keys:['about']}];
  const allowed=groups.flatMap(g=>g.keys);
  const active_:Place=aboutOnly?'about':allowed.includes(tab)?tab:'general';
  const q=query.trim().toLowerCase(),found=(p:Row)=>!q||`${p.label} ${p.words}`.toLowerCase().includes(q);
  const choose=(value:Place)=>{if(value==='apps'){onOpenApps?.();return;}if(value==='library'){onOpenTool?.(value);return;}setTab(value);};
  // ⌘F searches inside settings while this window is open.
  useEffect(()=>{if(!active||aboutOnly)return;const onKey=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='f'&&!document.querySelector('dialog[open]')&&!e.defaultPrevented){e.preventDefault();search.current?.focus();}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[active,aboutOnly]);
  const sidebar=<nav className="dk-sidebar settings-sidebar" aria-label="Settings sections">
    <div className="dk-side-top"><label className="dk-search"><UiIcon name="search" size={13}/><input ref={search} type="search" aria-label="Search settings" placeholder="Search settings" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Escape')setQuery('');}}/></label></div>
    {groups.map(group=>{const rows=group.keys.map(k=>ROWS[k]).filter(found);return rows.length?<div key={group.name||'end'} className="settings-nav-group">{group.name&&<p className="section-label dk-label">{group.name}</p>}{rows.map(t=><div key={t.value} className="dk-group"><button type="button" className="nav-item dk-place" title={t.jump?`Open ${t.label}`:undefined} aria-current={active_===t.value?'page':undefined} aria-expanded={t.value==='memory'||t.value==='mcp'?active_===t.value:undefined} onClick={()=>choose(t.value)}><UiIcon name={t.icon} size={15}/><span className="dk-place-name">{t.label}</span>{t.jump&&<UiIcon name="chevron" size={11}/>}</button>{t.value==='memory'&&active_==='memory'&&MEMORY_PANES.map(p=><button key={p.key} type="button" className="nav-item dk-place" data-nested aria-current={pane===p.key?'page':undefined} onClick={()=>setPane(p.key)}><span className="dk-place-name">{p.label}</span></button>)}{t.value==='mcp'&&active_==='mcp'&&<div ref={setMcpNav} className="mcp-settings-nav"/>}</div>)}</div>:null;})}
    {q&&!groups.some(g=>g.keys.some(k=>found(ROWS[k])))&&<p className="settings-search-empty">No setting matches “{query.trim()}”.</p>}
    {!signedIn&&<div className="settings-signin-note"><p>Sign in to see your account, keys and workspace settings.</p><button type="button" onClick={onAccount}>Sign in</button></div>}
  </nav>;
  const label=aboutOnly?'About Girru':active_==='memory'?`Memory · ${MEMORY_PANES.find(p=>p.key===pane)?.label??'Settings'}`:ROWS[active_].label;
  const ownTitle=active_==='schedules'||active_==='memory'||active_==='mcp'||active_==='backups';
  const signIn=(title:string,description:string)=><PreferenceGroup title={title}><PreferenceRow title="Sign in required" description={description} icon="contact"><button type="button" onClick={onAccount}>Sign in</button></PreferenceRow></PreferenceGroup>;
  const page=<div id="settings-view-panel" aria-label={label} className="settings-content settings-st" data-pane={active_}><div className="preferences-page">
      {!ownTitle&&<header className="settings-page-head"><h2 className="settings-page-title">{label}</h2>{ROWS[active_].note&&<p className="settings-page-desc">{ROWS[active_].note}</p>}</header>}
      {active_==='general'&&<>
        <PreferenceGroup title="Appearance"><div className="preference-row settings-theme-row"><div className="preference-label"><strong>Theme</strong><small>Use your device appearance or choose a theme. The sun and moon in the title bar switch it too.</small></div>
          <div className="settings-themes" role="radiogroup" aria-label="Theme">{(['system','light','dark'] as const).map(v=><label key={v} className="settings-theme" data-theme-choice={v}><input type="radio" name="app-theme" value={v} checked={preference===v} onChange={()=>onTheme(v)} aria-label={v==='system'?'System':v==='light'?'Light':'Dark'}/><span className="settings-theme-picture" aria-hidden="true"/><span>{v==='system'?'System':v==='light'?'Light':'Dark'}</span></label>)}</div></div></PreferenceGroup>
        {live&&<FooterSettings client={client!}/>}
        {live&&<ChatNoticeSettings client={client!}/>}
        <PreferenceGroup title="Language"><PreferenceRow title="Program language" description="More languages come later."><span className="preference-status">English</span></PreferenceRow></PreferenceGroup>
      </>}
      {active_==='account'&&(live?<AccountSettings client={client!}/>:signIn('Account','Connect to your workspace to manage your account.'))}
      {active_==='replies'&&<>
        <PreferenceGroup title="Agent replies"><PreferenceRow title="Model for each agent" description="Select an agent to choose its model and provider." icon="cpu"><button type="button" onClick={live&&onAgents?onAgents:onAccount}>{live?'Choose agent…':'Sign in'}</button></PreferenceRow></PreferenceGroup>
        {live&&owner&&<><PrimaryReplySettings client={client!} onAgents={onAgents}/><ReplyAppsSettings client={client!} onOpenChat={onOpenChat} onOpenStore={onOpenStore}/></>}
      </>}
      {active_==='move'&&owner&&<WorkspacePackSettings client={client!}/>}
      {active_==='voice'&&owner&&<VoiceSettings client={client!}/>}
      {active_==='permissions'&&owner&&<>
        <AgentPermissionsGrid client={client!} active={active} onAgent={id=>setPermAgent(id)}/>
        <h3 className="settings-sub-title">One agent's tools and memory</h3>
        <PermissionsSettings client={client!} parts={['tools','memory']} agentId={permAgent} onApprovals={onApprovals??(()=>{})} onAccount={()=>setTab('account')} onAgent={onAgent}/>
      </>}
      {active_==='verification'&&live&&<SignInAndReviewers client={client!} onApprovals={onApprovals??(()=>{})} onBoard={onBoard??(()=>{})} onAgent={onAgent??(()=>onAgents?.())} onAccount={()=>setTab('account')}/>}
      {active_==='approval-rules'&&owner&&<ReviewerPoliciesSettings client={client!} onAccount={()=>setTab('account')}/>}
      {active_==='keys'&&live&&<SavedKeys client={client!} owner={owner} page/>}
      {active_==='accounts'&&owner&&<ConnectionsSettings client={client!} onOpenGenvr={onOpenGenvr}/>}
      {active_==='departments'&&owner&&<DepartmentsSettings client={client!} onAgent={onAgent}/>}
      {active_==='channels'&&owner&&<AgentConnectSettings client={client!}/>}
      {active_==='memory'&&owner&&<MemorySettings client={client!} pane={pane} onOpenMemory={onOpenMemory}/>}
      {active_==='mcp'&&owner&&<McpSection client={client!} active={active} nav={mcpNav} openId={mcpOpenId} onOpenAgents={onAgents}/>}
      {active_==='schedules'&&owner&&<ScheduledTasks client={client!} active={active} onOpenConnections={()=>setTab('channels')}/>}
      {active_==='backups'&&owner&&<SettingsBackups client={client!} active={active}/>}
      {active_==='about'&&<>
        <div className="settings-about-head"><span className="settings-about-mark" aria-hidden="true">G</span><div><strong>Girru</strong><small>Version {info?.version??'development preview'} · {info?(info.connection==='local'?'runs on this computer':'connected installation'):'local browser preview'}</small></div></div>
        {owner&&appUpdateBridge()?<AppUpdateSettings bridge={appUpdateBridge()!}/>:live&&owner?<UpdateSettings client={client!}/>:<PreferenceGroup title="Updates"><PreferenceRow title="Manual updates" description="Automatic updates are not available in this build. Install a new version by hand." icon="refresh"><span className="preference-status">Not available</span></PreferenceRow></PreferenceGroup>}
        {live&&owner&&<PreferenceGroup title="Skills and specialties"><PreferenceRow title="Content updates" description="See whether the skills and specialties that came with Girru have newer content, and choose which to take." icon="refresh"><button type="button" onClick={()=>setContentUpdates(true)}>Check</button></PreferenceRow></PreferenceGroup>}
        {contentUpdates&&<SpecialtyUpdates client={client!} onClose={()=>setContentUpdates(false)} onApplied={()=>{}}/>}
        <PreferenceGroup title="This installation" note="The log folder and the workspace choice stay in the program menu (Help, File)."><PreferenceRow title="Connection" icon="link"><span className="preference-status">{info?(info.connection==='local'?'This computer':'Connected installation'):'Local browser preview'}</span></PreferenceRow></PreferenceGroup>
      </>}
    </div>
    </div>;
  return <div className="app-settings settings-workspace page-ui" data-inline-sidebar={!sidebarSlot&&!aboutOnly?'true':undefined}>
    {!aboutOnly&&sidebarSlot&&active?createPortal(sidebar,sidebarSlot):null}
    {!aboutOnly&&!sidebarSlot&&sidebar}
    {page}
  </div>;
}
