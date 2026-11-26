import { useEffect, useRef } from 'react';

/**
 * START-SCREEN: an ambient ASCII-ember field behind the empty chat — Girru, the fire.
 * It moves slowly and the whole field breathes (the opacity rises and fades on a ~7.5s
 * cycle, in CSS). It dims while the owner is typing (`dim`) and renders a single static
 * frame when the viewer prefers reduced motion. Purely decorative, so it is aria-hidden.
 */
export function EmberBackdrop({ dim = false }: { dim?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const CELL = 13, dpr = Math.min(2, window.devicePixelRatio || 1);
    const ramp = [' ', ' ', '.', '.', "'", ':', ';', '+', '*', 'o', 'x', '%', '#'];
    let cols = 0, rows = 0, buf = new Float32Array(0), raf = 0, last = 0;

    const size = () => {
      const r = cv.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      cv.width = Math.floor(r.width * dpr);
      cv.height = Math.floor(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `600 ${CELL}px ui-monospace,Menlo,Consolas,monospace`;
      ctx.textBaseline = 'top';
      cols = Math.max(1, Math.ceil(r.width / CELL));
      rows = Math.max(1, Math.ceil(r.height / CELL));
      buf = new Float32Array(cols * rows);
    };
    const colour = (v: number) => {
      const r = Math.min(255, 45 + v * 290), g = Math.min(220, v * v * 320), b = Math.min(150, v * v * v * 210);
      return `rgba(${r | 0},${g | 0},${b | 0},${Math.min(1, 0.12 + v * 0.9).toFixed(2)})`;
    };
    const stepSim = () => {
      if (!buf.length) return;
      for (let x = 0; x < cols; x++) {
        const s = Math.random();
        buf[(rows - 1) * cols + x] = s > 0.5 ? 0.6 + Math.random() * 0.3 : 0.12 + Math.random() * 0.18;
      }
      for (let y = 0; y < rows - 1; y++) for (let x = 0; x < cols; x++) {
        const below = buf[(y + 1) * cols + x];
        const bl = buf[(y + 1) * cols + ((x - 1 + cols) % cols)];
        const br = buf[(y + 1) * cols + ((x + 1) % cols)];
        const b2 = buf[Math.min(rows - 1, y + 2) * cols + x];
        const v = (below * 1.8 + bl + br + b2) / 4.78 - 0.015 - Math.random() * 0.012;
        buf[y * cols + x] = v < 0 ? 0 : v;
      }
    };
    const render = () => {
      const r = cv.getBoundingClientRect();
      ctx.clearRect(0, 0, r.width, r.height);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const v = buf[y * cols + x];
        if (v <= 0.06) continue;
        const ch = ramp[Math.min(ramp.length - 1, Math.floor(v * ramp.length))];
        if (ch === ' ') continue;
        ctx.fillStyle = colour(v);
        ctx.fillText(ch, x * CELL, y * CELL);
      }
    };
    const loop = (t: number) => {
      if (t - last > 115) { stepSim(); render(); last = t; }
      raf = requestAnimationFrame(loop);
    };

    size();
    if (reduce) { for (let i = 0; i < 60; i++) stepSim(); render(); }
    else raf = requestAnimationFrame(loop);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(size) : null;
    ro?.observe(cv);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, []);

  return <canvas ref={ref} className="chat-ember" data-dim={dim || undefined} aria-hidden="true"/>;
}
