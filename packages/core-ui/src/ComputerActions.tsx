import {useEffect, useState} from 'react';
import type {SessionClient} from './session';
import {Sheet} from './desktop-ui';
import {UiIcon} from './ui-icons';
import {COMPUTER_ICONS, type ComputerIconKey} from './ComputerLook';

/** The same Rename and icon sheet in Computers and in Settings › Computers › My computers. */
export function RenameComputerSheet({target, onSave, onClose}: {target: {id: string; name: string; icon: ComputerIconKey | null}; onSave: (id: string, change: {name: string; icon?: ComputerIconKey}) => Promise<void>; onClose: () => void}) {
  const [name, setName] = useState(target.name);
  const [icon, setIcon] = useState<ComputerIconKey | null>(target.icon);
  const [notice, setNotice] = useState('');
  return <Sheet title="Rename and icon" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!name.trim()} onClick={() => void onSave(target.id, {name: name.trim(), ...(icon ? {icon} : {})}).then(onClose).catch(() => setNotice('It could not be saved.'))}>Save</button></>}>
    <label className="phone-field"><span>Name on this computer</span><input autoFocus value={name} maxLength={64} onChange={e => setName(e.target.value)}/></label>
    <div className="computer-icons" role="radiogroup" aria-label="Picture">{COMPUTER_ICONS.map(i => <button key={i.key} type="button" role="radio" aria-checked={icon === i.key} className={`computer-icon-choice${icon === i.key ? ' is-on' : ''}`} title={i.name} onClick={() => setIcon(i.key)}><UiIcon name={i.icon} size={22}/><small>{i.name}</small></button>)}</div>
    <p className="fine-print">Girru picks the picture from the system by itself; choose another if you like.</p>
    {notice && <p role="status">{notice}</p>}
  </Sheet>;
}

/**
 * CP7f Forget with Undo: “Forget this computer” happens after a short wait with an Undo notice, so a
 * mistake costs one click. The wait runs outside any page, so leaving the page does not cancel it.
 */
export const FORGET_DELAY_MS = 8000;
type Pending = {id: string; name: string; publicKey?: string; at: number; timer: ReturnType<typeof setTimeout>};
let pending: Pending | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const l of [...listeners]) l(); };
let lastResult: {name: string; ok: boolean; partial?: boolean} | null = null;
let needsGoogle: {client: SessionClient; item: Pending; deviceId: string} | null = null;
let confirming = false;
const nonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** Sign in with Google again (the account asks for it), then take the computer out of the account. */
async function confirmWithGoogle() {
  const n = needsGoogle; if (!n || confirming) return;
  confirming = true; changed();
  const call = async (path: string, body: unknown) => { const r = await n.client.request({method: 'POST', path: '/api/computers/account' + path, body}); if (r.status !== 200) throw Error((r.body as {code?: string} | null)?.code ?? 'refused'); return r.body as Record<string, unknown>; };
  let ok = false;
  try {
    const clientNonce = nonce();
    const {flowId} = await call('/flow/start', {kind: 'reauth', clientNonce, confirmed: true}) as {flowId: string};
    for (let i = 0; i < 200; i++) { const st = await call('/flow/status', {flowId, clientNonce}) as {state: string}; if (st.state === 'ready') break; if (st.state === 'failed') throw Error('failed'); await new Promise(r => setTimeout(r, 1500)); }
    const done = await call('/flow/finish', {flowId, clientNonce});
    if (done.verificationRequired) throw Error('verification');
    await call('/devices/revoke', {deviceId: n.deviceId, confirmed: true});
    try { await n.client.request({method: 'POST', path: `/api/computers/peers/${encodeURIComponent(n.item.id)}/revoke`}); } catch { /* not linked here */ }
    ok = true;
  } catch { ok = false; }
  lastResult = {name: n.item.name, ok}; needsGoogle = null; confirming = false; changed();
}

export function forgetComputerLater(client: SessionClient, device: {id: string; name: string; publicKey?: string}) {
  if (pending) { clearTimeout(pending.timer); void runForget(client, pending); }
  const item: Pending = {id: device.id, name: device.name, publicKey: device.publicKey, at: Date.now(), timer: setTimeout(() => void runForget(client, item), FORGET_DELAY_MS)};
  pending = item; lastResult = null; changed();
}
async function runForget(client: SessionClient, item: Pending) {
  if (pending === item) pending = null;
  // A computer in your Dpro account must leave the account; the link here is forgotten too. The account decides the result.
  let inAccount: boolean | null = null, accountOk = false, hereOk = false;
  try {
    const status = await client.request({method: 'GET', path: '/api/computers/account'});
    if (status.status !== 200) throw Error();
    const view = (status.body as {view?: {devices?: {id: string; publicKey?: string; status?: string}[]}} | null)?.view;
    const match = view?.devices?.find(d => d.status !== 'revoked' && (d.id === item.id || !!item.publicKey && d.publicKey === item.publicKey));
    inAccount = !!match;
    if (match) {
      const r = await client.request({method: 'POST', path: '/api/computers/account/devices/revoke', body: {deviceId: match.id, confirmed: true}});
      accountOk = r.status === 200;
      // Taking a computer out of the account needs a fresh Google sign-in (the last 5 minutes): ask for it, then finish.
      if (!accountOk && (r.body as {code?: string} | null)?.code === 'account_fresh_google_required') { needsGoogle = {client, item, deviceId: match.id}; lastResult = null; changed(); return; }
    }
  } catch { inAccount = inAccount ?? null; }
  try { const r = await client.request({method: 'POST', path: `/api/computers/peers/${encodeURIComponent(item.id)}/revoke`}); hereOk = r.status === 200; } catch { /* not linked here */ }
  const ok = inAccount === true ? accountOk : inAccount === false ? hereOk : false;
  lastResult = {name: item.name, ok, partial: !ok && hereOk}; changed();
}
export function undoForget() { if (!pending) return; clearTimeout(pending.timer); pending = null; lastResult = null; changed(); }

/** The notice for the waiting Forget (with Undo) and its result, for any page that shows computers. */
export function ForgetNotice() {
  const [, tick] = useState(0);
  useEffect(() => { const l = () => tick(n => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  if (needsGoogle) return <p role="status" className="computer-undo"><UiIcon name="shield" size={14}/><span>To take {needsGoogle.item.name} out of your account, confirm with Google once.</span><button type="button" className="link-button" disabled={confirming} onClick={() => void confirmWithGoogle()}>{confirming ? 'Waiting for Google…' : 'Confirm with Google'}</button></p>;
  if (pending) return <p role="status" className="computer-undo"><UiIcon name="trash" size={14}/><span>{pending.name} will be forgotten.</span><button type="button" className="link-button" onClick={undoForget}>Undo</button></p>;
  if (lastResult) return <p role="status" className="computer-undo"><span>{lastResult.ok ? `${lastResult.name} was forgotten. To use it again, add it again.` : lastResult.partial ? `${lastResult.name} was removed here but is still in your Dpro account. Try again.` : `${lastResult.name} could not be forgotten. Try again.`}</span></p>;
  return null;
}
export const isForgetting = (id: string) => pending?.id === id;
/** Re-renders a page while a Forget is waiting, so the computer leaves its list at once and comes back on Undo. */
export function useForgetPending() {
  const [, tick] = useState(0);
  useEffect(() => { const l = () => tick(n => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return pending?.id ?? null;
}
