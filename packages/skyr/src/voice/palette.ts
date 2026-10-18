/**
 * The colour side of voice's display: the theme's token colours and the terminal's colour
 * mode joined in one palette, so 256-colour terminals get 256-colour escapes from the same
 * code that writes truecolour ones.
 *
 * The palette is the fallback when there is no theme to read (`FALLBACK_PALETTE`), and
 * `painter` is how every mark picks a colour in the palette's mode.
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
export interface VoicePalette {
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

/** Colours `s` in the palette's mode; mono and ascii draw no colour at all. */
export const painter =
  (P: VoicePalette, mode: VoiceMode) =>
  (c: Color, s: string): string =>
    mode === "color" ? `${foregroundAnsi(c, P.mode)}${s}\x1b[39m` : s;
