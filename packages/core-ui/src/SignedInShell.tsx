import {PersonalityLibrary} from './PersonalityLibrary';
import {WorkspaceModes,editorBounds,useNabuAvailability} from './WorkspaceModes';
import {TradingWorkspace} from './TradingWorkspace';
import {footerToolItem} from './AppsWorkspace';
import {StoreWorkspace} from './StoreView';
import {SpecialtyLibrary} from './SpecialtyLibrary';
import {LibrarySection} from './LibrarySection';
import {usePendingApprovalCount} from './ApprovalPage';
import {useBackupAlert} from './SettingsBackups';
import {ApprovalsWorkspace} from './HumanReviewsPage';
import type {ApprovalsPlaceRequest} from './HumanReviewsPage';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
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
import { GenVRPage } from './GenVRPage';
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
import { ShellFooter } from './ShellFooter';
import type { FooterEntry } from './ShellFooter';
import { footerFor } from './footer-prefs';
import type { FooterSection } from './footer-prefs';
import { ChatSearchController } from './chat-search';
import { chatFromLink } from './chat-actions';
import type { Command } from './CommandPalette';
import { accountRoleLabel, isDeveloperBuild } from './developer-build';

type Page = 'code' | 'trading' | 'library' | 'apps' | 'store' | 'approvals' | 'chat' | 'genvr' | 'agents' | 'board' | 'memory' | 'skills' | 'mcp' | 'terminal' | 'account' | 'settings' | 'about' | 'specialties' | 'personalities';
/** The section a page is a place of: its "← back" on top of the sidebar goes there. */
const placeParent: Partial<Record<Page, 'library' | 'store' | 'settings'>> = { personalities: 'library', specialties: 'library', skills: 'library', terminal: 'store' };
const PARENT_LABEL: Record<'library' | 'store' | 'settings', string> = { library: 'Library', store: 'Store', settings: 'Settings' };
/** Sections that own the sidebar with their own places (the chat list shows only in Chat). */
const OWN_SIDEBAR: ReadonlyArray<Page> = ['memory', 'settings', 'agents', 'library', 'skills', 'mcp', 'terminal','specialties','personalities','board','approvals','apps','store','trading'];
const pages: ReadonlyArray<{ key: Page; label: string; icon: IconName | 'board' | 'book' }> = [
  { key: 'chat', label: 'Chat', icon: 'message-circle' },
  { key: 'agents', label: 'Agents', icon: 'user' },
  { key: 'library', label: 'Library', icon: 'book' },
  { key: 'board', label: 'Board', icon: 'board' },
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
  if (first.pending && !finished) return <FirstRunSetup client={client} initialStep={first.step} workspaceType={first.workspaceType} companyName={first.companyName} onDone={chatId => {
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
  const nativeEditor=useNabuAvailability();
  useEffect(()=>{if(page!=='code'){const {top,bottom}=editorBounds();void window.dproApp?.nabu?.select('chat',top,bottom).catch(()=>{});}},[page]);
  useEffect(()=>()=>{void window.dproApp?.nabu?.select('chat',48,32).catch(()=>{});},[]);
  const openCode=async()=>{if(!chat||!await chat.ensureCodeConversation())return;const folder=await chat.editorDirectory();if(folder)openProjectCode(folder);};
  const openProjectCode=(folder:string,file?:string)=>{const {top,bottom,right}=editorBounds();void window.dproApp?.nabu?.open(folder,file??null,top,bottom,right).then(result=>{if(result?.mode==='code')setPage('code');}).catch(()=>{});};
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
  const [storeRequest,setStoreRequest]=useState<{updates:boolean;n:number;local?:'claude-code'|'codex';mine?:boolean}>();
  const openStore=(updates=false,local?:'claude-code'|'codex',mine=false)=>{setStoreRequest(r=>({updates,local,mine,n:(r?.n??0)+1}));setPage('store');};
  // SA6: Apps is Store › My apps now; every way that opened Apps opens it.
  const openMyApps=()=>openStore(false,undefined,true);
  // The separate Account and About pages are gone: menus and "Account verification" buttons open the Settings places.
  // MCP connections is a place of Settings (its places nest under its row there), so every way to it opens Settings.
  useEffect(()=>{if(page==='apps')openMyApps();else if(page==='account')openSettings('account');else if(page==='about')openSettings('about');else if(page==='mcp')openSettings('mcp');},[page]);
  const openTerminal=()=>{if(user.role!=='owner')return;setTerminalRequest(n=>n+1);setPage('chat');};
  const openMemorySettings=(target:SettingsTarget)=>{setMemoryPane(target);setSettingsTab('memory');setSettingsVisit(n=>n+1);setPage('settings');};
  const tools=[
    {id:'genvr',label:'GenVR',icon:<Icon name="dice"/>,run:()=>setPage('genvr')},
    ...(user.role==='owner'?[
      {id:'terminal',label:'Terminal',icon:<UiIcon name="terminal" size={14}/>,run:()=>setPage('terminal')},
      ...(nativeEditor?[{id:'code',label:'Code',icon:<UiIcon name="code" size={14}/>,run:openCode}]:[]),
    ]:[]),
  ];
  // Library places and Settings › MCP connections in ⌘K (owner only, like their pages).
  const libraryCommands:Command[]=user.role==='owner'?[
    {id:'tool-personalities',group:'Library',label:'Library › Personalities',keywords:'personality traits voice',icon:<UiIcon name="smile" size={14}/>,run:()=>setPage('personalities')},
    {id:'tool-specialties',group:'Library',label:'Library › Specialties',keywords:'agent templates jobs coming soon',icon:<UiIcon name="layers" size={14}/>,run:()=>setPage('specialties')},
    {id:'tool-skills',group:'Library',label:'Library › Skills',keywords:'skill abilities guides',icon:<UiIcon name="star" size={14}/>,run:()=>setPage('skills')},
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
    ...pages.filter(p=>p.key!=='genvr'&&(p.key!=='approvals'||user.role!=='guest')&&(p.key!=='library'||user.role==='owner')).map(p => ({ id: `go-${p.key}`, group: 'Go to', label: p.label, icon:p.icon==='board'||p.icon==='book'?<UiIcon name={p.icon} size={14}/>:<Icon name={p.icon}/>, run: () => setPage(p.key) })),
    ...tools.map(t=>({...t,id:'tool-'+t.id,group:'Tools',keywords:t.id==='terminal'?'console shell':t.id==='genvr'?'spaces worlds':'editor'})),
    ...libraryCommands,
    ...(user.role==='owner'?[{id:'scheduled-tasks',group:'Settings',label:'Scheduled tasks',keywords:'schedule cron automation paused active',icon:<UiIcon name="clock" size={14}/>,run:()=>openSettings('schedules')}]:[]),
    {id:'store-mine',group:'Store',label:'Store › My apps',keywords:'apps installed terminal trading genvr private',icon:<UiIcon name="layers" size={14}/>,run:openMyApps},
    ...(user.role==='owner'?[{id:'go-store',group:'Store',label:'Store › Find more',keywords:'catalogue install find more get apps mcp skills specialties',icon:<UiIcon name="store" size={14}/>,run:()=>openStore(false,undefined,false)},{id:'coding-app-plugins',group:'Settings',label:'Settings › Models and replies › Claude Code and Codex plugins',keywords:'plugins hooks add-ons claude codex',icon:<UiIcon name="puzzle" size={14}/>,run:()=>openSettings('replies')},{id:'store-updates',group:'Store',label:'Store › Updates',keywords:'new version update',icon:<UiIcon name="refresh" size={14}/>,run:()=>openStore(true)}]:[]),
    ...(user.role==='owner'?[{id:'go-trading',group:'Store',label:'Store › My apps › Trading',keywords:'paper practice stocks',icon:<UiIcon name="chart" size={14}/>,run:()=>setPage('trading')}]:[]),
    ...([['general','General'],['replies','Replies'],['account','Account'],['keys','Saved keys'],['accounts','Accounts'],['channels','Channels'],['departments','Departments'],['memory','Memory'],['schedules','Schedules'],['move','Move to another computer'],['about','About and updates']] as const).filter(([tab])=>user.role==='owner'||!['keys','accounts','channels','departments','memory','schedules','move'].includes(tab)).map(([tab,label])=>({id:`settings-${tab}`,group:'Settings',label:`Settings › ${label}`,icon:<UiIcon name="gear" size={14}/>,run:()=>openSettings(tab)})),
    { id: 'new-chat', group: 'Actions', icon:<UiIcon name="compose" size={14}/>, label: 'New chat', run: newChat },
    ...(chatState?.conversations ?? []).slice(0, 30).map(c => ({ id: `chat-${c.id}`, group: 'Conversations', icon:<Icon name="message-circle"/>, label: c.title || c.preview || 'New chat', run: () => { void chat?.open(c.id); setPage('chat'); } })),
    { id: 'theme', group: 'Actions', icon:<UiIcon name={theme==='dark'?'sun':'moon'} size={14}/>, label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', run: toggleTheme },
    { id: 'rail', group: 'Actions', icon:<UiIcon name="sidebar" size={14}/>, label: rail ? 'Hide the sidebar' : 'Show the sidebar', run: () => setRail(v => !v) },
  ];
  const active = chatState?.conversations.find(c => c.id === chatState.activeId);
  // CHAT-BUILD-01 stage 2 (CH1): the top bar names the chat and, muted, its project (hover = full path; a click opens Details › Place).
  const activeProject = active?.projectId ? chatState?.projects.find(p => p.id === active.projectId) : undefined;
  const pageTitle = page === 'code'?'Code':page === 'store'?'Store':page === 'library'?'Library':page === 'personalities'?'Personalities':page === 'trading'?'Trading':page === 'specialties'?'Specialties':page === 'chat' && active ? (active.title || 'Chat') : page === 'skills' ? 'Skills' : page === 'mcp' ? 'MCP connections' : page === 'terminal' ? 'Terminal' : pages.find(p => p.key === page)?.label ?? '';
  const footer=footerFor(client);
  const {prefs:footerPrefsNow}=useSyncExternalStore(footer.subscribe,footer.getSnapshot,footer.getSnapshot);
  const owner=user.role==='owner',go=(p:Page)=>()=>setPage(p);
  const entry=(id:Page,available=true,run=go(id),badge?:string,parent?:FooterSection):FooterEntry=>({available,current:page===id,run,badge,parent});
  const footerEntries:Record<FooterSection,FooterEntry>={chat:entry('chat'),agents:entry('agents'),library:entry('library',owner),board:entry('board'),memory:entry('memory'),approvals:entry('approvals',user.role!=='guest',go('approvals'),pendingApprovals.count?(pendingApprovals.count===100?'100+':String(pendingApprovals.count)):undefined),store:entry('store',true,go('store')),genvr:entry('genvr',true,go('genvr'),undefined,'store'),
    terminal:entry('terminal',owner,go('terminal'),undefined,'store'),code:entry('code',owner&&nativeEditor,openCode,undefined,'store'),skills:entry('skills',owner,go('skills'),undefined,'library'),personalities:entry('personalities',owner,go('personalities'),undefined,'library'),specialties:entry('specialties',owner,go('specialties'),undefined,'library')};

  const sidebarShown = rail && (page === 'chat' || ownSidebar);
  return <div className="shell app-shell" data-theme={theme} data-rail={sidebarShown ? 'open' : 'closed'} data-section={page} lang="en" dir="ltr">
    <header className="titlebar">
      <WorkspaceModes onModeChange={mode=>{if(mode==='code')setPage('code');else if(page==='code')setPage('chat');}}/>
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
        {chat && <ConversationList controller={chat} search={user.role === 'guest' ? undefined : search?.side} onOpen={() => setPage('chat')} onNewChat={newChat} onAddToBoard={user.role === 'owner' ? id => { void chat.open(id).then(() => setBoardRequest(n => n + 1)); setPage('chat'); } : undefined}/>}
      </div>}
      <div className="sidebar-footer">
        <details className="account-menu"><summary className="user-chip" title="Account">
          <span className="avatar" aria-hidden="true">{(displayName(user) || '?').slice(0, 1).toUpperCase()}</span>
          <span className="user-name"><bdi>{displayName(user)}</bdi>{accountRoleLabel(user.role)&&<small>{accountRoleLabel(user.role)}</small>}</span>
        </summary><div><button onClick={() => openSettings('account')}>Account</button><button onClick={() => client.cancel()}>Sign out on this device</button></div></details>
      </div>
    </aside>
    <main id="content" className="page-area">
      {notice}
      <section className="page page-chat" aria-label="Chat" hidden={page !== 'chat' && page !== 'code'}>
        {chat ? <ChatView embeddedCode={page==='code'} onOpenCode={nativeEditor&&owner?openProjectCode:undefined} active={page === 'chat'||page==='code'} titleSlot={titleSlot} onChooseContext={newChat} terminalRequest={terminalRequest} boardRequest={boardRequest} placeRequest={placeRequest} controller={chat} mode={mode} client={client} onAddConnector={() => setPage('mcp')} onSetUpModel={() => openSettings('replies')} onOpenApprovals={() => setPage('approvals')} onOpenAgent={id => { setAgentFocus(f => ({ id, n: (f?.n ?? 0) + 1 })); setPage('agents'); }} onOpenRules={user.role === 'owner' ? (agent, category) => { setApprovalsPlace(r => ({ place: 'perms', agent, category, n: (r?.n ?? 0) + 1 })); setPage('approvals'); } : undefined}
          onOpenCard={(boardId, cardId) => { setPage('board'); void board?.reveal(boardId, cardId); }}
          onOpenMemory={(drawerId, memoryId) => { setMemoryFocus(f => ({ drawerId, memoryId, n: (f?.n ?? 0) + 1 })); setPage('memory'); }}/> : null}
      </section>
      <section className="page page-agents" hidden={page !== 'agents'}><AgentsDestination client={client} active={page === 'agents'} onPersonalities={()=>setPage('personalities')} onSpecialties={()=>setPage('specialties')} onSkills={()=>setPage('skills')} sidebarSlot={slot} onOpenMcp={()=>setPage('mcp')} onOpenApprovals={()=>setPage('approvals')} focusAgent={agentFocus} onChat={agentId => { if (chat) { chat.newChat(); chat.selectAgent(agentId); } setPage('chat'); }} onOpenMemory={agentId => { if (agentId) setMemoryFocus(f => ({ scope: `agent:${agentId}`, n: (f?.n ?? 0) + 1 })); setPage('memory'); }}/></section>
      <section className="page page-board" hidden={page !== 'board'}>{board && <TaskBoard controller={board} sidebarSlot={slot} active={page === 'board'} onOpenChat={id => { void chat?.open(id); setPage('chat'); }}/>}</section>
      {user.role!=='guest'&&<section className="page page-approvals" hidden={page!=='approvals'}><ApprovalsWorkspace client={client} active={page==='approvals'} placeRequest={approvalsPlace} slot={slot} onDecision={decided} onAccount={()=>openSettings('account')} pendingCount={pendingApprovals.count} onAgent={id=>{setAgentFocus(f=>({id,n:(f?.n??0)+1}));setPage('agents');}}/></section>}
      <section className="page page-ui mem-desk" hidden={page !== 'memory'}><MemoryWindow client={client} active={page === 'memory'} focus={memoryFocus} sidebarSlot={slot} onOpenChat={id => { void chat?.open(id); setPage('chat'); }} onOpenSettings={openMemorySettings}/></section>
      {user.role === 'owner' && <>
        <section className="page page-library" hidden={page !== 'library'}><LibrarySection active={page==='library'} sidebarSlot={slot} onOpen={place=>setPage(place)}/></section>
        <section className="page page-personalities" hidden={page !== 'personalities'}><PersonalityLibrary client={client} active={page==='personalities'} sidebarSlot={slot} onOpenAgent={id=>{setAgentFocus(f=>({id,n:(f?.n??0)+1}));setPage('agents');}}/></section>
        <section className="page page-specialties" hidden={page !== 'specialties'}><SpecialtyLibrary client={client} active={page==='specialties'} sidebarSlot={slot} onOpenAgent={id=>{setAgentFocus(f=>({id,n:(f?.n??0)+1}));setPage('agents');}} onOpenConnections={()=>setPage('mcp')}/></section>
        <section className="page page-skills mem-desk" hidden={page !== 'skills'}><SkillsSection client={client} active={page === 'skills'} slot={slot} onOpenAgents={()=>setPage('agents')}/></section>
        <section className="page page-ui mem-desk" hidden={page !== 'terminal'}><TerminalSection client={client} active={page === 'terminal'} slot={slot} onOpenTerminal={openTerminal}/></section>
      </>}
      <section className="page page-ui" hidden={page!=='code'||!!chat}><p role="status" className="fine-print">Select Code in the bottom bar to open or reconnect the project editor.</p></section>
      <section className="page page-store" hidden={page!=='store'}><StoreWorkspace client={client} active={page==='store'} sidebarSlot={slot} request={storeRequest} canCode={nativeEditor&&owner} onOpenApp={id=>{if(id==='code')openCode();else setPage(id);}} onAccounts={()=>openSettings('accounts')} footerItem={owner?id=>footerToolItem(footerPrefsNow,id,x=>footer.toggle(x)):undefined} onPermissions={()=>{if(user.role!=='owner'){setPage('agents');return;}setApprovalsPlace(r=>({place:'perms',n:(r?.n??0)+1}));setPage('approvals');}}/></section>
      {user.role==='owner'&&<section className="page page-trading" hidden={page!=='trading'}><TradingWorkspace client={client} active={page==='trading'} sidebarSlot={slot} onBack={openMyApps}/></section>}
      <section className="page page-genvr" hidden={page !== 'genvr'}><GenVRPage key={user.id} client={client} active={page === 'genvr'}/></section>
      {page === 'settings' && <section className="page page-settings"><AppSettings key={settingsVisit} mcpOpenId={mcpOpen} onOpenStore={local=>openStore(false,local)} initialTab={settingsTab} initialMemoryPane={memoryPane} sidebarSlot={slot} active signedIn client={client} preference={appearance.preference} onTheme={appearance.setPreference} onAccount={() => openSettings('account')} onAgents={() => setPage('agents')} onOpenMemory={() => setPage('memory')} onOpenChat={() => setPage('chat')} onOpenApps={openMyApps} onOpenTool={tool => setPage(tool)} onOpenGenvr={() => setPage('genvr')} onApprovals={() => setPage('approvals')} onBoard={() => setPage('board')} onAgent={id => { setAgentFocus(f => ({ id, n: (f?.n ?? 0) + 1 })); setPage('agents'); }}/></section>}
    </main>
    <ShellFooter controller={footer} settingsCurrent={page==='settings'} settingsAlert={backupFailed?'the last backup failed':undefined} onSettings={()=>backupFailed?openSettings('backups'):setPage('settings')} onCustomize={()=>openSettings('general')}
      status={mode === 'mock' ? <span className="status-item"><span className={`status-dot ${mode}`} aria-hidden="true"/>Offline practice — fictional data</span>
        : <span className="status-item status-dot-only" title="Connected · this installation" aria-label="Connected · this installation" role="img"><span className={`status-dot ${mode}`} aria-hidden="true"/></span>}
      extra={isDeveloperBuild(client) && <button className="status-item statusbar-button" onClick={() => client.selectMode('fixture')} title="Clears this local session; the server sign-in stays until you sign out">Leave to fixture</button>}
      entries={footerEntries}/>
    <CommandPalette open={palette} commands={commands} onClose={() => setPalette(false)}
      search={chat && search && user.role !== 'guest' ? { controller: search.palette, onOpen: (id, messageId) => { void chat.openAt(id, messageId); setPage('chat'); } } : undefined}/>
  </div>;
}

const noopSubscribe = () => () => {};
const nullSnapshot = () => undefined;
