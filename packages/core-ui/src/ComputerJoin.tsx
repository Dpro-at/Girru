import {useEffect, useRef, useState} from 'react';
import type {SessionClient} from './session';
import {Sheet} from './desktop-ui';
import {QrImage} from './PhonePairing';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';

/** Adding a computer (DEVICES-PROJECT-01 B2, boards CP1, CP2, CP7, CP9c): plain words, pictures instead of codes. */
const root = '/api/computers/account';
type Status = {desktopAvailable?: boolean; connected?: boolean; googleLinked?: boolean; view?: {deviceStatus?: string; devices?: {id: string; label: string; status: string}[]} | null; pairing?: {self: {waiting: boolean; approver: string | null; code: string | null; changed?: boolean} | null; requests: {deviceId: string; label: string; osFamily: string; code: string | null; publicKey?: string; elsewhere: boolean; changed?: boolean}[]; addedWithCode: {deviceId: string; label: string; publicKey: string; checkCode: string}[]; twoFactorFailuresToday?: number; thisComputerCheck?: string} | null};

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
async function call(client: SessionClient, path: string, body?: unknown) {
  const r = await client.request(body === undefined ? {method: 'GET', path} : {method: 'POST', path, body});
  if (r.status !== 200) throw Error((r.body as {code?: string})?.code ?? 'computer_request_refused');
  return r.body as any;
}
/** The Dpro account status, read every few seconds while shown. */
export function useAccountStatus(client: SessionClient, enabled = true) {
  // undefined while reading; null when this window cannot reach the account (a browser, or no desktop app).
  const [status, setStatus] = useState<Status | null | undefined>(undefined);
  useEffect(() => { if (!enabled) return; let live = true; const load = async () => { try { const s = await call(client, root); if (live) setStatus(s); } catch { if (live) setStatus(null); } }; void load(); const t = setInterval(() => void load(), 3000); return () => { live = false; clearInterval(t); }; }, [client, enabled]);
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
  const current = useRef(flow); current.current = flow;
  useEffect(() => { if (!flow || flow.ready) return; let live = true; const t = setInterval(() => { void call(client, root + '/flow/status', {flowId: flow.flowId, clientNonce: flow.clientNonce}).then(r => { if (!live) return; if (r.state === 'ready') { clearInterval(t); setFlow({...flow, ready: true}); void finish({...flow, ready: true}); } else if (r.state === 'failed') { clearInterval(t); setFlow(null); setNotice('Google sign-in did not finish. Try again.'); } }).catch(() => { clearInterval(t); setFlow(null); setNotice('The sign-in took too long. Start again.'); }); }, 1500); return () => { live = false; clearInterval(t); }; }, [flow?.flowId]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setNotice(''); try { await fn(); } catch (e) { setNotice(computerAccountWords((e as Error).message)); } finally { setBusy(false); } };
  const start = () => run(async () => { const bytes = crypto.getRandomValues(new Uint8Array(32)); const clientNonce = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); const r = await call(client, root + '/flow/start', {kind: 'connect', clientNonce, label: name.trim() || 'Computer', confirmed: true}); setFlow({flowId: r.flowId, clientNonce}); });
  async function finish(f = current.current, verification?: {challenge: string; nonce: string; code: string}) { if (!f) return; await run(async () => { const r = await call(client, root + '/flow/finish', {flowId: f.flowId, clientNonce: f.clientNonce, ...(verification ? {verification} : {})}); if (r.verificationRequired) { setVerify({challenge: r.challenge, nonce: r.nonce}); return; } setVerify(null); setFlow(null); }); }
  const join = () => run(async () => { await call(client, root + '/join-with-code', {code: code.trim(), confirmed: true}); setCode(''); });

  const waiting = status?.connected && status.view?.deviceStatus === 'pending';
  if (waiting) {
    const self = status?.pairing?.self;
    return <div className="computer-join">
      <p className="computer-steps"><span>1 Signed in</span><b>2 Say Yes on your other computer</b><span>3 Choose what comes</span></p>
      <h2>Now go to your other computer</h2>
      <ol className="computer-join-list"><li>Open Girru on a computer you already use.</li><li>It asks: “Add this computer to your account?”</li><li>If it shows the same pictures, press Yes, add it.</li></ol>
      {self?.changed ? <p role="alert">Something changed while you were adding this computer, so it stopped for safety. Sign in again to start over.</p> : self?.code ? <ComputerPictures code={self.code}/> : <p role="status" className="fine-print">Waiting for your other computer…</p>}
      {notice && <p role="status">{notice}</p>}
      {!useCode ? <button type="button" className="link-button" onClick={() => setUseCode(true)}>My other computers are off — use my authenticator code</button>
        : <div className="computer-join-code"><label className="phone-field"><span>Code from your authenticator app</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}/></label><button type="button" className="primary" disabled={busy || code.length !== 6} onClick={() => void join()}>Add this computer</button></div>}
      <p className="fine-print">Signing in alone never adds a computer. Only a Yes from your other computer, or your authenticator code, does.</p>
    </div>;
  }
  return <div className="computer-join">
    <p className="computer-steps"><b>1 Sign in</b><span>2 Say Yes on your other computer</span><span>3 Choose what comes</span></p>
    <h2>Add this computer to your account</h2>
    <p>Sign in with the same Google account you use for Girru on your other computer.</p>
    <label className="phone-field"><span>Give this computer a name</span><input value={name} maxLength={64} placeholder="Office PC" onChange={e => setName(e.target.value)}/></label>
    {verify ? <div className="computer-join-code"><label className="phone-field"><span>Code from your authenticator app</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}/></label><button type="button" className="primary" disabled={busy || code.length !== 6} onClick={() => void finish(current.current, {...verify, code: code.trim()})}>Continue</button></div>
      : <button type="button" className="primary" disabled={busy || !!flow || status === null || status?.desktopAvailable === false} onClick={() => void start()}>{flow ? 'Waiting for Google…' : 'Continue with Google'}</button>}
    {(status === null || status?.desktopAvailable === false) && <p role="status">Open the Girru app on this computer to add it. A browser window can’t keep the computer’s key safe.</p>}
    {flow && <button type="button" className="link-button" onClick={() => { void call(client, root + '/flow/cancel', {flowId: flow.flowId, clientNonce: flow.clientNonce}).catch(() => {}); setFlow(null); }}>Cancel</button>}
    {notice && <p role="status">{notice}</p>}
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
    <p className="section-label">Needs you</p>
    {reqs.map(r => <div key={r.deviceId} className="computer-task" role="group" aria-label={`Add ${r.label}`}>
      <UiIcon name="user-plus" size={16}/>
      <span className="computer-task-text"><b>Add “{r.label}” to your account?</b><small>{r.changed ? 'This request changed after you answered it, so it stopped for safety. Start again on the new computer.' : r.elsewhere ? 'Another of your computers is answering this.' : r.code ? 'Check the new computer shows these same pictures. Only add a computer you own.' : 'Getting the pictures ready…'}</small>{r.code && <ComputerPictures code={r.code}/>}</span>
      {!r.elsewhere && !r.changed && <span className="computer-task-actions"><button type="button" disabled={busy === r.deviceId} onClick={() => void answer(r, false)}>No, it’s not me</button><button type="button" className="primary" disabled={busy === r.deviceId || !r.code} onClick={() => void answer(r, true)}>Yes, add it</button></span>}
    </div>)}
    {(status?.pairing?.twoFactorFailuresToday ?? 0) >= 5 && <p role="alert" className="fine-print"><UiIcon name="alert" size={13}/> Someone tried {status?.pairing?.twoFactorFailuresToday} wrong authenticator codes on your Dpro account today. If it was not you, change your Google password.</p>}
    {added.slice(0, 3).map(a => <div key={a.deviceId} className="computer-task" role="group" aria-label={`${a.label} joined with your code`}><UiIcon name="alert" size={16}/><span className="computer-task-text"><b>“{a.label}” joined with your authenticator code</b><small>Was this you? Keep it only if “{a.label}” shows this same code in Settings › Computers › My computers.</small><code className="computer-check-code">{a.checkCode.slice(0, 4)} {a.checkCode.slice(4, 8)} {a.checkCode.slice(8, 12)}</code></span><span className="computer-task-actions"><button type="button" className="primary" onClick={() => void forget(a)}>Forget it</button><button type="button" onClick={() => void keep(a)}>Same code — keep</button></span></div>)}
    {notice && <p role="status" className="fine-print">{notice}</p>}
  </section>;
}

/** A short notice anywhere in the window when a new computer asks to join. */
export function ComputerJoinNotice({client, enabled, onOpen}: {client: SessionClient; enabled: boolean; onOpen: () => void}) {
  const status = useAccountStatus(client, enabled);
  const [hidden, setHidden] = useState('');
  const r = status?.pairing?.requests?.find(x => !x.elsewhere);
  if (!r || hidden === r.deviceId) return null;
  return <div className="computer-join-notice" role="status"><UiIcon name="screen" size={16}/><span><b>New computer: {r.label}</b><small>Wants to join your account</small></span><button type="button" className="primary" onClick={() => { setHidden(r.deviceId); onOpen(); }}>Review</button><button type="button" className="tool" aria-label="Later" title="Later" onClick={() => setHidden(r.deviceId)}><UiIcon name="close" size={13}/></button></div>;
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
  return <section className="phone-row computer-twofactor" aria-label="Two-step sign-in for my Dpro account">
    <span className="phone-tile"><UiIcon name="lock" size={16}/></span>
    <span className="phone-row-text"><b>Two-step sign-in for my Dpro account</b><small>{!state.available ? 'Not available on this Dpro service yet.' : state.enabled ? 'On. A new computer can also join with your authenticator code.' : 'Off. Turn it on to add a computer when your other computers are off.'}</small>{notice && <small role="status">{notice}</small>}</span>
    {state.available && (state.enabled ? <button type="button" onClick={() => setOff(true)}>Turn off…</button> : <button type="button" onClick={() => void call(client, root + '/twofactor', {action: 'setup'}).then(setSetup).catch(e => setNotice(computerAccountWords((e as Error).message)))}>Turn on…</button>)}
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
