import {useEffect, useRef, useState} from 'react';
import type {SessionClient} from './session';
import {AddThisComputer, call, computerAccountWords, useAccountStatus, type Status} from './ComputerJoin';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';
import {computerIcon, useComputerLook} from './ComputerLook';

/**
 * A new computer joins an account that already has computers (DEVICES-PROJECT-01, boards CP1b–CP2d).
 * Sign in → a Yes on the other computer → “Same as This Mac” or “Start fresh” → AI tools → ready.
 */
const root = '/api/computers/account';
export type SetupEntry = 'signin' | 'same';
// Kept in memory only (no browser storage): after a restart the account itself tells the road (setupRoad).
let entry: SetupEntry | null = null;
/** Which road the first run takes after the welcome. */
export function readSetupEntry(): SetupEntry | null { return entry; }
export function writeSetupEntry(value: SetupEntry | null) { entry = value; }
/** The road read from the account: a computer still waiting, or one that chose “Same as”, keeps its road after a restart. */
export function setupRoad(status: Status | null | undefined): SetupEntry | null {
  if (!status?.connected) return null;
  if (status.workspaces?.some(w => w.mode === 'continuity')) return 'same';
  const view = status.view;
  if (view?.deviceStatus === 'pending') return 'signin';
  if (view?.deviceStatus === 'approved' && !status.workspaces?.length && (view.devices ?? []).some(d => d.id !== view.deviceId && d.status === 'approved')) return 'signin';
  return null;
}

const CATEGORY: Record<string, {icon: UiIconName; one: string; many: string}> = {
  agent: {icon: 'person', one: 'agent', many: 'agents'},
  personality: {icon: 'smile', one: 'personality', many: 'personalities'},
  specialty: {icon: 'cap', one: 'specialty', many: 'specialties'},
  skill: {icon: 'sparkle', one: 'skill', many: 'skills'},
  rule: {icon: 'shield', one: 'rule', many: 'rules'},
  preferences: {icon: 'sliders', one: 'set of preferences', many: 'preferences'},
  task: {icon: 'board', one: 'task', many: 'tasks'},
  project: {icon: 'folder', one: 'project', many: 'projects'},
  board: {icon: 'board', one: 'Board', many: 'Boards'},
};
type Resource = {category: string; logicalId: string; label?: string};
type Preview = {workspaceId?: string; label?: string; previewFingerprint?: string; resources?: Resource[]; workspaces?: {workspaceId: string; label: string}[]; waitingForSource?: boolean};
/** “3 agents, 2 rules”: what a resource list holds, in plain words. */
export function whatComes(resources: Resource[]) {
  const counts = new Map<string, number>();
  for (const r of resources) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  return [...counts].map(([category, n]) => ({category, n, icon: CATEGORY[category]?.icon ?? 'layers' as UiIconName, words: `${n} ${n === 1 ? CATEGORY[category]?.one ?? category : CATEGORY[category]?.many ?? category}`}));
}
const portable = (status: Status | null | undefined, resources: Resource[]) => resources.filter(r => (status?.coverage ?? []).some((c: {category: string; available: boolean; continuity: boolean}) => c.category === r.category && c.available && c.continuity));

export function JoinStart({client, onFresh, onSame}: {client: SessionClient; onFresh: () => void; onSame: (from: string, comes: string, name: string) => void}) {
  const status = useAccountStatus(client);
  const [choice, setChoice] = useState<'same' | 'fresh'>('same');
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const done = useRef(false);
  const view = status?.view;
  const selfId = view?.deviceId ?? '';
  const self = view?.devices?.find(d => d.id === selfId);
  const others = (view?.devices ?? []).filter(d => d.id !== selfId && d.status === 'approved');
  const approved = !!status?.connected && view?.deviceStatus === 'approved';
  const from = others.find(d => d.id === source) ?? others.find(d => d.presence === 'online') ?? others[0];
  const leave = (fn: () => void) => { if (done.current) return; done.current = true; fn(); };

  // The first computer of an account, or a choice made before a restart: go on by itself.
  useEffect(() => {
    if (!approved) return;
    const chosen = status?.workspaces?.[0];
    if (chosen?.mode === 'continuity') leave(() => onSame(others.find(d => d.id === chosen.sourceDeviceId)?.label ?? 'your other computer', '', self?.label ?? 'This computer'));
    else if (chosen) leave(onFresh);
    else if (!others.length) leave(onFresh);
  }, [approved, status?.workspaces?.length, others.length]);

  // “Same as …”: ask the other computer what it shares, and ask again while it is off.
  useEffect(() => {
    if (!approved || choice !== 'same' || !from || status?.workspaces?.length) return;
    let live = true;
    const load = async () => {
      try {
        let next: Preview = await call(client, root + '/workspaces/source', {sourceDeviceId: from.id});
        const first = next.workspaces?.[0];
        if (!next.waitingForSource && first) next = await call(client, root + '/workspaces/source', {sourceDeviceId: from.id, workspaceId: first.workspaceId});
        if (live) setPreview(next);
      } catch (e) { if (live) setNotice(computerAccountWords((e as Error).message)); }
    };
    void load();
    const t = setInterval(() => { if (!preview?.resources) void load(); }, 4000);
    return () => { live = false; clearInterval(t); };
  }, [approved, choice, from?.id, !!preview?.resources]);

  if (status === undefined) return <p role="status" className="setup-note">Reading your account…</p>;
  if (status === null || status.desktopAvailable === false || status.configured === false) return <section className="computer-join" aria-label="Your account">
    <h2>Can’t reach your Dpro account</h2>
    <p>{status?.desktopAvailable === false ? 'Open the Girru app on this computer to add it to your account.' : 'Check the internet connection. You can also set this computer up on its own and add it to your account later in Computers.'}</p>
    <div className="setup-actions"><button type="button" className="primary" onClick={() => leave(onFresh)}>Set up this computer on its own</button></div>
  </section>;
  if (!approved) return <>
    <AddThisComputer client={client} status={status}/>
    <p className="computer-join fine-print"><button type="button" className="link-button" onClick={() => leave(onFresh)}>Set up this computer on its own instead</button></p>
  </>;
  if (!others.length || status.workspaces?.length) return <p role="status" className="setup-note">Opening…</p>;

  const resources = portable(status, preview?.resources ?? []);
  const items = whatComes(resources);
  const name = self?.label ?? 'This computer';
  const go = async () => {
    setBusy(true); setNotice('');
    try {
      if (choice === 'fresh') { await call(client, root + '/workspaces/choose', {mode: 'independent', label: name, confirmed: true, confirmedMigration: false}); leave(onFresh); return; }
      if (!from || !preview?.workspaceId || !preview.previewFingerprint || !resources.length) return;
      const r = await call(client, root + '/workspaces/choose', {mode: 'continuity', workspaceId: preview.workspaceId, sourceDeviceId: from.id, previewFingerprint: preview.previewFingerprint, selection: resources.map(x => ({category: x.category, logicalId: x.logicalId})), confirmed: true, confirmedMigration: false});
      if (r?.waitingForSource) { setNotice(`${from.label} went off. Open Girru there, then press Continue again.`); return; }
      leave(() => onSame(from.label, items.map(i => i.words).join(', '), name));
    } catch (e) {
      const code = (e as Error).message;
      setNotice(code === 'account_workspace_preview_changed' ? `Something changed on ${from?.label ?? 'your other computer'}. Look at the list again, then press Continue.` : computerAccountWords(code));
      if (code === 'account_workspace_preview_changed') setPreview(null);
    } finally { setBusy(false); }
  };
  const box = (on: boolean) => `computer-start-choice${on ? ' is-on' : ''}`;
  return <section className="computer-join computer-start" aria-label="How should this computer start">
    <p className="computer-steps"><span>1 Added</span><b>2 What comes</b><span>3 AI tools</span><span>4 Open Girru</span></p>
    <h2>How should {name} start?</h2>
    <div role="radiogroup" aria-label="How to start" className="computer-start-choices">
      <button type="button" role="radio" aria-checked={choice === 'same'} className={box(choice === 'same')} onClick={() => setChoice('same')}>
        <span className="computer-start-tile"><UiIcon name="copy" size={18}/></span>
        <span><b>Same as {from?.label ?? 'my other computer'}</b><small>Like a restore: your agents, rules and projects come over, and stay the same on both. Recommended.</small></span>
      </button>
      <button type="button" role="radio" aria-checked={choice === 'fresh'} className={box(choice === 'fresh')} onClick={() => setChoice('fresh')}>
        <span className="computer-start-tile"><UiIcon name="sparkle" size={18}/></span>
        <span><b>Start fresh</b><small>A new setup (team, agents) just for this computer. It is still in your account and can take tasks.</small></span>
      </button>
    </div>
    {choice === 'same' && others.length > 1 && <label className="phone-field"><span>From</span><select value={from?.id ?? ''} onChange={e => { setSource(e.target.value); setPreview(null); }}>{others.map(d => <option key={d.id} value={d.id}>{d.label}{d.presence === 'online' ? '' : ' (off)'}</option>)}</select></label>}
    {choice === 'same' && (preview?.waitingForSource || from?.presence !== 'online' && !preview?.resources
      ? <p role="status" className="fine-print"><UiIcon name="clock" size={13}/> Open Girru on {from?.label ?? 'your other computer'}. It sends the list as soon as it is open.</p>
      : !preview ? <p role="status" className="fine-print">Asking {from?.label ?? 'your other computer'} what it shares…</p>
      : !preview.workspaceId || !resources.length ? <p role="status" className="fine-print">{from?.label ?? 'Your other computer'} is getting ready to share. Keep Girru open there for a moment.</p>
      : <div className="computer-start-list" aria-label={`Same as ${from?.label} brings`}>
        <p className="section-label">Same as {from?.label} brings:</p>
        {items.map(i => <span key={i.category} className="computer-start-item"><UiIcon name={i.icon} size={15}/>{i.words}</span>)}
        <span className="computer-start-item muted"><UiIcon name="message" size={15}/>Chats: only new chats from now on</span>
        <span className="computer-start-item muted"><UiIcon name="database" size={15}/>Memory stays on each computer for now</span>
      </div>)}
    {notice && <p role="status">{notice}</p>}
    <div className="setup-actions"><button type="button" className="primary" disabled={busy || choice === 'same' && (!preview?.workspaceId || !resources.length)} onClick={() => void go()}>{busy ? 'Working…' : 'Continue'}</button></div>
  </section>;
}

/** CP2d: the last screen on a computer that started “Same as …”. */
export function JoinReady({name, from, comes, onOpen}: {name: string; from: string; comes: string; onOpen: () => void}) {
  return <section className="computer-join computer-start" aria-label={`${name} is ready`}>
    <p className="computer-steps"><span>1 Added</span><span>2 What comes</span><span>3 AI tools</span><b>4 Open Girru</b></p>
    <span className="computer-start-done"><UiIcon name="check" size={28}/></span>
    <h2>{name} is ready</h2>
    <p>{comes ? `${comes[0].toUpperCase()}${comes.slice(1)} come from ${from}.` : `Your agents and projects come from ${from}.`} Press Allow on {from} when it asks, and they arrive here by themselves.</p>
    <div className="setup-actions"><button type="button" className="primary" onClick={onOpen}>Open Girru</button></div>
  </section>;
}

/**
 * On a computer already in the account: it shares by itself (board CP6c, “on by default”), so a new
 * computer can start “Same as” it. Only the list of what may be shared is set here; nothing is sent
 * until the owner presses Allow for a computer that asks.
 */
export function useShareByDefault(client: SessionClient, status: Status | null | undefined) {
  const tried = useRef(false);
  const ready = !!status?.connected && status.view?.deviceStatus === 'approved' && status.workspaces?.length === 0 && (status.view?.devices ?? []).filter(d => d.status === 'approved').length >= 1;
  useEffect(() => {
    if (!ready || tried.current) return;
    tried.current = true;
    void (async () => {
      try {
        const self = status!.view!.devices!.find(d => d.id === status!.view!.deviceId);
        const chosen = await call(client, root + '/workspaces/choose', {mode: 'independent', label: self?.label ?? 'My Girru', confirmed: true, confirmedMigration: false});
        const workspaceId: string | undefined = chosen?.workspaceId ?? chosen?.id;
        const local = (await call(client, root + '/resources'))?.resources ?? [];
        const id = workspaceId ?? (await call(client, root))?.workspaces?.[0]?.id;
        const shareable = local.filter((r: {category: string}) => (status?.coverage ?? []).some((c: {category: string; available: boolean; continuity: boolean}) => c.category === r.category && c.available && c.continuity)).slice(0, 100);
        if (id && shareable.length) await call(client, root + '/workspaces/resources', {workspaceId: id, resources: shareable.map((r: {category: string; localId: string}) => ({category: r.category, localId: r.localId})), confirmed: true});
      } catch { /* Settings › Computers › What they share still offers it */ }
    })();
  }, [ready]);
}

type ContinuityRequest = {id: string; peerId: string; label?: string | null; selection: string; selectionHash: string; state: string};
/** Requests from computers that want to start the same as this one (read every few seconds). */
export function useContinuity(client: SessionClient, status: Status | null | undefined) {
  const [requests, setRequests] = useState<ContinuityRequest[]>([]);
  const on = !!status?.connected && status.view?.deviceStatus === 'approved';
  useEffect(() => { if (!on) return; let live = true; const load = () => call(client, root + '/continuity').then(r => { if (live) setRequests(r?.requests ?? []); }).catch(() => {}); void load(); const t = setInterval(load, 4000); return () => { live = false; clearInterval(t); }; }, [on, client]);
  return [requests, setRequests] as const;
}

/** On the computer a new one copies from: one Allow for “start the same as this computer”. */
export function ContinuityRequests({client, status}: {client: SessionClient; status: Status | null | undefined}) {
  const [requests, setRequests] = useContinuity(client, status);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = requests.filter(r => r.state === 'pending');
  if (!pending.length) return notice ? <p role="status" className="fine-print">{notice}</p> : null;
  return <section className="computer-join-requests" aria-label="Computers that start the same as this one">
    {pending.map(r => {
      let list: Resource[] = []; try { list = JSON.parse(r.selection); } catch { /* shown without the list */ }
      const label = r.label ?? 'Your new computer';
      return <div key={r.id} className="computer-task" role="listitem">
        <UiIcon name="copy" size={16}/>
        <span className="computer-task-text"><b>{label} wants to start the same as this computer</b><small>{whatComes(list).map(i => i.words).join(', ') || 'Your agents, rules and projects'} · chats and memory stay here</small></span>
        <span className="computer-task-actions"><button type="button" className="primary" disabled={busy} onClick={() => { setBusy(true); void call(client, root + '/continuity/approve', {requestId: r.id, selectionHash: r.selectionHash, confirmed: true}).then(() => { setNotice(`${label} gets the same setup now.`); setRequests(old => old.filter(x => x.id !== r.id)); }).catch(e => setNotice(computerAccountWords((e as Error).message))).finally(() => setBusy(false)); }}>Allow</button></span>
      </div>;
    })}
    {notice && <p role="status" className="fine-print">{notice}</p>}
  </section>;
}

/** The “Your files” look happens quietly on a computer that starts “Same as …” (the first run needs it done). */
export async function quietDiscovery(client: SessionClient) {
  const read = async () => { try { const r = await client.request({method: 'GET', path: '/api/first-run/discovery'} as never); return (r.body as {status?: string} | null)?.status ?? null; } catch { return null; } };
  let state = await read();
  if (state !== 'done' && state !== 'scanning') { try { await client.request({method: 'POST', path: '/api/first-run/discovery'} as never); } catch { /* read again below */ } }
  for (let n = 0; n < 90 && (state = await read()) !== 'done'; n++) { if (state === 'error') return; await new Promise(r => setTimeout(r, 1000)); }
}

/**
 * Right after signing in (D11, Mohamed 2026-11-10): the only question about this computer is its name,
 * filled in with the system's own name. Signing in already added it to the account.
 */
export function NameThisComputer({client, onDone}: {client: SessionClient; onDone: () => void}) {
  const status = useAccountStatus(client);
  const {look, save} = useComputerLook(client);
  const selfId = status?.view?.deviceId ?? '';
  const label = status?.view?.devices?.find(d => d.id === selfId)?.label ?? '';
  const [name, setName] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const named = !!selfId && !!look?.names?.[selfId];
  useEffect(() => { if (named) onDone(); }, [named]);
  // Not in a Dpro account on this computer (for example Google was not ready): nothing to name.
  useEffect(() => { if (status === null || status && !status.connected) onDone(); }, [status]);
  if (!status?.connected || !look || named) return <p role="status" className="setup-note">One moment…</p>;
  const value = name ?? label;
  const go = async () => {
    setBusy(true); setNotice('');
    try { await save(selfId, {name: value.trim()}); onDone(); } catch { setNotice('It could not be saved. Try again.'); } finally { setBusy(false); }
  };
  return <section className="computer-join" aria-label="Name this computer">
    <span className="computer-start-done"><UiIcon name={computerIcon(look, selfId, status.view?.devices?.find(d => d.id === selfId)?.osFamily)} size={26}/></span>
    <h2>Name this computer</h2>
    <p>Your other computers see it with this name.</p>
    <label className="phone-field"><span>Computer name</span><input autoFocus value={value} maxLength={64} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && value.trim()) void go(); }}/></label>
    {notice && <p role="status">{notice}</p>}
    <div className="setup-actions"><button type="button" className="primary" disabled={busy || !value.trim()} onClick={() => void go()}>Continue</button></div>
  </section>;
}
