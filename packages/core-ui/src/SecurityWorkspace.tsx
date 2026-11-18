import {useEffect, useRef} from 'react';
import {createPortal} from 'react-dom';
import {UiIcon} from './ui-icons';
import type {SessionClient} from './session';

/**
 * Host for the Security app's own UI. The app (the store extension "Security") ships its frontend
 * and the backend serves it at /api/ext/waf-security/ui on this same origin; here it is embedded in
 * a frame inside the Girru window. The embedded page asks for the owner session over postMessage and
 * this host replies with the bearer (client.embedToken()) plus the current theme — only to our own
 * frame, on our own origin. The app's data routes stay owner-gated on the backend.
 */
const UI_PATH = '/api/ext/waf-security/ui';

function currentTheme(): 'dark' | 'light' {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function SecurityWorkspace({client, active, sidebarSlot, onBack}: {client: SessionClient; active: boolean; sidebarSlot?: HTMLElement | null; onBack: () => void}) {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const origin = window.location.origin;
    function send(type: string, extra: Record<string, unknown>) {
      const win = frame.current?.contentWindow;
      if (win) win.postMessage({type, ...extra}, origin);
    }
    function onMessage(e: MessageEvent) {
      // Only our own embedded frame, on our own origin, may ask for the session.
      if (e.source !== frame.current?.contentWindow || e.origin !== origin) return;
      if ((e.data || {}).type === 'girru:need-token') send('girru:token', {token: client.embedToken(), theme: currentTheme()});
    }
    window.addEventListener('message', onMessage);
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onTheme = () => send('girru:theme', {theme: currentTheme()});
    media?.addEventListener?.('change', onTheme);
    return () => { window.removeEventListener('message', onMessage); media?.removeEventListener?.('change', onTheme); };
  }, [client]);

  const nav = (
    <nav className="dk-sidebar" aria-label="Security">
      <p className="section-label dk-label">Security</p>
      <button className="nav-item dk-place" onClick={onBack}><UiIcon name="arrow-left" size={16}/>Back to apps</button>
    </nav>
  );

  return (
    <section className="security-workspace" aria-label="Security" style={{display: 'flex', height: '100%', minHeight: 0}}>
      {active && (sidebarSlot ? createPortal(nav, sidebarSlot) : <aside className="security-fallback-sidebar">{nav}</aside>)}
      <iframe
        ref={frame}
        title="Security"
        src={UI_PATH}
        style={{flex: 1, minWidth: 0, border: 0, width: '100%', height: '100%'}}
        // The embedded page is first-party (served by this Girru) but kept sandboxed to scripts and
        // same-origin only — no top navigation, popups, downloads or form posts elsewhere.
        sandbox="allow-scripts allow-same-origin"
      />
    </section>
  );
}
