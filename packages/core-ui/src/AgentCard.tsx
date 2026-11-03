import {AgentMemoryList} from './AgentMemoryList';
import {AgentNotesRow,ExportAgentSheet,useAgentPackages} from './AgentNotes';
import { modelDisplayName } from './model-names';
import {MemoryExplorerController} from './memory-explorer';
import {AgentPersonalityLibrary} from './AgentPersonalityLibrary';
import {AgentSpecialtiesSkills} from './AgentSpecialtiesSkills';
import {AgentPermissions,usePermissionSave} from './AgentPermissions';
import {AgentSubAgents} from './AgentSubAgents';
import {AgentFiles} from './AgentFiles';
import {createPortal} from 'react-dom';
import {Avatar,ContextMenu,IconButton,Notice,Sheet,useMenu} from './desktop-ui';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AgentCardController } from './agent-card';
import type { CardTab, PartDone, ProfileDraft } from './agent-card';
import type { AgentsController } from './agents';
import type { PersonalityController } from './personality';
import { drawerKinds } from './hire-contract.js';
import { drawerKindLabel } from './hire';
import type { DrawerKind } from './hire';
import { AgentMemoryController, handoffLine } from './agent-memory';
import { validatedDisplayName } from './naming';
import { UiIcon } from './ui-icons';
import { agentApprovals, approvalActivity, mergeTimeline, type ApprovalActivity } from './approvals-actions';
import type { UiIconName } from './ui-icons';
import { DocumentEditor } from './DocumentEditor';
import { DepartmentTile } from './StaffDirectory';
import { ROLE_CARDS, departmentName, roleWord } from './agent-look';
import { forgetFacts } from './agent-facts';

export const AGENT_SECTIONS: {key:CardTab;label:string;icon:UiIconName}[]=[
 {key:'profile',label:'General',icon:'info'},{key:'persona',label:'Personality',icon:'smile'},
 {key:'skills',label:'Specialties and skills',icon:'layers'},{key:'memory',label:'Memory',icon:'database'},{key:'files',label:'Files',icon:'file'},
 {key:'permissions',label:'Permissions',icon:'lock'},{key:'activity',label:'Activity',icon:'clock'},{key:'subs',label:'Sub-agents',icon:'sub-agent'}
];
export const CATEGORY: Record<string, string> = { browser: 'Use the browser', network: 'Reach the internet', message: 'Send messages', delete: 'Delete things', install: 'Install software', money: 'Spend money', settings: 'Change settings' };

/**
 * One agent's page (boards AG2, PL5, SP7, AG3, MC3): its parts in the
 * sidebar, each part saves as you go, and the last change can be undone
 * (Undo in the notice or ⌘Z). Every save still carries the version it read.
 */
/** Links from the agent page to the Library places (Personalities, Specialties, Skills). */
export type LibraryLinks={onPersonalities?:()=>void;onSpecialties?:()=>void;onSkills?:()=>void};
export function AgentCard({ client, agentId, agents, personality, onBack, onOpenMemory, sidebarSlot, initialSection = 'profile', onChat, onGone, onOpenMcp, onOpenApprovals, library, onOpenAgent }: {
  client: ConstructorParameters<typeof AgentCardController>[0]; agentId: string; agents: AgentsController; personality: PersonalityController;
  initialSection?:CardTab; onBack: () => void; onOpenMemory?: (agentId?: string) => void; sidebarSlot?:HTMLElement|null; onChat?: (agentId: string) => void; onGone?: (notice: string) => void; onOpenMcp?: () => void; onOpenApprovals?: () => void; library?: LibraryLinks; onOpenAgent?: (agentId: string) => void;
}) {
  const [card, setCard] = useState<AgentCardController>();
  useEffect(() => { const c = new AgentCardController(client, agentId, initialSection); setCard(c); void c.load(); void agents.select(agentId); return () => c.dispose(); }, [client, agentId, agents]);
  if (!card) return null;
  return <CardView card={card} agents={agents} personality={personality} onBack={onBack} onOpenMemory={onOpenMemory} sidebarSlot={sidebarSlot} onChat={onChat} onGone={onGone} onOpenMcp={onOpenMcp} onOpenApprovals={onOpenApprovals} library={library} onOpenAgent={onOpenAgent}/>;
}

export function CardView({ card, agents, personality, onBack, onOpenMemory, sidebarSlot, onChat, onGone, onOpenMcp, onOpenApprovals, library, onOpenAgent }: { card: AgentCardController; agents?: AgentsController; personality?: PersonalityController; onBack: () => void; onOpenMemory?: (agentId?: string) => void;sidebarSlot?:HTMLElement|null; onChat?: (agentId: string) => void; onGone?: (notice: string) => void; onOpenMcp?: () => void; onOpenApprovals?: () => void; library?: LibraryLinks; onOpenAgent?: (agentId: string) => void }) {
  const s = useSyncExternalStore(card.subscribe, card.getSnapshot, card.getSnapshot);
  const n = useSyncExternalStore(agents ? agents.subscribe : noop, agents ? agents.getSnapshot : none, agents ? agents.getSnapshot : none);
  const p = useSyncExternalStore(personality ? personality.subscribe : noop, personality ? personality.getSnapshot : none, personality ? personality.getSnapshot : none);
  const [toast,setToast]=useState<{id:number;text:string;undo:boolean}|null>(null);const undo=useRef<(()=>void|Promise<void>)|null>(null);
  const onDone:PartDone=(text,run)=>{undo.current=run??null;setToast({id:Date.now(),text,undo:!!run});};
  const runUndo=()=>{const u=undo.current;undo.current=null;setToast(null);if(u)void u();};
  useEffect(()=>{const key=(e:KeyboardEvent)=>{const t=e.target as HTMLElement|null;if(!(e.metaKey||e.ctrlKey)||e.shiftKey||e.key.toLowerCase()!=='z'||!undo.current)return;if(t&&(t.closest('textarea,[contenteditable="true"],dialog')||(t instanceof HTMLInputElement&&!['radio','checkbox','button','range'].includes(t.type))))return;e.preventDefault();runUndo();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  const a = s.agent;
  const name = (n?.selected?.id === s.agentId ? n.selected.name : undefined) ?? a?.name ?? 'Agent';
  const pending = p?.proposals.filter(x => x.status === 'pending').length ?? 0;
  const tab = s.tab === 'mcp' ? 'permissions' : s.tab;
  const libraryLinks=([['Personalities','smile',library?.onPersonalities],['Specialties','layers',library?.onSpecialties],['Skills','star',library?.onSkills]] as [string,UiIconName,(()=>void)|undefined][]).filter((x):x is [string,UiIconName,()=>void]=>!!x[2]);
  const navigation=<nav className="agent-profile-sidebar dk-sidebar ag-parts" aria-label="Parts of this agent"><button type="button" className="agent-return" onClick={onBack}><UiIcon name="arrow-left" size={13}/>All staff</button><div className="agent-sidebar-identity"><Avatar name={name} size={36}/><span><strong><bdi>{name}</bdi></strong><small>{departmentName(a?.department)}</small></span></div>{AGENT_SECTIONS.map(t=><button className="nav-item dk-place" title={t.label} type="button" key={t.key} aria-current={tab===t.key?'page':undefined} onClick={()=>void card.openTab(t.key)}><UiIcon name={t.icon} size={15}/><span className="dk-place-name">{t.label}</span>{t.key==='persona'&&pending>0&&<span className="ag-count" aria-label={`${pending} waiting for you`}>{pending}</span>}</button>)}{libraryLinks.length>0&&<><p className="section-label dk-label">Library</p>{libraryLinks.map(([label,icon,run])=><button key={label} type="button" className="nav-item dk-place" title={`Open ${label} in Library`} onClick={run}><UiIcon name={icon} size={15}/><span className="dk-place-name">{label}</span><UiIcon name="chevron" size={11}/></button>)}</>}</nav>;
  return <article className="agent-card ag-card" aria-label={a?.name ? `Agent ${a.name}` : 'Agent'}>
    {sidebarSlot?createPortal(navigation,sidebarSlot):navigation}
    <div className="ag-card-body">
    {s.phase === 'error' ? <div className="ag-empty"><p role="alert">{s.notice ?? 'The agent could not be loaded.'}</p><button type="button" onClick={() => void card.load()}>Try again</button></div> : <>
      {tab === 'profile' && <GeneralPart card={card} agents={agents} onDone={onDone} onChat={onChat} onGone={onGone}/>}
      {tab === 'persona' && (s.persona ? <AgentPersonalityLibrary card={card} personality={personality} onDone={onDone}/> : <p className="ag-muted" role="status">{s.phase === 'loading' ? 'Reading the personality…' : 'The personality could not be read.'}</p>)}
      {tab === 'skills' && <AgentSpecialtiesSkills key={s.agentId} client={card.client} agentId={s.agentId} onDone={onDone}/>}
      {tab === 'permissions' && <AgentPermissions card={card} onDone={onDone} onOpenMcp={onOpenMcp}/>}
      {tab === 'activity' && <ActivityPart card={card} onOpenApprovals={onOpenApprovals}/>}
      {tab === 'files' && <AgentFiles key={s.agentId} client={card.client as never} agentId={s.agentId} name={name} onDone={onDone} onPersonality={() => void card.openTab('persona')}/>}
      {tab === 'subs' && agents && <AgentSubAgents key={s.agentId} client={card.client as never} agentId={s.agentId} agents={agents} onDone={onDone} onOpenAgent={onOpenAgent}/>}
      {tab === 'memory' && <MemoryPart card={card} name={name} onDone={onDone} onOpenMemory={onOpenMemory}/>}
    </>}
    </div>
    <Notice toast={toast} onUndo={runUndo} onDone={id=>setToast(t=>t?.id===id?null:t)}/>
  </article>;
}

/** AG2: name in place (Enter saves, the sparkle suggests), role cards, department, who answers, responsibilities. */
function GeneralPart({ card, agents, onDone, onChat, onGone }: { card: AgentCardController; agents?: AgentsController; onDone: PartDone; onChat?: (agentId: string) => void; onGone?: (notice: string) => void }) {
  const s = useSyncExternalStore(card.subscribe, card.getSnapshot, card.getSnapshot);
  const n = useSyncExternalStore(agents ? agents.subscribe : noop, agents ? agents.getSnapshot : none, agents ? agents.getSnapshot : none);
  const [dept,setDept]=useState<string|null>(null),[editing,setEditing]=useState<string|null>(null),[hint,setHint]=useState(''),[removing,setRemoving]=useState(false),[acting,setActing]=useState(false);
  const menu=useMenu();
  const a = s.agent, id = s.agentId, busy = s.phase === 'saving' || s.phase === 'loading';
  // STORE-MAP-01 P5c: Export agent… (⇧⌘E) only while agent packages are on.
  const packages=useAgentPackages(card.client as never,card.client.getSnapshot().user?.role==='owner'),[exporting,setExporting]=useState(false);
  useEffect(()=>{if(!packages)return;const on=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==='e'&&!document.querySelector('dialog[open]')){e.preventDefault();setExporting(true);}};window.addEventListener('keydown',on);return()=>window.removeEventListener('keydown',on);},[packages,id]);
  const sel = n?.selected?.id === id ? n.selected : undefined;
  const nameOk = n ? validatedDisplayName(n.draft) : null;
  const nameBusy = !!n && ['listing', 'reading', 'saving', 'reconciling', 'generating'].includes(n.phase);
  const departments=[...new Set((n?.agents??[]).map(x=>x.department).filter((d):d is string=>!!d))].sort();
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&e.key.toLowerCase()==='e'&&!editing){e.preventDefault();setEditing(card.getSnapshot().profile.description);}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[card,editing]);
  async function change(patch:Partial<ProfileDraft>,text:string,undoable=true){
    if(card.getSnapshot().phase==='saving')return;
    const before=card.getSnapshot().profile;const prev=Object.fromEntries(Object.keys(patch).map(k=>[k,before[k as keyof ProfileDraft]])) as Partial<ProfileDraft>;
    card.editProfile(patch);if(!card.profileChanged())return;
    await card.saveProfile();
    if(card.getSnapshot().saved==='Profile saved.'){setHint('');if(agents&&!nameBusy&&n?.draft===sel?.name)void agents.select(id);forgetFacts(card.client,id);if(undoable)onDone(text,()=>change(prev,'Change undone',false));}
  }
  async function saveName(){
    if(!agents||!sel||sel.nameUnavailable||!nameOk||nameOk===sel.name||n?.needsReview||n?.refreshRequired||n?.unknown||nameBusy)return;
    const old=sel.name;await agents.save();
    if(agents.getSnapshot().phase==='saved'){void card.refreshAgent();onDone('Name saved',async()=>{agents.edit(old);await agents.save();void card.refreshAgent();});}
  }
  async function loadLatest(keepMine:boolean){
    if(!agents)return;const mine=agents.getSnapshot().draft;
    if(agents.getSnapshot().unknown||agents.getSnapshot().refreshRequired)await agents.reconcile();
    agents.review();
    if(keepMine){agents.edit(mine);await saveName();}else agents.cancel();
    void card.refreshAgent();
  }
  function commitDept(){
    if(dept===null)return;const v=dept.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();setDept(null);
    if(v===s.profile.department.trim().toLowerCase())return;
    if(v&&!/^[a-z0-9][a-z0-9 _-]{0,63}$/.test(v)){setHint('A department is up to 64 letters, numbers, spaces, - or _.');return;}
    void change({department:v},v?`Department: ${departmentName(v)}`:'No department');
  }
  async function act(kind:'main'|'copy'){
    if(!agents||acting)return;setActing(true);
    const r=kind==='main'?await agents.setPrimary(id):await agents.duplicate(id);setActing(false);
    void agents.select(id);if(kind==='main')void card.refreshAgent();onDone(r.notice);
  }
  const more=(e:React.MouseEvent)=>menu.at(e,[
    {label:'Make main agent',icon:'sparkle',disabled:!agents||!!a?.isPrimary||acting,run:()=>void act('main')},
    {label:'Duplicate',icon:'copy',disabled:!agents||acting,run:()=>void act('copy')},
    {label:'Copy agent id',icon:'key',run:()=>{void navigator.clipboard?.writeText(id);onDone(`Agent id ${id} copied`);}},
    ...(packages?[{label:'Export agent…',icon:'download' as const,shortcut:'⇧⌘E',run:()=>setExporting(true)}]:[]),'sep',
    {label:'Remove agent…',icon:'trash',danger:true,disabled:!agents||acting,run:()=>setRemoving(true)}]);
  const status=!n||!sel?'':n.phase==='generating'?'Suggesting a name…':n.phase==='saving'?'Saving…':n.phase==='reading'?'Reading…':nameOk&&nameOk!==sel.name&&!n.needsReview?'Enter saves the name · Esc puts it back':'Saved · Undo with ⌘Z';
  return <div className="ag-part ag-general">
    <div className="ag-who"><Avatar name={sel?.name??a?.name??'?'} size={64}/>
      <div className="ag-who-text">
        {agents&&sel?<div className="ag-name-row"><input className="ag-name" aria-label="Name" value={n!.draft} disabled={nameBusy||n!.unknown||!!sel.nameUnavailable} onChange={e=>agents.edit(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void saveName();}if(e.key==='Escape'){e.preventDefault();agents.cancel();}}} onBlur={()=>void saveName()}/>
          <IconButton icon="sparkle" label="Suggest a name" disabled={nameBusy||n!.unknown||!!sel.nameUnavailable} onClick={()=>void agents.generate('en')}/></div>:<b className="ag-name-static"><bdi>{a?.name??'Loading agent…'}</bdi></b>}
        {n?.needsReview||n?.unknown?<span className="ag-conflict" role="alert">{n.unknown?'The last save could not be confirmed.':`Changed elsewhere${sel?.name?`: now “${sel.name}”`:''}. Your draft is kept.`}<button type="button" className="link-button" onClick={()=>void loadLatest(false)}>Load latest</button>{!n.unknown&&<button type="button" className="link-button" onClick={()=>void loadLatest(true)}>Keep mine</button>}</span>:<small className="ag-muted" role="status">{nameOk===null&&n&&sel?'A name is 1 to 60 characters.':status}</small>}
      </div>
      {onChat&&<button type="button" className="primary" onClick={()=>onChat(id)}>Chat with it</button>}
      <IconButton icon="more" label="More for this agent" onClick={more}/>
    </div>
    {s.notice&&<p className="ag-alert" role="alert">{s.notice}{card.profileChanged()&&<><button type="button" className="link-button" onClick={()=>void card.saveProfile()}>Save again</button><button type="button" className="link-button" onClick={()=>card.discardProfile()}>Use the latest</button></>}</p>}
    {hint&&<p className="ag-alert" role="status">{hint}</p>}
    <div className="ag-field"><span>Role in the team</span>
      <div role="radiogroup" aria-label="Role" className="ag-roles">{ROLE_CARDS.map(r=><label key={r.key} className="ag-role" data-on={s.profile.role===r.key||undefined}><input type="radio" name={`role-${id}`} aria-label={r.label} checked={s.profile.role===r.key} disabled={busy} onChange={()=>void change({role:r.key},`Role: ${r.label}`)}/><UiIcon name={r.icon} size={17}/><b>{r.label}</b><small>{r.text}</small></label>)}</div>
    </div>
    <div className="ag-two">
      <label className="ag-field">Department<span className="ag-picker"><DepartmentTile department={(dept??s.profile.department).trim().toLowerCase()||null} size={20}/><input list={`ag-departments-${id}`} aria-label="Department" placeholder="No department" maxLength={64} value={dept??s.profile.department} disabled={busy} onChange={e=>setDept(e.target.value)} onBlur={commitDept} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitDept();}if(e.key==='Escape'){e.preventDefault();setDept(null);}}}/></span>
        <datalist id={`ag-departments-${id}`}>{departments.map(d=><option key={d} value={d}/>)}</datalist></label>
      <AnswersWith card={card} busy={busy} onPick={(model,label)=>void change({model},`Answers with ${label}`)}/>
    </div>
    <div className="ag-field"><span>Responsibilities</span>
      <button type="button" className="ag-longtext" title="Open the long-text editor (⌘E)" disabled={busy} onClick={()=>setEditing(s.profile.description)}><span dir="auto">{s.profile.description||'What this agent is responsible for.'}</span><small>Opens the long-text editor (⌘E) · up to 1,000 characters</small></button>
    </div>
    <small className="ag-muted">Its role never changes its personality or permissions; those have their own parts. {roleWord(s.profile.role)!=='No role yet'?'':'No role yet: pick one above.'}</small>
    {editing!==null&&<DocumentEditor title={`${sel?.name??a?.name??'Agent'} · Responsibilities`} files={[{id:'responsibilities',name:'Responsibilities.md',content:editing}]} maxLength={1000} onChange={(_,text)=>setEditing(text)} onClose={()=>{const text=editing;setEditing(null);if(text!==s.profile.description)void change({description:text},'Responsibilities saved');}}/>}
    {removing&&<Sheet title={`Remove ${sel?.name??a?.name??'this agent'}?`} onClose={()=>setRemoving(false)} actions={<><button type="button" onClick={()=>setRemoving(false)}>Cancel</button><button type="button" className="primary ag-danger" disabled={acting||!!a?.isPrimary&&(n?.agents.length??0)>1} onClick={()=>{setRemoving(false);setActing(true);void agents?.remove(id).then(r=>{setActing(false);if(r.ok&&onGone)onGone(r.notice);else onDone(r.notice);});}}>Remove</button></>}>
      <p>{a?.isPrimary&&(n?.agents.length??0)>1?'This is the main agent. Make another agent the main agent first.':'It leaves the team for good. This cannot be undone.'}</p></Sheet>}
    {exporting&&<ExportAgentSheet client={card.client as never} agentId={id} name={sel?.name??a?.name??'agent'} onClose={()=>setExporting(false)} onDone={onDone}/>}
    <ContextMenu menu={menu.menu} onClose={menu.close}/>
  </div>;
}

/** Who answers for the agent: installed local models, and Claude only when a key exists. */
function AnswersWith({ card, busy, onPick }: { card: AgentCardController; busy: boolean; onPick: (model: string, label: string) => void }) {
  const s = useSyncExternalStore(card.subscribe, card.getSnapshot, card.getSnapshot);
  const models = s.models ?? [];
  const current = s.profile.model;
  const known = models.some(m => m.id === current);
  const claudeWithoutKey = s.agent?.provider === 'claude' && !models.some(m => m.provider === 'claude');
  return <label className="ag-field">Answers with<span className="ag-picker"><UiIcon name={s.agent?.provider==='claude'?'sparkle':'screen'} size={14}/>
    <select aria-label="Answers with" value={current} disabled={busy || !models.length} onChange={e => { const m = models.find(x => x.id === e.target.value); onPick(e.target.value, m?.label ?? e.target.value); }}>
      {!known && <option value={current}>{modelDisplayName(current) || 'Not set'}{claudeWithoutKey ? ' · no key' : ''}</option>}
      {models.some(m => m.provider === 'ollama') && <optgroup label="On this computer">{models.filter(m => m.provider === 'ollama').map(m => <option key={m.id} value={m.id}>{m.label}{m.size ? ` · ${m.size}` : ''}</option>)}</optgroup>}
      {models.some(m => m.provider === 'claude') && <optgroup label="Claude (paid)">{models.filter(m => m.provider === 'claude').map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>}
    </select></span>
    {claudeWithoutKey && <small className="ag-muted">Set to Claude, but no Claude key is saved, so it answers with the local model. Pick a local model to make that clear.</small>}
  </label>;
}

/** AG3a: what the agent remembers, and one line for what it may read and write. */
function MemoryPart({card,name,onDone}:{card:AgentCardController;name:string;onDone:PartDone;onOpenMemory?:(agentId?:string)=>void}){
 const s=useSyncExternalStore(card.subscribe,card.getSnapshot,card.getSnapshot);
 const [explorer,setExplorer]=useState<MemoryExplorerController>(),[rules,setRules]=useState(false);
 useEffect(()=>{const c=new MemoryExplorerController(card.client as never,`agent:${card.getSnapshot().agentId}`);setExplorer(c);void c.load();return()=>c.dispose();},[card]);
 const d=s.permissionDraft;
 const words=(kinds:readonly string[])=>kinds.map(k=>drawerKindLabel[k as DrawerKind]?.toLowerCase()??k).join(', ');
 const line=!d?'Reading its memory rules…':[d.memoryRead.length?`Reads ${words(d.memoryRead)}`:'Reads nothing',d.memoryWrite.length?`writes ${words(d.memoryWrite)}`:'writes nothing',d.sharedMemory?'shares with the team':'keeps to itself'].join(' · ');
 return <div className="ag-part ag-memory">
  <div className="ag-head-row"><h3>Memory</h3><small className="ag-muted">what <bdi>{name}</bdi> remembers · saved memories from this agent</small></div>
  <div className="ag-rules-line"><UiIcon name="database" size={15}/><span>{line}</span><button type="button" className="link-button" disabled={!d} onClick={()=>setRules(true)}>Change…</button></div>
  <AgentNotesRow client={card.client as never} agentId={s.agentId} name={name} onDone={onDone}/>
  {explorer?<AgentMemoryList c={explorer}/>:<p className="ag-muted" role="status">Reading memories…</p>}
  {rules&&<MemoryRules card={card} onDone={onDone} onClose={()=>setRules(false)}/>}
 </div>;
}
/** Memory rules: None / Read / Read + write for each place, and sharing with the team (each change saves at once). */
function MemoryRules({card,onDone,onClose}:{card:AgentCardController;onDone:PartDone;onClose:()=>void}){
 const s=useSyncExternalStore(card.subscribe,card.getSnapshot,card.getSnapshot),d=s.permissionDraft,busy=s.phase==='saving';
 const {commit,ask}=usePermissionSave(card,onDone);
 return <Sheet title="Memory rules" onClose={onClose} actions={<button type="button" className="primary" onClick={onClose}>Done</button>}>
  {!d?<p role="status">Reading memory rules…</p>:<>{drawerKinds.map(k=>{const level=d.memoryWrite.includes(k)?'write':d.memoryRead.includes(k)?'read':'none',label=drawerKindLabel[k as DrawerKind]??k;
   return <div key={k} className="ag-action"><span>{label}</span><span className="dk-segmented" role="radiogroup" aria-label={label}>{([['none','None'],['read','Read'],['write','Read + write']] as const).map(([v,t])=><button type="button" key={v} role="radio" aria-checked={level===v} aria-pressed={level===v} disabled={busy} onClick={()=>commit(()=>card.setDrawer(k,v),`${label}: ${t}`)}>{t}</button>)}</span></div>;})}
  <label className="ag-switch-label"><button type="button" role="switch" className="ag-switch" aria-checked={d.sharedMemory} aria-label="Share what it learns with the team" disabled={busy} onClick={()=>commit(()=>card.setShared(!d.sharedMemory),d.sharedMemory?'Keeps what it learns to itself':'Shares what it learns with the team')}><i/></button>Share what it learns with the team</label>
  {s.notice&&<p className="ag-alert" role="alert">{s.notice}</p>}</>}
  {ask}
 </Sheet>;
}

const when=(iso?:string|null)=>{if(!iso)return '';const t=new Date(iso);if(Number.isNaN(t.getTime()))return '';const today=new Date();const day=(x:Date)=>Math.floor((x.getTime()-x.getTimezoneOffset()*6e4)/864e5);const diff=day(today)-day(t);
 return diff===0?`Today ${t.toTimeString().slice(0,5)}`:diff===1?'Yesterday':t.toLocaleDateString('en-GB',{day:'numeric',month:'short'});};
/** AG3b: one timeline of what the agent did and what changed about it. */
function ActivityPart({card,onOpenApprovals}:{card:AgentCardController;onOpenApprovals?:()=>void}){
 const s=useSyncExternalStore(card.subscribe,card.getSnapshot,card.getSnapshot),[mem,setMem]=useState<AgentMemoryController>();
 useEffect(()=>{const c=new AgentMemoryController(card.client as never,s.agentId);setMem(c);void c.load();return()=>c.dispose();},[card,s.agentId]);
 const m=useSyncExternalStore(mem?.subscribe??noop,mem?.getSnapshot??none,mem?.getSnapshot??none);
 // Approval requests this agent sent (owner only; the server checks again). A failed read only leaves them out.
 const owner=card.client.getSnapshot().user?.role==='owner',[asked,setAsked]=useState<ApprovalActivity[]|null>(null);
 useEffect(()=>{if(!owner){setAsked([]);return;}const abort=new AbortController();setAsked(null);agentApprovals(card.client as never,s.agentId,abort.signal).then(list=>{if(!abort.signal.aborted)setAsked(approvalActivity(list));},()=>{if(!abort.signal.aborted)setAsked([]);});return()=>abort.abort();},[card,s.agentId,owner]);
 type Item={key:string;at:string;icon:UiIconName;tone:string;title:string;text:string;approvalId?:string};
 const items:Item[]=mergeTimeline<Item>((m?.handoffs??[]).map(h=>({key:`h${h.id}`,at:h.createdAt,icon:(h.kind==='conversation'?'note':'board') as UiIconName,tone:h.kind==='conversation'?'blue':'teal',title:`Work note · ${h.kind==='conversation'?'chat':'board task'}`,text:handoffLine(h)||'No summary recorded.'})),
  (s.versions??[]).map(v=>({key:`v${v.version}`,at:v.createdAt??'',icon:'smile' as UiIconName,tone:'purple',title:`Personality version ${v.version}${v.version===s.persona?.version?' · now':''}`,text:v.note||(v.source==='seed'?'First version':'Personality saved')})),asked??[]);
 const reading=!m||m.phase==='loading'||m.phase==='idle';
 const body=(i:Item)=><span><span>{i.title}</span><small dir="auto">{i.text}</small></span>;
 return <div className="ag-part ag-activity"><h3>Activity</h3>
  {m&&m.handoffs===null&&!reading&&<p role="status">Work notes could not be read. <button type="button" className="link-button" onClick={()=>void mem?.load()}>Try again</button></p>}
  {!s.versions&&<p role="status">Personality changes could not be read. <button type="button" className="link-button" onClick={()=>void card.openTab('activity')}>Try again</button></p>}
  {items.length?<ol className="ag-timeline">{items.map(i=><li key={i.key}><span className="ag-when">{when(i.at)}</span><span className="ag-dot" data-tone={i.tone}><UiIcon name={i.icon} size={14}/></span>{i.approvalId&&onOpenApprovals?<button type="button" className="link-button ag-activity-open" title="Open in Approvals" onClick={onOpenApprovals}>{body(i)}</button>:body(i)}</li>)}</ol>:<p className="ag-muted" role="status">{reading?'Reading activity…':'Nothing has happened with this agent yet.'}</p>}
 </div>;
}

const noop = () => () => {};
const none = () => undefined;
