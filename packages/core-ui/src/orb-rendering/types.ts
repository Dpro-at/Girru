/** The five renderable finishes. `prism` is deliberately absent — see docs/style-guide.md. */
export type OrbFinish = "ink" | "pearl" | "vessel" | "aurora" | "plasma"

/** Agent presence states. Each must be distinguishable in a still frame (P8). */
export type OrbState = "idle" | "listening" | "thinking" | "speaking"

/** Which value structure the orb is drawn in. Not a palette — a light model (P4). */
export type OrbField = "light" | "dark"

export interface OrbFieldColors {
  /** Three gradient stops, any CSS colour the canvas can parse. */
  stops: [string, string, string]
  /**
   * The non-chromatic mass: `pearl`'s opaque body, `vessel`'s interior ground.
   * Ignored by finishes that have no body.
   */
  body: string
}

/**
 * A palette declares both fields. Dark mode swaps the whole model, so the two
 * halves are authored independently rather than derived from one another.
 */
export interface OrbPalette {
  light: OrbFieldColors
  dark: OrbFieldColors
}

/**
 * Anything ref-like. Deliberately structural rather than React's `RefObject`,
 * so a plain `{ current }` box works and `useRef` returns of either mutability
 * are accepted. `null` reads as silence.
 */
export type LevelRef = { readonly current: number | null }

/** A level source read once per frame. Never a prop — see P10 and the README. */
export type LevelSource = LevelRef | (() => number) | number | undefined

export interface OrbRendererConfig {
  finish: OrbFinish
  field: OrbField
  colors: OrbFieldColors
  state: OrbState
  /** 0–1. Film grain opacity. Defaults on; 0 flattens the orb (P6). */
  grain: number
  /** Decorrelates two orbs on the same screen. */
  seed: number
  /** Multiplies ambient time only. Audio-driven acceleration is separate. */
  speed: number
  /** Render a single frame and stop. */
  still: boolean
}
