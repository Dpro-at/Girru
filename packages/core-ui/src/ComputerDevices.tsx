import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SessionClient } from './session';
import type { ComputerOverview } from './computer-contract.js';
import { UiIcon } from './ui-icons';
const Computers = createContext<ComputerOverview | null>(null);
/** The answer when this installation has no computer account yet. */
const NOT_SET_UP: ComputerOverview = { testOnly: false, configured: false, productionEnrollment: { enabled: false, reason: 'not_set_up' }, self: null, devices: [], attempts: [], dispatchOptions: [] };
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
        // Not set up yet (no Dpro account on this installation): say so and stop asking every 2 seconds.
        const next = r.status === 200 ? r.body as ComputerOverview : r.status === 400 || r.status === 404 || r.status === 409 ? NOT_SET_UP : null;
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
/** Plain words for a computer's state (one word per thing: Computer, never device). */
export function computerStateLabel(state:string){return ({available:'Free',busy:'Working',paused:'Not taking tasks',offline:'Off',unknown:'Can’t reach it',revoked:'Forgotten',pending:'Waiting to be added'} as Record<string,string>)[state]??state;}
/** How two computers reach each other, in plain words. */
export function computerPathLabel(path:string){return path==='direct'?'Same Wi‑Fi':path==='relay'?'Over the internet':'Not connected';}
