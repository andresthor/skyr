/**
 * The slice of Pi's theme skyr draws with and what the terminal can show of it, as one `Paint`
 * that every drawing surface takes and styles through `styled`.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TextStyle } from "@earendil-works/pi-tui";
import type { Mark, Tier } from "./caps.js";

type Token =
  | "accent"
  | "text"
  | "muted"
  | "dim"
  | "error"
  | "warning"
  | "selectedBg";

/**
 * The part of Pi's Theme skyr draws with. Colours reach `style` as values from `colors`, never
 * as token names: a token the theme draws faint would come out in its own colour plus SGR 2,
 * not in the mixed colour `colors` holds for it.
 */
export interface ThemeLike {
  readonly colors: Pick<Theme["colors"], Token>;
  /** The background the theme is designed for; the meter shades away from it. */
  readonly appearance: Theme["appearance"];
  style(text: string, style: TextStyle): string;
}

/** The theme and what the terminal can show of it. */
export interface Paint {
  theme: ThemeLike;
  mode: Tier;
}

/** The ink of each mark's glyph. */
export const markToken: Readonly<Record<Mark, Token>> = {
  queued: "dim",
  running: "accent",
  failed: "error",
};

/** `text` in `style`, in the theme's colour mode; `mono` drops the colour and keeps the attributes, `ascii` draws plain text. */
export function styled(
  { theme, mode }: Paint,
  text: string,
  style: TextStyle,
): string {
  if (mode === "ascii") return text;
  return theme.style(
    text,
    mode === "color" ? style : { ...style, fg: undefined },
  );
}

/**
 * `text` as the selected item: bold on the theme's selection background, inverse without
 * colour. ascii has no styles, so it draws `plain` instead, which must say "selected" in
 * characters.
 */
export function selected(paint: Paint, text: string, plain: string): string {
  if (paint.mode === "ascii") return plain;
  return styled(paint, text, {
    bold: true,
    ...(paint.mode === "color"
      ? { fg: paint.theme.colors.text, bg: paint.theme.colors.selectedBg }
      : { inverse: true }),
  });
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
