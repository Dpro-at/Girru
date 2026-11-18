import {useMemo, useState} from 'react';
import type {SessionClient} from './session';
import {useComputerOverview} from './ComputerDevices';
import {Sheet} from './desktop-ui';
import {UiIcon} from './ui-icons';
import {useAccountStatus} from './ComputerJoin';
import {computerIcon, computerName, useComputerLook} from './ComputerLook';

/** When “Send later…” starts the task: tonight 20:00, tomorrow 09:00, or a picked time (each with a 30-minute start window). */
export function laterTiming(choice: 'tonight' | 'morning' | 'pick', picked: string, now = new Date()) {
  const at = new Date(now);
  if (choice === 'tonight') { at.setHours(20, 0, 0, 0); if (at.getTime() <= now.getTime() + 60_000) at.setDate(at.getDate() + 1); }
  else if (choice === 'morning') { at.setDate(at.getDate() + 1); at.setHours(9, 0, 0, 0); }
  else { const t = new Date(picked); if (Number.isNaN(t.getTime())) return null; at.setTime(t.getTime()); }
  if (at.getTime() <= now.getTime() + 60_000 || at.getTime() > now.getTime() + 30 * 86_400_000) return null;
  return {mode: 'scheduled' as const, executeAt: at.getTime(), latestStartAt: at.getTime() + 30 * 60_000, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone};
}

/**
 * One Send a task sheet everywhere (CP4a): Computers › Send a task, the chat toolbar icon and a Board
 * card's right-click › Send to computer (`card`, `title`). The free computer that has the project
 * comes first; off computers stay pickable (the task waits here). Board and column are the target's own.
 */
export function ComputerTaskRequest({client, conversationId, card, title, presetTarget, label, openNow, onClosed}: {client: SessionClient; conversationId?: string; card?: {boardId: string; cardId: string; cardVersion: number}; title?: string; presetTarget?: string; label?: string; openNow?: boolean; onClosed?: () => void}) {
  const view = useComputerOverview();
  const [open, setOpenState] = useState(!!openNow);
  const setOpen = (v: boolean) => { setOpenState(v); if (!v) onClosed?.(); };
  const [target, setTarget] = useState(presetTarget ?? '');
  const [binding, setBinding] = useState('');
  const [taskTitle, setTaskTitle] = useState(title ?? '');
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high' | 'urgent'>('normal');
  const [later, setLater] = useState<null | 'tonight' | 'morning' | 'pick'>(null);
  const [picked, setPicked] = useState('');
  const [showLater, setShowLater] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const account = useAccountStatus(client, open);
  const {look} = useComputerLook(client, open);
  const devices = useMemo(() => {
    const free = (d: {state: string; dispatchOptions?: unknown[]; capacity?: {active: number; limit: number} | null}) => (d.state === 'available' ? 2 : d.state === 'busy' ? 1 : 0) + ((d.dispatchOptions?.length ?? 0) > 0 ? 2 : 0) - (d.capacity && d.capacity.active >= d.capacity.limit ? 1 : 0);
    // One entry per computer: when the same computer signed in again, only its newest copy.
    const reg = (k?: string) => account?.view?.devices?.find(x => !!k && x.publicKey === k)?.registeredAt ?? 0;
    const seen = new Set<string>();
    return (view?.devices ?? []).filter(d => d.state !== 'revoked').sort((a, b) => reg(b.publicKey) - reg(a.publicKey)).filter(d => { const k = d.name.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => free(b) - free(a));
  }, [view, account]);
  if (!view?.devices.length || !view.configured && !view.testOnly) return null;
  const chosen = target || devices[0]?.id || '';
  const device = devices.find(d => d.id === chosen);
  // CP12 B: the project is the target's own; nothing to pick (a list only if it ever offers several).
  const options = device?.dispatchOptions ?? [];
  const pick = binding && options.some(o => o.id === binding) ? binding : options[0]?.id ?? '';
  const timing = later ? laterTiming(later, picked) : null;
  const os = (publicKey?: string) => account?.view?.devices?.find(d => !!publicKey && d.publicKey === publicKey)?.osFamily;
  const send = async () => {
    const b = options.find(o => o.id === pick);
    if (!b || !chosen) return;
    if (later && !timing) { setNotice('Choose a time between now and 30 days from now.'); return; }
    setBusy(true);
    try {
      const r = await client.request({method: 'POST', path: '/api/computers/tasks', body: {target: chosen, task: {taskId: crypto.randomUUID(), attemptId: crypto.randomUUID(), projectBinding: b.id, agentBinding: b.agentBinding, modelBinding: b.modelBinding, text: text.trim() || taskTitle.trim(), title: taskTitle.trim().slice(0, 200), priority, ...(timing ? {timing} : {}), ...(conversationId || card ? {source: {...(conversationId ? {conversationId} : {}), ...card}} : {})}}});
      if (r.status === 200) { setNotice(''); setOpen(false); return; }
      setNotice('The task could not be sent.');
    } catch { setNotice('The task could not be sent.'); } finally { setBusy(false); }
  };
  const when = later === 'tonight' ? 'Tonight, 20:00' : later === 'morning' ? 'Tomorrow, 09:00' : later === 'pick' && timing ? new Date(timing.executeAt).toLocaleString() : '';
  const deviceOn = !!device && (device.state === 'available' || device.state === 'busy');
  return <>
    {openNow === undefined && (label
      ? <button type="button" className="primary" onClick={() => { setTarget(presetTarget ?? ''); setOpen(true); }}>{label}</button>
      : <button type="button" className="tool" title="Send a task to another computer" aria-label="Send a task" onClick={() => setOpen(true)}><UiIcon name="screen" size={15}/></button>)}
    {open && <Sheet title="New task" onClose={() => setOpen(false)} actions={<>
      <button type="button" className="link-button computer-send-later" onClick={() => setShowLater(v => !v)}>{when ? `Later: ${when}` : 'Later…'}</button>
      <button type="button" onClick={() => setOpen(false)}>Cancel</button>
      <button type="button" className="primary" disabled={busy || !chosen || !pick || !taskTitle.trim()} onClick={() => void send()}>{later ? 'Send for later' : 'Send'}</button>
    </>}>
      <div className="phone-field"><span>Runs on</span>
        <div className="computer-to" role="radiogroup" aria-label="To">{devices.map(d => {
          const on = d.state === 'available' || d.state === 'busy', connecting = !on && account?.view?.devices?.find(x => !!d.publicKey && x.publicKey === d.publicKey)?.presence === 'online';
          const full = !!d.capacity && d.capacity.active >= d.capacity.limit;
          return <button key={d.id} type="button" role="radio" aria-checked={chosen === d.id} className={`computer-to-item${chosen === d.id ? ' is-on' : ''}`} onClick={() => { setTarget(d.id); setBinding(''); }}>
            <UiIcon name={computerIcon(look, d.id, os(d.publicKey))} size={16}/><i className={`computer-dot ${on ? 'on' : connecting ? 'connecting' : 'off'}`}/>
            <span>{computerName(look, d.id, d.name)}</span><small>{connecting ? 'connecting' : !on ? 'off' : full ? 'busy' : 'free'}</small>
          </button>;
        })}</div>
      </div>
      <label className="phone-field"><span>Task title</span><input autoFocus maxLength={200} value={taskTitle} placeholder="What needs to be done?" onChange={e => setTaskTitle(e.target.value)}/></label>
      <label className="phone-field"><span>Details</span><textarea maxLength={8000} rows={4} value={text} placeholder="Steps, files, what done looks like…" onChange={e => setText(e.target.value)}/></label>
      <label className="phone-field"><span>Priority</span><select value={priority} onChange={e => setPriority(e.target.value as typeof priority)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
      {options.length > 1 ? <label className="phone-field"><span>Project</span><select value={pick} onChange={e => setBinding(e.target.value)}>{options.map(o => <option value={o.id} key={o.id}>{o.label}</option>)}</select></label> : null}
      {options.length ? <p className="cp-note">Runs in {device ? computerName(look, device.id, device.name) : 'That computer'}’s project ({options.find(o => o.id === pick)?.label}). {device && !deviceOn ? 'It is off: the task waits here and goes when it is on.' : 'It asks there first, unless you allowed it always.'}</p>
        : <p className="cp-warn">Choose its folder on {device ? computerName(look, device.id, device.name) : 'That computer'} first: there, open Computers › this computer › Project › Change….</p>}
      {showLater && <div className="computer-later" role="group" aria-label="Send later">
        {(['tonight', 'morning', 'pick'] as const).map(k => <button key={k} type="button" aria-pressed={later === k} className={later === k ? 'is-on' : ''} onClick={() => setLater(later === k ? null : k)}><UiIcon name={k === 'tonight' ? 'moon' : k === 'morning' ? 'sun' : 'calendar'} size={14}/>{k === 'tonight' ? 'Tonight' : k === 'morning' ? 'Tomorrow morning' : 'Pick a time'}</button>)}
        {later === 'pick' && <input type="datetime-local" aria-label="Time" value={picked} onChange={e => setPicked(e.target.value)}/>}
      </div>}
      {notice && <p role="status">{notice}</p>}
    </Sheet>}
  </>;
}
