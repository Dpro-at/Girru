import type { OrbPalette } from "./types"

/**
 * Each palette authors its light and dark fields separately.
 *
 * On a light field the body is opaque and pale and colour sits in a band; on a
 * dark field the body drops away and the same colour has to carry the whole
 * form, so the stops are pushed brighter and more chromatic. Deriving one from
 * the other by inverting lightness produces mud — see P4.
 */
export const orbPalettes: Record<string, OrbPalette> = {
  ember: {
    light: {
      stops: ["#d92a0f", "#f7781f", "#ffd48c"],
      body: "#f4f0ee",
    },
    dark: {
      stops: ["#ff5a1f", "#ff9d3d", "#ffe0a8"],
      body: "#0a0708",
    },
  },

  iris: {
    light: {
      stops: ["#fa9ec7", "#dbbcf2", "#8ac9fa"],
      body: "#f6f4f7",
    },
    dark: {
      stops: ["#2a85f5", "#59d4fc", "#9e6bfa"],
      body: "#07080e",
    },
  },

  moss: {
    light: {
      stops: ["#1f8f6b", "#5cc79a", "#c9edd8"],
      body: "#eef3f0",
    },
    dark: {
      stops: ["#1fbd86", "#67e8b4", "#c2f5dd"],
      body: "#050b09",
    },
  },

  porcelain: {
    light: {
      stops: ["#b8c2cf", "#d9e0e8", "#f4f7fa"],
      body: "#f7f8fa",
    },
    dark: {
      stops: ["#6d7f96", "#a9bccf", "#e2ecf5"],
      body: "#080a0d",
    },
  },

  /**
   * Three deliberately unrelated hues. `vessel` maps one stop per inner body,
   * so a palette of near-neighbours collapses the lobes into a single mass —
   * this one keeps them readable as separate objects.
   */
  spectrum: {
    light: {
      stops: ["#2f8ff0", "#f0972a", "#8b5cf6"],
      body: "#f5f6f8",
    },
    dark: {
      stops: ["#3ba0ff", "#ffab3d", "#a077ff"],
      body: "#070910",
    },
  },

  /** Tuned for `plasma`: a cold discharge against deep blue gas. */
  discharge: {
    light: {
      stops: ["#2b3ecc", "#6f8dff", "#e6ecff"],
      body: "#eef0f7",
    },
    dark: {
      stops: ["#1b2fd6", "#7d97ff", "#f0f2ff"],
      body: "#04060f",
    },
  },
}

export type OrbPaletteName = keyof typeof orbPalettes

const FINISH_DEFAULT_PALETTE: Record<string, OrbPaletteName> = {
  ink: "ember",
  pearl: "iris",
  vessel: "spectrum",
  aurora: "iris",
  plasma: "discharge",
}

export const defaultPaletteFor = (finish: string): OrbPaletteName =>
  FINISH_DEFAULT_PALETTE[finish] ?? "ember"
