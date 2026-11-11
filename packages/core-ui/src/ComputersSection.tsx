import {useEffect, useMemo, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {SessionClient} from './session';
import type {ComputerAttempt} from './computer-contract.js';
import {useComputerOverview, computerStateLabel} from './ComputerDevices';
import {ComputerTaskRequest} from './ComputerTaskRequest';
import {ComputerTaskTiming} from './ComputerTaskTiming';
import {ContextMenu, useMenu, type MenuItem} from './desktop-ui';
import {computerIcon, computerName, useComputerLook, type ComputerIconKey} from './ComputerLook';
import {AddThisComputer, ComputerJoinRequests, useAccountStatus, TrustCompare, call, computerAccountWords, type Status} from './ComputerJoin';
import {ContinuityRequests, SameSetupArrived} from './ComputerStart';
import {AllowTask, TakesNewTasks} from './ComputerTaskRules';
import {ComputerWorksOn, ProjectCopyAsks} from './ComputerWorksOn';
import {RenameComputerSheet, forgetComputerLater, ForgetNotice, useForgetPending} from './ComputerActions';
import {UiIcon} from './ui-icons';

/** Tasks that wait for this computer's owner to allow them. */
const WAITING = new Set(['waiting_approval', 'blocked']);
/** Tasks that are on their way or running. */
const WORKING = new Set(['queued', 'scheduled', 'accepted', 'running', 'cancel_requested']);

/**
 * Computers (DEVICES-PROJECT-01, board CP3): a footer section with its own sidebar.
 * The sidebar lists my computers; the selected one shows what needs me and what it
 * works on; its details sit in the inspector. One main action: Send a task.
 * Rare and technical controls live in Settings › Computers.
 */
export function ComputersSection({client, active, sidebarSlot, onOpenChat, onApprovals, onSettings, onUpdates}: {
  client: SessionClient;
  active: boolean;
  sidebarSlot?: HTMLElement | null;
  onUpdates?: () => void;
  onOpenChat: (id: string) => void;
  onApprovals: () => void;
  onSettings: () => void;
}) {
  const view = useComputerOverview();
  const account = useAccountStatus(client, active);
  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState('');
  const [inspector, setInspector] = useState(true);
  const [worksOn, setWorksOn] = useState(false);
  const [renaming, setRenaming] = useState<{id: string; name: string; icon: ComputerIconKey | null} | null>(null);
  const [sending, setSending] = useState('');
  const {look, save} = useComputerLook(client, active);
  const menu = useMenu();
  // CP9c: the account knows each computer's system; its key ties it to the computer in this list.
  const accountDevice = (publicKey?: string) => account?.view?.devices?.find(d => d.publicKey && d.publicKey === publicKey);
  /** The account sees it online but the direct link is not up yet: “Connecting…”, not “Off”. */
  const shownState = (d: {state: string; publicKey?: string}) => (d.state === 'offline' || d.state === 'unknown') && accountDevice(d.publicKey)?.presence === 'online' ? 'connecting' : d.state;
  const stateWords = (d: {state: string; publicKey?: string}) => shownState(d) === 'connecting' ? 'Connecting…' : computerStateLabel(d.state);
  const iconOf = (id: string, publicKey?: string) => computerIcon(look, id, id === self?.id ? account?.view?.devices?.find(d => d.id === account?.view?.deviceId)?.osFamily : accountDevice(publicKey)?.osFamily);
  const nameOf = (id: string, name: string) => computerName(look, id, name);
  // CP11e (D10): computers take tasks from each other only on the same Girru version.
  const ownVersion = account?.view?.devices?.find(d => d.id === account?.view?.deviceId)?.appVersion;
  // CP11e (D10): this computer sees by itself that another of your computers runs a newer Girru.
  const newerElsewhere = (account?.view?.devices ?? []).filter(d => d.id !== account?.view?.deviceId && d.status === 'approved' && !!ownVersion && (d.appVersion ?? '').localeCompare(ownVersion, undefined, {numeric: true}) > 0).sort((a, b) => (b.appVersion ?? '').localeCompare(a.appVersion ?? '', undefined, {numeric: true}))[0];
  const older = (publicKey?: string) => { const v = accountDevice(publicKey)?.appVersion; return !!v && !!ownVersion && v !== ownVersion ? v : null; };
  const self = view?.self ?? null;
  // While this computer waits to be added, the coordinator has no list yet; the account still knows it.
  const accountSelf = account?.view?.devices?.find(d => d.id === account?.view?.deviceId) ?? null;
  const devices = useMemo(() => (view?.devices ?? []).filter(d => d.state !== 'revoked'), [view]);
  const forgetting = useForgetPending();
  // The same computer signed in again shows once (the newest); the older copies wait on one line to be forgotten.
  const newestFirst = [...devices].filter(d => d.id !== forgetting).sort((a, b) => (accountDevice(b.publicKey)?.registeredAt ?? 0) - (accountDevice(a.publicKey)?.registeredAt ?? 0));
  const seenNames = new Set<string>(), listed: typeof devices = [], olderCopies: typeof devices = [];
  for (const d of newestFirst) { const key = nameOf(d.id, d.name).trim().toLowerCase(); if (seenNames.has(key)) olderCopies.push(d); else { seenNames.add(key); listed.push(d); } }
  const attempts = view?.attempts ?? [];
  useEffect(() => { if (!selected && self) setSelected(self.id); }, [selected, self]);
  const device = devices.find(d => d.id === selected);
  const isSelf = !!self && selected === self.id;
  const waitingFrom = (id: string) => attempts.filter(a => self && a.targetDevice === self.id && a.sourceDevice === id && WAITING.has(a.state));
  const needs = isSelf ? attempts.filter(a => self && a.targetDevice === self.id && (WAITING.has(a.state) || (a.runWaiting ?? 0) > 0)) : waitingFrom(selected);
  const working = attempts.filter(a => a.targetDevice === selected && (WORKING.has(a.state) || a.state === 'completed' || a.state === 'cancelled' || a.state === 'unknown')).slice(0, 30);
  const usable = !!view && (view.testOnly || !!view.configured);

  const cancel = async (a: ComputerAttempt) => {
    try { const r = await client.request({method: 'POST', path: `/api/computers/tasks/${encodeURIComponent(a.taskId)}/cancel`}); setNotice(r.status === 200 ? 'Stopping the task.' : 'The task could not be stopped.'); }
    catch { setNotice('The task could not be stopped.'); }
  };

  const renameItem = (id: string, name: string): MenuItem => ({label: 'Rename and icon…', icon: 'pencil', shortcut: '↩', run: () => setRenaming({id, name, icon: look?.icons[id] as ComputerIconKey ?? null})});
  const menuFor = (d: {id: string; name: string; publicKey?: string}): MenuItem[] => [
    {label: 'Send a task…', icon: 'send', shortcut: '⌘↩', run: () => setSending(d.id)},
    {label: 'Project…', icon: 'board', run: () => { setSelected(d.id); setInspector(true); }},
    renameItem(d.id, nameOf(d.id, d.name)),
    'sep',
    {label: 'Forget this computer', icon: 'trash', shortcut: '⌫', danger: true, run: () => { forgetComputerLater(client, {id: d.id, name: nameOf(d.id, d.name), publicKey: d.publicKey}); setSelected(self?.id ?? ''); }},
  ];
  const menuForSelf = (): MenuItem[] => [renameItem(self?.id ?? '', nameOf(self?.id ?? '', self?.name ?? 'This computer')), {label: 'Settings › Computers', icon: 'gear', run: onSettings}];
  const nav = <nav className="dk-sidebar computers-places" aria-label="My computers">
    <p className="section-label dk-label computers-label"><span>My computers</span></p>
    {self && <button type="button" className="nav-item dk-place" aria-current={isSelf ? 'page' : undefined} onClick={() => setSelected(self.id)}>
      <UiIcon name={iconOf(self.id)} size={15}/><span className="dk-place-name">{nameOf(self.id, self.name)}</span><span className="dk-count">this one</span>
      {attempts.filter(a => a.targetDevice === self.id && WAITING.has(a.state)).length > 0 && <span className="dk-badge-pill" title="Needs you">{attempts.filter(a => a.targetDevice === self.id && WAITING.has(a.state)).length}</span>}
    </button>}
    {!self && accountSelf && <button type="button" className="nav-item dk-place" aria-current="page" title={accountSelf.status === 'pending' ? 'Waiting to be added to your account' : undefined}>
      <UiIcon name={computerIcon(look, accountSelf.id, accountSelf.osFamily)} size={15}/><span className="dk-place-name">{nameOf(accountSelf.id, accountSelf.label)}</span><span className="dk-count">{accountSelf.status === 'pending' ? 'waiting' : 'this one'}</span>
    </button>}
    {listed.map(d => <button key={d.id} type="button" className="nav-item dk-place" aria-current={selected === d.id ? 'page' : undefined} onClick={() => setSelected(d.id)} onContextMenu={e => { setSelected(d.id); menu.at(e, menuFor(d)); }}>
      <UiIcon name={iconOf(d.id, d.publicKey)} size={15}/><span className="dk-place-name">{nameOf(d.id, d.name)}</span>
      <span className={`computer-dot ${d.state === 'available' || d.state === 'busy' ? 'on' : shownState(d) === 'connecting' ? 'connecting' : 'off'}`} title={stateWords(d)} aria-label={stateWords(d)}/>
      {waitingFrom(d.id).length > 0 && <span className="dk-badge-pill" title="Needs you">{waitingFrom(d.id).length}</span>}
    </button>)}
    {olderCopies.length > 0 && <button type="button" className="nav-item dk-place computers-older" title="The same computers signed in before. They no longer work." onClick={() => { for (const d of olderCopies) forgetComputerLater(client, {id: d.id, name: nameOf(d.id, d.name), publicKey: d.publicKey}); }}>
      <UiIcon name="trash" size={14}/><span className="dk-place-name">Older copies ({olderCopies.length})</span><span className="dk-count">Forget</span>
    </button>}
  </nav>;

  /** CP16: this computer sent the task (its chat lives on the other computer). */
  const sentHere = (a: ComputerAttempt) => !!self && a.sourceDevice === self.id && a.targetDevice !== self.id;
  const row = (a: ComputerAttempt, actions: ReactNode) => <div key={a.attemptId} className="computer-task" role="listitem">
    <UiIcon name={a.state === 'completed' ? 'check' : WAITING.has(a.state) ? 'inbox' : 'play'} size={15}/>
    <span className="computer-task-text"><b>{(a as {title?: string}).title || (sentHere(a) ? '' : a.detail?.split('\n')[0]?.slice(0, 120)) || 'Task'}</b>
      {/* CP16 B: the computer that sent a task says where it went; the one that ran it says who sent it. */}
      <small>{a.state === 'completed' ? 'Done' : a.state === 'running' && /^Waits for your OK/.test(a.detail ?? '') ? 'Waits for your OK there' : a.statusLabel} · {sentHere(a) ? `sent from here to ${a.targetName}` : `from ${a.sourceName}`}</small>
      {a.state === 'blocked' && a.detail && <small className="cp-warn">{a.detail.split('\n')[0].slice(0, 200)}</small>}
      {sentHere(a) && a.state === 'completed' && a.detail && <TaskAnswer text={a.detail} where={a.targetName}/>}</span>
    <span className="computer-task-actions">{actions}</span>
  </div>;

  let main: ReactNode;
  if (!view) main = <div className="dk-empty"><p role="status">Reading your computers…</p></div>;
  // Right after Girru starts it reconnects to the account by itself: say so, never offer to add a computer that is already added.
  else if (account === undefined || account?.configured && !!account.mapping && !account.connected && !(account as {resumeRefused?: boolean}).resumeRefused || account?.connected && account.view?.deviceStatus === 'approved' && !usable) main = <div className="dk-empty computers-empty" role="status"><UiIcon name="screen" size={28}/><b>{account?.connected ? 'Getting your computers ready…' : 'Connecting to your account…'}</b><p>This takes a few seconds after Girru starts.</p></div>;
  else if (!usable || account?.view?.deviceStatus === 'pending') main = <div className="computers-main"><AddThisComputer client={client} status={account} knownName={(self ? nameOf(self.id, self.name) : accountSelf ? nameOf(accountSelf.id, accountSelf.label) : '').trim() || undefined}/></div>;
  else {
    const name = isSelf ? nameOf(self?.id ?? '', self?.name ?? 'This computer') : device ? nameOf(device.id, device.name) : 'Computer';
    // CP12 A: one short line: on or off, and the project it works on.
    const project = (isSelf ? view.dispatchOptions : device?.dispatchOptions ?? [])[0]?.label;
    const onWord = isSelf ? 'On' : device ? (shownState(device) === 'connecting' ? 'Connecting…' : device.state === 'available' || device.state === 'busy' ? 'On' : device.state === 'paused' ? 'On · not taking new tasks' : 'Off') : '';
    const status = onWord + (project ? ` · works on ${project}` : ' · no project yet');
    main = <div className="computers-main">
      <header className="computers-head">
        <span className="computers-tile"><UiIcon name={isSelf ? iconOf(self?.id ?? '') : iconOf(device?.id ?? '', device?.publicKey)} size={22}/></span>
        <span className="computers-title"><h2>{name}</h2><small>{status}</small></span>
        {!isSelf && device && <ComputerTaskRequest key={sending} client={client} presetTarget={device.id} label="Send a task" openNow={sending === device.id || undefined} onClosed={() => setSending('')}/>}
        {(isSelf ? self : device) && <button type="button" className="tool" title="More" aria-label="More" onClick={e => menu.at(e, isSelf ? menuForSelf() : menuFor(device!))}><UiIcon name="more" size={15}/></button>}
        <button type="button" className="tool" title={inspector ? 'Hide details' : 'Show details'} aria-label={inspector ? 'Hide details' : 'Show details'} aria-pressed={inspector} onClick={() => setInspector(v => !v)}><UiIcon name="inspector" size={15}/></button>
      </header>
      {notice && <p role="status" className="fine-print">{notice}</p>}
      <ForgetNotice/>
      <ProjectCopyAsks client={client}/>
      {isSelf && newerElsewhere && <div className="computer-task computer-version" role="status"><UiIcon name="download" size={16}/><span className="computer-task-text"><b>Update Girru on this computer</b><small>{newerElsewhere.label} has a newer Girru ({newerElsewhere.appVersion}). Until this computer is updated, they can’t send each other tasks.</small></span>{onUpdates && <span className="computer-task-actions"><button type="button" className="primary" onClick={onUpdates}>Update…</button></span>}</div>}
      {!isSelf && device && older(device.publicKey) && <div className="computer-task computer-version" role="status"><UiIcon name="download" size={16}/><span className="computer-task-text"><b>{nameOf(device.id, device.name)} has another Girru version</b><small>It can still be seen, but it can’t take new tasks until both run the same version. It updates by itself the next time it opens (backup first).</small></span></div>}
      <section aria-label="Needs you"><p className="section-label">Needs you</p>{isSelf && <ComputerJoinRequests client={client} status={account}/>}{isSelf && <ContinuityRequests client={client} status={account}/>}{isSelf && <SameSetupArrived client={client} status={account}/>}{isSelf && <TrustRequests client={client} status={account}/>}{needs.length > 0 ? <div className="computer-list" role="list">
        {needs.map(a => (a.runWaiting ?? 0) > 0 && !WAITING.has(a.state) ? row(a, <><span className="fine-print">A command waits for your Run</span>{a.sessionId && <button type="button" onClick={() => onOpenChat(a.sessionId!)}>Open its chat</button>}</>) : row(a, <>{a.state === 'blocked' ? null : a.approvalId ? <AllowTask client={client} approvalId={a.approvalId} sourceName={nameOf(a.sourceDevice, a.sourceName)} onDone={setNotice} onApprovals={onApprovals}/> : <button type="button" onClick={onApprovals}>Open Approvals</button>}{a.state === 'blocked' ? <TryAgain client={client} taskId={a.taskId} onDone={setNotice}/> : <ComputerTaskTiming client={client} taskId={a.taskId} onPrepared={onApprovals}/>}</>))}
      </div> : !(isSelf && ((account?.pairing?.addedWithCode?.length ?? 0) > 0 || (account?.pairing?.requests?.length ?? 0) > 0)) && <p className="fine-print">Nothing waits for you.</p>}</section>
      <section aria-label="Working on"><p className="section-label">Working on</p>
        {working.length ? <div className="computer-list" role="list">
          {working.map(a => row(a, <>{a.sessionId && !sentHere(a) && <button type="button" onClick={() => onOpenChat(a.sessionId!)}>Open its chat</button>}{WORKING.has(a.state) && a.state !== 'cancel_requested' && <button type="button" className="danger-text" onClick={() => void cancel(a)}>Stop</button>}</>))}
        </div> : <p className="fine-print">Nothing right now.{!isSelf && device && device.state !== 'available' && device.state !== 'busy' ? ' Tasks you send wait on this computer and go when it is open again.' : ''}</p>}
      </section>
      {/* CP3b: only this computer in the account. */}
      {isSelf && !devices.length && <div className="computers-alone"><UiIcon name="screen" size={22}/><span><b>Your agents can also work on your other computers</b><small>Install Girru on your other computer and sign in with the same Google account. It joins your account by itself and shows up here.</small></span></div>}
    </div>;
  }

  const inspectorPane = usable && inspector && (isSelf || device) ? <aside className="computers-inspector" aria-label="About this computer">
    <b>{isSelf ? nameOf(self?.id ?? '', self?.name ?? 'This computer') : device ? nameOf(device.id, device.name) : ''}</b>
    <span className="computers-field"><small>Project</small>{((isSelf ? view?.dispatchOptions : device?.dispatchOptions) ?? []).map(o => <span key={o.id}><UiIcon name="folder" size={14}/>{o.label}</span>)}{!((isSelf ? view?.dispatchOptions : device?.dispatchOptions) ?? []).length && <span>{isSelf ? 'None yet' : 'None yet: choose its folder on that computer'}</span>}
      {isSelf && <button type="button" className="cp-link" onClick={() => setWorksOn(true)}>{(view?.dispatchOptions ?? []).length ? 'Change…' : 'Choose a folder…'}</button>}</span>
    {isSelf && <TakesNewTasks client={client}/>}
  </aside> : null;

  return <section className="computers" data-inspector={inspectorPane ? 'open' : 'closed'} data-inline-sidebar={!sidebarSlot || undefined} aria-label="Computers">
    {sidebarSlot ? (active ? createPortal(nav, sidebarSlot) : null) : nav}
    {main}
    {inspectorPane}
    <ContextMenu menu={menu.menu} onClose={menu.close}/>
    {worksOn && <ComputerWorksOn client={client} currentName={view?.dispatchOptions?.[0]?.label} onClose={() => setWorksOn(false)}/>}
    {renaming && <RenameComputerSheet target={renaming} onSave={save} onClose={() => setRenaming(null)}/>}
  </section>;
}

/** CP13: a task that could not start tries again after the owner fixed the reason shown above it. */
function TryAgain({client, taskId, onDone}: {client: SessionClient; taskId: string; onDone: (text: string) => void}) {
  const [busy, setBusy] = useState(false);
  return <button type="button" disabled={busy} onClick={() => { setBusy(true); void client.request({method: 'POST', path: `/api/computers/tasks/${taskId}/timing`, body: {timing: {mode: 'immediate'}}}).then(r => onDone(r.status === 200 ? 'Trying again.' : 'It still cannot start. Fix the reason shown, then try again.')).catch(() => onDone('It still cannot start. Fix the reason shown, then try again.')).finally(() => setBusy(false)); }}>Try again</button>;
}

/** CP16 B: the answer of a task this computer sent, on its row (the chat stays on the computer that ran it). */
function TaskAnswer({text, where}: {text: string; where: string}) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); };
  return <span className="computer-task-answer">
    <pre dir="auto">{text}</pre>
    <span className="computer-task-answer-foot"><button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy answer'}</button><small>The chat stays on {where}</small></span>
  </span>;
}

/** CP16 A: on each of your computers, the others it does not trust yet: compare the code shown on both, then Same code (or remove a computer that is not yours). */
function TrustRequests({client, status}: {client: SessionClient; status: Status | null | undefined}) {
  const [removing, setRemoving] = useState(''), [notice, setNotice] = useState('');
  const items = status?.trust ?? [];
  if (!items.length) return notice ? <p role="status" className="fine-print">{notice}</p> : null;
  const remove = async (deviceId: string) => { try { await call(client, '/api/computers/account/devices/revoke', {deviceId, confirmed: true}); setNotice('Removed from your account.'); } catch (e) { setNotice(computerAccountWords((e as Error).message)); } finally { setRemoving(''); } };
  return <div className="computer-list" role="list" aria-label="Computers to trust">
    {items.map(t => <div key={t.deviceId} className="computer-task" role="listitem"><TrustCompare client={client} item={t}
      intro={<><b>{t.label}</b> is in your account. Is it yours? The same code shows on {t.label}.</>}
      extra={removing === t.deviceId ? <button type="button" className="danger-text" onClick={() => void remove(t.deviceId)}>Remove it from your account</button> : <button type="button" onClick={() => setRemoving(t.deviceId)}>Not mine</button>}/></div>)}
    {notice && <p role="status" className="fine-print">{notice}</p>}
  </div>;
}
