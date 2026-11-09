import {useEffect, useMemo, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {SessionClient} from './session';
import type {ComputerAttempt} from './computer-contract.js';
import {useComputerOverview, computerStateLabel, computerPathLabel} from './ComputerDevices';
import {ComputerTaskRequest} from './ComputerTaskRequest';
import {ComputerTaskTiming} from './ComputerTaskTiming';
import {ComputerLinkControls} from './ComputerLinkControls';
import {Sheet} from './desktop-ui';
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
  const [selected, setSelected] = useState('');
  const [adding, setAdding] = useState(false);
  const [forget, setForget] = useState(false);
  const [notice, setNotice] = useState('');
  const [inspector, setInspector] = useState(true);
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

  const nav = <nav className="dk-sidebar computers-places" aria-label="My computers">
    <p className="section-label dk-label computers-label"><span>My computers</span>{usable && <button type="button" className="tool" title="Add a computer (⌘N)" aria-label="Add a computer" onClick={() => setAdding(true)}><UiIcon name="plus" size={14}/></button>}</p>
    {self && <button type="button" className="nav-item dk-place" aria-current={isSelf ? 'page' : undefined} onClick={() => setSelected(self.id)}>
      <UiIcon name="screen" size={15}/><span className="dk-place-name">{self.name}</span><span className="dk-count">this one</span>
      {attempts.filter(a => a.targetDevice === self.id && WAITING.has(a.state)).length > 0 && <span className="dk-badge-pill" title="Needs you">{attempts.filter(a => a.targetDevice === self.id && WAITING.has(a.state)).length}</span>}
    </button>}
    {devices.map(d => <button key={d.id} type="button" className="nav-item dk-place" aria-current={selected === d.id ? 'page' : undefined} onClick={() => setSelected(d.id)}>
      <UiIcon name="screen" size={15}/><span className="dk-place-name">{d.name}</span>
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
  else if (!usable) main = <div className="dk-empty computers-empty"><UiIcon name="screen" size={28}/><b>Use Girru on your other computers</b><p>Sign in to your Dpro account first. Your agents can then send work to your other computers.</p><button type="button" className="primary" onClick={onSettings}>Open Settings › Computers</button></div>;
  else if (!devices.length && isSelf && !needs.length) main = <div className="dk-empty computers-empty"><UiIcon name="screen" size={28}/><b>Your agents can also work on your other computers</b><p>Install Girru there and sign in with the same account.</p><button type="button" className="primary" onClick={() => setAdding(true)}>Add a computer</button></div>;
  else {
    const name = isSelf ? self?.name ?? 'This computer' : device?.name ?? 'Computer';
    const status = isSelf ? 'This computer' : device ? `${computerStateLabel(device.state)} · ${computerPathLabel(device.path)}` : '';
    main = <div className="computers-main">
      <header className="computers-head">
        <span className="computers-tile"><UiIcon name="screen" size={22}/></span>
        <span className="computers-title"><h2>{name}</h2><small>{status}</small></span>
        {!isSelf && device && <ComputerTaskRequest client={client} presetTarget={device.id} label="Send a task"/>}
        {!isSelf && device && <button type="button" className="tool" title="More" aria-label="More" onClick={() => setForget(true)}><UiIcon name="more" size={15}/></button>}
        <button type="button" className="tool" title={inspector ? 'Hide details' : 'Show details'} aria-label={inspector ? 'Hide details' : 'Show details'} aria-pressed={inspector} onClick={() => setInspector(v => !v)}><UiIcon name="inspector" size={15}/></button>
      </header>
      {notice && <p role="status" className="fine-print">{notice}</p>}
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
      <p className="fine-print">Install Girru on the other computer and sign in with the same account. Then allow it here.</p>
      {view && <ComputerLinkControls client={client} view={view} onNotice={setNotice}/>}
    </Sheet>}
    {forget && device && <Sheet title={`Forget “${device.name}”?`} onClose={() => setForget(false)} actions={<><button type="button" onClick={() => setForget(false)}>Cancel</button><button type="button" className="danger" onClick={() => void forgetNow()}>Forget this computer</button></>}>
      <p>It can no longer send or take tasks. To use it again, add it again.</p>
    </Sheet>}
  </section>;
}
