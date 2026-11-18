/**
 * CHAT-LOADER-01: the chat's small orb (the setup orb's spectrum colours,
 * cleaned: no grain, no glass, sharper blobs, drawn at its exact pixel size).
 *
 * One WebGL context and one animation loop serve every orb on screen: each
 * frame renders an orb into the shared offscreen canvas and copies it into
 * that orb's own 2D canvas. The loop stops when no orb is visible, when the
 * window is hidden, and never advances with reduced motion (one still frame).
 * Without WebGL the orb is a plain CSS gradient (the .chat-orb fallback).
 */

export type OrbState = 'think' | 'search' | 'work' | 'write' | 'wait' | 'load' | 'done' | 'fail' | 'idle';
type Motion = { shader: 0 | 1 | 2 | 3; speed: number; out: (t: number) => number; inp: number };

const MOTION: Record<OrbState, Motion> = {
  load: { shader: 0, speed: 0.5, out: () => 0.2, inp: 0 },
  think: { shader: 2, speed: 1.1, out: () => 0.3, inp: 0 },
  search: { shader: 1, speed: 0.9, out: () => 0, inp: 1 },
  work: { shader: 3, speed: 1.4, out: () => 1, inp: 0 },
  write: { shader: 3, speed: 0.9, out: (t) => 0.3 + 0.7 * Math.abs(Math.sin(t * 6.1) * Math.sin(t * 2.3)), inp: 0 },
  wait: { shader: 0, speed: 0.15, out: (t) => 0.5 + 0.5 * Math.sin(t * 2.6), inp: 0 },
  done: { shader: 0, speed: 0.1, out: () => 0, inp: 0 },
  fail: { shader: 0, speed: 0.03, out: () => 0, inp: 0 },
  idle: { shader: 0, speed: 0.2, out: () => 0.2, inp: 0 },
};

/** The setup orb's colours (spectrum; moss for done, ember for failed), light and dark fields. */
const PALETTE = {
  spectrum: { dark: { stops: ['#3ba0ff', '#ffab3d', '#a077ff'], body: '#070910' }, light: { stops: ['#2f8ff0', '#f0972a', '#8b5cf6'], body: '#f5f6f8' } },
  moss: { dark: { stops: ['#1fbd86', '#67e8b4', '#c2f5dd'], body: '#050b09' }, light: { stops: ['#1f8f6b', '#5cc79a', '#c9edd8'], body: '#eef3f0' } },
  ember: { dark: { stops: ['#ff5a1f', '#ff9d3d', '#ffe0a8'], body: '#0a0708' }, light: { stops: ['#d92a0f', '#f7781f', '#ffd48c'], body: '#f4f0ee' } },
} as const;
const paletteOf = (s: OrbState) => (s === 'done' ? PALETTE.moss : s === 'fail' ? PALETTE.ember : PALETTE.spectrum);

const VS = 'attribute vec2 aPos;varying vec2 vUv;void main(){vUv=aPos*0.5+0.5;gl_Position=vec4(aPos,0.0,1.0);}';
// Three soft blobs orbit inside a disc; "think" adds a sweeping light. Sharp edge, no grain or glass.
const FS = `precision highp float;varying vec2 vUv;uniform float uFlow;uniform int uState;uniform float uIn;uniform float uOut;uniform float uSeed;uniform vec3 uC1;uniform vec3 uC2;uniform vec3 uC3;uniform vec3 uBody;
void main(){float grow=1.0+0.020*uOut-0.008*uIn;vec2 p=(vUv-0.5)*2.0/grow;float r=length(p);float fl=uFlow+uSeed*13.77;float alpha=1.0-smoothstep(0.965,0.995,r);
vec3 acc=vec3(0.0);float field=0.0;float spread=0.26+0.16*uOut+0.04*sin(fl*0.3);float mass=0.085+0.03*uOut;
for(int i=0;i<3;i++){float fi=float(i);float orbit=spread+0.05*sin(fl*0.37+fi*1.7);vec2 c=vec2(cos(fl*0.42+fi*2.094),sin(fl*0.35+fi*2.094))*orbit;float w=mass/(dot(p-c,p-c)+0.012);vec3 lc=fi<0.5?uC1:(fi<1.5?uC2:uC3);field+=w;acc+=w*lc;}
vec3 inner=acc/max(field,0.0001);float body=smoothstep(0.55,0.95,field);vec3 col=mix(uBody,inner,body);
if(uState==2){float ang=atan(p.y,p.x);float sweep=0.5+0.5*cos(ang-fl*1.5);col+=mix(uC2,uC3,0.5)*pow(sweep,5.0)*1.1*smoothstep(0.05,0.85,r);}
gl_FragColor=vec4(clamp(col,0.0,1.0),alpha);}`;

const SIZE = 128;
type Target = { el: HTMLCanvasElement; state: OrbState; flow: number; seed: number; drawn: boolean };
const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

class SharedOrbRenderer {
  private gl: WebGLRenderingContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private targets = new Set<Target>();
  private raf = 0;
  private last = 0;
  private start = 0;
  private failed = false;
  private seeds = 0;

  /** False when WebGL is unavailable: the caller keeps the CSS fallback. */
  get available(): boolean { return !this.failed && typeof document !== 'undefined' && !!this.ensure(); }

  private ensure(): WebGLRenderingContext | null {
    if (this.gl || this.failed) return this.gl;
    try {
      const c = document.createElement('canvas'); c.width = c.height = SIZE;
      const gl = c.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: true });
      if (!gl) { this.failed = true; return null; }
      const sh = (t: number, s: string) => { const o = gl.createShader(t)!; gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw Error('shader'); return o; };
      const pr = gl.createProgram()!;
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw Error('link');
      gl.useProgram(pr);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const a = gl.getAttribLocation(pr, 'aPos'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      for (const n of ['uFlow', 'uState', 'uIn', 'uOut', 'uSeed', 'uC1', 'uC2', 'uC3', 'uBody']) this.u[n] = gl.getUniformLocation(pr, n);
      c.addEventListener('webglcontextlost', e => { e.preventDefault(); this.gl = null; this.failed = true; this.stop(); });
      this.gl = gl; this.canvas = c;
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.kick(); else this.stop(); });
      return gl;
    } catch { this.failed = true; return null; }
  }

  add(el: HTMLCanvasElement, state: OrbState): Target | null {
    if (!this.ensure()) return null;
    const t: Target = { el, state, flow: Math.random() * 10, seed: (this.seeds++ % 7) * 0.17, drawn: false };
    this.targets.add(t); this.kick();
    return t;
  }
  update(t: Target, state: OrbState) { if (t.state !== state) { t.state = state; t.drawn = false; this.kick(); } }
  remove(t: Target) { this.targets.delete(t); if (!this.targets.size) this.stop(); }

  private reduced(): boolean { try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; } }
  private kick() { if (!this.raf && this.targets.size && document.visibilityState !== 'hidden') this.raf = requestAnimationFrame(this.tick); }
  private stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.last = 0; }

  private tick = (ts: number) => {
    this.raf = 0;
    const gl = this.gl; if (!gl || !this.canvas) return;
    if (!this.start) this.start = ts;
    const t = (ts - this.start) / 1000, dt = this.last ? Math.min((ts - this.last) / 1000, 0.05) : 0;
    this.last = ts;
    const still = this.reduced();
    let moving = false;
    for (const T of this.targets) {
      const el = T.el;
      if (!el.isConnected) { this.targets.delete(T); continue; }
      const css = el.clientWidth;
      if (!css) continue; // hidden (folded, other pane): nothing to draw
      const m = MOTION[T.state];
      if (still && T.drawn) continue;
      const out = still ? 0.3 : m.out(t);
      if (!still) { T.flow += dt * m.speed * (1 + out * 3.2); moving = true; }
      // Exact pixel size: the CSS size times the screen's pixel ratio (capped to the shared canvas).
      const px = Math.min(SIZE, Math.max(1, Math.round(css * Math.min(Math.max(window.devicePixelRatio || 1, 1), 3))));
      if (el.width !== px) { el.width = px; el.height = px; }
      const light = el.closest('[data-theme]')?.getAttribute('data-theme') === 'light' || (!el.closest('[data-theme]') && window.matchMedia?.('(prefers-color-scheme: light)').matches);
      const p = paletteOf(T.state)[light ? 'light' : 'dark'];
      gl.viewport(0, 0, px, px);
      gl.uniform1f(this.u.uFlow, T.flow); gl.uniform1i(this.u.uState, m.shader); gl.uniform1f(this.u.uIn, m.inp); gl.uniform1f(this.u.uOut, out); gl.uniform1f(this.u.uSeed, T.seed);
      const [a, b, c] = p.stops.map(hex), d = hex(p.body);
      gl.uniform3f(this.u.uC1, ...a); gl.uniform3f(this.u.uC2, ...b); gl.uniform3f(this.u.uC3, ...c); gl.uniform3f(this.u.uBody, ...d);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3);
      const ctx = el.getContext('2d'); if (!ctx) continue;
      ctx.clearRect(0, 0, px, px); ctx.drawImage(this.canvas, 0, SIZE - px, px, px, 0, 0, px, px);
      T.drawn = true;
      el.parentElement?.setAttribute('data-gl', '');
    }
    // Keep going while something moves; with reduced motion one still frame per change is enough.
    if (this.targets.size && (moving || [...this.targets].some(x => !x.drawn))) this.raf = requestAnimationFrame(this.tick);
  };
}

let shared: SharedOrbRenderer | null = null;
/** The one renderer every chat orb uses. */
export function orbRenderer(): SharedOrbRenderer { return (shared ??= new SharedOrbRenderer()); }

/** CHAT-LOADER-01: the live row's words → the orb's state. */
export function orbStateOf(verb: string): OrbState {
  if (/^Loading|^Opening the conversation/.test(verb)) return 'load';
  if (/^Thinking|^Starting/.test(verb)) return 'think';
  if (/^Search|^Reading|^Opening|^Browsing|^Looking/.test(verb)) return 'search';
  if (/^Answering|^Writing$/.test(verb)) return 'write';
  if (/^Waiting/.test(verb)) return 'wait';
  return 'work';
}
