"use client"

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"

import { defaultPaletteFor, orbPalettes } from "./palettes"
import { OrbRenderer } from "./renderer"
import type {
  LevelSource,
  OrbField,
  OrbFieldColors,
  OrbFinish,
  OrbState,
} from "./types"

export interface OrbProps {
  /** Visual archetype. `pearl` resolves to `aurora` on a dark field (P4). */
  finish?: OrbFinish
  /** Named palette from `orbPalettes`. */
  palette?: string
  /** Three explicit stops. Overrides `palette`. */
  colors?: [string, string, string]
  /** The non-chromatic mass behind the colour. Defaults to the palette's. */
  bodyColor?: string
  /** Force a light model. Defaults to following the page. */
  field?: OrbField

  state?: OrbState
  /** Agent speech level, 0–1. Drives the body. Ref, getter, or constant. */
  outputLevelRef?: LevelSource
  /** Microphone level, 0–1. Drives the boundary. Ref, getter, or constant. */
  inputLevelRef?: LevelSource

  /** 0–1 film grain. Leave on unless you have a reason (P6). */
  grain?: number
  /** Decorrelates orbs shown together. */
  seed?: number
  /** Ambient time multiplier. Audio acceleration is separate. */
  speed?: number
  /**
   * Filaments follow the pointer on `plasma`. Off elsewhere, where it would be
   * motion without meaning.
   */
  pointerReactive?: boolean

  className?: string
  style?: CSSProperties
  /** Announced to assistive tech. Defaults to a description of the state. */
  label?: string
}

const STATE_LABEL: Record<OrbState, string> = {
  idle: "Assistant idle",
  listening: "Assistant listening",
  thinking: "Assistant thinking",
  speaking: "Assistant speaking",
}

function toGetter(source: LevelSource): () => number {
  if (typeof source === "function") return source
  if (typeof source === "number") return () => source
  if (source && typeof source === "object") return () => source.current ?? 0
  return () => 0
}

type LevelGetters = { input: () => number; output: () => number }

/**
 * Some finishes are objects with their own light model rather than surfaces
 * that adapt to the page. A plasma globe on a white desk is still dark inside;
 * pulling its colours from a light palette washes it out. Only `ink` and
 * `vessel` genuinely follow the page.
 */
const FINISH_FIELD: Record<OrbFinish, OrbField | null> = {
  ink: null,
  vessel: null,
  pearl: "light",
  aurora: "dark",
  plasma: "dark",
}

/** Follows the page unless `field` is given. Re-reads on OS and class changes. */
function useResolvedField(explicit?: OrbField): OrbField {
  const [field, setField] = useState<OrbField>(explicit ?? "light")

  useEffect(() => {
    if (explicit) {
      setField(explicit)
      return
    }
    if (typeof window === "undefined") return

    const query = window.matchMedia("(prefers-color-scheme: dark)")
    const read = (): OrbField => {
      const attr = document.documentElement.getAttribute("data-theme")
      if (attr === "dark") return "dark"
      if (attr === "light") return "light"
      if (document.documentElement.classList.contains("dark")) return "dark"
      return query.matches ? "dark" : "light"
    }

    setField(read())
    const onChange = () => setField(read())
    query.addEventListener("change", onChange)

    const observer = new MutationObserver(onChange)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    })

    return () => {
      query.removeEventListener("change", onChange)
      observer.disconnect()
    }
  }, [explicit])

  return field
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined") return
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(query.matches)
    const onChange = () => setReduced(query.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return reduced
}

export function Orb({
  finish = "ink",
  palette,
  colors,
  bodyColor,
  field: fieldProp,
  state = "idle",
  outputLevelRef,
  inputLevelRef,
  grain = 0.05,
  seed = 0,
  speed = 1,
  pointerReactive = true,
  className,
  style,
  label,
}: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<OrbRenderer | null>(null)
  const [fallback, setFallback] = useState(false)

  const pageField = useResolvedField(fieldProp)
  const reduced = usePrefersReducedMotion()

  // Pearl has no dark form; on a dark page it becomes Aurora rather than being
  // recoloured into mud (P4).
  const effectiveFinish: OrbFinish =
    finish === "pearl" && pageField === "dark" ? "aurora" : finish

  const field: OrbField = FINISH_FIELD[effectiveFinish] ?? pageField

  const resolved: OrbFieldColors = useMemo(() => {
    const named = orbPalettes[palette ?? defaultPaletteFor(effectiveFinish)]
    const base = (named ?? orbPalettes.ember)[field]
    return {
      stops: colors ?? base.stops,
      body: bodyColor ?? base.body,
    }
  }, [palette, colors, bodyColor, field, effectiveFinish])

  // Kept in a ref so changing the source never re-creates the WebGL context.
  const levels = useRef<LevelGetters>({ input: () => 0, output: () => 0 })
  levels.current.input = toGetter(inputLevelRef)
  levels.current.output = toGetter(outputLevelRef)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const renderer = new OrbRenderer(
      canvas,
      {
        finish: effectiveFinish,
        field,
        colors: resolved,
        state,
        grain,
        seed,
        speed,
        still: reduced,
      },
      {
        getInputLevel: () => levels.current.input(),
        getOutputLevel: () => levels.current.output(),
      },
    )

    if (!renderer.supported) {
      setFallback(true)
      return
    }

    rendererRef.current = renderer
    if (reduced) renderer.renderStill()
    else renderer.start()

    const onVisibility = () => {
      if (reduced) return
      if (document.hidden) renderer.stop()
      else renderer.start()
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      renderer.destroy()
      rendererRef.current = null
    }
    // Recreated only when the drawing surface's own lifecycle changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced])

  // Everything else is a cheap uniform update, not a teardown.
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    renderer.update({
      finish: effectiveFinish,
      field,
      colors: resolved,
      state,
      grain,
      seed,
      speed,
      still: reduced,
    })
    if (reduced) renderer.renderStill()
  }, [effectiveFinish, field, resolved, state, grain, seed, speed, reduced])

  const trackPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const renderer = rendererRef.current
    if (!renderer || !pointerReactive || effectiveFinish !== "plasma") return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2
    const y = -((event.clientY - rect.top) / rect.height - 0.5) * 2
    renderer.setPointer(x, y, true)
  }

  const releasePointer = () => {
    rendererRef.current?.setPointer(0, 0, false)
  }

  // No WebGL: a static approximation rather than an empty hole.
  if (fallback) {
    return (
      <div
        className={className}
        style={{
          borderRadius: "50%",
          background: `radial-gradient(circle at 34% 30%, ${resolved.stops[2]}, ${resolved.stops[1]} 45%, ${resolved.stops[0]} 100%)`,
          ...style,
        }}
        role="img"
        aria-label={label ?? STATE_LABEL[state]}
      />
    )
  }

  return (
    <div
      className={className}
      style={{ position: "relative", borderRadius: "50%", overflow: "hidden", ...style }}
      onPointerMove={trackPointer}
      onPointerDown={trackPointer}
      onPointerLeave={releasePointer}
      role="img"
      aria-label={label ?? STATE_LABEL[state]}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
        aria-hidden="true"
      />
    </div>
  )
}
