import { useEffect, useRef } from 'react';
import { orbRenderer, type OrbState } from './chat-orb';

/**
 * CHAT-LOADER-01: the agent's small orb in the chat. The ring and motion around it
 * (CSS, .chat-orb[data-state]) say what it does; the words beside it say it too.
 * Decorative: the live row's text carries the meaning for screen readers.
 */
export function ChatOrb({ state, size = 20 }: { state: OrbState; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const target = useRef<ReturnType<ReturnType<typeof orbRenderer>['add']>>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const r = orbRenderer();
    target.current = r.add(el, state);
    return () => { if (target.current) r.remove(target.current); target.current = null; };
  }, []);
  useEffect(() => { if (target.current) orbRenderer().update(target.current, state); }, [state]);
  return <span className="chat-orb" data-state={state} style={{ inlineSize: size, blockSize: size }} aria-hidden="true">
    <canvas ref={ref} style={{ inlineSize: size, blockSize: size }}/>
    {state === 'done' && <span className="chat-orb-mark" data-kind="done"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg></span>}
    {state === 'fail' && <span className="chat-orb-mark" data-kind="fail"><svg viewBox="0 0 16 16"><path d="M5 5l6 6M11 5l-6 6"/></svg></span>}
  </span>;
}
