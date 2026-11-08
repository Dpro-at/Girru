import {DproAccountPanel} from './DproAccountPanel';
import {ComputerTaskTiming} from './ComputerTaskTiming';
import {ComputerEnrollment} from './ComputerEnrollment';
import {ComputerLinkControls,ComputerDirectControls} from './ComputerLinkControls';
import {ComputerSyncWorkspace} from './ComputerSyncWorkspace';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SessionClient } from './session';
import type { ComputerOverview } from './computer-contract.js';
import { UiIcon } from './ui-icons';
const Computers = createContext<ComputerOverview | null>(null);
export function ComputerDevicesProvider({ client, enabled, children }: {
    client: SessionClient;
    enabled: boolean;
    children: ReactNode;
}) { const [view, setView] = useState<ComputerOverview | null>(null); useEffect(() => { if (!enabled) {
    setView(null);
    return;
} let current = true; let timer: ReturnType<typeof setInterval> | undefined; const load = async () => { try {
    const r = await client.request({ method: 'GET', path: '/api/computers' });
    if (current) {
        const next = r.status === 200 ? r.body as ComputerOverview : null;
        setView(next);
        if (next && !next.testOnly && !next.configured && timer)
            clearInterval(timer);
    }
}
catch {
    if (current)
        setView(null);
} }; void load(); timer = setInterval(() => void load(), 2000); return () => { current = false; clearInterval(timer); }; }, [client, enabled]); return <Computers.Provider value={view}>{children}</Computers.Provider>; }
export function ComputerExecutionBadge({ sessionId, runId,cardId }: {
    sessionId?: string | null;cardId?:string|null;
    runId?: string | null;
}) { const view = useContext(Computers); const a = view?.attempts.find(a => sessionId && (a.sessionId === sessionId||a.sourceSessionId===sessionId)||cardId&&(a.sourceCardId===cardId||a.targetCardId===cardId)|| runId && a.runId === runId); return a ? <small className="computer-execution" title={`From ${a.sourceName}. ${a.detail}`}><UiIcon name="screen" size={12}/>{a.targetName} · {a.statusLabel}</small> : null; }
export function useComputerOverview(){return useContext(Computers);}
export function ComputerDevices({ client, onOpenChat, onApprovals }: {
    client: SessionClient;
    onOpenChat?: (id: string) => void;
    onApprovals?: () => void;
}) {
    const view = useContext(Computers), [selected, setSelected] = useState(''), [text, setText] = useState(''), [option, setOption] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
    const device = view?.devices.find(d => d.id === selected);
    const send = async () => { const b = (device?.dispatchOptions?.length?device.dispatchOptions:view?.dispatchOptions)?.find(b => b.id === option); if (!b || !device)
        return; setBusy(true); try {
        const r = await client.request({ method: 'POST', path: '/api/computers/tasks', body: { target: device.id, task: { taskId: crypto.randomUUID(), attemptId: crypto.randomUUID(), projectBinding: b.id, agentBinding: b.agentBinding, modelBinding: b.modelBinding, text } } });
        setNotice(r.status === 200 ? 'Task queued on this computer. The target owner must approve.' : 'Could not queue the task.');
        if (r.status === 200)
            setText('');
    }
    catch {
        setNotice('Could not queue the task.');
    }
    finally {
        setBusy(false);
    } };
    return <div className="phone-settings"><div className="phone-main"><header className="phone-head"><div><h2 className="settings-page-title">Devices</h2><p className="settings-page-desc">Choose where your task runs.</p></div></header><DproAccountPanel client={client}/><details><summary>Existing owner-hosted device group</summary><ComputerEnrollment client={client}/></details>{!view ? <p role="status">Reading your computers…</p> : !view.testOnly&&!view.configured ? <div className="phone-empty"><UiIcon name="screen" size={24}/><b>Computer pairing is not available yet</b><p>Your signed-in sessions and shared settings stay separate.</p></div> : <>{view.testOnly&&<p className="fine-print">Temporary computer pilot</p>}<ComputerLinkControls client={client} view={view} onNotice={setNotice}/><div role="listbox" aria-label="Linked computers" className="phone-list">{view.devices.map(d => <button className="phone-row" type="button" role="option" aria-selected={selected === d.id} key={d.id} onClick={() => setSelected(d.id)}><span className="phone-tile"><UiIcon name="screen" size={17}/></span><span className="phone-row-text"><b>{d.name}</b><small>{d.state === 'unknown' ? 'Last-known status unavailable' : d.state} · {d.path==='direct'?'Direct connection':d.path==='relay'?'Via relay':'Connection unavailable'}{d.capacity&&d.capacity.active>0?` · ${d.capacity.active} running`:''}</small></span></button>)}</div>{view.attempts.map(a => <div className="preference-row" key={a.taskId}><div className="preference-label"><strong>{a.targetName} · {a.statusLabel}</strong><small>From {a.sourceName}. {a.detail}{a.timing?.mode==='scheduled'&&a.timing.executeAt?` Starts ${new Date(a.timing.executeAt).toLocaleString(undefined,{timeZone:a.timing.timeZone})} (${a.timing.timeZone}); no start after ${new Date(a.timing.latestStartAt!).toLocaleTimeString(undefined,{timeZone:a.timing.timeZone})}.`:null}</small></div>{view.self?.id===a.targetDevice&&['waiting_approval','blocked'].includes(a.state)&&<ComputerTaskTiming client={client} taskId={a.taskId} onPrepared={onApprovals}/>} {a.sessionId && view.self?.id === a.targetDevice && onOpenChat && <button type="button" onClick={() => onOpenChat(a.sessionId!)}>Open chat</button>}{a.approvalId && a.state === 'waiting_approval' && onApprovals && <button type="button" onClick={onApprovals}>Review task</button>}{(a.sourceDevice === view.self?.id||a.targetDevice===view.self?.id&&['scheduled','waiting_approval','blocked'].includes(a.state)) && !['completed', 'cancelled', 'unknown', 'cancel_requested'].includes(a.state) && <button type="button" onClick={() => void client.request({ method: 'POST', path: `/api/computers/tasks/${a.taskId}/cancel` }).then(r => setNotice(r.status===200?'Waiting for the target to confirm cancellation.':'Could not request cancellation.')).catch(() => setNotice('Could not request cancellation.'))}>Cancel task</button>}</div>)}</>}{view?.configured&&<ComputerSyncWorkspace client={client} devices={view.devices} onApprovals={onApprovals}/>} {notice && <p role="status" className="setup-note">{notice}</p>}</div>{device && (view?.testOnly||view?.configured) && <aside className="phone-inspector" aria-label={device.name}><h3>{device.name}</h3><p>Approval and permissions belong to this computer.</p><ComputerDirectControls client={client} view={view!} device={device} onNotice={setNotice}/><label className="phone-field"><span>Project</span><select value={option} onChange={e => setOption(e.target.value)}><option value="">Choose a project</option>{(device.dispatchOptions?.length?device.dispatchOptions:view.dispatchOptions).map(b => <option value={b.id} key={b.id}>{b.label}</option>)}</select></label><label className="phone-field"><span>Task</span><textarea value={text} maxLength={8000} onChange={e => setText(e.target.value)}/></label><button className="primary" type="button" disabled={busy || !option || !text.trim() || device.state === 'revoked'} onClick={() => void send()}>Send task</button></aside>}</div>;
}
