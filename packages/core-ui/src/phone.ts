// MOB-PAIR-01: pairing a phone and the owner's paired phones (contract:
// phone-contract.js). One pairing flow for the setup step, the sidebar
// popover and Settings › Phone.
import { useEffect, useRef, useState } from 'react';
import type { SessionClient } from './session';

export type PhonePath = 'anywhere' | 'wifi';
export type PhoneLifetime = 30 | 60 | 90 | 120 | null;
export type PhoneDevice = { id: string; name: string; model: string | null; path: PhonePath; lifetimeDays: PhoneLifetime; status: 'active' | 'expired'; pairedAt: string; lastUsedAt: string; expiresAt: string | null };
export type PhoneOverview = { computer: { id: string; name: string } | null; devices: PhoneDevice[]; relayUrl: string; connection: 'off' | 'connecting' | 'connected' | 'waiting'; wifi: 'on' | 'off' | 'failed' };
export type PairingRequest = { name: string; model: string; checkCode: string; lifetimeDays?: 30 | 60 | 90 | 120 };
export type PairingView = { state: 'starting' | 'waiting' | 'request' | 'paired' | 'cancelled' | 'expired' | 'error'; qr: string | null; expiresAt: string | null; request?: PairingRequest; warning?: 'second_request'; deviceId?: string };

export const WIFI_OFF = 'Only on this Wi-Fi is not turned on on this computer yet.';
export const DEFAULT_LIFETIME = 90;

type Reply = { status: number; body: Record<string, unknown> | null };
export async function phoneCall(client: SessionClient, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Reply> {
  try {
    const r = await client.request({ method, path, ...(body === undefined ? {} : { body }) } as never);
    return { status: r.status, body: r.body && typeof r.body === 'object' ? r.body as Record<string, unknown> : null };
  } catch { return { status: 0, body: null }; }
}
export const codeOf = (r: Reply) => typeof r.body?.code === 'string' ? r.body.code : '';

/** "ios" → "iPhone"; the phone app sends its platform, not its model. */
export function modelName(model: string | null): string {
  if (model === 'ios') return 'iPhone';
  if (model === 'android') return 'Android phone';
  return model ? model.charAt(0).toUpperCase() + model.slice(1) : 'Phone';
}
/** m:ss until the code renews. */
export function countdown(expiresAt: string | null, now: number): string {
  const s = Math.max(0, Math.ceil(((expiresAt ? Date.parse(expiresAt) : now) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDate = (iso: string) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
/** "2 minutes ago", "yesterday", "3 Nov". */
export function ago(iso: string, now: number): string {
  const m = Math.floor((now - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : d < 7 ? `${d} days ago` : shortDate(iso);
}
export const pathWords = (p: PhonePath) => p === 'anywhere' ? 'Anywhere' : 'Only on this Wi-Fi';
export const lifetimeWords = (d: PhoneLifetime) => d === null ? 'stays signed in' : `stays signed in ${d} days after last use`;

// A pairing finished on this computer; the shell shows the notice (board D5).
type Paired = { deviceId: string; name: string };
const listeners = new Set<(p: Paired) => void>();
export function onPhonePaired(f: (p: Paired) => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }
export function phonePaired(p: Paired): void { for (const f of [...listeners]) f(p); }

function useVisible(): boolean {
  const [v, setV] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setV(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return v;
}
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!active) return; const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [active, ms]);
  return now;
}

const ENDED = new Set(['paired', 'cancelled', 'expired', 'error']);

/**
 * One open pairing while `open`: starts it, reads it every second while the
 * window is visible (the code renews every 2 minutes), closes it when the
 * view closes. Choosing a path starts a new code.
 */
export function usePairing(client: SessionClient, open: boolean, onPaired?: (p: Paired) => void) {
  const [path, setPathState] = useState<PhonePath>('anywhere');
  const [round, setRound] = useState(0);
  const [id, setId] = useState<string | null>(null);
  const [view, setView] = useState<PairingView>({ state: 'starting', qr: null, expiresAt: null });
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const visible = useVisible();
  const lastName = useRef('Your phone');
  const cb = useRef(onPaired); cb.current = onPaired;
  const reported = useRef(false);
  const paired = { current: (p: Paired) => { if (reported.current) return; reported.current = true; cb.current?.(p); } };

  useEffect(() => {
    if (!open) return;
    let live = true, current: string | null = null;
    setView({ state: 'starting', qr: null, expiresAt: null }); setId(null); reported.current = false;
    void phoneCall(client, 'POST', '/api/phone/pairing', { path }).then(r => {
      const b = r.body;
      if (r.status === 201 && b && typeof b.id === 'string') {
        if (!live) { void phoneCall(client, 'DELETE', `/api/phone/pairing/${b.id}`); return; }
        current = b.id; setId(b.id);
        setView({ state: 'waiting', qr: b.qr as string, expiresAt: b.expiresAt as string });
      } else if (live && codeOf(r) === 'wifi_off') { setNotice(WIFI_OFF); setPathState('anywhere'); }
      else if (live) setView({ state: 'error', qr: null, expiresAt: null });
    });
    return () => { live = false; if (current) void phoneCall(client, 'DELETE', `/api/phone/pairing/${current}`); };
  }, [client, open, path, round]);

  useEffect(() => {
    if (!open || !id || !visible) return;
    let live = true, t: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const r = await phoneCall(client, 'GET', `/api/phone/pairing/${id}`);
      if (!live) return;
      if (r.status === 200 && r.body && typeof r.body.state === 'string') {
        const v = r.body as unknown as PairingView;
        if (v.request) lastName.current = v.request.name;
        setView(v);
        if (v.state === 'paired') { paired.current({ deviceId: v.deviceId ?? '', name: lastName.current }); return; }
        if (ENDED.has(v.state)) return;
      } else if (r.status === 404) { setView({ state: 'expired', qr: null, expiresAt: null }); return; }
      t = setTimeout(() => void read(), 1000);
    };
    t = setTimeout(() => void read(), 1000);
    return () => { live = false; clearTimeout(t); };
  }, [client, open, id, visible]);

  const setPath = (p: PhonePath) => { setNotice(undefined); if (p !== path) setPathState(p); };
  const renew = () => { setNotice(undefined); setRound(n => n + 1); };
  const allow = async () => {
    if (!id || !view.request) return;
    setBusy(true);
    const r = await phoneCall(client, 'POST', `/api/phone/pairing/${id}/allow`, { lifetimeDays: view.request.lifetimeDays ?? DEFAULT_LIFETIME, path });
    setBusy(false);
    if (r.status === 200) {
      lastName.current = view.request.name;
      setView({ state: 'paired', qr: null, expiresAt: null, deviceId: r.body?.deviceId as string });
      // The read loop stops at "paired"; report it here when the loop is not running.
      paired.current({ deviceId: r.body?.deviceId as string, name: view.request.name });
      setId(null);
    } else setNotice(codeOf(r) === 'pairing_closed' ? 'This phone stopped asking. Show a new code and scan it again.' : 'Could not allow this phone. Try again.');
  };
  const deny = async () => {
    if (!id) return;
    await phoneCall(client, 'POST', `/api/phone/pairing/${id}/deny`);
    renew();
  };
  return { path, setPath, view, notice, busy, allow, deny, renew, pairedName: lastName.current };
}
