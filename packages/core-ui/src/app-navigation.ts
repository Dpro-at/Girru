import { useEffect, useState } from 'react';
import type { NabuBridge } from './workspace-modes';
import type { SessionClient } from './session';
export type AppDestination = 'home' | 'settings' | 'account' | 'about' | 'new-chat' | 'agents' | 'library' | 'board' | 'memory';
type AppInfo = { version: string; connection: 'local' | 'remote'; memoryEncrypted?: boolean | null };
declare global { interface Window { dproApp?: { nabu?: NabuBridge; setSetupWindow?: (compact: boolean) => Promise<boolean>; onNavigate: (fn: (page: AppDestination) => void) => () => void; info: () => Promise<AppInfo> }; } }
export function useAppNavigation(open: (page: AppDestination) => void) {
  useEffect(() => window.dproApp?.onNavigate(page => { if (['home', 'settings', 'account', 'about', 'new-chat', 'agents', 'library', 'board', 'memory'].includes(page)) open(page); }), [open]);
}
export function useAppInfo() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => { let active = true; void window.dproApp?.info().then(value => { if (active && typeof value.version === 'string') setInfo(value); }).catch(() => {}); return () => { active = false; }; }, []);
  return info;
}
export type ThemePreference = 'system' | 'light' | 'dark';
/** The theme; with `client` it is also saved in the program (CP13), so “Same as” brings it to a new computer. */
export function useAppTheme(client?: SessionClient) {
  const [preference, update] = useState<ThemePreference>(() => { try { const value = localStorage.getItem('dpro.theme'); if (value === 'light' || value === 'dark') return value; } catch { /* optional preference store */ } return 'system'; });
  const [systemDark, setSystemDark] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  useEffect(() => { const media = window.matchMedia?.('(prefers-color-scheme: dark)'); const changed = () => setSystemDark(!!media?.matches); media?.addEventListener('change', changed); return () => media?.removeEventListener('change', changed); }, []);
  const keep = (value: ThemePreference) => { update(value); try { localStorage.setItem('dpro.theme', value); } catch { /* session-only if storage unavailable */ } };
  useEffect(() => { if (!client) return; let live = true; void client.request({ method: 'GET', path: '/api/me/theme' } as never).then(r => { const t = (r.body as { theme?: unknown } | null)?.theme; if (live && r.status === 200 && (t === 'system' || t === 'light' || t === 'dark')) keep(t); }).catch(() => {}); return () => { live = false; }; }, [client]);
  const setPreference = (value: ThemePreference) => { keep(value); if (client) void client.request({ method: 'PUT', path: '/api/me/theme', body: { theme: value } } as never).catch(() => {}); };
  return { preference, setPreference, theme: preference === 'system' ? (systemDark ? 'dark' : 'light') : preference };
}
