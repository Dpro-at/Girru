import {ComputerDevicesProvider} from './ComputerDevices';
import { ComputersSection } from './ComputersSection';
import { ComputerJoinNotice } from './ComputerJoin';
import {AppUpdateNotice} from './AppUpdateNotice';
import {ReportsPage} from './ReportsPage';
import {BrowserWorkspace} from './BrowserWorkspace';
import {useBrowserApp} from './browser-app';
import {PersonalityLibrary} from './PersonalityLibrary';
import {WorkspaceModes,editorBounds,useNabuRuntime} from './WorkspaceModes';
import {StoreTradingView} from './StoreTradingView';
import {footerToolItem} from './AppsWorkspace';
import {StoreWorkspace} from './StoreView';
import {SpecialtyLibrary} from './SpecialtyLibrary';
import {RulesLibrary} from './RulesLibrary';
import {LibrarySection} from './LibrarySection';
import {usePendingApprovalCount} from './ApprovalPage';
import {useBackupAlert} from './SettingsBackups';
import {ApprovalsWorkspace} from './HumanReviewsPage';
import type {ApprovalsPlaceRequest} from './HumanReviewsPage';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FirstRunSetup, useFirstRun } from './FirstRunSetup';
import type { ReactNode } from 'react';
import type { SessionClient } from './session';
import { displayName } from './session';
import { ConversationsController } from './conversations';
import { ChatView } from './ChatView';
import { ConversationList } from './ConversationList';
import { AgentsDestination } from './AgentsDestination';
import { BoardController } from './board';
import { TaskBoard } from './TaskBoard';
import { RunsDestination } from './RunsDestination';
import type { RunsPlace } from './RunsDestination';
import { GenVRPage } from './GenVRPage';
import { GENVR_RUNTIME } from './genvr-contract';
import type {SettingsTab} from './AppSettings';
import { AppSettings } from './AppSettings';
import { useAppNavigation, useAppTheme } from './app-navigation';
import { MemoryWindow } from './MemoryDesktop';
import type { MemoryFocus, SettingsTarget } from './MemoryDesktop';
import type { MemorySettingsPane } from './MemorySettings';
import { SkillsSection, TerminalSection } from './ToolSections';
import { Icon } from './icons';
import type { IconName } from './icons';
import { UiIcon } from './ui-icons';
import { CommandPalette } from './CommandPalette';
import { NewPhoneNotice, SidebarPhoneButton } from './PhonePairing';
import { ShellFooter } from './ShellFooter';
import { FooterHelperPill } from './MemoryHelper';
import type { FooterEntry } from './ShellFooter';
import { footerFor } from './footer-prefs';
import type { FooterSection } from './footer-prefs';
import { ChatSearchController } from './chat-search';
import { chatFromLink } from './chat-actions';
import type { Command } from './CommandPalette';
import { accountRoleLabel, isDeveloperBuild } from './developer-build';
import { setCodeHost, setCodeInstall } from './code-open';

type Page = 'computers' | 'reports' | 'browser' | 'rules' | 'code' | 'trading' | 'library' | 'apps' | 'store' | 'approvals' | 'chat' | 'genvr' | 'agents' | 'board' | 'runs' | 'memory' | 'skills' | 'mcp' | 'terminal' | 'account' | 'settings' | 'about' | 'specialties' | 'personalities';
/** The section a page is a place of: its "← back" on top of the sidebar goes there. */
const placeParent: Partial<Record<Page, 'library' | 'store' | 'settings'>> = { personalities: 'library', specialties: 'library', skills: 'library', rules: 'library', terminal: 'store' };
const PARENT_LABEL: Record<'library' | 'store' | 'settings', string> = { library: 'Library', store: 'Store', settings: 'Settings' };
/** Sections that own the sidebar with their own places (the chat list shows only in Chat). */
const OWN_SIDEBAR: ReadonlyArray<Page> = ['computers', 'rules', 'memory', 'settings', 'agents', 'library', 'skills', 'mcp', 'terminal','specialties','personalities','board','runs','reports','approvals','apps','store','trading'];
const pages: ReadonlyArray<{ key: Page; label: string; icon: IconName | 'board' | 'book' | 'play' }> = [
  { key: 'chat', label: 'Chat', icon: 'message-circle' },
  { key: 'agents', label: 'Agents', icon: 'user' },
  { key: 'library', label: 'Library', icon: 'book' },
  { key: 'board', label: 'Board', icon: 'board' },
  { key: 'runs', label: 'Runs', icon: 'play' },
  { key:'reports',label:'Reports',icon:'book' },
  { key: 'approvals', label: 'Approvals', icon: 'clock' },
  { key: 'memory', label: 'Memory', icon: 'database' },
  { key: 'genvr', label: 'GenVR', icon: 'dice' },
  { key: 'store', label: 'Store', icon: 'settings' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
];

/**
 * The signed-in workspace: one left sidebar owned by the open section (the
 * chat list in Chat; Memory, Settings, Agents, Skills, MCP connections and
 * Terminal show their own places in it), every page in the status bar, the
 * page area and a status bar. Every page
 * stays mounted and only the active one is shown, so a conversation or an
 * unsaved agent draft survives switching pages.
 */
/** FIRSTRUN-01: a new owner finishes the setup steps first; then the workspace opens on the Welcome chat. */
export function SignedInShell({ client, notice }: { client: SessionClient; notice: ReactNode }) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  // Only a real (live) owner session can still have setup steps; practice and offline modes open the workspace.
  const first = useFirstRun(client, state.user?.role === 'owner' && state.mode === 'live');
  const [finished, setFinished] = useState(false);
  if (first.pending === null) return <div className="first-run-setup" aria-busy="true"/>;
  if (first.pending && !finished) return <FirstRunSetup client={client} initialStep={first.step} workspaceType={first.workspaceType} companyName={first.companyName} companyKind={first.companyKind} onDone={chatId => {
    if (chatId) try { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#chat=${chatId}`); } catch { /* the last chat opens instead */ }
    setFinished(true);
  }}/>;
  return <Workspace client={client} notice={notice}/>;
}

function Workspace({ client, notice }: { client: SessionClient; notice: ReactNode }) {
  // The small setup window grows to the normal size once (a no-op when it is already normal).
  useEffect(() => { void window.dproApp?.setSetupWindow?.(false).catch(() => {}); }, []);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [page, setPage] = useState<Page>('chat');
  const [genvrOpened,setGenvrOpened]=useState(false);
  const genvrOpenSeq=useRef(0);
  useEffect(()=>{genvrOpenSeq.current++;return()=>{genvrOpenSeq.current++;};},[page,state.user?.id,state.user?.role]);
  // CODE-STORE-01: Code comes from the Store; while the desktop app has none, every way to Code opens its Store page.
  const {available:nativeEditor,missing:codeMissing}=useNabuRuntime();
  useEffect(()=>{if(page!=='code'){const {top,bottom}=editorBounds();void window.dproApp?.nabu?.select('chat',top,bottom).catch(()=>{});}},[page]);
  useEffect(()=>()=>{void window.dproApp?.nabu?.select('chat',48,32).catch(()=>{});},[]);
  const openCode=async()=>{if(!chat||!await chat.ensureCodeConversation())return;const folder=await chat.editorDirectory();if(folder)openProjectCode(folder);};
  const openProjectCode=(folder:string,file?:string)=>{const {top,bottom,right}=editorBounds();void window.dproApp?.nabu?.open(folder,file??null,top,bottom,right).then(result=>{if(result?.mode==='code')setPage('code');}).catch(()=>{});};
  // CODE-OPEN-01: every "Open in Code" in the app opens here (the file at its line), only for the owner.
  const codeOwner=state.user?.role==='owner';
  useEffect(()=>{if(!codeOwner){setCodeHost(null,false);return;}setCodeHost(async(t,o)=>{const {top,bottom,right}=editorBounds();const result=await window.dproApp?.nabu?.open(t.folder,t.file,top,bottom,right,{...(t.line?{line:t.line}:{}),...(t.generated?{note:true}:{}),...(o.readOnly?{readOnly:true}:{})});if(result?.mode==='code'){setPage('code');return true;}return false;},nativeEditor);return()=>setCodeHost(null,false);},[codeOwner,nativeEditor]);
  useEffect(()=>{setCodeInstall(codeOwner&&codeMissing?()=>openCodeInStore():null);return()=>setCodeInstall(null);},[codeOwner,codeMissing]);
  const appearance = useAppTheme();
  const theme = appearance.theme;
  // The title-bar switch goes back to "system" when it lands on the system's own theme.
  const toggleTheme = () => { const next = theme === 'dark' ? 'light' : 'dark'; const system = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; appearance.setPreference(next === system ? 'system' : next); };
  const [chat, setChat] = useState<ConversationsController>();
  useAppNavigation(destination => { if (destination === 'new-chat') { chat?.newChat(); setPage('chat'); } else setPage(destination === 'home' ? 'chat' : destination); });
  // A window opened for one chat (⌘O) carries `#chat=<id>`: open that chat once the list is in.
  useEffect(() => { const c = new ConversationsController(client); setChat(c); const linked = chatFromLink(window.location.hash);
    void c.load().then(() => {
      // CH11: after sign-in the window opens where the owner left it (the last open chat, if it still exists).
      if (!linked) { void c.restoreLast(); return; }
      try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* keep going */ } void c.open(linked); }); return () => c.dispose(); }, [client]);
  // CHAT-PRO-02 D: search inside the chats (the sidebar box and the ⌘K box each keep their own).
  const [search, setSearch] = useState<{ side: ChatSearchController; palette: ChatSearchController }>();
  useEffect(() => { const s = { side: new ChatSearchController(client), palette: new ChatSearchController(client) }; setSearch(s); return () => { s.side.dispose(); s.palette.dispose(); }; }, [client]);
  const [board, setBoard] = useState<BoardController>();
  useEffect(() => { const b = new BoardController(client); setBoard(b); return () => b.dispose(); }, [client]);
  const chatState = useSyncExternalStore(
    chat ? chat.subscribe : noopSubscribe,
    chat ? chat.getSnapshot : nullSnapshot,
    chat ? chat.getSnapshot : nullSnapshot);
  const user = state.user!;
  const pendingApprovals=usePendingApprovalCount(client,user.role==='owner');
  const backupFailed=useBackupAlert(client,user.role==='owner');
  // An approval decided on the Approvals page: the open chat picks up the reply the server continues it with (stable for ApprovalPage's effect).
  const reloadApprovals=pendingApprovals.reload;
  const decided=useCallback(()=>{reloadApprovals();void chat?.pickUpContinuation();},[reloadApprovals,chat]);
  const mode = state.mode === 'mock' ? 'mock' : 'live';
  const [rail, setRail] = useState(true);
  const [palette, setPalette] = useState(false);
  const [settingsTab,setSettingsTab]=useState<SettingsTab>('general');
  const [memoryPane,setMemoryPane]=useState<MemorySettingsPane>('rules');
  const [slot,setSlot]=useState<HTMLElement|null>(null);
  const [titleSlot,setTitleSlot]=useState<HTMLElement|null>(null);
  const ownSidebar=OWN_SIDEBAR.includes(page);
  const [settingsVisit,setSettingsVisit]=useState(0);
  const [terminalRequest,setTerminalRequest]=useState(0);
  const [boardRequest,setBoardRequest]=useState(0);
  const [placeRequest,setPlaceRequest]=useState(0);
  const openSettings=(tab:SettingsTab)=>{setSettingsTab(tab);setSettingsVisit(n=>n+1);setPage('settings');};
  const [runsRequest,setRunsRequest]=useState<{place:RunsPlace;n:number}|null>(null);
  const openRuns=(place:RunsPlace)=>{setRunsRequest(r=>({place,n:(r?.n??0)+1}));setPage('runs');};
  const [storeRequest,setStoreRequest]=useState<{updates:boolean;n:number;local?:'claude-code'|'codex';mine?:boolean;item?:string}>();
  const openCodeInStore=()=>{setStoreRequest(r=>({updates:false,item:'girru:code',n:(r?.n??0)+1}));setPage('store');};
  const openGenvr=async()=>{
    const seq=++genvrOpenSeq.current;
    try{
      const result=await client.request({method:'GET',path:GENVR_RUNTIME} as never);
      if(seq!==genvrOpenSeq.current)return;
      if(result.status===200&&['installed','bundled'].includes((result.body as {state?:string})?.state??'')){setGenvrOpened(true);setPage('genvr');return;}
    }catch{/* The Store explains availability and offers the existing retry action. */}
    if(seq!==genvrOpenSeq.current)return;
    setStoreRequest(r=>({updates:false,item:'girru:genvr',n:(r?.n??0)+1}));setPage('store');
  };
  const openStore=(updates=false,local?:'claude-code'|'codex',mine=false)=>{setStoreRequest(r=>({updates,local,mine,n:(r?.n??0)+1}));setPage('store');};
  // SA6: Apps is Store › My apps now; every way that opened Apps opens it.
  const openMyApps=()=>openStore(false,undefined,true);
  // The separate Account and About pages are gone: menus and "Account verification" buttons open the Settings places.
  // MCP connections is a place of Settings (its places nest under its row there), so every way to it opens Settings.
  useEffect(()=>{if(page==='apps')openMyApps();else if(page==='account')openSettings('account');else if(page==='about')openSettings('about');else if(page==='mcp')openSettings('mcp');},[page]);
  const openTerminal=()=>{if(user.role!=='owner')return;setTerminalRequest(n=>n+1);setPage('chat');};
  const openMemorySettings=(target:SettingsTarget)=>{setMemoryPane(target);setSettingsTab('memory');setSettingsVisit(n=>n+1);setPage('settings');};
  const tools=[
    {id:'genvr',label:'GenVR',icon:<Icon name="dice"/>,run:()=>void openGenvr()},
    ...(user.role==='owner'?[
      {id:'terminal',label:'Terminal',icon:<UiIcon name="terminal" size={14}/>,run:openTerminal},
      ...(nativeEditor||codeMissing?[{id:'code',label:'Code',icon:<UiIcon name="code" size={14}/>,run:nativeEditor?openCode:openCodeInStore}]:[]),
    ]:[]),
  ];
  // Library places and Settings › MCP connections in ⌘K (owner only, like their pages).
  const libraryCommands:Command[]=user.role==='owner'?[
    {id:'tool-personalities',group:'Library',label:'Library › Personalities',keywords:'personality traits voice',icon:<UiIcon name="smile" size={14}/>,run:()=>setPage('personalities')},
    {id:'tool-specialties',group:'Library',label:'Library › Specialties',keywords:'agent templates jobs coming soon',icon:<UiIcon name="layers" size={14}/>,run:()=>setPage('specialties')},
    {id:'tool-skills',group:'Library',label:'Library › Skills',keywords:'skill abilities guides',icon:<UiIcon name="star" size={14}/>,run:()=>setPage('skills')},
    {id:'tool-rules',group:'Library',label:'Library › Rules',keywords:'rules instructions policies',icon:<UiIcon name="scale" size={14}/>,run:()=>setPage('rules')},
    // The Terminal opens beside the chat in one click (footer, ⌘K, My apps); its saved SSH hosts stay one command away.
    {id:'tool-ssh-hosts',group:'Tools',label:'Terminal › Saved SSH hosts',keywords:'ssh hosts servers terminal sessions',icon:<UiIcon name="terminal" size={14}/>,run:()=>setPage('terminal')},
    {id:'tool-mcp',group:'Settings',label:'Settings › MCP connections',keywords:'connectors mcp servers tools',icon:<UiIcon name="tool" size={14}/>,run:()=>setPage('mcp')},
  ]:[];
  const [mcpOpen,setMcpOpen]=useState<string>();
  const [approvalsPlace,setApprovalsPlace]=useState<ApprovalsPlaceRequest|null>(null);
  const [agentFocus,setAgentFocus]=useState<{id:string;n:number}|null>(null);
  const [memoryFocus, setMemoryFocus] = useState<MemoryFocus | null>(null);
  const boardState = useSyncExternalStore(board ? board.subscribe : noopSubscribe, board ? board.getSnapshot : nullSnapshot, board ? board.getSnapshot : nullSnapshot);
  // ⌘K / Ctrl+K opens the command box anywhere in the workspace; ⌘, / Ctrl+, opens Settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(v => !v); }
      else if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); setPage('settings'); }
      else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === '\\') { e.preventDefault(); setRail(v => !v); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  // CHAT-BUILD-01 stage 3 (CH5): a new chat opens at once, in the project you are in — no dialog.
  const newChat = () => { const c = chat?.getSnapshot(); const p = c?.conversations.find(x => x.id === c.activeId)?.projectId ?? c?.projectFilter ?? ''; chat?.filterProject(p); chat?.newChat(); setPage('chat'); };
  const commands: Command[] = [
    ...pages.filter(p=>p.key!=='genvr'&&(p.key!=='approvals'||user.role!=='guest')&&(p.key!=='runs'||user.role!=='guest')&&(!['library','reports'].includes(p.key)||user.role==='owner')).map(p => ({ id: `go-${p.key}`, group: 'Go to', label: p.label, icon:p.icon==='board'||p.icon==='book'||p.icon==='play'?<UiIcon name={p.icon} size={14}/>:<Icon name={p.icon}/>, run: () => setPage(p.key) })),
    ...tools.map(t=>({...t,id:'tool-'+t.id,group:'Tools',keywords:t.id==='terminal'?'console shell':t.id==='genvr'?'spaces worlds':'editor'})),
    ...libraryCommands,
    // DEVICES-PROJECT-01 (CP3): my other computers, owner only.
    ...(user.role==='owner'&&mode==='live'?[{id:'go-computers',group:'Go to',label:'Computers',keywords:'computers other computer devices linked send task add a computer',icon:<UiIcon name="screen" size={14}/>,run:()=>setPage('computers')},{id:'settings-computers',group:'Settings',label:'Settings › Computers',keywords:'computers account wi-fi recover forget share',icon:<UiIcon name="screen" size={14}/>,run:()=>openSettings('computers')}]:[]),
    // RUNS-01: the schedules moved from Settings to Runs › Scheduled; the old words still find them.
    ...(user.role!=='guest'?[{id:'scheduled-tasks',group:'Runs',label:'Runs › Scheduled',keywords:'scheduled tasks schedules cron automation paused active settings',icon:<UiIcon name="calendar" size={14}/>,run:()=>openRuns('scheduled')},{id:'runs-failed',group:'Runs',label:'Runs › Failed or stopped',keywords:'failed stopped errors why bug log',icon:<UiIcon name="alert" size={14}/>,run:()=>openRuns('failed')},{id:'runs-waiting',group:'Runs',label:'Runs › Waiting',keywords:'waiting approval needs you',icon:<UiIcon name="hourglass" size={14}/>,run:()=>openRuns('waiting')}]:[]),
    {id:'store-mine',group:'Store',label:'Store › My apps',keywords:'apps installed terminal trading genvr private',icon:<UiIcon name="layers" size={14}/>,run:openMyApps},
    ...(user.role==='owner'?[{id:'go-store',group:'Store',label:'Store › Find more',keywords:'catalogue install find more get apps mcp skills specialties',icon:<UiIcon name="store" size={14}/>,run:()=>openStore(false,undefined,false)},{id:'coding-app-plugins',group:'Settings',label:'Settings › Models and replies › Claude Code and Codex plugins',keywords:'plugins hooks add-ons claude codex',icon:<UiIcon name="puzzle" size={14}/>,run:()=>openSettings('replies')},{id:'store-updates',group:'Store',label:'Store › Updates',keywords:'new version update',icon:<UiIcon name="refresh" size={14}/>,run:()=>openStore(true)}]:[]),
    ...(user.role==='owner'?[{id:'go-trading',group:'Store',label:'Store › My apps › Trading',keywords:'paper practice stocks',icon:<UiIcon name="chart" size={14}/>,run:()=>setPage('trading')}]:[]),
    ...([['general','General'],['replies','Replies'],['account','Account'],['keys','Saved keys'],['accounts','Accounts'],['channels','Channels'],['departments','Departments'],['memory','Memory'],['move','Move to another computer'],['about','About and updates']] as const).filter(([tab])=>user.role==='owner'||!['keys','accounts','channels','departments','memory','move'].includes(tab)).map(([tab,label])=>({id:`settings-${tab}`,group:'Settings',label:`Settings › ${label}`,icon:<UiIcon name="gear" size={14}/>,run:()=>openSettings(tab)})),
    { id: 'new-chat', group: 'Actions', icon:<UiIcon name="compose" size={14}/>, label: 'New chat', run: newChat },
    ...(chatState?.conversations ?? []).slice(0, 30).map(c => ({ id: `chat-${c.id}`, group: 'Conversations', icon:<Icon name="message-circle"/>, label: c.title || c.preview || 'New chat', run: () => { void chat?.open(c.id); setPage('chat'); } })),
    { id: 'theme', group: 'Actions', icon:<UiIcon name={theme==='dark'?'sun':'moon'} size={14}/>, label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', run: toggleTheme },
    { id: 'rail', group: 'Actions', icon:<UiIcon name="sidebar" size={14}/>, label: rail ? 'Hide the sidebar' : 'Show the sidebar', run: () => setRail(v => !v) },
  ];
  const active = chatState?.conversations.find(c => c.id === chatState.activeId);
  // CHAT-BUILD-01 stage 2 (CH1): the top bar names the chat and, muted, its project (hover = full path; a click opens Details › Place).
  const activeProject = active?.projectId ? chatState?.projects.find(p => p.id === active.projectId) : undefined;
  const pageTitle = page === 'computers'?'Computers':page === 'browser'?'Browser':page === 'rules'?'Rules':page === 'code'?'Code':page === 'store'?'Store':page === 'library'?'Library':page === 'personalities'?'Personalities':page === 'trading'?'Trading':page === 'specialties'?'Specialties':page === 'chat' && active ? (active.title || 'Chat') : page === 'skills' ? 'Skills' : page === 'mcp' ? 'MCP connections' : page === 'terminal' ? 'Terminal' : pages.find(p => p.key === page)?.label ?? '';
  const footer=footerFor(client);
  const {prefs:footerPrefsNow}=useSyncExternalStore(footer.subscribe,footer.getSnapshot,footer.getSnapshot);
  const browser=useBrowserApp(client,user.role==='owner');
  const owner=user.role==='owner',go=(p:Page)=>()=>setPage(p);
  const entry=(id:Page,available=true,run=go(id),badge?:string,parent?:FooterSection):FooterEntry=>({available,current:page===id,run,badge,parent});
  const footerEntries:Record<FooterSection,FooterEntry>={computers:entry('computers',owner&&mode==='live'),chat:entry('chat'),agents:entry('agents'),library:{...entry('library',owner),current:page==='library'||page==='rules'},board:entry('board'),runs:entry('runs',user.role!=='guest'),reports:entry('reports',owner),memory:entry('memory'),approvals:entry('approvals',user.role!=='guest',go('approvals'),pendingApprovals.count?(pendingApprovals.count===100?'100+':String(pendingApprovals.count)):undefined),store:entry('store',true,go('store')),genvr:entry('genvr',true,()=>void openGenvr(),undefined,'store'),
    browser:{available:owner&&browser.available,current:page==='browser',run:go('browser'),parent:'store'},terminal:entry('terminal',owner,openTerminal,undefined,'store'),code:entry('code',owner&&(nativeEditor||codeMissing),nativeEditor?openCode:openCodeInStore,undefined,'store'),skills:entry('skills',owner,go('skills'),undefined,'library'),personalities:entry('personalities',owner,go('personalities'),undefined,'library'),specialties:entry('specialties',owner,go('specialties'),undefined,'library')};

  const sidebarShown = rail && (page === 'chat' || ownSidebar);
  return <ComputerDevicesProvider key={user.id} client={client} enabled={owner && mode==='live'}><div className="shell app-shell" data-theme={theme} data-rail={sidebarShown ? 'open' : 'closed'} data-section={page} lang="en" dir="ltr">
    <header className="titlebar">
      {browser.problem&&<span role="alert">{browser.problem}</span>}<WorkspaceModes onModeChange={mode=>{if(mode==='code')setPage('code');else if(page==='code')setPage('chat');}}/>
      <div className="titlebar-tools">
        <button type="button" className="tool" aria-label={rail ? 'Hide the sidebar' : 'Show the sidebar'} title={rail ? 'Hide the sidebar (⌘\\)' : 'Show the sidebar (⌘\\)'} aria-pressed={rail} onClick={() => setRail(v => !v)}><UiIcon name="sidebar" size={14}/></button>
      </div>
      <p className="titlebar-title">{page === 'chat' && activeProject && <span className="titlebar-tile" aria-hidden="true"><UiIcon name="folder" size={12}/></span>}{pageTitle}{page === 'chat' && activeProject && <button type="button" className="titlebar-project" title={activeProject.folder ?? activeProject.name} aria-label={`${activeProject.name} · show its folder in Details`} onClick={() => setPlaceRequest(n => n + 1)}>{activeProject.name}</button>}</p>
      {/* CH1/SH1: Commands sits in the middle of the title bar; the theme lives in Settings › General and in Commands. */}
      <button type="button" className="titlebar-cmdk" onClick={() => {if(page==='code'&&window.dproApp?.nabu?.showCommands)void window.dproApp.nabu.showCommands();else setPalette(true);}} aria-label={page==='code'?'Code commands':'Search or run a command (⌘K)'}><UiIcon name="search" size={13}/>Commands<kbd>⌘K</kbd></button>
      <div className="titlebar-tools end" ref={setTitleSlot}/>
    </header>
    <aside className="sidebar">
      {/* The open section owns the sidebar: the chat list only in Chat; other sections render their places into the slot. */}
      {/* A place inside a section (Skills in Library, MCP connections in Settings) shows the way back on top, like an open agent's "All staff" (board SH1). */}
      {placeParent[page]&&<button type="button" className="agent-return place-return" onClick={()=>setPage(placeParent[page]!)}><UiIcon name="arrow-left" size={13}/>{PARENT_LABEL[placeParent[page]!]}</button>}
      <div className="section-sidebar" ref={setSlot} hidden={page === 'chat'}/>
      {page === 'chat' && <div className="session-list">
        {chat && <ConversationList controller={chat} search={user.role === 'guest' ? undefined : search?.side} onOpen={() => setPage('chat')} onNewChat={newChat} onAddToBoard={user.role === 'owner' ? id => { void chat.open(id).then(() => setBoardRequest(n => n + 1)); setPage('chat'); } : undefined} trustClient={user.role === 'owner' ? client : undefined}/>}
      </div>}
      <div className="sidebar-footer">
        <details className="account-menu"><summary className="user-chip" title="Account">
          <span className="avatar" aria-hidden="true">{(displayName(user) || '?').slice(0, 1).toUpperCase()}</span>
          <span className="user-name"><bdi>{displayName(user)}</bdi>{accountRoleLabel(user.role)&&<small>{accountRoleLabel(user.role)}</small>}</span>
        </summary><div><button onClick={() => openSettings('account')}>Account</button><button onClick={() => client.cancel()}>Sign out on this device</button></div></details>
        {owner && mode === 'live' && <SidebarPhoneButton client={client} onSettings={() => openSettings('phone')}/>}
      </div>
    </aside>
    <main id="content" className="page-area">
      {notice}
      <section className="page page-chat" aria-label="Chat" hidden={page !== 'chat' && page !== 'code'}>
        {chat ? <ChatView embeddedCode={page==='code'} onOpenCode={nativeEditor&&owner?openProjectCode:undefined} active={page === 'chat'||page==='code'} titleSlot={titleSlot} onChooseContext={newChat} terminalRequest={terminalRequest} boardRequest={boardRequest} placeRequest={placeRequest} controller={chat} mode={mode} client={client} onAddConnector={() => setPage('mcp')} onSetUpModel={() => openSettings('replies')} onOpenApprovals={() => setPage('approvals')} onOpenAgent={id => { setAgentFocus(f => ({ id, n: (f?.n ?? 0) + 1 })); setPage('agents'); }} onOpenRules={user.role === 'owner' ? (agent, category) => { setApprovalsPlace(r => ({ place: 'perms', agent, category, n: (r?.n ?? 0) + 1 })); setPage('approvals'); } : undefined}
          onOpenCard={(boardId, cardId) => { setPage('board'); void board?.reveal(boardId, cardId); }}
          onOpenMemoryPage={() => setPage('memory')} onOpenMemory={(drawerId, memoryId) => { setMemoryFocus(f => ({ drawerId, memoryId, n: (f?.n ?? 0) + 1 })); setPage('memory'); }}/> : null}
      </section>
      <section className="page page-agents" hidden={page !== 'agents'}><AgentsDestination client={client} active={page === 'agents'} onPersonalities={()=>setPage('personalities')} onSpecialties={()=>setPage('specialties')} onSkills={()=>setPage('skills')} sidebarSlot={slot} onOpenMcp={()=>setPage('mcp')} onOpenApprovals={()=>setPage('approvals')} focusAgent={agentFocus} onChat={agentId => { if (chat) { chat.newChat(); chat.selectAgent(agentId); } setPage('chat'); }} onOpenMemory={agentId => { if (agentId) setMemoryFocus(f => ({ scope: `agent:${agentId}`, n: (f?.n ?? 0) + 1 })); setPage('memory'); }}/></section>
      <section className="page page-board" hidden={page !== 'board'}>{board && <TaskBoard controller={board} sidebarSlot={slot} active={page === 'board'} onOpenChat={id => { void chat?.open(id); setPage('chat'); }} onOpenMemory={to => { setMemoryFocus(f => ('handoffs' in to ? { handoffs: true as const, n: (f?.n ?? 0) + 1 } : { scope: to.scope, n: (f?.n ?? 0) + 1 })); setPage('memory'); }}/>}</section>
      {user.role==='owner'&&<section className="page page-reports" hidden={page!=='reports'}><ReportsPage onOpenCard={(boardId,cardId)=>{setPage('board');void board?.reveal(boardId,cardId);}} key={user.id} client={client} active={page==='reports'} sidebarSlot={slot} agents={chatState?.agents??[]} projects={chatState?.projects??[]} onOpenChat={id=>{void chat?.open(id);setPage('chat');}}/></section>}
      {user.role!=='guest'&&<section className="page page-runs" hidden={page!=='runs'}><RunsDestination client={client} active={page==='runs'} sidebarSlot={slot} request={runsRequest} agents={chatState?.agents??[]} projects={chatState?.projects??[]} models={chatState?.models??[]} onOpenChat={id=>{void chat?.open(id);setPage('chat');}} onOpenCard={(boardId,cardId)=>{setPage('board');void board?.reveal(boardId,cardId);}} onOpenAgent={id=>{setAgentFocus(f=>({id,n:(f?.n??0)+1}));setPage('agents');}} onOpenApprovals={()=>setPage('approvals')} onOpenConnections={()=>openSettings('channels')}/></section>}
      {user.role!=='guest'&&<section className="page page-approvals" hidden={page!=='approvals'}><ApprovalsWorkspace client={client} active={page==='approvals'} placeRequest={approvalsPlace} slot={slot} onDecision={decided} onAccount={()=>openSettings('account')} pendingCount={pendingApprovals.count} onAgent={id=>{setAgentFocus(f=>({id,n:(f?.n??0)+1}));setPage('agents');}}/></section>}
      <section className="page page-ui mem-desk" hidden={page !== 'memory'}><MemoryWindow client={client} active={page === 'memory'} focus={memoryFocus} sidebarSlot={slot} onOpenChat={id => { void chat?.open(id); setPage('chat'); }} onOpenCard={(boardId, cardId) => { setPage('board'); void board?.reveal(boardId, cardId); }} onOpenSettings={openMemorySettings}/></section>
      {user.role === 'owner' && <>
        <section className="page page-library" hidden={page !== 'library'}><LibrarySection canManageRules={owner} active={page==='library'} sidebarSlot={slot} onOpen={place=>setPage(place)}/></section>
        <section className="page page-ui page-rules" hidden={page!=='rules'}><RulesLibrary client={client} active={page==='rules'} sidebarSlot={slot} agents={(chatState?.agents??[]).map(a=>({id:a.id,name:a.name??'Agent',department:a.department??null}))} onOpen={place=>setPage(place)}/></section>
        <section className="page page-personalities" hidden={page !== 'personalities'}><PersonalityLibrary client={client} active={page==='personalities'} sidebarSlot={slot} onOpenAgent={id=>{setAgentFocus(f=>({id,n:(f?.n??0)+1}));setPage('agents');}}/></section>
        <section className="page page-specialties" hidden={page !== 'specialties'}><SpecialtyLibrary client={client} active={page==='specialties'} sidebarSlot={slot} onOpenAgent={id=>{setAgentFocus(f=>({id,n:(f?.n??0)+1}));setPage('agents');}} onOpenConnections={()=>setPage('mcp')}/></section>
        <section className="page page-skills mem-desk" hidden={page !== 'skills'}><SkillsSection client={client} active={page === 'skills'} slot={slot} onOpenAgents={()=>setPage('agents')}/></section>
        <section className="page page-ui mem-desk" hidden={page !== 'terminal'}><TerminalSection client={client} active={page === 'terminal'} slot={slot} onOpenTerminal={openTerminal}/></section>
      </>}
      <section className="page page-ui" hidden={page!=='code'||!!chat}><p role="status" className="fine-print">Select Code in the bottom bar to open or reconnect the project editor.</p></section>
      <section className="page page-browser" hidden={page!=='browser'}><BrowserWorkspace client={client} active={page==='browser'}/></section>
      <section className="page page-store" hidden={page!=='store'}><StoreWorkspace client={client} active={page==='store'} sidebarSlot={slot} request={storeRequest} canBrowser={browser.available&&owner} canCode={nativeEditor&&owner} codeMissing={codeMissing&&owner} onOpenApp={id=>{if(id==='browser')setPage('browser');else if(id==='code')void (nativeEditor?openCode():openCodeInStore());else if(id==='terminal')openTerminal();else if(id==='genvr')void openGenvr();else if(id==='channels')openSettings('channels');else setPage(id);}} onAccounts={()=>openSettings('accounts')} footerItem={owner?id=>footerToolItem(footerPrefsNow,id,x=>footer.toggle(x)):undefined} onPermissions={()=>{if(user.role!=='owner'){setPage('agents');return;}setApprovalsPlace(r=>({place:'perms',n:(r?.n??0)+1}));setPage('approvals');}}/></section>
      {user.role==='owner'&&<section className="page page-trading" hidden={page!=='trading'}><StoreTradingView client={client} active={page==='trading'} sidebarSlot={slot} onBack={openMyApps} onOpenStore={()=>{setStoreRequest(r=>({updates:false,item:'store:trading',n:(r?.n??0)+1}));setPage('store');}} onPermissions={()=>{setApprovalsPlace(r=>({place:'perms',n:(r?.n??0)+1}));setPage('approvals');}}/></section>}
      {user.role==='owner'&&mode==='live'&&<section className="page page-computers" hidden={page!=='computers'}><ComputersSection client={client} active={page==='computers'} sidebarSlot={slot} onOpenChat={id=>{void chat?.open(id);setPage('chat');}} onApprovals={()=>setPage('approvals')} onSettings={()=>openSettings('computers')}/></section>}
      <section className="page page-genvr" hidden={page !== 'genvr'}>{genvrOpened&&<GenVRPage key={user.id} client={client} active={page === 'genvr'}/>}</section>
      {page === 'settings' && <section className="page page-settings"><AppSettings onOpenDeviceChat={id=>{void chat?.open(id);setPage('chat');}} key={settingsVisit} mcpOpenId={mcpOpen} onOpenChannelsStore={()=>{setStoreRequest(r=>({updates:false,item:'store:agent-connect',n:(r?.n??0)+1}));setPage('store');}} onOpenStore={local=>openStore(false,local)} initialTab={settingsTab} initialMemoryPane={memoryPane} sidebarSlot={slot} active signedIn client={client} preference={appearance.preference} onTheme={appearance.setPreference} onAccount={() => openSettings('account')} onAgents={() => setPage('agents')} onOpenMemory={() => setPage('memory')} onOpenChat={() => setPage('chat')} onOpenApps={openMyApps} onOpenTool={tool => setPage(tool)} onOpenGenvr={()=>void openGenvr()} onApprovals={() => setPage('approvals')} onBoard={() => setPage('board')} onAgent={id => { setAgentFocus(f => ({ id, n: (f?.n ?? 0) + 1 })); setPage('agents'); }}/></section>}
    </main>
    <ShellFooter controller={footer} settingsCurrent={page==='settings'} settingsAlert={backupFailed?'the last backup failed':undefined} onSettings={()=>backupFailed?openSettings('backups'):setPage('settings')} onCustomize={()=>openSettings('general')}
      status={mode === 'mock' ? <span className="status-item"><span className={`status-dot ${mode}`} aria-hidden="true"/>Offline practice — fictional data</span>
        : <span className="status-item status-dot-only" title="Connected · this installation" aria-label="Connected · this installation" role="img"><span className={`status-dot ${mode}`} aria-hidden="true"/></span>}
      extra={<>{owner && mode === 'live' && <AppUpdateNotice onOpen={()=>openSettings('about')}/>}{isDeveloperBuild(client) && <button className="status-item statusbar-button" onClick={() => client.selectMode('fixture')} title="Clears this local session; the server sign-in stays until you sign out">Leave to fixture</button>}{owner && mode === 'live' && <FooterHelperPill client={client}/>}</>}
      entries={footerEntries}/>
    {owner && mode === 'live' && <NewPhoneNotice client={client} onSettings={() => openSettings('phone')}/>}
    {owner && mode === 'live' && page !== 'computers' && <ComputerJoinNotice client={client} enabled={owner && mode === 'live'} onOpen={() => setPage('computers')}/>}
    <CommandPalette open={palette} commands={commands} onClose={() => setPalette(false)}
      search={chat && search && user.role !== 'guest' ? { controller: search.palette, onOpen: (id, messageId) => { void chat.openAt(id, messageId); setPage('chat'); } } : undefined}/>
  </div></ComputerDevicesProvider>;
}

const noopSubscribe = () => () => {};
const nullSnapshot = () => undefined;
