// MOB-PAIR-01 / MOB-ONBOARD-01 (boards D1–D5): one pairing flow, one QR, in
// the setup step, the sidebar popover and Settings › Phone.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { SessionClient } from './session';
import { UiIcon } from './ui-icons';
import { Popover } from './desktop-ui';
import { encodeQr, qrPath } from './qr-code';
import { PHONE_APP_LINK } from './phone-contract.js';
import { countdown, lifetimeWords, modelName, onPhonePaired, phoneCall, phonePaired, useNow, usePairing } from './phone';
import type { PairingRequest, PairingView, PhonePath } from './phone';

/** The pairing text as a QR code (own encoder), dark on white with its quiet zone. */
export function QrImage({ text, size = 150 }: { text: string; size?: number }) {
  const q = useMemo(() => encodeQr(text), [text]);
  const d = useMemo(() => qrPath(q), [q]);
  const n = q.size + 8;
  return <svg className="phone-qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label="Pairing code" shapeRendering="crispEdges">
    <rect width={n} height={n} fill="#FFFFFF"/><path d={d} fill="#111318"/>
  </svg>;
}

/** The code, or a quiet placeholder while there is none. */
function QrSlot({ view, size }: { view: PairingView; size: number }) {
  return <div className="phone-qr-frame" style={{ inlineSize: size + 16, blockSize: size + 16 }}>
    {view.state === 'waiting' && view.qr ? <QrImage text={view.qr} size={size}/> : <span className="phone-qr-empty" aria-hidden="true"><UiIcon name="mobile" size={28}/></span>}
  </div>;
}

/** "Waiting for your phone · new code in 1:45", or what happened to the code. */
export function PairingStatus({ view, now, onRenew }: { view: PairingView; now: number; onRenew: () => void }) {
  const ended = view.state === 'expired' || view.state === 'cancelled' || view.state === 'error';
  const text = view.state === 'starting' ? 'Making a code…'
    : view.state === 'waiting' ? `Waiting for your phone · new code in ${countdown(view.expiresAt, now)}`
    : view.state === 'request' ? 'Your phone is asking. Check the numbers.'
    : view.state === 'paired' ? 'Paired'
    : view.warning === 'second_request' ? 'Two phones used this code, so it stopped.'
    : view.state === 'error' ? 'Could not make a code.' : 'This code has ended.';
  return <span className="phone-status" role="status" data-state={view.state}><span className="phone-status-dot" aria-hidden="true"/>{text}
    {ended && <button type="button" className="link-button" onClick={onRenew}>Show a new code</button>}</span>;
}

/** Anywhere (relay) / Only on this Wi-Fi as two large choices (board D1). */
export function PathChoice({ path, onPath, notice }: { path: PhonePath; onPath: (p: PhonePath) => void; notice?: string }) {
  const choice = (p: PhonePath, icon: 'globe' | 'wifi', title: string, text: string) =>
    <label className="phone-path" data-on={path === p || undefined}>
      <input type="radio" name="phone-path" value={p} checked={path === p} onChange={() => onPath(p)} aria-label={title}/>
      <span className="phone-path-icon"><UiIcon name={icon} size={18}/></span>
      <span className="setup-row-text"><b>{title}</b><small>{text}</small></span>
    </label>;
  return <>
    <b className="phone-subtitle">How your phone reaches this computer</b>
    <div role="radiogroup" aria-label="How your phone connects" className="phone-paths">
      {choice('anywhere', 'globe', 'Anywhere', 'At home and away. Messages pass through the Girru relay, locked so only your phone and this computer can read them. The relay keeps nothing.')}
      {choice('wifi', 'wifi', 'Only on this Wi-Fi', 'Your phone reaches this computer only on the same network. Nothing goes through the internet.')}
    </div>
    {notice && <p className="setup-note" role="note"><UiIcon name="info" size={14}/>{notice}</p>}
  </>;
}

/** "Allow <name>?" with the 6-digit check code (board D2). Esc = Don't allow. */
export function AllowPhoneDialog({ request, busy, onAllow, onDeny }: { request: PairingRequest; busy?: boolean; onAllow: () => void; onDeny: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const deny = useRef(onDeny); deny.current = onDeny;
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); deny.current(); } };
    window.addEventListener('keydown', key, true);
    ref.current?.querySelector<HTMLButtonElement>('button.primary')?.focus();
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  const days = request.lifetimeDays ?? 90;
  return <div className="phone-allow-scrim">
    <div ref={ref} className="phone-allow" role="dialog" aria-modal="true" aria-label={`Allow ${request.name}?`}>
      <div className="phone-allow-head"><span className="phone-tile"><UiIcon name="mobile" size={22}/></span>
        <span><b>Allow <bdi>{request.name}</bdi>?</b><small>{modelName(request.model)} · wants to use this computer</small></span></div>
      <p>Check that your phone shows the same numbers. If they are different, choose Don't allow.</p>
      <div className="phone-check-code" aria-label="Check code">{request.checkCode.slice(0, 3)} {request.checkCode.slice(3)}</div>
      <p className="fine-print">It can chat with your agents, see your tasks and approve what they ask. It stays signed in for {days} days after you last use it.</p>
      <div className="phone-allow-actions"><button type="button" onClick={onDeny} disabled={busy}>Don't allow</button><button type="button" className="primary" onClick={onAllow} disabled={busy}>Allow</button></div>
    </div>
  </div>;
}

/** App Store / Google Play; both open the app page until the store pages exist. */
export function AppLinks() {
  const link = (top: string, name: string, icon: ReactNode) => <a className="phone-store" href={PHONE_APP_LINK} target="_blank" rel="noreferrer">{icon}<span><small>{top}</small><b>{name}</b></span></a>;
  return <div className="phone-stores">
    {link('Download on the', 'App Store', <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.2-2.8.8-3.5.8-.7 0-1.8-.8-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-1.1 2.8-2.3c.9-1.3 1.2-2.5 1.3-2.6-.1 0-2.5-.9-2.5-3.7zM14.1 5.8c.6-.8 1.1-1.8 1-2.8-.9 0-2 .6-2.6 1.4-.6.7-1.1 1.7-1 2.7 1 .1 2-.5 2.6-1.3z"/></svg>)}
    {link('Get it on', 'Google Play', <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5l13 8.5-13 8.5z" fill="currentColor"/></svg>)}
  </div>;
}

type Pairing = ReturnType<typeof usePairing>;

/** Board D1, without state: the setup step "Girru on your phone". */
export function PhoneSetupView({ pairing, now, onBack, onSkip }: { pairing: Pick<Pairing, 'path' | 'setPath' | 'view' | 'notice' | 'busy' | 'allow' | 'deny' | 'renew'>; now: number; onBack: () => void; onSkip: () => void }) {
  return <section className="setup-pane phone-setup" aria-label="Girru on your phone">
    <h2>Girru on your phone</h2>
    <p>Chat with your agents, approve what they ask and follow your tasks when you are away from this computer. Your chats and files stay here.</p>
    <div className="phone-cards">
      <div className="phone-card"><b>1. Get the app</b><small>Free on iPhone and Android.</small><AppLinks/><small className="phone-card-foot">Or open girru.dev/app on your phone.</small></div>
      <div className="phone-card phone-card-qr"><QrSlot view={pairing.view} size={150}/>
        <div className="phone-card-text"><b>2. Scan with the app</b><small>Open Girru on your phone, tap Pair, and point it at this code.</small><PairingStatus view={pairing.view} now={now} onRenew={pairing.renew}/></div></div>
    </div>
    <PathChoice path={pairing.path} onPath={pairing.setPath} notice={pairing.notice}/>
    <div className="setup-actions"><button type="button" onClick={onBack}>Back</button><span className="phone-later">You can do this later in Settings › Phone.</span><button type="button" onClick={onSkip}>Skip for now</button></div>
    {pairing.view.state === 'request' && pairing.view.request && <AllowPhoneDialog request={pairing.view.request} busy={pairing.busy} onAllow={() => void pairing.allow()} onDeny={() => void pairing.deny()}/>}
  </section>;
}

/** Board D3: the phone is paired. */
export function PhoneReadyView({ name, path, lifetimeDays = 90, onBack, onStart }: { name: string; path: PhonePath; lifetimeDays?: number | null; onBack: () => void; onStart: () => void }) {
  return <section className="setup-pane phone-setup" aria-label="Your phone is ready">
    <h2>Your phone is ready</h2>
    <p><bdi>{name}</bdi> can now reach Girru on this computer.</p>
    <div className="setup-row"><span className="setup-mark"><UiIcon name="mobile" size={16}/></span>
      <span className="setup-row-text"><b><bdi>{name}</bdi></b><small data-state="ok">Paired · reaches this computer {path === 'anywhere' ? 'anywhere' : 'only on this Wi-Fi'} · {lifetimeWords(lifetimeDays as 30 | null)}</small></span><UiIcon name="check" size={16}/></div>
    <p className="fine-print phone-center">The app asks for Face ID or your phone's code every time it opens. Rename the phone, change how it connects or forget it in Settings › Phone.</p>
    <div className="setup-actions"><button type="button" onClick={onBack}>Back</button><button type="button" className="primary" onClick={onStart}>Start using Girru</button></div>
  </section>;
}

/** The last setup step: pair now, or skip; Team → Phone → finish. */
export function PhoneSetupStep({ client, onBack, onDone }: { client: SessionClient; onBack: () => void; onDone: () => void }) {
  const [ready, setReady] = useState<{ name: string; path: PhonePath; lifetimeDays: number } | null>(null);
  const pairing = usePairing(client, !ready, p => setReady({ name: p.name, path: pairing.path, lifetimeDays: pairing.view.request?.lifetimeDays ?? 90 }));
  const now = useNow(!ready && pairing.view.state === 'waiting');
  return ready ? <PhoneReadyView {...ready} onBack={() => setReady(null)} onStart={onDone}/>
    : <PhoneSetupView pairing={pairing} now={now} onBack={onBack} onSkip={onDone}/>;
}

/** Board D4, without state: the popover content. */
export function ConnectPhoneView({ pairing, now, onSettings }: { pairing: Pick<Pairing, 'path' | 'setPath' | 'view' | 'notice' | 'busy' | 'allow' | 'deny' | 'renew'>; now: number; onSettings: () => void }) {
  return <div className="phone-connect">
    <b>Connect a phone</b>
    <span className="phone-connect-text">Open the Girru app on your phone, tap Pair and scan this code.</span>
    <QrSlot view={pairing.view} size={160}/>
    <PairingStatus view={pairing.view} now={now} onRenew={pairing.renew}/>
    {pairing.notice && <p className="setup-note" role="note">{pairing.notice}</p>}
    <div className="phone-connect-path"><UiIcon name={pairing.path === 'anywhere' ? 'globe' : 'wifi'} size={14}/><span>Reaches this computer {pairing.path === 'anywhere' ? 'anywhere' : 'only on this Wi-Fi'}</span>
      <button type="button" className="link-button" title={pairing.path === 'anywhere' ? 'Use only this Wi-Fi' : 'Reach this computer anywhere'} onClick={() => pairing.setPath(pairing.path === 'anywhere' ? 'wifi' : 'anywhere')}>Change</button></div>
    <div className="phone-connect-links"><a href={PHONE_APP_LINK} target="_blank" rel="noreferrer">No app yet? Get it</a><button type="button" className="link-button" onClick={onSettings}>Settings › Phone</button></div>
    {pairing.view.state === 'request' && pairing.view.request && <AllowPhoneDialog request={pairing.view.request} busy={pairing.busy} onAllow={() => void pairing.allow()} onDeny={() => void pairing.deny()}/>}
  </div>;
}

/** A live pairing for a popover or a sheet; reports the paired phone to the shell. */
export function ConnectPhone({ client, onSettings, onPaired }: { client: SessionClient; onSettings: () => void; onPaired?: (deviceId: string) => void }) {
  const pairing = usePairing(client, true, p => { phonePaired(p); onPaired?.(p.deviceId); });
  const now = useNow(pairing.view.state === 'waiting');
  return <ConnectPhoneView pairing={pairing} now={now} onSettings={onSettings}/>;
}

/** Board D4: the phone button next to the owner's name in the sidebar footer. */
export function SidebarPhoneButton({ client, onSettings }: { client: SessionClient; onSettings: () => void }) {
  const [open, setOpen] = useState(false);
  return <span className="phone-side">
    <button type="button" className="tool phone-side-button" data-popover-anchor title="Connect a phone" aria-label="Connect a phone" aria-expanded={open} onClick={() => setOpen(v => !v)}><UiIcon name="mobile" size={17}/></button>
    <Popover open={open} onClose={() => setOpen(false)} label="Connect a phone">
      <ConnectPhone client={client} onSettings={() => { setOpen(false); onSettings(); }} onPaired={() => setOpen(false)}/>
    </Popover>
  </span>;
}

/** Board D5, without state. */
export function NewPhoneNoticeView({ name, busy, onForget, onSettings, onClose }: { name: string; busy?: boolean; onForget: () => void; onSettings: () => void; onClose: () => void }) {
  return <div className="phone-notice" role="status">
    <span className="phone-tile"><UiIcon name="mobile" size={18}/></span>
    <span className="phone-notice-text"><b><bdi>{name}</bdi> can now use Girru</b><small>Paired just now. Not you? Forget it right away.</small>
      <span className="phone-notice-links"><button type="button" className="link-button phone-danger" disabled={busy} onClick={onForget}>Forget this phone</button><button type="button" className="link-button" onClick={onSettings}>Open Settings › Phone</button></span></span>
    <button type="button" className="tool" aria-label="Close" title="Close" onClick={onClose}><UiIcon name="close" size={13}/></button>
  </div>;
}

/** Shown after any pairing on this computer; "Forget this phone" acts at once (it is the "Not you?" escape). */
export function NewPhoneNotice({ client, onSettings }: { client: SessionClient; onSettings: () => void }) {
  const [shown, setShown] = useState<{ deviceId: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  useEffect(() => onPhonePaired(p => { setDone(undefined); setShown(p); }), []);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(undefined), 4000); return () => clearTimeout(t); }, [done]);
  if (done) return <div className="dk-notice" role="status">{done}</div>;
  if (!shown) return null;
  const forget = async () => {
    setBusy(true);
    const r = await phoneCall(client, 'DELETE', `/api/phone/devices/${shown.deviceId}`);
    setBusy(false);
    if (r.status === 200) { setShown(null); setDone(`${shown.name} is forgotten. It cannot reach this computer any more.`); }
    else setDone('Could not forget the phone. Open Settings › Phone and try again.');
  };
  return <NewPhoneNoticeView name={shown.name} busy={busy} onForget={() => void forget()} onSettings={() => { setShown(null); onSettings(); }} onClose={() => setShown(null)}/>;
}
