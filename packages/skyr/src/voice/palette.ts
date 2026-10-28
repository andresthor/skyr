/**
 * The colour side of voice's display: the slice of Pi's theme voice draws with, and what the
 * terminal can show of it, bundled in one `Paint` that every drawing surface takes and styles
 * through `styled`.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TextStyle } from "@earendil-works/pi-tui";
import type { Tier } from "../ui/caps.js";

type VoiceToken = "accent" | "text" | "muted" | "dim" | "error" | "warning";

/**
 * The part of Pi's Theme voice draws with. Colours reach `style` as values from `colors`, never
 * as token names: a token the theme draws faint would come out in its own colour plus SGR 2,
 * not in the mixed colour `colors` holds for it.
 */
export interface VoiceTheme {
  readonly colors: Pick<Theme["colors"], VoiceToken>;
  /** The background the theme is designed for; the meter shades away from it. */
  readonly appearance: Theme["appearance"];
  style(text: string, style: TextStyle): string;
}

/** The theme and what the terminal can show of it. */
export interface Paint {
  theme: VoiceTheme;
  mode: Tier;
}

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

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
