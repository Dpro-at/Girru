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
type Pending = {id: string; name: string; at: number; timer: ReturnType<typeof setTimeout>};
let pending: Pending | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const l of [...listeners]) l(); };
let lastResult: {name: string; ok: boolean} | null = null;

export function forgetComputerLater(client: SessionClient, device: {id: string; name: string}) {
  if (pending) { clearTimeout(pending.timer); void runForget(client, pending); }
  const item: Pending = {id: device.id, name: device.name, at: Date.now(), timer: setTimeout(() => void runForget(client, item), FORGET_DELAY_MS)};
  pending = item; lastResult = null; changed();
}
async function runForget(client: SessionClient, item: Pending) {
  if (pending === item) pending = null;
  let ok = false;
  try { const r = await client.request({method: 'POST', path: `/api/computers/peers/${encodeURIComponent(item.id)}/revoke`}); ok = r.status === 200; } catch { ok = false; }
  lastResult = {name: item.name, ok}; changed();
}
export function undoForget() { if (!pending) return; clearTimeout(pending.timer); pending = null; lastResult = null; changed(); }

/** The notice for the waiting Forget (with Undo) and its result, for any page that shows computers. */
export function ForgetNotice() {
  const [, tick] = useState(0);
  useEffect(() => { const l = () => tick(n => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  if (pending) return <p role="status" className="computer-undo"><UiIcon name="trash" size={14}/><span>{pending.name} will be forgotten.</span><button type="button" className="link-button" onClick={undoForget}>Undo</button></p>;
  if (lastResult) return <p role="status" className="computer-undo"><span>{lastResult.ok ? `${lastResult.name} was forgotten. To use it again, add it again.` : `${lastResult.name} could not be forgotten. Try again.`}</span></p>;
  return null;
}
export const isForgetting = (id: string) => pending?.id === id;
/** Re-renders a page while a Forget is waiting, so the computer leaves its list at once and comes back on Undo. */
export function useForgetPending() {
  const [, tick] = useState(0);
  useEffect(() => { const l = () => tick(n => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return pending?.id ?? null;
}
