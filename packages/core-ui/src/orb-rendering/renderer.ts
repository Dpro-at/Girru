import {
  FINISH_INDEX,
  FRAGMENT_SHADER,
  STATE_INDEX,
  VERTEX_SHADER,
} from "./shader"
import type { OrbRendererConfig } from "./types"

const UNIFORMS = [
  "uTime", "uFlow", "uRing", "uFinish", "uState", "uDark", "uIn", "uOut",
  "uGrain", "uSeed", "uDetail", "uC1", "uC2", "uC3", "uBody", "uPointer", "uPtr",
] as const

type UniformName = (typeof UNIFORMS)[number]

export interface OrbRendererHooks {
  /** Read once per frame. Returning a ref's `.current` here is the whole point. */
  getInputLevel?: () => number
  getOutputLevel?: () => number
}

const DPR_CAP = 2

/** #rgb, #rrggbb, or anything else the canvas can parse, to linear-ish 0-1 RGB. */
function parseColor(input: string): [number, number, number] {
  const hex = input.trim()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex)
  if (short) {
    return [
      parseInt(short[1] + short[1], 16) / 255,
      parseInt(short[2] + short[2], 16) / 255,
      parseInt(short[3] + short[3], 16) / 255,
    ]
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (long) {
    return [
      parseInt(long[1], 16) / 255,
      parseInt(long[2], 16) / 255,
      parseInt(long[3], 16) / 255,
    ]
  }
  // Anything exotic (oklch, colour names, CSS vars already resolved): let the
  // platform do it. Falls back to mid grey if there is no 2D context.
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas")
    c.width = c.height = 1
    const ctx = c.getContext("2d")
    if (ctx) {
      ctx.fillStyle = "#808080"
      ctx.fillStyle = input
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0] / 255, d[1] / 255, d[2] / 255]
    }
  }
  return [0.5, 0.5, 0.5]
}

export class OrbRenderer {
  readonly supported: boolean

  private canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext | null = null
  private program: WebGLProgram | null = null
  private loc = {} as Record<UniformName, WebGLUniformLocation | null>

  private config: OrbRendererConfig
  private hooks: OrbRendererHooks

  private raf = 0
  private running = false
  private visible = true
  private lastTs: number | null = null
  private startTs: number | null = null

  private flow = 0
  private ring = 0
  private inLevel = 0
  private outLevel = 0

  private pointer = { x: 0.7, y: 0.5, on: 0, target: 0 }
  private detail = 1

  private resizeObserver: ResizeObserver | null = null
  private intersectionObserver: IntersectionObserver | null = null

  constructor(
    canvas: HTMLCanvasElement,
    config: OrbRendererConfig,
    hooks: OrbRendererHooks = {},
  ) {
    this.canvas = canvas
    this.config = config
    this.hooks = hooks

    const gl =
      canvas.getContext("webgl", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
      }) ||
      (canvas.getContext("experimental-webgl", {
        alpha: true,
        premultipliedAlpha: true,
      }) as WebGLRenderingContext | null)

    if (!gl) {
      this.supported = false
      return
    }

    this.gl = gl
    this.supported = this.build()
    if (!this.supported) return

    canvas.addEventListener("webglcontextlost", this.onContextLost)
    canvas.addEventListener("webglcontextrestored", this.onContextRestored)
    this.observe()
  }

  private onContextLost = (event: Event) => {
    // Default behaviour is to never fire `restored`; preventing it opts in.
    event.preventDefault()
    this.stop()
  }

  private onContextRestored = () => {
    if (this.build()) this.start()
  }

  private build(): boolean {
    const gl = this.gl!
    const vs = this.compile(gl.VERTEX_SHADER, VERTEX_SHADER)
    const fs = this.compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    if (!vs || !fs) return false

    const program = gl.createProgram()
    if (!program) return false
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("[AI-Orb] link failed:", gl.getProgramInfoLog(program))
      return false
    }

    gl.useProgram(program)
    this.program = program

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    // One oversized triangle covers the viewport with no seam down the middle.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const attr = gl.getAttribLocation(program, "aPos")
    gl.enableVertexAttribArray(attr)
    gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0)

    for (const name of UNIFORMS) {
      this.loc[name] = gl.getUniformLocation(program, name)
    }

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    return true
  }

  private compile(type: number, source: string): WebGLShader | null {
    const gl = this.gl!
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("[AI-Orb] shader compile failed:", gl.getShaderInfoLog(shader))
      return null
    }
    return shader
  }

  private observe() {
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(this.canvas)
    }
    if (typeof IntersectionObserver !== "undefined") {
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          this.visible = entries[0].isIntersecting
        },
        { rootMargin: "120px" },
      )
      this.intersectionObserver.observe(this.canvas)
    }
  }

  private resize() {
    const gl = this.gl
    if (!gl) return
    const rect = this.canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    // Detail is a function of CSS size, not device pixels: a 32px avatar on a
    // 3x screen is still a 32px avatar to the eye. Grain, striations and thin
    // filaments below this become dither rather than texture.
    this.detail = Math.min(1, Math.max(0, (Math.min(rect.width, rect.height) - 28) / 68))
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP)
    const w = Math.round(rect.width * dpr)
    const h = Math.round(rect.height * dpr)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      gl.viewport(0, 0, w, h)
    }
  }

  /** Merge a partial config. Cheap; safe to call on every React render. */
  update(next: Partial<OrbRendererConfig>) {
    this.config = { ...this.config, ...next }
  }

  setHooks(hooks: OrbRendererHooks) {
    this.hooks = hooks
  }

  /** Normalised direction from the orb centre; `active` false releases it. */
  setPointer(x: number, y: number, active: boolean) {
    if (active) {
      const len = Math.hypot(x, y) || 1
      this.pointer.x = x / len
      this.pointer.y = y / len
    }
    this.pointer.target = active ? 1 : 0
  }

  start() {
    if (!this.supported || this.running) return
    this.running = true
    this.lastTs = null
    this.startTs = null
    const tick = (ts: number) => {
      if (!this.running) return
      this.frame(ts)
      if (this.config.still) {
        this.running = false
        return
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop() {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /** Draw exactly one frame — the poster used for reduced motion. */
  renderStill(atSeconds = 6) {
    if (!this.supported) return
    this.resize()
    this.draw(atSeconds, atSeconds, 0, 0, 0)
  }

  private frame(ts: number) {
    if (this.startTs === null) {
      this.startTs = ts
      this.lastTs = ts
    }
    const t = (ts - this.startTs) / 1000
    const dt = Math.min((ts - (this.lastTs ?? ts)) / 1000, 0.05)
    this.lastTs = ts

    const rawIn = clamp01(read(this.hooks.getInputLevel))
    const rawOut = clamp01(read(this.hooks.getOutputLevel))

    // Smoothing lives here, not in the consumer: an unsmoothed analyser reads
    // as a jitter, and every caller would otherwise reimplement this.
    const k = Math.min(1, dt * 11)
    this.inLevel += (rawIn - this.inLevel) * k
    this.outLevel += (rawOut - this.outLevel) * k

    // Cumulative, so speech accelerates the interior instead of just brightening
    // it — motion gains inertia the way the ElevenLabs shader does.
    this.flow += dt * this.config.speed * (1 + this.outLevel * 3.2)
    this.ring += dt * (0.42 + this.inLevel * 0.5)
    this.pointer.on += (this.pointer.target - this.pointer.on) * Math.min(1, dt * 5)

    if (!this.visible) return
    this.resize()
    this.draw(t, this.flow, this.ring, this.inLevel, this.outLevel)
  }

  private draw(time: number, flow: number, ring: number, input: number, output: number) {
    const gl = this.gl
    if (!gl || !this.program) return

    const { finish, state, colors, field, grain, seed } = this.config
    const c1 = parseColor(colors.stops[0])
    const c2 = parseColor(colors.stops[1])
    const c3 = parseColor(colors.stops[2])
    const body = parseColor(colors.body)

    gl.uniform1f(this.loc.uTime, time)
    gl.uniform1f(this.loc.uFlow, flow)
    gl.uniform1f(this.loc.uRing, ring)
    gl.uniform1i(this.loc.uFinish, FINISH_INDEX[finish] ?? 0)
    gl.uniform1i(this.loc.uState, STATE_INDEX[state] ?? 0)
    gl.uniform1f(this.loc.uDark, field === "dark" ? 1 : 0)
    gl.uniform1f(this.loc.uIn, input)
    gl.uniform1f(this.loc.uOut, output)
    gl.uniform1f(this.loc.uGrain, grain)
    gl.uniform1f(this.loc.uSeed, seed)
    gl.uniform1f(this.loc.uDetail, this.detail)
    gl.uniform3f(this.loc.uC1, c1[0], c1[1], c1[2])
    gl.uniform3f(this.loc.uC2, c2[0], c2[1], c2[2])
    gl.uniform3f(this.loc.uC3, c3[0], c3[1], c3[2])
    gl.uniform3f(this.loc.uBody, body[0], body[1], body[2])
    gl.uniform2f(this.loc.uPointer, this.pointer.x, this.pointer.y)
    gl.uniform1f(this.loc.uPtr, this.pointer.on)

    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  destroy() {
    this.stop()
    this.resizeObserver?.disconnect()
    this.intersectionObserver?.disconnect()
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost)
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored)

    // Deliberately not calling WEBGL_lose_context.loseContext(). A canvas hands
    // back the same context object on every getContext call, so killing it here
    // would poison any renderer built on this canvas afterwards — which is
    // exactly what StrictMode's mount/unmount/remount does. Dropping the
    // program and our references is enough; the context goes with the canvas.
    if (this.gl && this.program) this.gl.deleteProgram(this.program)
    this.gl = null
    this.program = null
  }
}

function read(source: (() => number) | undefined): number {
  return typeof source === "function" ? source() : 0
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}
