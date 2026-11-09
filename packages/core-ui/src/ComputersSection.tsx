import {useEffect, useMemo, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {SessionClient} from './session';
import type {ComputerAttempt} from './computer-contract.js';
import {useComputerOverview, computerStateLabel, computerPathLabel} from './ComputerDevices';
import {ComputerTaskRequest} from './ComputerTaskRequest';
import {ComputerTaskTiming} from './ComputerTaskTiming';
import {ComputerLinkControls} from './ComputerLinkControls';
import {Sheet, ContextMenu, useMenu, type MenuItem} from './desktop-ui';
import {COMPUTER_ICONS, computerIcon, computerName, useComputerLook, type ComputerIconKey} from './ComputerLook';
import {AddThisComputer, ComputerJoinRequests, useAccountStatus} from './ComputerJoin';
import {ContinuityRequests} from './ComputerStart';
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
export function ComputersSection({client, active, sidebarSlot, onOpenChat, onApprovals, onSettings}: {
  client: SessionClient;
  active: boolean;
  sidebarSlot?: HTMLElement | null;
  onOpenChat: (id: string) => void;
  onApprovals: () => void;
  onSettings: () => void;
}) {
  const view = useComputerOverview();
  const account = useAccountStatus(client, active);
  const [selected, setSelected] = useState('');
  const [adding, setAdding] = useState(false);
  const [forget, setForget] = useState(false);
  const [notice, setNotice] = useState('');
  const [inspector, setInspector] = useState(true);
  const [renaming, setRenaming] = useState<{id: string; name: string; icon: ComputerIconKey | null} | null>(null);
  const [sending, setSending] = useState('');
  const {look, save} = useComputerLook(client, active);
  const menu = useMenu();
  // CP9c: the account knows each computer's system; its key ties it to the computer in this list.
  const accountDevice = (publicKey?: string) => account?.view?.devices?.find(d => d.publicKey && d.publicKey === publicKey);
  const iconOf = (id: string, publicKey?: string) => computerIcon(look, id, id === self?.id ? account?.view?.devices?.find(d => d.id === account?.view?.deviceId)?.osFamily : accountDevice(publicKey)?.osFamily);
  const nameOf = (id: string, name: string) => computerName(look, id, name);
  // CP11e (D10): computers take tasks from each other only on the same Girru version.
  const ownVersion = account?.view?.devices?.find(d => d.id === account?.view?.deviceId)?.appVersion;
  const older = (publicKey?: string) => { const v = accountDevice(publicKey)?.appVersion; return !!v && !!ownVersion && v !== ownVersion ? v : null; };
  const self = view?.self ?? null;
  const devices = useMemo(() => (view?.devices ?? []).filter(d => d.state !== 'revoked'), [view]);
  const attempts = view?.attempts ?? [];
  useEffect(() => { if (!selected && self) setSelected(self.id); }, [selected, self]);
  const device = devices.find(d => d.id === selected);
  const isSelf = !!self && selected === self.id;
  const waitingFrom = (id: string) => attempts.filter(a => self && a.targetDevice === self.id && a.sourceDevice === id && WAITING.has(a.state));
  const needs = isSelf ? attempts.filter(a => self && a.targetDevice === self.id && WAITING.has(a.state)) : waitingFrom(selected);
  const working = attempts.filter(a => a.targetDevice === selected && (WORKING.has(a.state) || a.state === 'completed' || a.state === 'cancelled' || a.state === 'unknown')).slice(0, 30);
  const usable = !!view && (view.testOnly || !!view.configured);

  const cancel = async (a: ComputerAttempt) => {
    try { const r = await client.request({method: 'POST', path: `/api/computers/tasks/${encodeURIComponent(a.taskId)}/cancel`}); setNotice(r.status === 200 ? 'Stopping the task.' : 'The task could not be stopped.'); }
    catch { setNotice('The task could not be stopped.'); }
  };
  const forgetNow = async () => {
    if (!device) return;
    try { const r = await client.request({method: 'POST', path: `/api/computers/peers/${encodeURIComponent(device.id)}/revoke`}); setNotice(r.status === 200 ? `${device.name} was forgotten.` : 'It could not be forgotten.'); if (r.status === 200) setSelected(self?.id ?? ''); }
    catch { setNotice('It could not be forgotten.'); }
    finally { setForget(false); }
  };

  const renameItem = (id: string, name: string): MenuItem => ({label: 'Rename and icon…', icon: 'pencil', shortcut: '↩', run: () => setRenaming({id, name, icon: look?.icons[id] as ComputerIconKey ?? null})});
  const menuFor = (d: {id: string; name: string}): MenuItem[] => [
    {label: 'Send a task…', icon: 'send', shortcut: '⌘↩', run: () => setSending(d.id)},
    {label: 'Works on…', icon: 'board', run: () => { setSelected(d.id); setInspector(true); }},
    renameItem(d.id, nameOf(d.id, d.name)),
    'sep',
    {label: 'Forget this computer', icon: 'trash', shortcut: '⌫', danger: true, run: () => { setSelected(d.id); setForget(true); }},
  ];
  const menuForSelf = (): MenuItem[] => [renameItem(self?.id ?? '', nameOf(self?.id ?? '', self?.name ?? 'This computer')), {label: 'Settings › Computers', icon: 'gear', run: onSettings}];
  const nav = <nav className="dk-sidebar computers-places" aria-label="My computers">
    <p className="section-label dk-label computers-label"><span>My computers</span>{usable && <button type="button" className="tool" title="Add a computer (⌘N)" aria-label="Add a computer" onClick={() => setAdding(true)}><UiIcon name="plus" size={14}/></button>}</p>
    {self && <button type="button" className="nav-item dk-place" aria-current={isSelf ? 'page' : undefined} onClick={() => setSelected(self.id)}>
      <UiIcon name={iconOf(self.id)} size={15}/><span className="dk-place-name">{nameOf(self.id, self.name)}</span><span className="dk-count">this one</span>
      {attempts.filter(a => a.targetDevice === self.id && WAITING.has(a.state)).length > 0 && <span className="dk-badge-pill" title="Needs you">{attempts.filter(a => a.targetDevice === self.id && WAITING.has(a.state)).length}</span>}
    </button>}
    {devices.map(d => <button key={d.id} type="button" className="nav-item dk-place" aria-current={selected === d.id ? 'page' : undefined} onClick={() => setSelected(d.id)} onContextMenu={e => { setSelected(d.id); menu.at(e, menuFor(d)); }}>
      <UiIcon name={iconOf(d.id, d.publicKey)} size={15}/><span className="dk-place-name">{nameOf(d.id, d.name)}</span>
      <span className={`computer-dot ${d.state === 'available' || d.state === 'busy' ? 'on' : 'off'}`} title={computerStateLabel(d.state)} aria-label={computerStateLabel(d.state)}/>
      {waitingFrom(d.id).length > 0 && <span className="dk-badge-pill" title="Needs you">{waitingFrom(d.id).length}</span>}
    </button>)}
  </nav>;

  const row = (a: ComputerAttempt, actions: ReactNode) => <div key={a.attemptId} className="computer-task" role="listitem">
    <UiIcon name={a.state === 'completed' ? 'check' : WAITING.has(a.state) ? 'inbox' : 'play'} size={15}/>
    <span className="computer-task-text"><b>{a.detail?.split('\n')[0]?.slice(0, 120) || 'Task'}</b><small>{a.state === 'completed' ? 'Done' : a.statusLabel} · from {a.sourceName}</small></span>
    <span className="computer-task-actions">{actions}</span>
  </div>;

  let main: ReactNode;
  if (!view) main = <div className="dk-empty"><p role="status">Reading your computers…</p></div>;
  else if (!usable || account?.view?.deviceStatus === 'pending') main = <div className="computers-main"><AddThisComputer client={client} status={account}/></div>;
  else if (!devices.length && isSelf && !needs.length) main = <div className="dk-empty computers-empty"><UiIcon name="screen" size={28}/><b>Your agents can also work on your other computers</b><p>Install Girru there and sign in with the same account.</p><button type="button" className="primary" onClick={() => setAdding(true)}>Add a computer</button></div>;
  else {
    const name = isSelf ? nameOf(self?.id ?? '', self?.name ?? 'This computer') : device ? nameOf(device.id, device.name) : 'Computer';
    const status = isSelf ? 'This computer' : device ? `${computerStateLabel(device.state)} · ${computerPathLabel(device.path)}` : '';
    main = <div className="computers-main">
      <header className="computers-head">
        <span className="computers-tile"><UiIcon name={isSelf ? iconOf(self?.id ?? '') : iconOf(device?.id ?? '', device?.publicKey)} size={22}/></span>
        <span className="computers-title"><h2>{name}</h2><small>{status}</small></span>
        {!isSelf && device && <ComputerTaskRequest key={sending} client={client} presetTarget={device.id} label="Send a task" openNow={sending === device.id} onClosed={() => setSending('')}/>}
        {(isSelf ? self : device) && <button type="button" className="tool" title="More" aria-label="More" onClick={e => menu.at(e, isSelf ? menuForSelf() : menuFor(device!))}><UiIcon name="more" size={15}/></button>}
        <button type="button" className="tool" title={inspector ? 'Hide details' : 'Show details'} aria-label={inspector ? 'Hide details' : 'Show details'} aria-pressed={inspector} onClick={() => setInspector(v => !v)}><UiIcon name="inspector" size={15}/></button>
      </header>
      {notice && <p role="status" className="fine-print">{notice}</p>}
      {!isSelf && device && older(device.publicKey) && <div className="computer-task computer-version" role="status"><UiIcon name="download" size={16}/><span className="computer-task-text"><b>{nameOf(device.id, device.name)} has another Girru version</b><small>It can still be seen, but it can’t take new tasks until both run the same version. It updates by itself the next time it opens (backup first).</small></span></div>}
      {isSelf && <ComputerJoinRequests client={client} status={account}/>}
      {isSelf && <ContinuityRequests client={client} status={account}/>}
      {needs.length > 0 && <section aria-label="Needs you"><p className="section-label">Needs you</p><div className="computer-list" role="list">
        {needs.map(a => row(a, <><ComputerTaskTiming client={client} taskId={a.taskId} onPrepared={onApprovals}/><button type="button" onClick={onApprovals}>Open Approvals</button></>))}
      </div></section>}
      <section aria-label="Working on"><p className="section-label">Working on</p>
        {working.length ? <div className="computer-list" role="list">
          {working.map(a => row(a, <>{a.sessionId && <button type="button" onClick={() => onOpenChat(a.sessionId!)}>Open its chat</button>}{WORKING.has(a.state) && a.state !== 'cancel_requested' && <button type="button" className="danger-text" onClick={() => void cancel(a)}>Stop</button>}</>))}
        </div> : <p className="fine-print">Nothing right now.{!isSelf && device && device.state !== 'available' && device.state !== 'busy' ? ' Tasks you send wait on this computer and go when it is open again.' : ''}</p>}
      </section>
    </div>;
  }

  const inspectorPane = usable && inspector && (isSelf || device) ? <aside className="computers-inspector" aria-label="About this computer">
    <b>{isSelf ? self?.name : device?.name}</b>
    {device && <><span className="computers-field"><small>Connection</small><span><UiIcon name="wifi" size={14}/>{computerPathLabel(device.path)}</span></span>
      <span className="computers-field"><small>Last seen</small><span>{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'Not yet'}</span></span>
      <span className="computers-field"><small>Works on</small>{(device.dispatchOptions ?? []).length ? (device.dispatchOptions ?? []).map(o => <span key={o.id}><UiIcon name="board" size={14}/>{o.label}</span>) : <span>No projects shared yet</span>}</span></>}
    {isSelf && <span className="computers-field"><small>Works on</small>{(view?.dispatchOptions ?? []).length ? view!.dispatchOptions.map(o => <span key={o.id}><UiIcon name="board" size={14}/>{o.label}</span>) : <span>No projects shared yet</span>}</span>}
    <button type="button" className="link-button" onClick={onSettings}>Settings › Computers</button>
  </aside> : null;

  return <section className="computers" data-inspector={inspectorPane ? 'open' : 'closed'} data-inline-sidebar={!sidebarSlot || undefined} aria-label="Computers">
    {sidebarSlot ? (active ? createPortal(nav, sidebarSlot) : null) : nav}
    {main}
    {inspectorPane}
    {adding && <Sheet title="Add a computer" onClose={() => setAdding(false)}>
      <ol className="computer-join-list"><li>Install Girru on the other computer.</li><li>Choose Computers › Continue with Google there, with the same Google account.</li><li>This computer then asks “Add it to your account?” with pictures to compare.</li></ol>
      {view && <details><summary>Older way, with a code to copy</summary><ComputerLinkControls client={client} view={view} onNotice={setNotice}/></details>}
    </Sheet>}
    <ContextMenu menu={menu.menu} onClose={menu.close}/>
    {renaming && <Sheet title="Rename and icon" onClose={() => setRenaming(null)} actions={<><button type="button" onClick={() => setRenaming(null)}>Cancel</button><button type="button" className="primary" disabled={!renaming.name.trim()} onClick={() => { const r = renaming; void save(r.id, {name: r.name.trim(), ...(r.icon ? {icon: r.icon} : {})}).then(() => setRenaming(null)).catch(() => setNotice('It could not be saved.')); }}>Save</button></>}>
      <label className="phone-field"><span>Name on this computer</span><input autoFocus value={renaming.name} maxLength={64} onChange={e => setRenaming({...renaming, name: e.target.value})}/></label>
      <div className="computer-icons" role="radiogroup" aria-label="Picture">{COMPUTER_ICONS.map(i => <button key={i.key} type="button" role="radio" aria-checked={renaming.icon === i.key} className={`computer-icon-choice${renaming.icon === i.key ? ' is-on' : ''}`} title={i.name} onClick={() => setRenaming({...renaming, icon: i.key})}><UiIcon name={i.icon} size={22}/><small>{i.name}</small></button>)}</div>
      <p className="fine-print">Girru picks the picture from the system by itself; choose another if you like.</p>
    </Sheet>}
    {forget && device && <Sheet title={`Forget “${device.name}”?`} onClose={() => setForget(false)} actions={<><button type="button" onClick={() => setForget(false)}>Cancel</button><button type="button" className="danger" onClick={() => void forgetNow()}>Forget this computer</button></>}>
      <p>It can no longer send or take tasks. To use it again, add it again.</p>
    </Sheet>}
  </section>;
}
