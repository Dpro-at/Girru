import type React from 'react';
import {useEffect, useRef, useState} from 'react';
import type {SessionClient} from './session';
import {Sheet} from './desktop-ui';
import {QrImage} from './PhonePairing';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';
import {useContinuity, useShareByDefault, SetupRoad} from './ComputerStart';
import {computerIcon} from './ComputerLook';

/** Adding a computer (DEVICES-PROJECT-01 B2, boards CP1, CP2, CP7, CP9c): plain words, pictures instead of codes. */
const root = '/api/computers/account';
export type Status = {desktopAvailable?: boolean; configured?: boolean; mapping?: unknown; connected?: boolean; active?: boolean; googleLinked?: boolean; workspaces?: {id: string; label: string; mode: string; state: string; sourceDeviceId?: string | null}[]; coverage?: {category: string; label: string; available: boolean; continuity: boolean}[]; view?: {deviceId?: string; deviceStatus?: string; devices?: {id: string; label: string; status: string; presence?: string; osFamily?: string; publicKey?: string; appVersion?: string; registeredAt?: number}[]} | null; pairing?: {self: {waiting: boolean; approver: string | null; code: string | null; changed?: boolean} | null; requests: {deviceId: string; label: string; osFamily: string; code: string | null; publicKey?: string; elsewhere: boolean; changed?: boolean}[]; addedWithCode: {deviceId: string; label: string; publicKey: string; checkCode: string}[]; twoFactorFailuresToday?: number; thisComputerCheck?: string} | null};

/** Plain words for the account service's answers (one name per thing; never a code on screen). */
export function computerAccountWords(code: string) {
  const words: Record<string, string> = {
    account_link_google_locally_first: 'First link Google to your Girru account in Settings › Account, then try again.',
    account_local_verification_refused: 'That code was not right. Try again.',
    account_flow_session_changed: 'The sign-in took too long. Start again.',
    account_flow_not_ready: 'Google has not finished yet. Wait a moment.',
    account_twofactor_code_wrong: 'That code was not right. Try again.',
    account_twofactor_wait: 'Too many wrong codes. Wait 15 minutes, then try again.',
    account_twofactor_off: 'Two-step sign-in is not on for your Dpro account. Say Yes on one of your other computers instead.',
    account_twofactor_unavailable: 'Two-step sign-in is not available on this Dpro service yet.',
    account_fresh_google_required: 'For safety, sign in with Google again on this computer, then try again.',
    account_key_comparison_changed: 'The pictures did not match, or the request ended. Start again on the new computer.',
    account_device_unavailable: 'That request has ended.',
    account_pairing_taken: 'Another of your computers is already answering this request.',
    account_device_pending: 'This computer is still waiting to be added.',
    account_twofactor_locked: 'Too many wrong codes today. Add this computer with a Yes on one of your other computers instead.',
    account_desktop_required: 'Open the Girru app on this computer to add it. A browser window can’t keep the computer’s key safe.',
    account_local_desktop_required: 'Open the Girru app on this computer to add it.',
  };
  return words[code] ?? 'That did not work. Try again in a moment.';
}
export async function call(client: SessionClient, path: string, body?: unknown) {
  const r = await client.request(body === undefined ? {method: 'GET', path} : {method: 'POST', path, body});
  if (r.status !== 200) throw Error((r.body as {code?: string})?.code ?? 'computer_request_refused');
  return r.body as any;
}
/** The Dpro account status, read every few seconds while shown. */
/** This computer was added before: after Girru restarts it reconnects by itself (once per start), no “Resume” button. */
let resumeTried = false;
/** Set when that reconnect was refused (for example the account ended this computer's sign-in): the page then offers to sign in instead of waiting. */
let resumeRefused = false;
export function useAccountStatus(client: SessionClient, enabled = true) {
  // undefined while reading; null when this window cannot reach the account (a browser, or no desktop app).
  const [status, setStatus] = useState<Status | null | undefined>(undefined);
  useEffect(() => { if (!enabled) return; let live = true; const load = async () => { try { let s = await call(client, root); if (s?.configured && !s.connected && s.mapping && !resumeTried) { resumeTried = true; try { await call(client, root + '/resume', {}); s = await call(client, root); } catch { resumeRefused = true; /* stays signed out; Computers offers to sign in */ } } if (s?.connected) resumeRefused = false; if (live) setStatus(s && resumeRefused && !s.connected ? {...s, resumeRefused: true} : s); } catch { if (live) setStatus(null); } }; void load(); const t = setInterval(() => void load(), 3000); return () => { live = false; clearInterval(t); }; }, [client, enabled]);
  return status;
}

const SHAPES: UiIconName[] = ['sun', 'moon', 'star', 'heart', 'home', 'book', 'bug', 'key', 'lock', 'bulb', 'globe', 'flask', 'dice', 'coin', 'palette', 'puzzle'];
const SHAPE_NAMES = ['Sun', 'Moon', 'Star', 'Heart', 'House', 'Book', 'Bug', 'Key', 'Lock', 'Bulb', 'Globe', 'Flask', 'Dice', 'Coin', 'Palette', 'Puzzle'];
const COLORS = [['Blue', '#3B7BF6'], ['Green', '#23945A'], ['Orange', '#C26A00'], ['Pink', '#B4316A']];
/** Four pictures from the first 24 bits of the 12-character code, with the full code under them for a strict check. */
export function ComputerPictures({code}: {code: string}) {
  const first24 = parseInt(code.slice(0, 6), 16);
  const pics = [0, 1, 2, 3].map(i => { const bits = (first24 >> (18 - i * 6)) & 63; return {icon: SHAPES[bits >> 2], name: `${COLORS[bits & 3][0]} ${SHAPE_NAMES[bits >> 2]}`, color: COLORS[bits & 3][1]}; });
  return <div className="computer-pictures">
    <div className="computer-pictures-row" role="img" aria-label={pics.map(p => p.name).join(', ')}>
      {pics.map((p, i) => <span key={i} className="computer-picture" title={p.name} style={{color: p.color}}><UiIcon name={p.icon} size={28}/></span>)}
    </div>
    <small className="fine-print">Or compare the code: {code.slice(0, 4)} {code.slice(4, 8)} {code.slice(8, 12)}</small>
  </div>;
}

/** On a new computer (CP1b–CP1c): sign in, then wait for a Yes on another computer — or use the account's authenticator code. */
export function AddThisComputer({client, status}: {client: SessionClient; status: Status | null | undefined}) {
  const [name, setName] = useState('');
  const [flow, setFlow] = useState<{flowId: string; clientNonce: string; ready?: boolean} | null>(null);
  const [verify, setVerify] = useState<{challenge: string; nonce: string} | null>(null);
  const [code, setCode] = useState('');
  const [useCode, setUseCode] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  // A Girru that was not closed properly kept this computer's keys locked; the owner unlocks them (the Mac asks to confirm).
  const unlock = locked ? <button type="button" className="link-button" disabled={busy} onClick={() => { setBusy(true); void call(client, '/api/computers/enrollment/recover-custody-lease', {confirmed: true}).then(() => { setLocked(false); setNotice('Unlocked. Sign in again.'); }).catch(() => setNotice('Not unlocked. Close every other Girru window and try again.')).finally(() => setBusy(false)); }}>Unlock</button> : null;
  const current = useRef(flow); current.current = flow;
  useEffect(() => { if (!flow || flow.ready) return; let live = true; const t = setInterval(() => { void call(client, root + '/flow/status', {flowId: flow.flowId, clientNonce: flow.clientNonce}).then(r => { if (!live) return; if (r.state === 'ready') { clearInterval(t); setFlow({...flow, ready: true}); void finish({...flow, ready: true}); } else if (r.state === 'failed') { clearInterval(t); setFlow(null); setLocked(r.reason === 'locked'); setNotice(r.reason === 'locked' ? 'Girru was not closed properly last time, so this computer’s keys are still locked. Unlock them, then sign in again.' : 'Sign-in did not finish. Nothing changed. Sign in again when you are ready.'); } }).catch(() => { clearInterval(t); setFlow(null); setNotice('The sign-in took too long. Start again.'); }); }, 1500); return () => { live = false; clearInterval(t); }; }, [flow?.flowId]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setNotice(''); try { await fn(); } catch (e) { setNotice(computerAccountWords((e as Error).message)); } finally { setBusy(false); } };
  // The name is optional: without one the computer registers with its own name (for example “Mohamed’s MacBook Pro”).
  const start = (kind: 'connect' | 'recover' = 'connect') => run(async () => { const bytes = crypto.getRandomValues(new Uint8Array(32)); const clientNonce = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); const r = await call(client, root + '/flow/start', {kind, clientNonce, ...(name.trim() ? {label: name.trim()} : {}), confirmed: true}); setFlow({flowId: r.flowId, clientNonce}); });
  const [firstAsk, setFirstAsk] = useState(false);
  async function finish(f = current.current, verification?: {challenge: string; nonce: string; code: string}) { if (!f) return; await run(async () => { const r = await call(client, root + '/flow/finish', {flowId: f.flowId, clientNonce: f.clientNonce, ...(verification ? {verification} : {})}); if (r.verificationRequired) { setVerify({challenge: r.challenge, nonce: r.nonce}); return; } setVerify(null); setFlow(null); }); }
  const join = () => run(async () => { await call(client, root + '/join-with-code', {code: code.trim(), confirmed: true}); setCode(''); });

  const waiting = status?.connected && status.view?.deviceStatus === 'pending';
  // CP7b/CP7c: a wait that ends without a Yes says why, in one sentence, with one way on.
  const waitStarted = useRef<number | null>(null);
  const [ended, setEnded] = useState<'refused' | 'late' | null>(null);
  useEffect(() => {
    if (waiting) { if (waitStarted.current === null) waitStarted.current = Date.now(); setEnded(null); return; }
    if (waitStarted.current !== null && status !== undefined && status?.view?.deviceStatus !== 'approved') { setEnded(Date.now() - waitStarted.current >= 9 * 60_000 ? 'late' : 'refused'); waitStarted.current = null; }
  }, [waiting, status?.view?.deviceStatus]);
  if (ended && !flow) return <div className="computer-join" role="alert">
    <span className="computer-start-done is-warn"><UiIcon name={ended === 'late' ? 'clock' : 'close'} size={24}/></span>
    <h2>{ended === 'late' ? 'Nobody added this computer in time' : 'This computer was not added'}</h2>
    <p>{ended === 'late' ? 'The request ended after 10 minutes. Open Girru on one of your other computers first, then try again.' : 'Your other computer said No, or the pictures were different. Start again; if it happens again, someone else may be using your account — change your Google password.'}</p>
    <div className="setup-actions"><button type="button" className="primary" onClick={() => { setEnded(null); void start(); }}>{ended === 'late' ? 'Try again' : 'Start again'}</button></div>
  </div>;
  if (waiting) {
    const self = status?.pairing?.self;
    // No other computer of this account is on: it can never say Yes. Offer to start over with this one as the first.
    const othersOn = (status?.view?.devices ?? []).some(d => d.id !== status?.view?.deviceId && d.status === 'approved' && d.presence === 'online');
    if (flow || verify) return <div className="computer-join">
      <h2>Make this the first computer</h2>
      {verify ? <div className="computer-join-code"><label className="phone-field"><span>Code from your authenticator app</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}/></label><button type="button" className="primary" disabled={busy || code.length !== 6} onClick={() => void finish(current.current, {...verify, code: code.trim()})}>Continue</button></div>
        : <p role="status" className="fine-print">Continue with Google in your browser…</p>}
      {flow && <button type="button" className="link-button" onClick={() => { void call(client, root + '/flow/cancel', {flowId: flow.flowId, clientNonce: flow.clientNonce}).catch(() => {}); setFlow(null); setVerify(null); }}>Cancel</button>}
      {notice && <p role="status">{notice}</p>}{unlock}
    </div>;
    return <div className="computer-join">
      <SetupRoad at={1}/>
      <h2>Now go to your other computer</h2>
      <p>Open Girru there. It asks “Add this computer to your account?” If it shows the same pictures, press <b>Yes, add it</b>.</p>
      {self?.changed ? <p role="alert">Something changed while you were adding this computer, so it stopped for safety. Sign in again to start over.</p> : self?.code ? <ComputerPictures code={self.code}/> : <p role="status" className="computer-waiting"><UiIcon name="clock" size={15}/> Waiting for your other computer…</p>}
      {notice && <p role="status">{notice}</p>}{unlock}
      <p className="section-label">Can’t use your other computer?</p>
      <div className="computer-start-choices" role="group" aria-label="Other ways">
        <button type="button" className={`computer-start-choice${useCode ? ' is-on' : ''}`} aria-expanded={useCode} onClick={() => { setUseCode(v => !v); setFirstAsk(false); }}>
          <span className="computer-start-tile"><UiIcon name="key" size={16}/></span><span><b>Use my authenticator code</b><small>If two-step sign-in is on for your account.</small></span>
        </button>
        {!othersOn && <button type="button" className={`computer-start-choice${firstAsk ? ' is-on' : ''}`} aria-expanded={firstAsk} onClick={() => { setFirstAsk(v => !v); setUseCode(false); }}>
          <span className="computer-start-tile"><UiIcon name="screen" size={16}/></span><span><b>Make this the first computer</b><small>None of your other computers is on. Use this if they are old or gone.</small></span>
        </button>}
      </div>
      {useCode && <div className="computer-join-code"><label className="phone-field"><span>Code from your authenticator app</span><input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}/></label><button type="button" className="primary" disabled={busy || code.length !== 6} onClick={() => void join()}>Add this computer</button></div>}
      {firstAsk && <div className="computer-first-ask" role="alertdialog" aria-label="Make this the first computer">
        <p>Your other computers leave your account. Their work stays on them, and you can add them again later. Google asks once more.</p>
        <div className="setup-actions"><button type="button" onClick={() => setFirstAsk(false)}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={() => { setFirstAsk(false); void start('recover'); }}>Make it the first</button></div>
      </div>}
    </div>;
  }
  return <div className="computer-join">
    <SetupRoad at={1}/>
    <h2>Add this computer to your account</h2>
    <p>Sign in with the same Google account you use for Girru on your other computer.</p>
    <label className="phone-field"><span>Give this computer a name</span><input value={name} maxLength={64} placeholder="Office PC" onChange={e => setName(e.target.value)}/></label>
    {verify ? <div className="computer-join-code"><label className="phone-field"><span>Code from your authenticator app</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}/></label><button type="button" className="primary" disabled={busy || code.length !== 6} onClick={() => void finish(current.current, {...verify, code: code.trim()})}>Continue</button></div>
      : <button type="button" className="primary" disabled={busy || !!flow || status === null || status?.desktopAvailable === false} onClick={() => void start()}>{flow ? 'Waiting for Google…' : 'Continue with Google'}</button>}
    {(status === null || status?.desktopAvailable === false) && <p role="status">Open the Girru app on this computer to add it. A browser window can’t keep the computer’s key safe.</p>}
    {flow && <button type="button" className="link-button" onClick={() => { void call(client, root + '/flow/cancel', {flowId: flow.flowId, clientNonce: flow.clientNonce}).catch(() => {}); setFlow(null); }}>Cancel</button>}
    {notice && <p role="status">{notice}</p>}{unlock}
    <p className="fine-print">Your browser opens for Google. Your chats, files and agents are never sent to Dpro.</p>
  </div>;
}

/** On a computer you already use (CP2a): Yes / No for a new computer, with the same pictures it shows. */
export function ComputerJoinRequests({client, status}: {client: SessionClient; status: Status | null | undefined}) {
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const reqs = status?.pairing?.requests ?? [], added = status?.pairing?.addedWithCode ?? [];
  if (!reqs.length && !added.length) return null;
  const answer = async (r: {deviceId: string; code: string | null; publicKey?: string}, yes: boolean) => { const deviceId = r.deviceId; setBusy(deviceId); setNotice(''); try { await call(client, root + (yes ? '/requests/approve' : '/requests/deny'), yes ? {deviceId, comparisonCode: r.code, publicKey: r.publicKey, confirmed: true} : {deviceId, confirmed: true}); setNotice(yes ? 'Added. It shows in your computers.' : 'It was not added.'); } catch (e) { setNotice(computerAccountWords((e as Error).message)); } finally { setBusy(''); } };
  const forget = async (a: {deviceId: string}) => { setNotice(''); try { await call(client, root + '/devices/revoke', {deviceId: a.deviceId, confirmed: true}); setNotice('It was forgotten.'); } catch (e) { setNotice(computerAccountWords((e as Error).message)); } };
  const keep = async (a: {deviceId: string; publicKey: string; checkCode: string}) => { setNotice(''); try { await call(client, root + '/requests/keep', {deviceId: a.deviceId, publicKey: a.publicKey, checkCode: a.checkCode, confirmed: true}); setNotice('Kept. It shows in your computers.'); } catch (e) { setNotice(computerAccountWords((e as Error).message)); } };
  return <section aria-label="New computers" className="computer-join-requests">
    {reqs.map(r => <div key={r.deviceId} className="computer-task" role="group" aria-label={`Add ${r.label}`}>
      <UiIcon name={computerIcon(null, r.deviceId, r.osFamily)} size={16}/>
      <span className="computer-task-text"><b>Add “{r.label}” to your account?</b><small>{r.changed ? 'This request changed after you answered it, so it stopped for safety. Start again on the new computer.' : r.elsewhere ? 'Another of your computers is answering this.' : r.code ? 'Check the new computer shows these same pictures. Only add a computer you own.' : 'Getting the pictures ready…'}</small>{r.code && <ComputerPictures code={r.code}/>}</span>
      {!r.elsewhere && !r.changed && <span className="computer-task-actions"><button type="button" disabled={busy === r.deviceId} onClick={() => void answer(r, false)}>No, it’s not me</button><button type="button" className="primary" disabled={busy === r.deviceId || !r.code} onClick={() => void answer(r, true)}>Yes, add it</button></span>}
    </div>)}
    {(status?.pairing?.twoFactorFailuresToday ?? 0) >= 5 && <p role="alert" className="fine-print"><UiIcon name="alert" size={13}/> Someone tried {status?.pairing?.twoFactorFailuresToday} wrong authenticator codes on your Dpro account today. If it was not you, change your Google password.</p>}
    {added.slice(0, 3).map(a => <div key={a.deviceId} className="computer-task" role="group" aria-label={`${a.label} joined your account`}><UiIcon name="alert" size={16}/><span className="computer-task-text"><b>“{a.label}” joined your account</b><small>Did you just sign in on “{a.label}”? Press Yes. If not, press No, remove it, and change your Google password. To double-check: “{a.label}” shows the same code in Settings › Computers › Account and safety › Advanced.</small><code className="computer-check-code">{a.checkCode.slice(0, 4)} {a.checkCode.slice(4, 8)} {a.checkCode.slice(8, 12)}</code></span><span className="computer-task-actions"><button type="button" className="primary" onClick={() => void keep(a)}>Yes, it’s me</button><button type="button" onClick={() => void forget(a)}>No, remove it</button></span></div>)}
    {notice && <p role="status" className="fine-print">{notice}</p>}
  </section>;
}

/** A short notice anywhere in the window when a new computer asks to join. */
export function ComputerJoinNotice({client, enabled, onOpen}: {client: SessionClient; enabled: boolean; onOpen: () => void}) {
  const status = useAccountStatus(client, enabled);
  const [hidden, setHidden] = useState('');
  useShareByDefault(client, status);
  const [continuity] = useContinuity(client, status);
  const r = status?.pairing?.requests?.find(x => !x.elsewhere);
  const same = continuity.find(x => x.state === 'pending');
  if ((!r || hidden === r.deviceId) && same && hidden !== same.id) return <div className="computer-join-notice" role="status"><UiIcon name="copy" size={16}/><span><b>{same.label ?? 'Your new computer'} wants to start the same as this one</b><small>Your agents, rules and projects</small></span><button type="button" className="primary" onClick={() => { setHidden(same.id); onOpen(); }}>Review</button><button type="button" className="tool" aria-label="Later" title="Later" onClick={() => setHidden(same.id)}><UiIcon name="close" size={13}/></button></div>;
  if (!r || hidden === r.deviceId) return null;
  return <div className="computer-join-notice" role="status"><UiIcon name={computerIcon(null, r.deviceId, r.osFamily)} size={16}/><span><b>New computer: {r.label}</b><small>Wants to join your account</small></span><button type="button" className="primary" onClick={() => { setHidden(r.deviceId); onOpen(); }}>Review</button><button type="button" className="tool" aria-label="Later" title="Later" onClick={() => setHidden(r.deviceId)}><UiIcon name="close" size={13}/></button></div>;
}

/** Settings › Computers › Account and safety: the Dpro account's own two-step sign-in (D11). */
export function AccountTwoFactor({client}: {client: SessionClient}) {
  const [state, setState] = useState<{enabled: boolean; available: boolean} | null>(null);
  const [setup, setSetup] = useState<{secret: string; uri: string} | null>(null);
  const [off, setOff] = useState(false);
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const load = async () => { try { setState(await call(client, root + '/twofactor', {action: 'status'})); } catch { setState(null); } };
  useEffect(() => { void load(); }, [client]);
  if (!state) return null;
  const act = async (body: unknown, done: string) => { setNotice(''); try { await call(client, root + '/twofactor', body); setNotice(done); setSetup(null); setOff(false); setCode(''); await load(); } catch (e) { setNotice(computerAccountWords((e as Error).message)); } };
  return <section className="cp-list-row computer-twofactor" aria-label="Two-step sign-in for my Dpro account">
    <span className="cp-tile" style={{'--tint': '#8FD6B0'} as React.CSSProperties}><UiIcon name="lock" size={16}/></span>
    <span className="cp-choice-text"><span>Two-step sign-in</span><small>{!state.available ? 'Not available on this Dpro service yet.' : state.enabled ? 'On. A new computer can also join with your authenticator code.' : 'Off. Turn it on to add a computer when your other computers are off.'}</small>{notice && <small role="status">{notice}</small>}</span>
    {state.available && (state.enabled ? <button type="button" className="cp-soft" onClick={() => setOff(true)}>Turn off…</button> : <button type="button" className="cp-soft" onClick={() => void call(client, root + '/twofactor', {action: 'setup'}).then(setSetup).catch(e => setNotice(computerAccountWords((e as Error).message)))}>Turn on…</button>)}
    {setup && <Sheet title="Turn on two-step sign-in" onClose={() => setSetup(null)}>
      <p>Scan this with your authenticator app, then type the 6-digit code it shows.</p>
      <QrImage text={setup.uri}/>
      <p className="fine-print">Can’t scan? Type this key: {setup.secret}</p>
      <label className="phone-field"><span>Code</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}/></label>
      <button type="button" className="primary" disabled={code.length !== 6} onClick={() => void act({action: 'enable', code}, 'Two-step sign-in is on.')}>Turn on</button>
      {notice && <p role="status">{notice}</p>}
    </Sheet>}
    {off && <Sheet title="Turn off two-step sign-in?" onClose={() => setOff(false)}>
      <p>New computers will then join only with a Yes on another of your computers.</p>
      <label className="phone-field"><span>Code from your authenticator app</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}/></label>
      <button type="button" className="danger" disabled={code.length !== 6} onClick={() => void act({action: 'disable', code, confirmed: true}, 'Two-step sign-in is off.')}>Turn off</button>
      {notice && <p role="status">{notice}</p>}
    </Sheet>}
  </section>;
}

/** Settings › Computers › My computers: this computer's code, for checking it from another computer. */
export function ThisComputerCheck({client}: {client: SessionClient}) {
  const status = useAccountStatus(client);
  const c = status?.pairing?.thisComputerCheck;
  if (!c) return null;
  return <p className="fine-print">This computer’s check code: <code className="computer-check-code">{c.slice(0, 4)} {c.slice(4, 8)} {c.slice(8, 12)}</code></p>;
}
