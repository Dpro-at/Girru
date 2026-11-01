import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { UiIcon } from './ui-icons';

export type DiscoveryLabel = { kind: 'folder' | 'file' | 'memory' | 'skill' | 'mcp' | 'ssh'; name: string };

/** One label per clipped lane: animated names cannot cross or touch their neighbours. */
export function DiscoveryStream({ items }: { items: readonly DiscoveryLabel[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  const [turns, setTurns] = useState([0, 0, 0]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setColumns(Math.max(1, Math.min(3, Math.floor((el.clientWidth + 32) / 292))));
    measure();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }
    const observer = new ResizeObserver(measure); observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const labels = items.slice(0, 18);
  const lanes = Math.max(1, Math.min(columns, labels.length));
  return <div ref={ref} className="setup-discovery-stream" aria-hidden="true" style={{ '--stream-lanes': lanes } as CSSProperties}>
    {labels.length > 0 && Array.from({ length: lanes }, (_, lane) => {
      const item = labels[(turns[lane] * lanes + lane) % labels.length];
      return <div className="setup-discovery-lane" key={lane}>
        <span className="setup-discovery-particle" data-kind={item.kind} style={{ '--particle-delay': `${-[1.1, 3.8, 6.2][lane]}s`, '--particle-duration': `${[7, 8.3, 9.1][lane]}s`, '--particle-drift': `${[12, -12, 8][lane]}px` } as CSSProperties}
          onAnimationIteration={() => setTurns(previous => previous.map((turn, index) => index === lane ? turn + 1 : turn))}>
          <UiIcon name={item.kind === 'folder' ? 'folder' : item.kind === 'ssh' ? 'key' : item.kind === 'skill' ? 'sparkle' : item.kind === 'mcp' ? 'server' : item.kind === 'memory' ? 'brain' : 'file'} size={22}/>
          <small title={item.name}>{item.name}</small>
        </span>
      </div>;
    })}
  </div>;
}
