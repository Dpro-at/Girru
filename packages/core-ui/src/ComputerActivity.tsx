import {useEffect, useRef, useState} from 'react';
import type {SessionClient} from './session';
import type {ComputerAttempt} from './computer-contract.js';
import {useComputerOverview} from './ComputerDevices';
import {UiIcon} from './ui-icons';

/** Remote work that is on its way or running, and work that waits for this computer's owner. */
const ACTIVE = new Set(['queued', 'scheduled', 'accepted', 'running', 'cancel_requested', 'waiting_approval']);
const NEEDS = new Set(['waiting_approval', 'blocked']);

/** CP11d: one quiet footer status, “3 computers · 1 working”; a click opens Computers. */
export function ComputersFooterStatus({onOpen}: {onOpen: () => void}) {
  const view = useComputerOverview();
  // CP7g: without internet, say so here (not in a dialog); tasks for other computers wait on this one.
  const [online, setOnline] = useState(typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => { const on = () => setOnline(true), off = () => setOnline(false); window.addEventListener('online', on); window.addEventListener('offline', off); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); }; }, []);
  if (!view || !(view.configured || view.testOnly)) return null;
  const devices = view.devices.filter(d => d.state !== 'revoked');
  if (!devices.length) return null;
  const working = view.attempts.filter(a => ACTIVE.has(a.state) && a.state !== 'waiting_approval').length;
  const needs = view.attempts.filter(a => view.self && a.targetDevice === view.self.id && NEEDS.has(a.state)).length;
  if (!online) return <button type="button" className="status-item" title="Can’t reach your other computers. Same Wi‑Fi still works; other tasks wait here and go when you are online." onClick={onOpen}><UiIcon name="wifi" size={13}/><span className="footer-label">Offline · tasks wait here</span></button>;
  const text = `${devices.length + 1} computers${working ? ` · ${working} working` : ''}`;
  return <button type="button" className="status-item" title={needs ? `${text} · ${needs} need you` : text} aria-label={needs ? `${text}, ${needs} need you` : text} onClick={onOpen}>
    <UiIcon name="screen" size={13}/><span className="footer-label">{text}</span>{needs > 0 && <span className="dk-badge-pill">{needs}</span>}
  </button>;
}

/** CP11b: Runs shows the work on your other computers too, above this computer's runs. */
export function ComputerRunsRows({waiting, onOpen}: {waiting: boolean; onOpen: () => void}) {
  const view = useComputerOverview();
  if (!view) return null;
  const selfId = view.self?.id;
  const rows = view.attempts.filter(a => waiting ? selfId && a.targetDevice === selfId && NEEDS.has(a.state) : a.targetDevice !== selfId && ACTIVE.has(a.state)).slice(0, 20);
  if (!rows.length) return null;
  return <section className="runs-computers" aria-label={waiting ? 'Tasks from your other computers' : 'On your other computers'}>
    <p className="section-label">{waiting ? 'From your other computers' : 'On your other computers'}</p>
    {rows.map(a => <button key={a.attemptId} type="button" className="computer-task" onClick={onOpen}>
      <UiIcon name="screen" size={15}/>
      <span className="computer-task-text"><b>{a.detail?.split('\n')[0]?.slice(0, 120) || 'Task'}</b><small>{waiting ? `From ${a.sourceName}` : a.targetName} · {a.statusLabel}</small></span>
    </button>)}
  </section>;
}

/**
 * CP11c: a system notice when a task you sent finishes, or another computer needs your Allow.
 * Clicking it opens Computers. Only changes seen while Girru is open are announced.
 */
export function useComputerNotices(enabled: boolean, onOpen: () => void, client?: SessionClient) {
  const view = useComputerOverview();
  const seen = useRef<Map<string, string> | null>(null);
  // Settings › General › Notifications › From my other computers (read again every minute).
  const allowed = useRef(true);
  useEffect(() => {
    if (!enabled || !client) return;
    let live = true;
    const read = () => void client.request({method: 'GET', path: '/api/computers/look'}).then(r => { if (live && r.status === 200) allowed.current = (r.body as {notices?: boolean})?.notices !== false; }).catch(() => {});
    read(); const t = setInterval(read, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [enabled, client]);
  useEffect(() => {
    if (!enabled || !view) return;
    const before = seen.current;
    const now = new Map([...view.attempts.map(a => [a.attemptId, a.state] as [string, string]), ...(view.copyAsks ?? []).map(c => [c.requestId, 'copy-ask'] as [string, string])]);
    seen.current = now;
    if (!before || !allowed.current || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const selfId = view.self?.id;
    const say = (title: string, body: string) => { try { const n = new Notification(title, {body, silent: false}); n.onclick = () => { window.focus(); onOpen(); }; } catch { /* the list still shows it */ } };
    for (const a of view.attempts as ComputerAttempt[]) {
      const old = before.get(a.attemptId);
      if (old === a.state) continue;
      const title = a.detail?.split('\n')[0]?.slice(0, 80) || 'A task';
      if (a.sourceDevice === selfId && a.state === 'completed') say(`${a.targetName} finished “${title}”`, 'Open it to see the result.');
      else if (a.sourceDevice === selfId && ['cancelled', 'blocked', 'unknown'].includes(a.state)) say(`${a.targetName} stopped “${title}”`, a.statusLabel);
      else if (a.targetDevice === selfId && a.state === 'waiting_approval' && !old) say(`${a.sourceName} sent a task`, `Allow “${title}”?`);
    }
    for (const c of view.copyAsks ?? []) if (!before.has(c.requestId)) say(`${c.fromName} asks for a copy of a project`, 'Open Computers to choose the project and allow it.');
  }, [enabled, view]);
}
