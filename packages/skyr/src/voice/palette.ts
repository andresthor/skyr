/**
 * The colour side of voice's display: the theme's token colours and the terminal's colour
 * mode joined in one palette, so 256-colour terminals get 256-colour escapes from the same
 * code that writes truecolour ones.
 *
 * The palette is the fallback when there is no theme to read (`FALLBACK_PALETTE`). `paintFor`
 * bundles a palette with a `VoiceMode` into one `Paint`, the single colour value every drawing
 * surface takes — nothing threads a (palette, mode) pair.
 */
import {
  type Color,
  foregroundAnsi,
  parseColor,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";

/** What the terminal can show: `mono` is NO_COLOR (glyphs and attributes, no colour), `ascii` is TERM=dumb. */
export type VoiceMode = "color" | "mono" | "ascii";

type VoiceToken = "accent" | "text" | "muted" | "dim" | "error" | "warning";

/** Theme colours plus the terminal's colour mode, so 256-colour terminals get 256-colour escapes. */
interface VoicePalette {
  colors: Record<VoiceToken, Color>;
  mode: TerminalColorMode;
}

/** Corti dark token values: the palette when there is no theme to read. */
export const FALLBACK_PALETTE: VoicePalette = {
  colors: {
    accent: parseColor("#B8F818"),
    text: parseColor("#d4d4d4"),
    muted: parseColor("#808080"),
    dim: parseColor("#666666"),
    error: parseColor("#cc6666"),
    warning: parseColor("#d7af5f"),
  },
  mode: "truecolor",
};

/** The narrow shape of Pi's Theme the palette reads; `colors` is concrete in every colour mode. */
interface ThemeLike {
  readonly colors: Readonly<Record<VoiceToken, Color>>;
  getColorMode(): TerminalColorMode;
}

/** The theme's token colours and the terminal colour mode it renders in. */
export function paletteFromTheme(theme: ThemeLike | undefined): VoicePalette {
  if (!theme) return FALLBACK_PALETTE;
  const { accent, text, muted, dim, error, warning } = theme.colors;
  return {
    colors: { accent, text, muted, dim, error, warning },
    mode: theme.getColorMode(),
  };
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Everything a glyph with a colour needs: the theme tokens, what the terminal can carry, and the painter. */
export interface Paint {
  colors: Record<VoiceToken, Color>;
  /** TERM=dumb: neither colour nor the decorated glyph set. */
  ascii: boolean;
  /** False under NO_COLOR: glyphs and attributes stay, colour goes. */
  colour: boolean;
  /** Colours `s` with `c`, in the palette's mode; plain `s` when colour is out. */
  fg(c: Color, s: string): string;
}

/** One `Paint` for a frame, from a ready palette or straight from the theme. */
export function paintFor(
  source: VoicePalette | ThemeLike | undefined,
  mode: VoiceMode,
): Paint {
  // a theme hands its colours over one accessor at a time; a VoicePalette is already one
  const P =
    source && "getColorMode" in source
      ? paletteFromTheme(source)
      : (source ?? FALLBACK_PALETTE);
  return {
    colors: P.colors,
    ascii: mode === "ascii",
    colour: mode === "color",
    fg:
      mode === "color"
        ? (c, s) => `${foregroundAnsi(c, P.mode)}${s}\x1b[39m`
        : (_c, s) => s,
  };
}
