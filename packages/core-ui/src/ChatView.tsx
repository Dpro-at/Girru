import { ChatVoice } from './ChatVoice';
import {CodeChatResize} from './CodeChatResize';
import { DepartmentBadge } from './DepartmentBadge';
import { MeetingPanels } from './MeetingPanels';
import { Meetings } from './Meetings';
import type { MeetingRecord } from './meetings-contract.js';
import { ChatDetails, DetailsRail } from './ChatDetails';
import type { PanelPart } from './ChatDetails';
import { ApprovalCard, ChangesLine, DelegationCard, MomentsContext, NoticeCard, SteerLine, TaskList, TitleFaces, chatPeople, redoTarget } from './ChatMoments';
import { ScheduleSheet } from './ScheduleSheet';
import { KeysSheet, ModeButton, ModelButton, PlusButton, ProjectChip, ProjectSheet, SlashList, WhoButton, slashMatches } from './ChatComposerControls';
import { modelDisplayName } from './model-names';
import {ChatAddons} from './ChatAddons';
import {DocumentEditor} from './DocumentEditor';
import { RecoveryApprovals } from './RecoveryApprovals';
import { ChatAvatar } from './ChatAvatar';
import {CodingSessions} from './CodingSessions';
import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent, ReactNode } from 'react';
import type { ConversationsController, ModelOption } from './conversations';
import { splitAttached } from './conversations';
import { AgentPanel } from './AgentPanel';
import { ChangesPane, FilesPane } from './ProjectPanes';
import { PanesController } from './panes';
import { TerminalPrefsController, TerminalTabs } from './terminal';
import { TerminalPane } from './TerminalPane';
import { MicController } from './mic';
import type { PaneName } from './panes';
import type { SessionClient } from './session';
import { Markdown } from './markdown';
import { UiIcon } from './ui-icons';
import { ClaudeCodeIcon, CodexIcon, GeminiIcon } from './brand-icons';
import type { UiIconName } from './ui-icons';
import { approxTokens, duration, groupLabel, splitWork, toolCount, toolView, turnOutputs, turnPlan, turnSuggestions, withoutPlan, workGroups, workSegments, type WorkItem } from './turns';
import type { CardSuggestion, PlanStep } from './turns';
import { ChatCardsController, activityLine, cardDraftFrom } from './chat-board';
import type { ChatCard, ChatProgress } from './chat-board';
import type { Priority } from './board';
import { ChatMemoryController, messageRef, proposalsByRun, rememberDraft, MAX_REMEMBER } from './chat-memory';
import type { ChatMemory, RememberDrawer, RememberType } from './chat-memory';
import { drawerLabel } from './MemoryViews';
import { ChatRecallController } from './chat-recall';
import { ContextCard, HandoffCard, RecallChip, RecallPanel, SpeedDetails } from './ChatRecall';
import { MemoryMoveController } from './memory-move';
import { MoveDialog } from './MemoryDialogs';
import { exportConversation, exportNote } from './chat-export';
import { ContextMenu, Sheet, useMenu } from './desktop-ui';
import type { MenuItem } from './desktop-ui';
import { ContinueElsewhere, openChatWindow } from './chat-actions';
import { secretLabel, splitSecrets } from './chat-secrets';
import { SavedKeys } from './SavedKeys';
import type { Part, ToolCall, ToolKind, Turn } from './turns';

/** Pixels from the bottom within which the thread keeps following new text. */
export const FOLLOW_PX = 80;
/** How long a message opened from search stays highlighted. */
export const HIGHLIGHT_MS = 2400;
/** A busy turn with no new output for this long shows the working row. */
export const QUIET_MS = 1500;
/** In a long live step only the newest tool rows stay open; older ones fold. */
export const LIVE_ROWS = 4;


/**
 * The chat page: a reading column (the user's messages right-aligned in a
 * quiet bubble that stays pinned while its answer scrolls; the agent's work
 * as one-line rows; its answer as plain prose) and a docked composer. A
 * finished turn folds its work into "Worked for …". Behaviour lives in
 * ConversationsController; this file is layout and local view state only.
 */
export function ChatView({ embeddedCode=false, onOpenCode, controller, mode, productName = 'Girru', client, onAddConnector, onOpenCard, onOpenMemory, onChooseContext, onSetUpModel, onOpenApprovals, onOpenAgent, onOpenRules, terminalRequest = 0, boardRequest = 0, placeRequest = 0, active = true, titleSlot = null }: { embeddedCode?:boolean; onOpenCode?:(folder:string,file?:string)=>void; titleSlot?: HTMLElement | null; placeRequest?: number; controller: ConversationsController; mode: 'live' | 'mock'; productName?: string; terminalRequest?: number; boardRequest?: number; client?: SessionClient; onChooseContext?:()=>void; onAddConnector?: () => void; onSetUpModel?: () => void; onOpenApprovals?: () => void; onOpenAgent?: (agentId: string) => void; onOpenRules?: (agentId: string, category: string) => void; onOpenCard?: (boardId: string, cardId: string) => void; onOpenMemory?: (drawerId: string, memoryId: string) => void; active?: boolean }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [meetingMeta, setMeetingMeta] = useState<MeetingRecord | null>(null);
  const [meetingCall, setMeetingCall] = useState(false), [meetingStage, setMeetingStage] = useState<HTMLDivElement | null>(null);
  useEffect(() => { if (meetingCall) { setPane(null); setTermOpen(false); } }, [meetingCall]);
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [following, setFollowing] = useState(true);
  const [below, setBelow] = useState(false);
  const running = !!s.runId;
  const busy = running || s.starting;

  // Follow the newest output only while the reader is near the bottom.
  useLayoutEffect(() => {
    const el = thread.current;
    if (!el) return;
    if (following) el.scrollTop = el.scrollHeight;
    else setBelow(true);
  }, [s.turns]);
  // Opening another conversation starts at its end.
  useLayoutEffect(() => { const el = thread.current; if (el) el.scrollTop = el.scrollHeight; setFollowing(true); setBelow(false); }, [s.activeId, s.threadPhase === 'ready']);
  const onScroll = () => {
    const el = thread.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
    setFollowing(near);
    if (near) setBelow(false);
  };
  // CHAT-PRO-02 D: a search hit scrolls to its message and highlights it briefly.
  const [flash, setFlash] = useState<string | null>(null);
  useLayoutEffect(() => {
    const f = s.focus; const el = thread.current;
    if (!f || !el || s.threadPhase !== 'ready') return;
    controller.clearFocus();
    const target = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(n => n.dataset.messageId === f.messageId);
    if (!target) return;
    // Scroll only the thread (never the page around it). A user message is sticky,
    // so its place in the thread is measured with the stickiness off.
    const sticky = target.style.position;
    target.style.position = 'static';
    const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    target.style.position = sticky;
    el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    setFollowing(false);
    setFlash(f.messageId);
  }, [s.focus, s.threadPhase]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), HIGHLIGHT_MS); return () => clearTimeout(t); }, [flash]);
  const jump = () => { const el = thread.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); setFollowing(true); setBelow(false); };

  // The composer grows with its text up to a cap.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [s.draft]);
  useEffect(() => { input.current?.focus(); }, [s.activeId]);
  // CHAT-BUILD-01: a reply the server started by itself (after an approval) shows up when the window is back in front, or within 20 s.
  useEffect(() => {
    if (mode !== 'live' || !s.activeId) return;
    const refresh = () => { if (document.visibilityState === 'visible') void controller.refreshActive(); };
    const timer = setInterval(refresh, 20_000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [controller, mode, s.activeId]);
  // Coming back to the chat from another page (an approval allowed in Approvals) picks up the continued reply at once.
  useEffect(() => { if (mode === 'live' && active && s.activeId) void controller.refreshActive(); }, [controller, mode, active, s.activeId]);

  const submit = () => { if (s.draft.trim() || s.attachments.length) { setFollowing(true); void controller.send(); } };
  const picker = useRef<HTMLInputElement>(null);
  const [mic, setMic] = useState<MicController | null>(null);
  useEffect(() => {
    if (!client) return;
    const m = new MicController(client, text => { const d = controller.getSnapshot().draft; controller.edit(d.trim() ? `${d.replace(/\s+$/, '')} ${text}` : text); input.current?.focus(); });
    setMic(m); void m.check();
    return () => m.dispose();
  }, [client, controller]);
  const [longDraft,setLongDraft]=useState(false);
  const [attachmentPreview,setAttachmentPreview]=useState<string|null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    try {
      // CHAT-GAPS-01: images go to a model that can see; other binary files are still refused.
      const pics=[...list].filter(f=>/^image\/(png|jpeg|gif|webp)$/.test(f.type));
      if(pics.length){const read=await Promise.all(pics.map(f=>new Promise<{name:string;type:string;data:string}>((ok,no)=>{const r=new FileReader();r.onload=()=>ok({name:f.name,type:f.type,data:String(r.result).replace(/^data:[^,]*,/,'')});r.onerror=()=>no(r.error);r.readAsDataURL(f);})));setAttachError(controller.attachImages(read));if(pics.length===list.length){if(picker.current)picker.current.value='';return;}}
      if([...list].some(f=>!pics.includes(f)&&(/^(image|audio|video)\//.test(f.type)||/\.(pdf|zip|gz|png|jpe?g|gif|webp|mp4|mov|mp3|wav|svg)$/i.test(f.name)))){setAttachError('This chat attaches text and code files and PNG, JPEG, GIF or WebP images. PDFs and other binary files are not supported here yet.');return;}
      if([...list].some(f=>f.size>2_000_000)){setAttachError('Choose smaller text files. Each attachment can contain up to 60,000 characters.');return;}
      const files = await Promise.all([...list].filter(f=>!pics.includes(f)).map(async f => ({ name: f.name, text: await f.text() })));
      // CH3: the files that can be read are added; each one that cannot shows its reason in a red chip.
      const errors = files.map(f => controller.attach([f])).filter((e): e is string => !!e);
      setAttachError(errors.length ? errors.join(' · ') : null);
    } catch { setAttachError('The file could not be read.'); }
    if (picker.current) picker.current.value = '';
  };
  // CHAT-PRO-02 I: "@" at the start of a word suggests agents; picking one fills in its name.
  const mention = /(^|\s)@([^\s@]{0,40})$/.exec(s.draft);
  const suggestions = mention && s.agents.length > 1 ? s.agents.filter(a => a.name.toLowerCase().startsWith(mention[2].toLowerCase())).slice(0, 6) : [];
  const [pick, setPick] = useState(0);
  const choose = (name: string) => { if (!mention) return; controller.edit(`${s.draft.slice(0, s.draft.length - mention[2].length - 1)}@${name} `); setPick(0); input.current?.focus(); };
  // CHAT-BUILD-01 stage 3 (CH3): the composer's popovers, the chat's keys and "/" commands.
  const [popover, setPopover] = useState<'who' | 'model' | 'mode' | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [projectSheet, setProjectSheet] = useState<{ id: string | null; folder?: string } | null>(null);
  const slashQuery = /^\/[a-z]*$/.test(s.draft) ? s.draft : null;
  const slash = slashQuery ? slashMatches(slashQuery) : [];
  const runSlash = (c: string) => {
    controller.edit('');
    const last = [...s.turns].reverse().find(t => t.role === 'assistant' && t.status === 'complete');
    if (c === '/agent') setPopover('who');
    else if (c === '/model') setPopover('model');
    else if (c === '/export' && s.activeId) void controller.exportMarkdown(s.activeId);
    else if (c === '/remember' && last && canRemember) openRemember(last, last.content);
    else if (c === '/board' && owner && cardsCtl && s.activeId) openCardForm();
    // CH3: "/note" opens Details › Where we left off for editing (owner, an open chat with an agent to write it for).
    else if (c === '/note' && recallCtl && s.activeId && (convAgentId || s.agentId || s.agents[0]?.id)) { setPane('details'); setFocusPart(f => ({ id: 'memory', n: (f?.n ?? 0) + 1 })); setPick(0); void recallCtl.editHandoff(); return; }
    setPick(0); input.current?.focus();
  };
  useEffect(() => {
    if (!active) return;
    const key = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const hit = (fn: () => void) => { e.preventDefault(); fn(); };
      if (k === 'j' && !e.shiftKey) hit(() => setPopover(p => (p === 'who' ? null : 'who')));
      else if (k === 'm' && e.shiftKey) hit(() => setPopover(p => (p === 'model' ? null : 'model')));
      else if (k === 'p' && e.shiftKey) hit(() => setPopover(p => (p === 'mode' ? null : 'mode')));
      else if (k === 'u' && !e.shiftKey) hit(() => picker.current?.click());
      else if (k === 'e' && e.shiftKey) hit(() => setLongDraft(true));
      else if (k === '/') hit(() => setShortcutsOpen(v => !v));
      else if (k === 'n' && e.shiftKey && client?.getSnapshot().user?.role === 'owner') hit(() => setProjectSheet({ id: null }));
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [active, client]);
  // CH3: hold ⌥Space to dictate; letting go turns the speech into text. The keys never type a space into the box.
  useEffect(() => {
    if (!active || !mic) return;
    const down = (e: globalThis.KeyboardEvent) => { if (e.code !== 'Space' || !e.altKey || e.metaKey || e.ctrlKey || e.isComposing || ['unknown', 'off'].includes(mic.getSnapshot().phase)) return; e.preventDefault(); if (!e.repeat) mic.hold(); };
    const up = (e: globalThis.KeyboardEvent) => { if (e.code === 'Space' || e.key === 'Alt') mic.release(); };
    const blur = () => mic.release();
    window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', blur); mic.release(); };
  }, [active, mic]);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (slash.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setPick(p => (p + (e.key === 'ArrowDown' ? 1 : slash.length - 1)) % slash.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runSlash(slash[Math.min(pick, slash.length - 1)].c); return; }
    }
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setPick(p => (p + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(suggestions[Math.min(pick, suggestions.length - 1)].name); return; }
    }
    // CHAT-BUILD-01 stage 5 (CH10): while the agent works, Enter steers it now; ⌥Enter waits until it finishes.
    if (e.key === 'Enter' && !e.shiftKey && running && !e.altKey && s.draft.trim()) { e.preventDefault(); if (!e.repeat) void controller.steer(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!e.repeat) submit(); return; }
    if (e.key === 'Escape' && running) { e.preventDefault(); void controller.stop(); return; }
    if (e.key === 'ArrowUp' && !s.draft) { const last = controller.recall(); if (last) { e.preventDefault(); controller.edit(last); } }
  };

  const lastUser = [...s.turns].reverse().find(t => t.role === 'user');
  const agentName = s.agents.find(a => a.id === (meetingMeta ? s.replyAgent || s.agentId : s.agentId))?.name;
  const who = whoAnswers(s.model, s.models);
  const activeConv = s.conversations.find(c => c.id === s.activeId);
  const convAgentId = activeConv?.agentId ?? null;
  const nameOf = (id: string | null | undefined) => (id ? s.agents.find(a => a.id === id)?.name : s.agents.find(a => a.primary)?.name) ?? 'Main agent';
  const departmentOf = (id?: string | null) => (id ? s.agents.find(a => a.id === id) : s.agents.find(a => a.primary))?.department;
  const convAgentName = nameOf(convAgentId);
  const empty = s.turns.length === 0 && s.threadPhase !== 'loading';

  const project = controller.activeProject();
  // CHAT-BUILD-01 stage 4 (CH8): the side panel opens on Details; hidden, it is a thin rail. The terminal is its own panel under the chat.
  const [pane, setPane] = useState<PaneName | null>('details');
  const [codeExpanded,setCodeExpanded]=useState(false);
  useEffect(()=>{if(embeddedCode)setPane(null);},[embeddedCode]);
  const [focusPart, setFocusPart] = useState<{ id: PanelPart; n: number } | null>(null);
  const [termOpen, setTermOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [panes, setPanes] = useState<PanesController | null>(null);
  const [terminal, setTerminal] = useState<{ tabs: TerminalTabs; prefs: TerminalPrefsController } | null>(null);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => { if (!client) return; const p = new PanesController(client); setPanes(p); const t = { tabs: new TerminalTabs(client), prefs: new TerminalPrefsController(client) }; setTerminal(t); return () => { p.dispose(); t.tabs.dispose(); t.prefs.dispose(); }; }, [client]);
  const owner = client?.getSnapshot().user?.role === 'owner';
  useEffect(()=>{if(terminalRequest>0&&owner)setTermOpen(true);},[terminalRequest,owner]);
  // CH1/CH8c: the side panel on one of its parts (the faces open Team, the title bar's project name opens Place).
  const openPart = (id: PanelPart) => { setPane('details'); setFocusPart(f => ({ id, n: (f?.n ?? 0) + 1 })); };
  useEffect(() => { if (placeRequest > 0) openPart('place'); }, [placeRequest]);
  // CH3 ⇧⌘Z: the changes cards on screen register here, so the key redoes the newest undone one.
  const changeCards = useRef(new Map<string, { undone: boolean; redo: () => void }>()).current;
  // ⌥⌘I hides or shows the side panel, ⌃` the terminal, ⌘. stops everything in this chat.
  useEffect(() => {
    if (!active) return;
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey && e.altKey && e.code === 'KeyI') { e.preventDefault(); setPane(p => (p === 'details' ? null : 'details')); }
      // A narrow window shows the side panel over the chat: Esc closes it from anywhere (menus and sheets close first).
      else if (e.key === 'Escape' && !e.defaultPrevented && window.innerWidth <= 1100 && !document.querySelector('[role="dialog"], .dk-menu')) setPane(p => (p ? null : p));
      else if (e.ctrlKey && e.shiftKey && !e.metaKey && e.code === 'Backquote' && terminal && client?.getSnapshot().user?.role === 'owner') { e.preventDefault(); setTermOpen(true); terminal.tabs.add(); }
      else if (e.ctrlKey && !e.metaKey && e.code === 'Backquote' && terminal && client?.getSnapshot().user?.role === 'owner') { e.preventDefault(); setTermOpen(v => !v); }
      else if ((e.metaKey || e.ctrlKey) && e.key === '.' && controller.getSnapshot().activeId) { e.preventDefault(); void controller.stopAll(); }
      // ⌥⌘N (Ctrl+Alt+N): a new chat in this chat's project, like the sidebar's "New chat here" (⌥ changes e.key on a Mac, so the key's code is read).
      else if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === 'KeyN') { e.preventDefault(); const snap = controller.getSnapshot(); controller.newChatIn(snap.conversations.find(c => c.id === snap.activeId)?.projectId ?? snap.projectFilter ?? ''); input.current?.focus(); }
      else chatKeys(e);
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [active, terminal, client, controller]);
  // CH1: keys for the open chat — ⌘P pin, ⇧⌘S export, ⌘⌫ archive, ⌥⌘⌫ delete (asks), ⇧⌘C copy the last reply.
  const chatKeys = (e: globalThis.KeyboardEvent) => {
    const snap = controller.getSnapshot(), id = snap.activeId, conv = snap.conversations.find(c => c.id === id);
    if (!id || !conv || !(e.metaKey || e.ctrlKey)) return;
    const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    const k = e.key.toLowerCase(), hit = (fn: () => void) => { e.preventDefault(); fn(); };
    if (k === 'p' && !e.shiftKey && !e.altKey) hit(() => void controller.pin(id, !conv.pinned));
    else if (k === 's' && e.shiftKey && !e.altKey) hit(() => setExportKey(Date.now()));
    else if (k === 'backspace' && !typing) hit(() => (e.altKey ? setChatSheet('delete') : void controller.archive(id, !conv.archived)));
    // ⇧⌘Z (Ctrl+Shift+Z) redoes the newest undone file change; in a text box it stays the system's redo, and with nothing undone it does nothing.
    else if (k === 'z' && e.shiftKey && !e.altKey && !typing) { const target = redoTarget(snap.turns, changeCards); if (target) hit(() => changeCards.get(target)?.redo()); }
    else if (k === 'c' && e.shiftKey && !e.altKey) {
      const last = [...snap.turns].reverse().find(t => t.role === 'assistant' && t.content);
      if (last && navigator.clipboard) hit(() => void navigator.clipboard.writeText(last.content).catch(() => undefined));
    }
  };
  const [keysOpen, setKeysOpen] = useState<string | null>(null);
  // CHAT-PRO-02 I step 2: board cards made from this conversation.
  const [cardsCtl, setCardsCtl] = useState<ChatCardsController | null>(null);
  useEffect(() => { if (!client) return; const c = new ChatCardsController(client); setCardsCtl(c); return () => c.dispose(); }, [client]);
  useEffect(() => { cardsCtl?.setConversation(s.activeId); }, [cardsCtl, s.activeId]);
  // A reply that ends may have moved the work on; read the cards again.
  const wasRunning = useRef(false);
  // CHAT-PRO-02 E: memories from this conversation ("Remember this", agent proposals).
  const [memCtl, setMemCtl] = useState<ChatMemoryController | null>(null);
  useEffect(() => { if (!client) return; const m = new ChatMemoryController(client); setMemCtl(m); return () => m.dispose(); }, [client]);
  useEffect(() => { memCtl?.setConversation(s.activeId); setRemember(null); }, [memCtl, s.activeId]);
  // A memory decided elsewhere (Memory › Review, Approvals, another window) shows here when the chat is seen again.
  useEffect(() => { if (active) void memCtl?.refresh(); }, [active, memCtl]);
  useEffect(() => {
    if (!memCtl || typeof document === 'undefined') return;
    const again = () => { if (document.visibilityState === 'visible' && active) void memCtl.refresh(); };
    document.addEventListener('visibilitychange', again); window.addEventListener('focus', again);
    return () => { document.removeEventListener('visibilitychange', again); window.removeEventListener('focus', again); };
  }, [memCtl, active]);
  const mem = useSyncExternalStore(memCtl ? memCtl.subscribe : noopSubscribe, memCtl ? memCtl.getSnapshot : nullSnapshot, memCtl ? memCtl.getSnapshot : nullSnapshot);
  // MEM-UI-01 (board M5): what each reply remembered, and the conversation's handoff.
  const [recallCtl, setRecallCtl] = useState<ChatRecallController | null>(null);
  useEffect(() => { if (!client || !owner) return; const r = new ChatRecallController(client); setRecallCtl(r); return () => r.dispose(); }, [client, owner]);
  useEffect(() => { recallCtl?.setConversation(s.activeId); }, [recallCtl, s.activeId]);
  // Board M15 → M13: a reply's "Wrong place" opens the move dialog; the reply then shows "moved".
  const [moveCtl, setMoveCtl] = useState<MemoryMoveController | null>(null);
  useEffect(() => { if (!client || !owner || !recallCtl) return; const m = new MemoryMoveController(client, (id, drawer) => recallCtl.moved(id, drawer)); setMoveCtl(m); return () => m.dispose(); }, [client, owner, recallCtl]);
  const [remember, setRemember] = useState<RememberSeed | null>(null);
  const canRemember = owner && !!memCtl && !!s.activeId;
  const openRemember = (t: Turn, text: string) => { const ref = messageRef(t); if (ref) setRemember({ ref, text: rememberDraft(text), key: Date.now() }); };
  // ⌘⇧R / Ctrl+Shift+R: Remember this — the last reply (or the last message) of the open chat (board M28).
  useEffect(() => {
    if (!active || !canRemember) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== 'r') return;
      const last = [...s.turns].reverse().find(t => messageRef(t) && t.content.trim());
      if (!last) return;
      e.preventDefault(); openRemember(last, last.content);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [active, canRemember, s.turns]);
  const byRun = proposalsByRun(mem?.memories ?? [], s.turns);
  useEffect(() => { if (wasRunning.current && !running) { void cardsCtl?.refresh(); void memCtl?.refresh(); } wasRunning.current = running; }, [running, cardsCtl, memCtl]);
  const [cardForm, setCardForm] = useState<CardFormSeed | null>(null);
  const openCardForm = (seed?: CardSuggestion) => {
    const draft = cardDraftFrom(s.turns, activeConv?.title ?? null);
    const ids = (seed?.agents ?? []).map(n => s.agents.find(a => a.name.toLowerCase() === n.toLowerCase() || a.id === n)?.id).filter((x): x is string => !!x);
    setCardForm({ title: seed?.title ?? draft.title, description: seed ? [seed.description, draft.description].filter(Boolean).join('\n\n') : draft.description, agents: ids, priority: seed?.priority ?? 'normal', key: Date.now() });
  };
  // The agent's face beside the conversation (GenVR avatar frame); remembered on this device.
  const avatarOn = useSyncExternalStore(avatarShown.subscribe, avatarShown.get, avatarShown.get);
  const toggleAvatar = avatarShown.toggle;
  const folderProject = project?.folder ? project.id : null;
  useEffect(() => { panes?.setProject(folderProject); }, [panes, folderProject]);
  const paneButtons: { name: PaneName; icon: UiIconName; label: string }[] = [
    { name: 'details', icon: 'info', label: 'Details' },
    ...(panes ? [{ name: 'changes' as const, icon: 'diff' as const, label: 'Changes' }, { name: 'files' as const, icon: 'folder' as const, label: 'Files' }] : []),
  ];
  const previewFile=s.attachments.find(f=>f.name===attachmentPreview);
  // CHAT-BUILD-01 follow-up (CH5): ⋯ "More for this chat" — the rest of the chat's actions live here.
  const moreMenu = useMenu();
  const [exportKey, setExportKey] = useState(0);
  const [chatSheet, setChatSheet] = useState<'rename' | 'delete' | 'continue' | null>(null);
  const canBoard = owner && !!cardsCtl && !!s.activeId;
  // Add to board from the chat list's right-click: the chat opens, then its card form.
  useEffect(() => { if (boardRequest > 0 && canBoard) openCardForm(); }, [boardRequest]);
  const rememberAll = () => {
    const last = [...s.turns].reverse().find(t => t.role === 'assistant' && t.status === 'complete');
    if (!last) return;
    openRemember(last, s.turns.filter(t => t.content.trim()).map(t => `${t.role === 'user' ? 'You' : nameOf(t.agentId ?? convAgentId)}: ${t.content.trim()}`).join('\n\n'));
  };
  const openChatCode=async()=>{if(!onOpenCode)return;if(!await controller.ensureCodeConversation())return;const folder=controller.activeProject()?.folder??await controller.editorDirectory();if(folder)onOpenCode(folder);};
  const moreItems = (): MenuItem[] => {
    if (!s.activeId || !activeConv) return [];
    const id = s.activeId;
    return [
      { label: 'Rename', icon: 'pencil', run: () => setChatSheet('rename') },
      { label: activeConv.pinned ? 'Unpin' : 'Pin', icon: 'pin', shortcut: '⌘P', run: () => void controller.pin(id, !activeConv.pinned) },
      ...(s.projects.length ? ['sep' as const, ...[{ id: '', name: 'No project' }, ...s.projects].map(p => ({ label: p.id ? `Move to ${p.name}` : 'Move out of the project', icon: 'folder' as const, checked: (activeConv.projectId ?? '') === p.id, run: () => void controller.moveToProject(id, p.id) }))] : []),
      'sep',
      { label: 'Open in a new window', icon: 'open', shortcut: '⌘O', run: () => openChatWindow(id) },
      ...(onOpenCode ? [{label:'Open in Code',icon:'code' as const,run:()=>void openChatCode()}] : []),
      { label: 'Continue in another folder…', icon: 'folder', run: () => setChatSheet('continue') },
      { label: 'Export…', icon: 'download', shortcut: '⇧⌘S', run: () => setExportKey(Date.now()) },
      ...(mode === 'live' ? [{ label: avatarOn ? 'Hide the avatar' : 'Show the agent as an avatar', icon: 'avatar' as const, checked: avatarOn, run: toggleAvatar }] : []),
      ...(canRemember ? [{ label: 'Remember the whole chat', icon: 'brain' as const, disabled: !s.turns.some(t => t.role === 'assistant' && t.status === 'complete'), run: rememberAll }] : []),
      'sep',
      { label: 'Delete…', icon: 'trash', danger: true, shortcut: '⌥⌘⌫', run: () => setChatSheet('delete') },
    ];
  };
  useEffect(() => {
    if (!active) return;
    const key = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.target instanceof HTMLElement && e.target.closest('[contenteditable="true"], .document-editor')) return;
      const k = e.key.toLowerCase();
      if (k === 'o' && s.activeId) { e.preventDefault(); openChatWindow(s.activeId); }
      else if (k === 'b' && canBoard) { e.preventDefault(); if (cardForm) setCardForm(null); else openCardForm(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });
  // CHAT-BUILD-01 stage 5: what the trust moments in the thread need (approvals, undo, switch to Auto, start fresh).
  // CH6: while a reply works, the step each delegated agent is on (read every 3 s from the chat's team).
  const [steps, setSteps] = useState<readonly { agentId: string; tool: string; at: string }[]>([]);
  useEffect(() => {
    if (!client || !s.activeId || !s.runId) { setSteps([]); return; }
    let on = true; const id = s.activeId;
    const read = async () => { try { const r = await client.request({ method: 'GET', path: `/api/chat/conversations/${id}/team` } as never); if (on && r.status === 200) setSteps(((r.body as { steps?: { agentId: string; tool: string; at: string }[] }).steps) ?? []); } catch { /* the card keeps "Thinking…" */ } };
    void read(); const t = setInterval(() => void read(), 3000);
    return () => { on = false; clearInterval(t); };
  }, [client, s.activeId, s.runId]);
  const moments = { client, conversationId: s.activeId, onOpenApprovals, steps, changeCards, nativeCode:embeddedCode,
    // CH6/CH10 team moments: Hand it again adds to the box (never sends), Set a model opens the agent, Always allow opens What agents may do.
    onOpenAgent, onOpenRules, onDraft: (text: string) => { const d = controller.getSnapshot().draft.trim(); controller.edit(d ? `${d}\n\n${text}` : text); },
    agentAbout: (id?: string) => s.agents.find(a => a.id === id)?.about, subAgentOf: (id?: string) => s.agents.find(a => a.id === id)?.subAgentOf, onStop: () => void controller.stopAll(), agentName: (id?: string) => (id ? s.agents.find(a => a.id === id)?.name ?? id : nameOf(convAgentId)),
    onSwitchAuto: () => controller.selectModel('auto'), onReviewChanges: () => setPane('changes'), onChanged: () => void controller.refreshGit(), onDecided: () => void controller.pickUpContinuation(),
    onStartFresh: (summary: string) => { const title = activeConv?.title ?? 'the last chat'; controller.newChat(); controller.edit(`Continue from “${title}”. ${summary}`.slice(0, 4000)); } };
  return <MomentsContext.Provider value={moments}><div className="chat-layout" data-code-expanded={embeddedCode&&codeExpanded||undefined} data-panel={pane ?? 'rail'} data-empty={empty || undefined} data-max={(maximized && termOpen) || undefined}>
  {embeddedCode&&<CodeChatResize onResize={()=>setCodeExpanded(false)}/>}
  <div className="chat-screen" onDragOver={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();}} onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();void onFiles(e.dataTransfer.files);}}}>
    {embeddedCode&&<div className="code-chat-heading"><strong>{activeConv?.title||'Chat'}</strong><button type="button" className="tool" aria-label={codeExpanded?'Narrow chat':'Expand chat'} aria-expanded={codeExpanded} title={codeExpanded?'Narrow chat':'Expand chat'} onClick={()=>setCodeExpanded(v=>!v)}><UiIcon name="expand" size={14}/></button></div>}
    {/* CH1: the chat's tools sit in the window's title bar (Terminal · Add to board · ⋯ · side panel); no second bar. */}
    {active && titleSlot && createPortal(<span className="chat-title-tools" role="toolbar" aria-label="This chat">
      {pane === null && s.activeId && s.turns.length > 0 && <TitleFaces names={chatPeople(s.turns, convAgentId, nameOf)} onOpen={() => openPart('team')}/>}
      {client && s.activeId && s.threadPhase !== 'loading' && <ExportMenu key={s.activeId} client={client} conversationId={s.activeId} disabled={running} openKey={exportKey} bare/>}
      {terminal && owner && <button type="button" className="tool" aria-pressed={termOpen} aria-label="Terminal" title={termOpen ? 'Hide the terminal (⌃`)' : 'Terminal (⌃`)'} onClick={() => setTermOpen(v => !v)}><UiIcon name="terminal" size={15}/></button>}
      {onOpenCode && <button type="button" className="tool" aria-label="Open in Code" title="Open this project in Code" onClick={()=>void openChatCode()}><UiIcon name="code" size={15}/></button>}
      {canBoard && <button type="button" className="tool chat-to-board" onClick={() => cardForm ? setCardForm(null) : openCardForm()} aria-pressed={!!cardForm} aria-label="Add to board" title="Add to board (⌘B)">
        <UiIcon name="board" size={15}/></button>}
      {s.activeId && activeConv && <button type="button" className="tool chat-more" aria-label="More for this chat" title="Rename · Pin · Move to project · Export · Remember the whole chat · Delete…" aria-haspopup="menu"
        onClick={e => moreMenu.at(e, moreItems())}><UiIcon name="more" size={15}/></button>}
      <button type="button" className="tool" aria-pressed={pane !== null} aria-label={pane !== null ? 'Hide the side panel' : 'Show the side panel'} title={pane !== null ? 'Hide the side panel (⌥⌘I)' : 'Show the side panel (⌥⌘I)'}
        onClick={() => setPane(p => p === null ? 'details' : null)}><UiIcon name="inspector" size={15}/></button>
    </span>, titleSlot)}
    {!embeddedCode && mode === 'live' && client && client.getSnapshot().user?.role === 'owner' && <Meetings key={s.activeId ?? 'new'} client={client} controller={controller} active={active} onMeetingChanged={setMeetingMeta} callTarget={meetingStage} onCallChanged={setMeetingCall} onOpenCard={onOpenCard}/>}
    <MeetingPanels active={meetingCall} onStage={setMeetingStage}>
    {mode === 'live' && avatarOn && !meetingMeta && <ChatAvatar turns={s.turns} agentId={convAgentId ?? s.agentId ?? ''} agentName={nameOf(convAgentId ?? s.agentId)} onClose={toggleAvatar}/>}
    <div className="chat-thread" ref={thread} onScroll={onScroll} aria-label="Conversation">
      {s.threadPhase === 'loading' && <p className="chat-loading" role="status"><span className="pulse" aria-hidden="true"/>Opening the conversation</p>}
      {empty ? <div className="chat-empty">
        {/* CHAT-BUILD-01 stage 3 (CH5): one sentence and three ideas. */}
        <span className="chat-empty-tile" aria-hidden="true"><UiIcon name="message" size={22}/></span>
        <h2 className="chat-wordmark">{embeddedCode?'What are we working on?':'What should the team do?'}</h2>
        <p className="chat-tagline">{mode === 'mock'
          ? 'Offline practice: replies are fictional and nothing leaves this page.'
          : embeddedCode ? 'Ask about this project, review changes, or work with your agent.' : 'Write it the way you would tell a person. The team picks who does what.'}</p>
        {/* CH5 first run: nothing on this computer can answer yet (no local model, no key, no signed-in coding app). */}
        {mode === 'live' && owner && s.modelsLoaded && s.models.length === 0 && onSetUpModel && <div className="first-run-card" role="note">
          <UiIcon name="cpu" size={20}/>
          <b>Your team needs a model to think with</b>
          <span>Girru found no model on this computer yet. Sign in to Claude Code or Codex, or set up a free local model.</span>
          <span className="first-run-actions"><button type="button" className="primary" onClick={onSetUpModel}>Use a coding app…</button>
            <button type="button" className="ghost-action" onClick={onSetUpModel}>Local model…</button></span>
        </div>}
      </div> : <div className="chat-column" role="log" aria-live="polite" aria-relevant="additions">
        {s.hasEarlier && <button type="button" className="ghost-action chat-earlier" disabled={s.loadingEarlier} onClick={() => void controller.loadEarlier()}>{s.loadingEarlier ? 'Loading earlier messages…' : 'Show earlier messages'}</button>}
        {s.turns.map((t, i) => t.role === 'user'
          ? <UserMessage key={t.key} turn={t} highlight={flash === t.key} onKey={client ? setKeysOpen : undefined} onEdit={running ? undefined : text => { controller.edit(text); input.current?.focus(); }} onRemember={canRemember && messageRef(t) ? () => openRemember(t, t.content) : undefined}/>
          : <AssistantTurn recovery={t.code === 'run_interrupted' && client && s.activeId ? <RecoveryApprovals key={`${s.activeId}:${client.getSnapshot().epoch}`} client={client} conversationId={s.activeId}/> : undefined} key={t.key} turn={t} highlight={flash === t.key} writer={nameOf(t.agentId ?? convAgentId)} writerDepartment={departmentOf(t.agentId ?? convAgentId)} writerRole={s.agents.find(a => a.id === (t.agentId ?? convAgentId))?.primary || (!(t.agentId ?? convAgentId) && s.agents.some(a => a.primary)) ? 'main agent' : undefined} last={i === s.turns.length - 1} onRetry={lastUser ? () => void controller.send(t.code === 'run_interrupted' ? 'Continue the interrupted work from the saved checkpoints. Review what is already done and inspect unknown outcomes before repeating any action. Ask me to approve each tool call.' : lastUser.content) : undefined}
            onSuggest={owner && cardsCtl && s.activeId ? openCardForm : undefined} onRemember={canRemember && messageRef(t) ? text => openRemember(t, text) : undefined}
            proposals={t.runId && memCtl ? <MemoryProposals controller={memCtl} items={byRun.get(t.runId) ?? []}/> : null} recall={recallCtl} onWrongPlace={moveCtl ? m => void moveCtl.open(m) : undefined}/>)}
        {moveCtl && <MoveDialog c={moveCtl} from="From a reply’s “wrong place”"/>}
        {cardsCtl && <ChatCards controller={cardsCtl} nameOf={id => s.agents.find(a => a.id === id)?.name ?? 'Former agent'} onOpen={onOpenCard}/>}
        {s.starting && !s.turns.some(t => t.status === 'running') && <WorkingRow since={Date.now()} label="Starting"/>}
      </div>}
    </div>
    {client && keysOpen !== null && <SavedKeys client={client} owner={owner} highlight={keysOpen || undefined} onClose={() => setKeysOpen(null)}/>}
    {below && !empty && <button type="button" className="chat-jump" onClick={jump} aria-label="Jump to the latest message"><UiIcon name="arrow-down" size={15}/></button>}
    {previewFile&&<DocumentEditor title="Attached file" files={[{id:previewFile.name,name:previewFile.name,content:previewFile.text,readOnly:true}]} maxLength={60000} onChange={()=>{}} onClose={()=>setAttachmentPreview(null)}/>}
    {shortcutsOpen && <KeysSheet onClose={() => setShortcutsOpen(false)}/>}
    {projectSheet && <ProjectSheet controller={controller} id={projectSheet.id} folder={projectSheet.folder} onClose={() => setProjectSheet(null)}/>}
    {longDraft&&<DocumentEditor title="Message draft" files={[{id:'message',name:'message.md',content:s.draft}]} maxLength={100000} onChange={(_,text)=>controller.edit(text)} onClose={()=>setLongDraft(false)}/>}
    <div className="chat-dock">
      <TaskList turns={s.turns} who={nameOf(convAgentId)} waits={activeConv?.waiting ?? 0}/>
      {s.notice && <p className="chat-notice" role="status">{s.notice}</p>}
      {mem?.notice && !remember && <p className="chat-notice" role="status">{mem.notice} <button type="button" className="link-button" onClick={() => memCtl?.clearNotice()}>OK</button></p>}
      <ContextMenu menu={moreMenu.menu} onClose={moreMenu.close}/>
      {chatSheet === 'continue' && s.activeId && <ContinueElsewhere controller={controller} chatId={s.activeId} onDone={() => setChatSheet(null)}/>}
      {chatSheet === 'rename' && activeConv && <RenameSheet title={activeConv.title ?? ''} onClose={() => setChatSheet(null)} onSave={t => { void controller.rename(activeConv.id, t); setChatSheet(null); }}/>}
      {chatSheet === 'delete' && activeConv && <Sheet title="Delete this chat?" onClose={() => setChatSheet(null)} actions={<>
        <button type="button" autoFocus onClick={() => setChatSheet(null)}>Keep</button>
        <button type="button" className="danger" onClick={() => { void controller.remove(activeConv.id); setChatSheet(null); }}>Delete</button></>}>
        <p>“{activeConv.title || 'New chat'}” and its messages are deleted for good. To keep it out of the way instead, archive it from the sidebar.</p></Sheet>}
      {remember && memCtl && <RememberForm key={remember.key} controller={memCtl} seed={remember} project={project?.name ?? null} agent={convAgentName} onClose={() => setRemember(null)}/>}
      {cardForm && cardsCtl && <ChatCardForm key={cardForm.key} controller={cardsCtl} seed={cardForm} agents={s.agents} onClose={() => setCardForm(null)}/>}
      {s.reconnecting && <p className="chat-notice" role="status">Reconnecting to the reply…</p>}
      {s.elsewhere && s.queue.length > 0 && !s.queuePaused && <p className="chat-notice" role="status">This chat is working in another window. Your message waits until it is done.</p>}
      {s.queuePaused && s.queue.length > 0 && <p className="chat-notice" role="status">Stopped. The waiting {s.queue.length === 1 ? 'message stays' : 'messages stay'} here until you send {s.queue.length === 1 ? 'it' : 'them'}.</p>}
      {s.queue.length > 0 && <ul className="chat-queue" aria-label="Waiting to send">
        {s.queue.map((q, i) => <li key={q.key}>
          <span className="chat-queue-n">{i === 0 ? 'Next' : `${i + 1}.`}</span>
          <span className="chat-queue-text" dir="auto">{q.text}</span>
          {s.queuePaused && !busy && <button type="button" className="ghost-action strong" onClick={() => controller.sendQueued(q.key)}>Send now</button>}
          <button type="button" className="ghost-action" onClick={() => controller.editQueued(q.key)}>Edit</button>
          <button type="button" className="ghost-action" aria-label="Remove from the queue" onClick={() => controller.removeQueued(q.key)}><UiIcon name="trash" size={13}/></button>
        </li>)}
      </ul>}

      <form className="chat-composer" method="post" onSubmit={e => { e.preventDefault(); submit(); }}
        onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void onFiles(e.dataTransfer.files); } }}>
        <label htmlFor="chat-input" className="sr-only">Message</label>
        {/* CH3: files sit above the text, inside the box. */}
        {(s.attachments.length > 0 || s.images.length > 0 || attachError) && <div className="chat-attachments" aria-label="Attached files">
          {s.images.map(i => <span key={i.key} className="attach-chip image" dir="ltr"><img src={`data:${i.type};base64,${i.data}`} alt="" className="attach-thumb"/><span className="attach-name">{i.name}</span>
            <button type="button" className="row-tool" aria-label={`Remove ${i.name}`} onClick={() => controller.detachImage(i.key)}><UiIcon name="close" size={11}/></button></span>)}
          {s.attachments.map(f => <span key={f.name} className="attach-chip" dir="ltr"><button type="button" className="attachment-preview" title={`Read ${f.name}`} onClick={()=>setAttachmentPreview(f.name)}><UiIcon name="file" size={12}/>{f.name}</button><small>{Math.ceil(f.text.length / 1024)} KB</small>
            <button type="button" className="row-tool" aria-label={`Remove ${f.name}`} onClick={() => controller.detach(f.name)}><UiIcon name="close" size={11}/></button></span>)}
          {attachError && <span className="attach-chip bad" role="alert"><UiIcon name="alert" size={13}/><span className="attach-name">{attachError}</span></span>}
        </div>}
        {slash.length > 0 && <SlashList query={slashQuery!} index={pick} onPick={runSlash}/>}
        {suggestions.length > 0 && <ul className="mention-list" role="listbox" aria-label="Agents">{suggestions.map((a, i) =>
          <li key={a.id} role="option" aria-selected={i === Math.min(pick, suggestions.length - 1)}><button type="button" onMouseDown={e => { e.preventDefault(); choose(a.name); }}>
            <span className="avatar" aria-hidden="true">{a.name.slice(0, 1).toUpperCase()}</span>{a.name}<DepartmentBadge department={a.department} compact/></button></li>)}</ul>}
        <textarea id="chat-input" ref={input} rows={1} dir="auto" value={s.draft} maxLength={100000}
          placeholder={running ? 'Steer the work now, or ⌥Enter to send it after this reply' : agentName ? `Message ${agentName}` : s.turns.length ? 'Reply, or type @ to bring in a teammate…' : 'Ask anything, add files, or type @…'}
          onChange={e => controller.edit(e.target.value)} onPaste={e=>{if(e.clipboardData.files.length){e.preventDefault();void onFiles(e.clipboardData.files);}}} onKeyDown={onKeyDown} disabled={s.access === 'denied'}/>
        <div className="chat-composer-row">
          <input ref={picker} type="file" multiple hidden onChange={e => void onFiles(e.target.files)}
            accept=".txt,.md,.csv,.json,.yml,.yaml,.xml,.toml,.ini,.log,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.php,.sh,.sql,.html,.css,text/*,image/png,image/jpeg,image/gif,image/webp"/>
          {!s.activeId && onChooseContext && <ProjectChip controller={controller} onNewProject={folder => setProjectSheet({ id: null, folder })}/>}
          <PlusButton onFiles={() => picker.current?.click()} onLong={() => setLongDraft(true)}/>
          <ModeButton value={s.mode} onChange={m => void controller.setMode(m)} open={popover === 'mode'} setOpen={v => setPopover(v ? 'mode' : null)}/>
          <span className="composer-spacer"/>
          {!meetingMeta && s.agents.length > 0 && <WhoButton team={{ id: '', name: (s.activeId ? convAgentName : s.agents.find(a => a.primary)?.name) ?? 'Main agent', department: departmentOf(convAgentId) }}
            agents={s.agents.filter(a => s.activeId ? (a.id !== convAgentId && !(a.primary && !convAgentId)) : !a.primary).map(a => ({ id: a.id, name: a.name, department: a.department }))}
            value={s.activeId ? s.replyAgent : s.agentId} label={s.activeId ? convAgentName : 'Team'}
            onChange={id => (s.activeId ? controller.setReplyAgent(id) : controller.selectAgent(id))} open={popover === 'who'} setOpen={v => setPopover(v ? 'who' : null)}/>}
          {owner && <ModelButton controller={controller} open={popover === 'model'} setOpen={v => setPopover(v ? 'model' : null)}/>}
          {mic && <MicButton mic={mic}/>}
          {running && !s.draft.trim()
            ? <button type="button" className="round-button stop" onClick={() => void controller.stop()} disabled={s.stopping} aria-label={s.stopping ? 'Stopping' : 'Stop the reply'}><UiIcon name="stop" size={10}/></button>
            : <button type="submit" className="round-button" disabled={(!s.draft.trim() && !s.attachments.length) || s.access === 'denied'} aria-label={busy ? 'Queue the message' : 'Send'}><UiIcon name="arrow-up" size={15}/></button>}
        </div>
      </form>
      {client && owner && mode === 'live' && !meetingMeta && <ChatVoice client={client} controller={controller} active={active}/>}
    </div>
    </MeetingPanels>
    {terminal && termOpen && <section className="chat-terminal" aria-label="Terminal"><TerminalPane tabs={terminal.tabs} prefs={terminal.prefs} projectId={folderProject} maximized={maximized} onToggleMax={() => setMaximized(v => !v)} onClose={() => { setMaximized(false); setTermOpen(false); }}/></section>}
  </div>
  {pane === 'details' ? <ChatDetails controller={controller} client={client} recall={recallCtl} onSettings={onAddConnector} onSignIn={onSetUpModel} onClose={() => setPane(null)}
      memoryCard={s.activeId ? <>{recallCtl && <HandoffCard c={recallCtl} agentId={convAgentId || s.agentId || s.agents[0]?.id || ''} agentName={convAgentName}/>}{memCtl && <ChatMemoryCard controller={memCtl} onOpen={onOpenMemory}/>}</> : undefined}
      resultsExtra={project?.folder && s.git?.branch ? <GitHubCard git={s.git} pr={owner && client ? { client, projectId: project.id } : undefined} onRefresh={() => void controller.refreshGit()}/> : undefined}
      placeExtra={client && owner && project?.folder ? <details className="details-more"><summary>Coding sessions in this folder</summary><CodingSessions key={project.id + ':' + project.folder} client={client} controller={controller} folder={project.folder}/></details> : undefined}
      onOpenPane={p => (p === 'terminal' ? setTermOpen(true) : setPane(p))} onStop={() => void controller.stopAll()}
      onSchedule={() => setScheduleOpen(true)} onAddFolder={() => project && setProjectSheet({ id: project.id })} onContinue={() => setChatSheet('continue')} focusPart={focusPart}
      switcher={<PaneSwitch items={paneButtons} pane={pane} onPane={setPane}/>}/>
    : pane === null && !embeddedCode && <DetailsRail controller={controller} onOpen={openPart}/>}
  {scheduleOpen && client && s.activeId && <ScheduleSheet client={client} chatId={s.activeId} onClose={() => setScheduleOpen(false)}/>}
  {panes && (pane === 'changes' || pane === 'files') && <aside className="chat-panel chat-pane" aria-label={pane === 'changes' ? 'Changes' : 'Files'} onKeyDown={e => { if (e.key === 'Escape') setPane(null); }}><PaneSwitch items={paneButtons} pane={pane} onPane={setPane}/>
    {pane === 'changes' ? <ChangesPane panes={panes}/> : <FilesPane panes={panes} onOpenCode={onOpenCode&&project?.folder?file=>onOpenCode(project.folder!,file):undefined}/>}
  </aside>}

  </div></MomentsContext.Provider>;
}

const TERMINAL_APPS = [{ id: 'subscription:claude', label: 'Claude Code' }, { id: 'subscription:codex', label: 'Codex' }, { id: 'subscription:gemini', label: 'Google Gemini' }] as const;
type TerminalApp = (typeof TERMINAL_APPS)[number];

function AppIcon({ id, size }: { id: string; size: number }) {
  if(id === 'subscription:gemini')return <GeminiIcon size={size}/>;
  return id === 'subscription:claude' ? <ClaudeCodeIcon size={size}/> : <CodexIcon size={size}/>;
}

/** Which coding app answers (if any), with its chosen model: `subscription:<app>[:<session>][/<model>]`. */
export function whoAnswers(model: string, models: readonly ModelOption[]): { app: TerminalApp | null; base: string; variant: string; text: string } {
  const [base, variant = ''] = model.split('/');
  const app = model.startsWith('subscription:') ? TERMINAL_APPS.find(a => base === a.id || base.startsWith(`${a.id}:`)) ?? null : null;
  if (!app) return { app: null, base: '', variant: '', text: '' };
  const label = variant ? models.find(m => m.id === app.id)?.variants?.find(v => v.id === variant)?.label ?? variant : '';
  return { app, base, variant, text: [app.label, base !== app.id ? 'previous session' : '', label].filter(Boolean).join(' · ') };
}



function SessionDisclosure({title,icon,summary,children}:{title:string;icon:UiIconName;summary?:ReactNode;children:ReactNode}){return <details className="session-disclosure"><summary><UiIcon name={icon} size={15}/><span>{title}</span>{summary&&<small>{summary}</small>}<UiIcon name="chevron" size={12}/></summary><div className="session-disclosure-body">{children}</div></details>;}

function ContextUsage({c,keys}:{c:ChatRecallController;keys:readonly string[]}){useSyncExternalStore(c.subscribe,c.getSnapshot,c.getSnapshot);const trace=c.latest(keys);if(!trace||!trace.context.numCtx||!trace.context.promptTokens)return <span>No measurement</span>;const value=Math.min(100,Math.round(trace.context.promptTokens/trace.context.numCtx*100));return <span className="session-context-usage"><span>{value}%</span><meter min={0} max={100} value={value} aria-label="Measured context window usage" title={`${trace.context.promptTokens.toLocaleString()} of ${trace.context.numCtx.toLocaleString()} tokens`}/></span>;}

/** Details › Context of the newest reply that has a trace. */
function RecallContext({ c, keys }: { c: ChatRecallController; keys: readonly string[] }) {
  useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  return <ContextCard trace={c.latest(keys)} c={c}/>;
}

/** The branch against GitHub: upstream, ahead/behind (last known state, offline), last commit, links to open on github.com. */
function GitHubCard({ git, pr, onRefresh }: { git: NonNullable<ReturnType<ConversationsController['getSnapshot']>['git']>; pr?: { client: SessionClient; projectId: string }; onRefresh: () => void }) {
  const gh = git.github;
  const live = usePullRequest(gh && git.upstream ? pr : undefined, git.branch);
  const when = git.lastCommit?.date ? new Date(git.lastCommit.date) : null;
  // CH8: the branch, its pull request, the repository and the last commit as quiet rows (tile · name · one muted line).
  const sync = git.upstream ? `${git.upstream}${git.ahead !== null && git.ahead !== undefined ? ` · ↑${git.ahead} ↓${git.behind ?? 0}` : ''}` : 'Not on GitHub yet (never pushed)';
  const note = [git.upstream && (git.ahead ?? 0) > 0 ? `${git.ahead} ${git.ahead === 1 ? 'commit is' : 'commits are'} only on this computer. Pushing is your call.` : '',
    (git.behind ?? 0) > 0 ? `GitHub has ${git.behind} newer ${git.behind === 1 ? 'commit' : 'commits'} (as of the last sync with GitHub).` : ''].filter(Boolean).join(' ');
  return <section className="git-rows" aria-label={gh ? 'GitHub' : 'Git'} title={live ? 'Counts are from the last sync with GitHub. The pull request is read from GitHub; nothing is changed there.' : 'Counts are from the last sync with GitHub; nothing is sent to GitHub from here.'}>
    {live && <div className="details-row"><span className="details-icon git-tile" data-state={live.pr?.state ?? 'none'}><UiIcon name="pr" size={13}/></span>
      <span className="pop-text">{live.pr
        ? <><b title={live.pr.title}><a href={live.pr.url} target="_blank" rel="noopener noreferrer">{live.pr.title || `#${live.pr.number}`}</a></b><small>Pull request #{live.pr.number} · <span className="pr-state" data-state={live.pr.state}>{PR_WORD[live.pr.state].toLowerCase()}</span>{live.pr.checks && <> · {CHECKS_WORD[live.pr.checks].toLowerCase()}</>}</small></>
        : <><b>{live.unavailable ? 'Pull request state unavailable' : 'No pull request yet'}</b><small dir="ltr">{git.branch}</small></>}</span>
      {live.pr?.checks && <span className="pr-checks" data-checks={live.pr.checks} title={CHECKS_WORD[live.pr.checks]}><span className="pr-dot" aria-hidden="true"/></span>}</div>}
    <div className="details-row"><span className="details-icon git-tile"><UiIcon name="branch" size={13}/></span>
      <span className="pop-text"><b dir="ltr">{git.branch}</b><small dir="ltr">{sync}</small></span>
      <button type="button" className="row-tool" aria-label="Reload git status" title="Reload" onClick={onRefresh}><UiIcon name="refresh" size={11}/></button></div>
    {gh && <div className="details-row"><span className="details-icon git-tile"><UiIcon name="globe" size={13}/></span>
      <span className="pop-text"><b dir="ltr"><a href={gh.repoUrl} target="_blank" rel="noopener noreferrer">{gh.owner}/{gh.repo}</a></b><small>GitHub</small></span></div>}
    {git.lastCommit && <div className="details-row" title={`${git.lastCommit.author}${when ? ` · ${when.toLocaleString()}` : ''}`}><span className="details-icon git-tile"><UiIcon name="check" size={13}/></span>
      <span className="pop-text"><b dir="auto">{git.lastCommit.subject}</b><small dir="ltr"><code>{git.lastCommit.hash}</code> · {git.lastCommit.author}</small></span></div>}
    {note && <p className="git-note">{note}</p>}
    {gh && (gh.branchUrl || gh.compareUrl) && <div className="git-links">
      {gh.branchUrl && <a className="link-button" href={gh.branchUrl} target="_blank" rel="noopener noreferrer">Open branch</a>}
      {gh.compareUrl && <a className="link-button" href={gh.compareUrl} target="_blank" rel="noopener noreferrer" title={`Compare ${git.defaultBranch} with ${git.branch} and open a pull request on GitHub`}>Compare / pull request</a>}
    </div>}
  </section>;
}

const PR_WORD = { open: 'Open', merged: 'Merged', closed: 'Closed', draft: 'Draft' } as const;
const CHECKS_WORD = { passing: 'Checks pass', pending: 'Checks running', failing: 'Checks fail' } as const;
type PrLive = { pr: { number: number; title: string; state: keyof typeof PR_WORD; url: string; checks: keyof typeof CHECKS_WORD | null } | null; unavailable?: true };
/** CH8: the branch's pull request (owner only): read when the card shows, when the branch changes and when the window comes back. */
function usePullRequest(src: { client: SessionClient; projectId: string } | undefined, branch: string | null): PrLive | null {
  const [live, setLive] = useState<PrLive | null>(null);
  const client = src?.client, projectId = src?.projectId;
  useEffect(() => {
    if (!client || !projectId) { setLive(null); return; }
    let on = true;
    const load = async () => {
      try { const r = await client.request({ method: 'GET', path: `/api/chat/projects/${projectId}/pr` } as never); if (on) setLive(r.status === 200 ? r.body as PrLive : { pr: null, unavailable: true }); }
      catch { if (on) setLive({ pr: null, unavailable: true }); }
    };
    void load();
    const focus = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { on = false; window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [client, projectId, branch]);
  return live;
}

/** Dictation: record, then the words land in the composer (transcribed on this computer). */
function MicButton({ mic }: { mic: MicController }) {
  const m = useSyncExternalStore(mic.subscribe, mic.getSnapshot, mic.getSnapshot);
  // Shown only when speech-to-text is set up on this computer (nothing to fix from here otherwise).
  if (m.phase === 'unknown' || m.phase === 'off') return null;
  const clock = `${Math.floor(m.seconds / 60)}:${String(m.seconds % 60).padStart(2, '0')}`;
  return <span className="composer-mic">
    {m.error && <span className="mic-error" role="alert">{m.error}</span>}
    {m.phase === 'recording' && <><span className="mic-clock" aria-live="polite"><i className="mic-dot" aria-hidden="true"/><span className="mic-status">Listening…</span>{clock}</span>
      <button type="button" className="row-tool" aria-label="Discard the recording" title="Discard" onClick={() => void mic.cancel()}><UiIcon name="close" size={11}/></button></>}
    {m.phase === 'transcribing' && <span className="mic-clock" aria-live="polite"><span className="mic-status">Writing it down…</span></span>}
    <button type="button" className="tool mic-button" data-phase={m.phase} disabled={m.phase === 'transcribing'}
      aria-label={m.phase === 'recording' ? 'Stop and turn into text' : m.phase === 'transcribing' ? 'Turning speech into text' : 'Dictate'}
      title={m.phase === 'recording' ? 'Stop and turn into text' : m.phase === 'transcribing' ? 'Turning speech into text…' : 'Dictate (speech to text on this computer) · hold ⌥Space'}
      onClick={() => void (m.phase === 'recording' ? mic.stop() : mic.start())}>
      {m.phase === 'recording' ? <UiIcon name="stop" size={11}/> : m.phase === 'transcribing' ? <span className="pulse" aria-hidden="true"/> : <UiIcon name="mic" size={16}/>}
    </button>
  </span>;
}

/** Where this conversation works: project, folder, git branch and repository. */
/** CHAT-BUILD-01 follow-up: rename the open chat from its ⋯ menu. */
function RenameSheet({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (title: string) => void }) {
  const [value, setValue] = useState(title);
  return <Sheet title="Rename chat" onClose={onClose} actions={<>
    <button type="button" onClick={onClose}>Cancel</button>
    <button type="button" className="primary" onClick={() => onSave(value)}>Rename</button></>}>
    <form onSubmit={e => { e.preventDefault(); onSave(value); }}><input autoFocus aria-label="Chat name" value={value} maxLength={120} onChange={e => setValue(e.target.value)}/></form>
  </Sheet>;
}

/** CHAT-PRO-02 F: "Export" — the conversation as a Markdown file, optionally with a summary of the tool calls. */
function ExportMenu({ client, conversationId, disabled, openKey = 0, bare = false }: { client: SessionClient; conversationId: string; disabled: boolean; openKey?: number; bare?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (openKey) { setOpen(true); } }, [openKey]);
  const [tools, setTools] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setNote(null);
    const r = await exportConversation(client, conversationId, tools);
    setBusy(false);
    setNote(r.ok ? exportNote(r.file) : r.message);
  };
  return <span className="chat-export">
    {!bare && <button type="button" className="tool chat-export-button" aria-expanded={open} aria-haspopup="dialog" aria-label="Export" title="Export as Markdown"
      onClick={() => { setOpen(v => !v); setNote(null); }}><UiIcon name="download" size={14}/></button>}
    {open && <div className="chat-export-pop" role="dialog" aria-label="Export this conversation" onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
      <strong>Export as Markdown</strong>
      <label className="chat-export-check"><input type="checkbox" checked={tools} onChange={e => setTools(e.target.checked)}/> Include tool calls (collapsed summary)</label>
      <p className="chat-export-hint">Your messages and the agents' answers. Secret values such as keys and passwords are left out.</p>
      <div className="chat-export-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void run()}>{busy ? 'Preparing…' : 'Download .md'}</button>
        <button type="button" className="link-button" onClick={() => setOpen(false)}>Close</button>
      </div>
      {disabled && !note && <p className="chat-export-hint">The agent is still answering; the file has what is saved so far.</p>}
      {note && <p className="chat-export-note" role="status">{note}</p>}
    </div>}
  </span>;
}

/** CH1/CH8: the side panel's three views, a switch with their names on its top (not a row of buttons in the chat). */
function PaneSwitch({ items, pane, onPane }: { items: { name: PaneName; icon: UiIconName; label: string }[]; pane: PaneName | null; onPane: (p: PaneName) => void }) {
  return <div className="pane-switch" role="radiogroup" aria-label="Side panel view">{items.map(b =>
    <button key={b.name} type="button" role="radio" aria-checked={pane === b.name} title={b.label} onClick={() => onPane(b.name)}>{b.label}</button>)}</div>;
}


/** The user's message: right-aligned, pinned while its answer scrolls; long text folds. */
/** CH2: an image sent in this chat, read from the chat (never from the internet). */
function ChatImage({ id, name }: { id: string; name: string }) {
  const { client, conversationId } = useContext(MomentsContext);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!client || !conversationId) return;
    let live = true;
    void client.request({ method: 'GET', path: `/api/chat/conversations/${conversationId}/images/${id}` } as never)
      .then(r => { const v = (r.body as { image?: { type: string; data: string } } | null)?.image; if (live && r.status === 200 && v) setSrc(`data:${v.type};base64,${v.data}`); }).catch(() => undefined);
    return () => { live = false; };
  }, [client, conversationId, id]);
  return src ? <img className="user-image" src={src} alt={name} title={name}/> : <span className="user-image placeholder" title={name}><UiIcon name="image" size={14}/></span>;
}

function UserMessage({ turn, onRemember, onKey, onEdit, highlight }: { turn: Turn; onRemember?: () => void; onKey?: (id: string) => void; onEdit?: (text: string) => void; highlight?: boolean }) {
  const [open, setOpen] = useState(false);
  // CH2: files sent with the message show as chips in the bubble, not as their text.
  const { text, files } = splitAttached(turn.content);
  // The pinned bubble stays short (3 lines) so the answer under it stays readable.
  const long = text.length > 220 || text.split('\n').length > 3;
  return <div className="chat-user" data-pending={turn.pending || undefined} data-message-id={turn.key} data-highlight={highlight || undefined}>
    <div className="user-bubble" data-folded={long && !open || undefined}>
      <p className="sr-only">You</p>
      <div className="turn-text" dir="auto">{splitSecrets(text).map((p, i) => p.kind === 'text' ? p.text
        : <SecretChip key={i} type={p.type} id={p.id} onOpen={onKey}/>)}</div>
      {files.length > 0 && <span className="user-files">{files.map(f => <span key={f.name} className="user-file" title={`${f.name} · ${f.kb} KB`}><UiIcon name="file" size={12}/>{f.name}</span>)}</span>}
      {turn.parts.map((p, i) => p.kind === 'images' ? <div key={i} className="user-images">{p.images.map(img => <ChatImage key={img.id} id={img.id} name={img.name}/>)}</div> : null)}
    </div>
    <div className="user-actions">
      {long && <button type="button" className="chat-more" onClick={() => setOpen(v => !v)}>{open ? 'Show less' : 'Show all'}</button>}
      {onEdit && <button type="button" className="ghost-action" aria-label="Edit and send again" title="Edit (↑ in an empty box)" onClick={() => onEdit(text)}><UiIcon name="pencil" size={14}/></button>}
      <Copy text={text} label="Copy"/>
      {onRemember && <RememberButton onClick={onRemember}/>}
    </div>
  </div>;
}

/** CHAT-SECRETS-01: a secret of the message, kept in the key store; the chip opens the saved keys. */
function SecretChip({ type, id, onOpen }: { type: string; id: string; onOpen?: (id: string) => void }) {
  const label = `${secretLabel(type)} saved securely`;
  const body = <><UiIcon name="lock" size={11}/>{label}</>;
  return onOpen
    ? <button type="button" className="secret-chip" title="Stored encrypted in the key store. Open saved keys" onClick={() => onOpen(id)}>{body}</button>
    : <span className="secret-chip" title="Stored encrypted in the key store">{body}</span>;
}

/** One assistant turn: live parts in order while running; work folded once finished. */
function AssistantTurn({ turn, last, onRetry, writer, writerDepartment, writerRole, recovery, onSuggest, onRemember, proposals, highlight, recall, onWrongPlace }: { turn: Turn; last: boolean; onRetry?: () => void; writer?: string; writerDepartment?: string | null; writerRole?: string; recovery?: ReactNode; onSuggest?: (s: CardSuggestion) => void; onRemember?: (text: string) => void; proposals?: ReactNode; highlight?: boolean; recall?: ChatRecallController | null; onWrongPlace?: (m: { id: string; text: string; drawerId: string }) => void }) {
  const live = turn.status === 'running';
  const plan = turnPlan(turn.parts);
  const suggestions = turnSuggestions(turn.parts);
  const parts = plan || suggestions.length ? withoutPlan(turn.parts) : turn.parts;
  const { work, answer } = splitWork(parts);
  const tools = toolCount(parts);
  const answerText = answer.filter(p => p.kind === 'text').map(p => (p as { text: string }).text).join('');
  const [quiet, since] = useQuiet(turn, live);
  return <article className="chat-assistant" aria-busy={live || undefined} data-message-id={turn.key} data-highlight={highlight || undefined}>
    {/* CH1/CH2: who wrote it, their role and the time, beside their face. */}
    {writer ? <p className="reply-writer"><span className="avatar" aria-hidden="true">{writer.slice(0, 1).toUpperCase()}</span><span className="reply-writer-name">{writer}</span><DepartmentBadge department={writerDepartment}/>{(writerRole || turn.at) && <span className="reply-meta">{[writerRole, turn.at ? clockTime(turn.at) : ''].filter(Boolean).map(x => ` · ${x}`).join('')}</span>}</p> : <p className="sr-only">Agent</p>}
    {/* CHAT-BUILD-01 stage 5 (CH1): the plan's steps live in Tasks above the box; here only one quiet line. */}
    {live && plan && <p className="moment-line"><UiIcon name="list" size={12}/>Plan: {plan.length} {plan.length === 1 ? 'step' : 'steps'}, {plan.filter(s => s.status === 'done').length} done · the steps are in Tasks above the box</p>}
    {live
      ? <>{parts.map((p, i) => <PartView key={i} part={p} live last={i === parts.length - 1}/>)}
        {/* CHAT-BUILD-01 stage 5: the reply as it is written (checked text replaces it at the end). */}
        {!parts.some(p => p.kind === 'text') && turn.preview && <div className="chat-prose turn-text md-host chat-live" aria-live="off"><Markdown text={turn.preview}/></div>}
        {(quiet || parts.length === 0) && <WorkingRow since={since} label={turn.previewTool ? `Using ${turn.previewTool}` : turn.preview ? 'Writing' : parts.length ? 'Working' : 'Thinking'}/>}</>
      : <>
        {tools > 0
          ? <WorkedRow parts={work} ms={turn.durationMs}/>
          : work.map((p, i) => <PartView key={i} part={p}/>)}
        {/* CH1: the plan's quiet line comes after the work row. */}
        {plan && <p className="moment-line"><UiIcon name="list" size={12}/>Plan: {plan.length} {plan.length === 1 ? 'step' : 'steps'}, {plan.filter(s => s.status === 'done').length} done · the steps are in Tasks above the box</p>}
        {/* CHAT-BUILD-01 stage 5: hand-offs, what waits for you and notices stay in view when the work is folded. */}
        {/* CH6: a hand-off to a sub-agent of someone handed work in the same reply sits inside that person's card. */}
        <HandOffs calls={work.flatMap(p => (p.kind === 'tools' ? p.calls : [])).filter(c => c.name === 'team_delegate')}/>
        {work.flatMap(p => (p.kind === 'tools' ? p.calls : [])).filter(c => c.approvalId && c.name !== 'team_delegate').map(c => <ApprovalCard key={`p${c.id}`} call={c}/>)}
        {tools > 0 && work.filter(p => p.kind === 'steer' || p.kind === 'notice').map((p, i) => <PartView key={`n${i}`} part={p}/>)}
        {answer.map((p, i) => <PartView key={`a${i}`} part={p}/>)}
        {turn.changes && <ChangesLine turn={turn} messageId={turn.key}/>}
        {turn.status === 'error' && <div className="chat-error" role="alert">
          <strong>{turn.code === 'run_interrupted' ? 'Work interrupted by restart' : turn.code === 'subscription_org_blocked' ? 'Claude subscription access is disabled' : turn.code === 'lmstudio_not_running' ? 'LM Studio is not running' : turn.code === 'local_model_missing' ? 'The local model is not installed' : turn.code === 'model_unavailable' ? 'The model could not be reached' : 'This reply failed'}</strong>
          <span>{turn.code === 'run_interrupted' ? 'Your request and tool checkpoints are saved. Continue safely after reviewing them; previous actions are not replayed automatically.' : turn.code === 'subscription_org_blocked' ? 'Your organization has disabled Claude Code subscription access. Ask its administrator to enable access, or choose another signed-in coding app.' : turn.code === 'lmstudio_not_running' ? 'Open LM Studio, load the model and start its local server (port 1234), then try again.' : turn.code === 'local_model_missing' ? 'This agent answers with a local model that is not on this computer. Pick an installed model or add a Claude key in Settings, then try again.' : turn.code === 'model_unavailable' ? 'Check that the model is running, then try again.' : 'Anything above was written before the failure.'}</span>
          {last && onRetry && <button type="button" className="chat-error-action" onClick={onRetry}><UiIcon name="refresh" size={12}/>{turn.code === 'run_interrupted' ? 'Continue safely' : 'Try again'}</button>}
        </div>}
        {suggestions.map((g, i) => <CardSuggestionView key={i} suggestion={g} onCreate={onSuggest}/>)}
        {proposals}
        {recovery}
        <TurnFooter text={answerText || turn.content} ms={turn.durationMs} stopped={turn.status === 'stopped'} onRemember={onRemember} recall={recall ? <RecallChip c={recall} turn={turn}/> : null}
          onAgain={last && turn.status === 'complete' ? onRetry : undefined}/>
        {recall && <RecallPanel c={recall} turnKey={turn.key} onWrongPlace={onWrongPlace}/>}
      </>}
  </article>;
}

/** An agent's suggestion to put the task on the board; only the owner creates the card. */
function CardSuggestionView({ suggestion, onCreate }: { suggestion: CardSuggestion; onCreate?: (s: CardSuggestion) => void }) {
  return <section className="card-suggestion" aria-label="Suggested board card">
    <UiIcon name="board" size={13}/>
    <span className="card-suggestion-text"><span className="card-suggestion-label">Suggested card</span><strong dir="auto">{suggestion.title}</strong>
      {suggestion.agents.length > 0 && <small>for {suggestion.agents.join(', ')}</small>}</span>
    {onCreate ? <button type="button" className="ghost-action strong" onClick={() => onCreate(suggestion)}>Review and create</button> : <small>The owner decides.</small>}
  </section>;
}

type CardFormSeed = { title: string; description: string; agents: string[]; priority: Priority; key: number };

/** "Add to board": pick a board and column, the title, the description and the agents the task needs. */
function ChatCardForm({ controller, seed, agents, onClose }: { controller: ChatCardsController; seed: CardFormSeed; agents: readonly { id: string; name: string }[]; onClose: () => void }) {
  const st = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [boardId, setBoardId] = useState('');
  const [columnId, setColumnId] = useState('');
  const [title, setTitle] = useState(seed.title);
  const [description, setDescription] = useState(seed.description);
  const [picked, setPicked] = useState<string[]>(seed.agents);
  const [priority, setPriority] = useState<Priority>(seed.priority);
  useEffect(() => { void controller.loadBoards().then(id => { if (id) setBoardId(b => b || id); }); }, [controller]);
  useEffect(() => { if (st.columns.length && !st.columns.some(c => c.id === columnId)) setColumnId((st.columns.find(c => c.name.toLowerCase() === 'to do') ?? st.columns[0]).id); }, [st.columns, columnId]);
  const submit = async () => { if (await controller.create({ boardId, columnId: columnId || undefined, title, description, priority, agents: picked })) onClose(); };
  return <form className="chat-card-form" aria-label="Add this task to a board" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <div className="chat-card-form-head"><UiIcon name="board" size={14}/><strong>Add this task to a board</strong>
      <button type="button" className="row-tool" aria-label="Close" onClick={onClose}><UiIcon name="close" size={12}/></button></div>
    <div className="chat-card-form-row">
      <label>Board<select value={boardId} onChange={e => { setBoardId(e.target.value); setColumnId(''); void controller.pickBoard(e.target.value); }} disabled={!st.boards.length}>
        {st.boards.length ? st.boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>) : <option value="">Reading the boards…</option>}</select></label>
      <label>Column<select value={columnId} onChange={e => setColumnId(e.target.value)} disabled={!st.columns.length}>
        {st.columns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Priority<select value={priority} onChange={e => setPriority(e.target.value as Priority)}>
        {(['low', 'normal', 'high', 'urgent'] as const).map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select></label>
    </div>
    <label>Title<input value={title} maxLength={200} onChange={e => setTitle(e.target.value)} dir="auto" required/></label>
    <label>Description<textarea value={description} rows={3} maxLength={5000} onChange={e => setDescription(e.target.value)} dir="auto"/></label>
    {agents.length > 0 && <fieldset className="chat-card-agents"><legend>Agents it needs</legend>
      {agents.map(a => <label key={a.id} className="chat-card-agent"><input type="checkbox" checked={picked.includes(a.id)} onChange={e => setPicked(p => e.target.checked ? [...p, a.id] : p.filter(x => x !== a.id))}/>
        <span className="avatar" aria-hidden="true">{a.name.slice(0, 1).toUpperCase()}</span>{a.name}</label>)}</fieldset>}
    {st.notice && <p className="chat-card-notice" role="status">{st.notice}</p>}
    <div className="chat-card-form-actions">
      <span className="fine-print">The card links back to this chat; its moves and comments show up here.</span>
      <button type="button" className="ghost-action" onClick={onClose}>Cancel</button>
      <button type="submit" className="primary" disabled={st.saving || !boardId || !title.trim()}>{st.saving ? 'Adding…' : 'Add card'}</button>
    </div>
  </form>;
}

/** The board cards made from this conversation: column, agents and their progress, newest board activity. */
function ChatCards({ controller, nameOf, onOpen }: { controller: ChatCardsController; nameOf: (agentId: string) => string; onOpen?: (boardId: string, cardId: string) => void }) {
  const st = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  if (!st.owner || !st.cards.length) return null;
  return <>{st.cards.map(c => <ChatCardBlock key={c.id} card={c} progress={st.progress} nameOf={nameOf} onOpen={onOpen}/>)}</>;
}

function ChatCardBlock({ card, progress, nameOf, onOpen }: { card: ChatCard; progress: ChatProgress; nameOf: (agentId: string) => string; onOpen?: (boardId: string, cardId: string) => void }) {
  const [open, setOpen] = useState(false);
  const status = card.archived ? 'archived' : card.done ? 'done' : 'open';
  const people = card.agents.map(id => ({ id, p: progress.agents.find(a => a.agentId === id) }));
  const recent = open ? card.activity : card.activity.slice(-3);
  return <section className="chat-card-block" data-status={status} aria-label={`Board card ${card.title}`}>
    <div className="chat-card-head">
      <UiIcon name="board" size={13}/>
      <span className="chat-card-where">{card.boardName} · <b>{card.archived ? 'Archived' : card.column}</b></span>
      {card.done && !card.archived && <span className="chat-card-badge">Done</span>}
      {onOpen && !card.archived && <button type="button" className="ghost-action strong" onClick={() => onOpen(card.boardId, card.id)}>Open card</button>}
    </div>
    <p className="chat-card-title" dir="auto">{card.title}</p>
    {people.length > 0 && <ul className="chat-card-people" aria-label="Agents on this card">{people.map(({ id, p }) =>
      <li key={id} data-running={p?.running || undefined}>
        <span className="avatar" aria-hidden="true">{nameOf(id).slice(0, 1).toUpperCase()}</span>
        <span>{nameOf(id)}</span>
        <small>{p?.running ? (p.plan?.active ? `working: ${p.plan.active}` : 'working now')
          : p?.plan ? `plan ${p.plan.done} of ${p.plan.total}` : p?.replies ? `${p.replies} ${p.replies === 1 ? 'reply' : 'replies'}` : 'not started'}</small>
        {p?.plan && p.plan.total > 0 && <span className="plan-bar" aria-hidden="true"><i style={{ inlineSize: `${Math.round((p.plan.done / p.plan.total) * 100)}%` }}/></span>}
      </li>)}</ul>}
    {(card.checklist.total > 0 || card.comments > 0) && <p className="chat-card-meta">
      {card.checklist.total > 0 && <span>Checklist {card.checklist.done}/{card.checklist.total}</span>}
      {card.comments > 0 && <span>{card.comments} {card.comments === 1 ? 'comment' : 'comments'}</span>}</p>}
    {recent.length > 0 && <ol className="chat-card-activity" aria-label="Board updates">{recent.map(a =>
      <li key={a.id} data-kind={a.kind}><span dir="auto">{activityLine(a, nameOf)}</span><time>{a.createdAt.slice(5, 16).replace('T', ' ')}</time></li>)}</ol>}
    {card.activity.length > 3 && <button type="button" className="ghost-action" onClick={() => setOpen(v => !v)}>{open ? 'Fewer updates' : `All ${card.activity.length} updates`}</button>}
  </section>;
}

/** The agent's task plan as a live checklist; folds to one line once every step is done. */
function PlanCard({ steps, live, status }: { steps: readonly PlanStep[]; live: boolean; status: Turn['status'] }) {
  const done = steps.filter(s => s.status === 'done').length;
  const counted = steps.filter(s => s.status !== 'skipped').length;
  const finished = !live && steps.every(s => s.status === 'done' || s.status === 'skipped');
  const [open, setOpen] = useState(!finished);
  // Fold once the run ends with every step done (the owner can open it again).
  useEffect(() => { if (finished) setOpen(false); }, [finished]);
  const halted = !live && status !== 'complete';
  const active = steps.find(s => s.status === 'active');
  return <section className="plan-card" aria-label="Task plan" data-live={live || undefined}>
    <button type="button" className="plan-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <UiIcon name="check" size={12}/>
      <span className="plan-title">{finished ? 'Plan done' : 'Plan'}</span>
      <span className="plan-count">{done} of {counted}</span>
      <span className="plan-bar" aria-hidden="true"><i style={{ inlineSize: `${counted ? Math.round((done / counted) * 100) : 0}%` }}/></span>
      {!open && active && <span className="plan-now" dir="auto">{active.title}</span>}
      <span className="plan-chevron" aria-hidden="true"><UiIcon name="chevron" size={10}/></span>
    </button>
    {open && <ol className="plan-steps">{steps.map((s, i) => {
      const state = s.status === 'active' && halted ? 'halted' : s.status;
      return <li key={i} data-status={state}>
        <span className="plan-mark" aria-hidden="true">{state === 'done' ? <UiIcon name="check" size={10}/> : state === 'active' ? <i className="plan-spin"/> : null}</span>
        <span className="plan-step" dir="auto">{s.title}</span>
        <span className="sr-only">{state === 'done' ? 'done' : state === 'active' ? 'in progress' : state === 'halted' ? 'stopped here' : state === 'skipped' ? 'skipped' : 'to do'}</span>
      </li>;
    })}</ol>}
  </section>;
}

/** True when a live turn produced nothing for QUIET_MS; returns when that quiet began. */
function useQuiet(turn: Turn, live: boolean): [boolean, number] {
  const [quiet, setQuiet] = useState(false);
  const [since, setSince] = useState(() => turn.startedAt ?? Date.now());
  useEffect(() => {
    if (!live) { setQuiet(false); return; }
    setQuiet(false); const t0 = Date.now(); setSince(t0);
    const timer = setTimeout(() => setQuiet(true), QUIET_MS);
    return () => clearTimeout(timer);
  }, [turn.lastSeq, live]);
  return [quiet, since];
}

function PartView({ part, live = false, last = false }: { part: Part; live?: boolean; last?: boolean }) {
  if (part.kind === 'text') return part.text ? <div className="chat-prose turn-text md-host"><Markdown text={part.text}/></div> : null;
  if (part.kind === 'reasoning') return part.text.trim() ? <Thinking part={part} live={live && last && part.endedAt === undefined}/> : null;
  if (part.kind === 'steer') return <SteerLine part={part}/>;
  if (part.kind === 'notice') return <NoticeCard part={part}/>;
  if (part.kind === 'images') return null;
  return <ToolStep calls={part.calls} live={live}/>;
}

function Thinking({ part, live }: { part: Extract<Part, { kind: 'reasoning' }>; live: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const shown = open ?? live;
  useLayoutEffect(() => { if (live && body.current) body.current.scrollTop = body.current.scrollHeight; }, [part.text, live]);
  const secs = part.startedAt !== undefined && part.endedAt !== undefined ? Math.round((part.endedAt - part.startedAt) / 1000) : undefined;
  const label = live ? 'Thinking' : secs === undefined ? 'Thought' : secs < 1 ? 'Thought briefly' : `Thought for ${duration(secs * 1000)}`;
  return <div className="scaffold thinking" data-open={shown || undefined}>
    <button type="button" className="scaffold-row" aria-expanded={shown} onClick={() => setOpen(!shown)}>
      <UiIcon name="brain" size={12}/><span className={live ? 'shimmer' : undefined}>{label}</span>
      {live && part.startedAt !== undefined && <Elapsed since={part.startedAt}/>}
      <span className="caret" aria-hidden="true"><UiIcon name="chevron" size={11}/></span>
    </button>
    {shown && <div ref={body} className="thinking-body" data-live={live || undefined} dir="auto"><Markdown text={part.text}/></div>}
  </div>;
}

/** One model step's tool calls; in a long live step the older rows fold under a count. */
function ToolStep({ calls, live }: { calls: readonly ToolCall[]; live: boolean }) {
  const [all, setAll] = useState(false);
  const hidden = live && !all && calls.length > LIVE_ROWS ? calls.length - LIVE_ROWS : 0;
  return <div className="scaffold tool-step">
    {hidden > 0 && <button type="button" className="scaffold-row muted" onClick={() => setAll(true)}>{hidden} earlier {hidden === 1 ? 'step' : 'steps'}</button>}
    {calls.slice(hidden).map(c => live && c.name === 'team_delegate' ? <DelegationCard key={c.id} call={c}/> : <div key={c.id}><ToolRow call={c}/>{live && c.approvalId && <ApprovalCard call={c}/>}</div>)}
  </div>;
}

const KIND_ICON: Record<ToolKind, UiIconName> = { command: 'terminal', read: 'file', write: 'file', edit: 'pencil', search: 'search', web: 'globe', browser: 'globe', memory: 'brain', board: 'board', other: 'tool' };

const stepTime = (ms: number) => (duration(ms) === '0s' ? `${(ms / 1000).toFixed(1)}s` : duration(ms));

/** `bare`: inside a "Ran 6 commands" group a command shows only its text (the group says what was done). */
function ToolRow({ call, bare = false }: { call: ToolCall; bare?: boolean }) {
  const [open, setOpen] = useState(false);
  const v = toolView(call);
  const hasDetail = !!(call.output || call.input.length > 2);
  const plain = bare && v.kind === 'command' && !!v.target;
  return <div className="tool-row" data-error={call.isError || undefined} data-open={open || undefined}>
    {(() => { const Row = hasDetail ? 'button' : 'div'; return <Row {...(hasDetail ? { type: 'button' as const, 'aria-expanded': open, onClick: () => setOpen(v => !v) } : {})} className="scaffold-row" data-static={hasDetail ? undefined : true}>
      {call.running ? <span className="spinner" aria-hidden="true"/> : <UiIcon name={call.isError ? 'alert' : KIND_ICON[v.kind]} size={12}/>}
      <span className="tool-title">{plain ? <span className="sr-only">{v.verb}</span> : <span className={call.running ? 'shimmer' : 'tool-verb'}>{v.verb}</span>}{v.target && <span className="tool-target" dir="auto">{v.kind === 'command' ? <code>{v.target}</code> : v.target}</span>}</span>
      {call.isError && <span className="tool-meta error">failed</span>}
      {!call.running && call.ms !== undefined && call.ms >= 100 && <span className="tool-meta">{stepTime(call.ms)}</span>}
      {hasDetail && <span className="caret" aria-hidden="true"><UiIcon name="chevron" size={11}/></span>}
    </Row>; })()}
    {open && <ToolDetail call={call} kind={v.kind} command={v.command} args={v.args}/>}
  </div>;
}

function ToolDetail({ call, kind, command, args }: { call: ToolCall; kind: ToolKind; command?: string; args: Record<string, unknown> }) {
  const entries = Object.entries(args).filter(([k]) => !(kind === 'command' && ['command', 'cmd'].includes(k)));
  return <div className="tool-detail">
    {kind === 'command' && command && <pre className="tool-cmd" dir="ltr"><span aria-hidden="true">$ </span>{command}</pre>}
    {entries.length > 0 && <dl className="tool-args">{entries.slice(0, 12).map(([k, val]) =>
      <div key={k}><dt>{k}</dt><dd dir="auto">{typeof val === 'string' ? val.slice(0, 400) : JSON.stringify(val).slice(0, 400)}</dd></div>)}</dl>}
    {call.output !== undefined && <div className="tool-output">
      <div className="tool-output-head"><span>{call.isError ? 'Error' : 'Output'}</span><Copy text={call.output} label="Copy output"/></div>
      <pre dir="ltr">{call.output || '(no output)'}</pre>
    </div>}
    {call.running && <p className="tool-running">Running…</p>}
  </div>;
}

function HandOffs({ calls }: { calls: ToolCall[] }) {
  const { subAgentOf } = useContext(MomentsContext);
  const target = (c: ToolCall) => { try { return (JSON.parse(c.input) as { agent_id?: string }).agent_id; } catch { return undefined; } };
  const ids = new Set(calls.map(target));
  const inside = (c: ToolCall) => { const p = subAgentOf?.(target(c)); return !!p && ids.has(p); };
  return <>{calls.filter(c => !inside(c)).map(c => <DelegationCard key={`h${c.id}`} call={c}>
    {calls.filter(k => inside(k) && subAgentOf?.(target(k)) === target(c)).map(k => <DelegationCard key={`s${k.id}`} call={k} nested/>)}
  </DelegationCard>)}</>;
}

export function WorkedRow({ parts, ms }: { parts: Part[]; ms: number | null }) {
  const [open, setOpen] = useState(false);
  // CH10 item 10: one part per kind, "Thought for 12s › · Ran 6 commands › · Read 4 files ›".
  const segments = workSegments(parts);
  return <div className="scaffold worked" data-open={open || undefined}>
    <button type="button" className="scaffold-row" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <UiIcon name="check" size={14}/><span>{ms !== null ? `Worked for ${duration(ms)}` : 'Worked'}</span>
      {segments.length > 0 && <span className="worked-summary">{segments.map(s => <span key={s.kind} className="worked-seg" data-error={s.failed > 0 || undefined}><span aria-hidden="true">· </span>{s.label}{s.failed > 0 && `, ${s.failed} failed`}<span className="worked-seg-caret" aria-hidden="true"> ›</span></span>)}</span>}
      <span className="caret" aria-hidden="true"><UiIcon name="chevron" size={11}/></span>
    </button>
    {open && <div className="worked-body">{workGroups(parts).map((it, i) => <WorkItemView key={i} item={it}/>)}</div>}
  </div>;
}

/** CH2 item 4: back-to-back steps of one kind are one line ("Ran 6 commands") that opens to each step. */
function WorkItemView({ item }: { item: WorkItem }) {
  if (item.kind === 'part') return <PartView part={item.part}/>;
  if (item.entries.length === 1) return <div className="scaffold tool-step"><ToolRow call={item.calls[0]}/></div>;
  return <ToolGroup item={item}/>;
}

function ToolGroup({ item }: { item: Extract<WorkItem, { kind: 'group' }> }) {
  const failed = item.calls.filter(c => c.isError).length;
  const [open, setOpen] = useState(failed > 0);
  const ms = item.calls.reduce((n, c) => n + (c.ms ?? 0), 0);
  return <div className="scaffold tool-step tool-group" data-error={failed > 0 || undefined} data-open={open || undefined}>
    <button type="button" className="scaffold-row" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <UiIcon name={failed ? 'alert' : KIND_ICON[item.tool]} size={12}/>
      <span className="tool-title"><span className="tool-verb">{groupLabel(item.tool, item.calls.length)}</span></span>
      {failed > 0 && <span className="tool-meta error">{failed} failed</span>}
      {ms >= 100 && <span className="tool-meta">{stepTime(ms)}</span>}
      <span className="caret" aria-hidden="true"><UiIcon name="chevron" size={11}/></span>
    </button>
    {open && <div className="tool-group-body">{item.entries.map((e, i) => ('kind' in e ? <PartView key={`t${i}`} part={e}/> : <ToolRow key={e.id} call={e} bare/>))}</div>}
  </div>;
}

function WorkingRow({ since, label }: { since: number; label: string }) {
  return <p className="scaffold working" role="status"><span className="pulse" aria-hidden="true"/><span className="shimmer">{label}</span><Elapsed since={since}/></p>;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="elapsed">{s >= 1 ? duration(s * 1000) : ''}</span>;
}

function TurnFooter({ text, ms, stopped, onRemember, recall, onAgain }: { text: string; ms: number | null; stopped: boolean; onRemember?: (text: string) => void; recall?: ReactNode; onAgain?: () => void }) {
  return <div className="turn-actions">
    {recall}
    {stopped && <span className="turn-chip">Stopped</span>}
    {ms !== null && <span className="turn-time" title={`This reply took ${duration(ms)}`}>{duration(ms)}</span>}
    {text && <Copy text={text} label="Copy reply (⇧⌘C)"/>}
    {onAgain && <button type="button" className="ghost-action" aria-label="Answer again" title="Answer again (asks the same once more)" onClick={onAgain}><UiIcon name="refresh" size={12}/></button>}
    {text && onRemember && <RememberButton onClick={() => onRemember(text)}/>}
  </div>;
}

function RememberButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="ghost-action" aria-label="Remember this" title="Remember this (⌘⇧R)" onClick={onClick}><UiIcon name="brain" size={13}/></button>;
}

type RememberSeed = { ref: { messageId: string } | { runId: string }; text: string; key: number };
const TYPE_CHOICES: { value: RememberType; label: string }[] = [
  { value: 'fact', label: 'Fact' }, { value: 'preference', label: 'Preference' }, { value: 'context', label: 'Context' }, { value: 'insight', label: 'Insight' },
  { value: 'event', label: 'Event' }, { value: 'task', label: 'Task' }, { value: 'skill', label: 'Skill' }, { value: 'relationship', label: 'Relationship' },
];

/** "Remember this": the message text (editable) and the drawer it goes to. */
export function RememberForm({ controller, seed, project, agent, onClose }: { controller: ChatMemoryController; seed: RememberSeed; project: string | null; agent: string; onClose: () => void }) {
  const st = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [text, setText] = useState(seed.text);
  const [drawer, setDrawer] = useState<RememberDrawer>(project ? 'project' : 'owner');
  const [type, setType] = useState<RememberType>('fact');
  const [importance, setImportance] = useState(7);
  const left = MAX_REMEMBER - [...text].length;
  const save = async () => { if (await controller.remember({ ...seed.ref, content: text, drawer, type, importance })) onClose(); };
  return <form className="chat-card-form remember-form" aria-label="Remember this" onSubmit={e => { e.preventDefault(); void save(); }}>
    <div className="chat-card-form-head"><UiIcon name="brain" size={13}/><strong>Remember this</strong>
      <button type="button" className="row-tool" aria-label="Close" onClick={onClose}><UiIcon name="close" size={11}/></button></div>
    <label className="field"><span>What to remember <small className="muted">(edit it to keep only what matters)</small></span>
      <textarea rows={Math.min(8, Math.max(3, text.split('\n').length + 1))} value={text} dir="auto" onChange={e => setText(e.target.value)} autoFocus/></label>
    <div className="chat-card-form-row">
      <label className="field"><span>Drawer</span>
        <select value={drawer} onChange={e => setDrawer(e.target.value as RememberDrawer)}>
          {project && <option value="project">Project: {project}</option>}
          <option value="owner">About you</option>
          <option value="experience">{agent}'s lessons</option>
        </select></label>
      <label className="field"><span>Type</span>
        <select value={type} onChange={e => setType(e.target.value as RememberType)}>{TYPE_CHOICES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
      <label className="field"><span>Importance {importance}</span><input type="range" min={1} max={10} value={importance} onChange={e => setImportance(Number(e.target.value))}/></label>
    </div>
    {st.notice && <p className="card-notice" role="alert">{st.notice}</p>}
    <div className="remember-actions">
      <span className={left < 0 ? 'attach-error' : 'muted'}>{left < 0 ? `${-left} characters too long` : `${left} characters left`} · secrets are left out</span>
      <button type="submit" className="primary" disabled={st.saving || !text.trim() || left < 0}>{st.saving ? 'Saving…' : 'Save to memory'}</button>
      <button type="button" className="ghost" onClick={onClose}>Cancel</button>
    </div>
  </form>;
}

const STATUS_LABEL: Record<ChatMemory['status'], string> = { saved: 'Saved', removed: 'Removed from memory', pending: 'Waiting for you', rejected: 'Not saved', stale: 'Out of date', cancelled: 'Withdrawn' };

/** An agent's memory proposals under its reply: Accept or Reject (never saved by itself). */
export function MemoryProposals({ controller, items }: { controller: ChatMemoryController; items: readonly ChatMemory[] }) {
  const st = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  if (!items.length) return null;
  return <>{items.map(m => {
    const live = st.memories.find(x => x.id === m.id) ?? m;
    const review = live.proposalId ? st.reviews[live.proposalId] : undefined;
    return <section key={m.id} className="memory-proposal" data-status={live.status} aria-label="Memory suggested by the agent">
      <UiIcon name="brain" size={13}/>
      <span className="card-suggestion-text"><span className="card-suggestion-label">Remember this? · {drawerLabel(drawerRef(review?.drawerId ?? live.drawerId))}</span>
        <span className="memory-proposal-text" dir="auto">{review?.text ?? live.text}</span></span>
      {live.status === 'pending'
        ? <span className="memory-proposal-actions">
          <button type="button" className="ghost-action strong" disabled={!!st.deciding || !review} onClick={() => void controller.decide(live, 'approve')}>{st.deciding === live.proposalId ? '…' : 'Accept'}</button>
          <button type="button" className="ghost-action" disabled={!!st.deciding || !review} onClick={() => void controller.decide(live, 'reject')}>Reject</button></span>
        : <small className="turn-chip">{STATUS_LABEL[live.status]}</small>}
    </section>;
  })}</>;
}

/** The side panel list: what this conversation put into memory, each opening on the Memory page. */
export function ChatMemoryCard({ controller, onOpen }: { controller: ChatMemoryController; onOpen?: (drawerId: string, memoryId: string) => void }) {
  const st = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  if (!st.owner) return null;
  const items = [...st.memories].reverse();
  return <section className="panel-card" aria-label="Memory from this chat">
    <h3>Memory from this chat</h3>
    {items.length === 0 ? <p className="muted">Use the brain button on a message to remember it. Memories the agent suggests wait here for you.</p>
      : <ul className="panel-memories">{items.slice(0, 30).map(m => <li key={m.id} data-status={m.status}>
        <span className="panel-memory-text" dir="auto" title={m.text}>{m.text}</span>
        <span className="panel-memory-meta">{drawerLabel(drawerRef(m.drawerId))} · {m.kind === 'proposed' ? 'suggested by the agent' : 'remembered'} · {STATUS_LABEL[m.status]}
          {m.status === 'saved' && m.memoryId && onOpen && <> · <button type="button" className="link-button" onClick={() => onOpen(m.drawerId, m.memoryId!)}>Open in Memory</button></>}</span>
      </li>)}</ul>}
  </section>;
}

const drawerRef = (id: string) => { const i = id.indexOf(':'); return (i < 0 ? { kind: id } : { kind: id.slice(0, i), key: id.slice(i + 1) }) as { kind: 'owner' }; };
const noopSubscribe = () => () => {};
const nullSnapshot = () => undefined;

/** "10:42" for a message time (local clock). */
const clockTime = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

function Copy({ text, label }: { text: string; label: string }): ReactNode {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const copy = () => {
    const done = (s: 'done' | 'failed') => { setState(s); setTimeout(() => setState('idle'), 1500); };
    if (!navigator.clipboard) { done('failed'); return; }
    navigator.clipboard.writeText(text).then(() => done('done'), () => done('failed'));
  };
  return <button type="button" className="ghost-action" aria-label={state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed' : label} title={label} onClick={copy}>
    <UiIcon name={state === 'done' ? 'check' : 'copy'} size={13}/>
  </button>;
}
/** Whether the chat avatar is shown; one shared value for every chat view, kept in memory for this session (no browser storage). */
const avatarShown = (() => {
  let on = false; const listeners = new Set<() => void>();
  return { get: () => on, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, toggle: () => { on = !on; listeners.forEach(listener => listener()); } };
})();
