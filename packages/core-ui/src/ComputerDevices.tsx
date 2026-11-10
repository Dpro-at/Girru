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
} let current = true; let timer: ReturnType<typeof setInterval> | undefined; let slowNow = false; const load = async () => { try {
    const r = await client.request({ method: 'GET', path: '/api/computers' });
    if (current) {
        // Not set up yet (no Dpro account, or this computer still waiting to be added): say so and ask
        // every 10 seconds instead of every 2, so the page notices when the computer is added.
        const next = r.status === 200 ? r.body as ComputerOverview : r.status === 400 || r.status === 404 || r.status === 409 ? NOT_SET_UP : null;
        setView(next);
        const slow = !!next && !next.testOnly && !next.configured;
        if (slow !== slowNow) { slowNow = slow; clearInterval(timer); timer = setInterval(() => void load(), slow ? 10_000 : 2000); }
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

/** The attempt that belongs to a Board card (sent from here, or arrived here). */
export function useCardAttempt(cardId?: string | null, sessionId?: string | null) {
  const view = useContext(Computers);
  return view?.attempts.find(a => !!cardId && (a.sourceCardId === cardId || a.targetCardId === cardId) || !!sessionId && (a.sessionId === sessionId || a.sourceSessionId === sessionId)) ?? null;
}
/** CP5 on the card tile: which computer and which step, with a thin progress bar; “Done on …” when it is back. */
export function ComputerCardStatus({cardId, sessionId}: {cardId?: string | null; sessionId?: string | null}) {
  const a = useCardAttempt(cardId, sessionId);
  if (!a) return null;
  const steps = a.steps ?? [];
  const now = steps.find(s => s.state === 'now')?.title;
  const done = steps.filter(s => s.state === 'done').length;
  const words = a.state === 'completed' ? `Done on ${a.targetName}` : a.state === 'waiting_approval' ? `${a.targetName} · waiting for Allow` : a.state === 'scheduled' ? `${a.targetName} · later` : ['running', 'accepted'].includes(a.state) ? `${a.targetName}${now ? ` · ${now.toLowerCase()}` : ' · running'}` : ['cancelled', 'unknown', 'blocked'].includes(a.state) ? `${a.targetName} · stopped` : `${a.targetName} · ${a.statusLabel.toLowerCase()}`;
  const running = ['running', 'accepted'].includes(a.state);
  return <span className={`computer-card-status is-${a.state}`} title={`Runs on ${a.targetName} · sent by ${a.sourceName}`}>
    <span className="computer-card-line"><UiIcon name={a.state === 'completed' ? 'check' : 'screen'} size={13}/>{words}</span>
    {running && <span className="computer-card-bar"><i style={{width: `${steps.length ? Math.max(8, Math.round(done / steps.length * 100)) : 30}%`}}/></span>}
  </span>;
}
