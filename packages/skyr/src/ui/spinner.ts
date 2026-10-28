/**
 * The working spinner. Pi's loader ticks every 80 ms and is told once per session; the editor
 * picks the glyph from the clock, so every interval is a whole number of ticks.
 */
import type { WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { type Paint, styled } from "./palette.js";

/** Pi's loader tick; the editor redraws on it, so no frame can be shorter. */
const TICK_MS = 80;

interface SpinnerVariant {
  readonly frames: readonly string[];
  readonly intervalMs: number;
}

/** A star that swells and fades, while the model thinks. */
const THINKING: SpinnerVariant = {
  frames: ["·", "✧", "✦", "✦", "✧", "·"],
  intervalMs: 240,
};

/** The ASCII tier's spinner in every situation. */
const LINE: SpinnerVariant = {
  frames: ["-", "\\", "|", "/"],
  intervalMs: TICK_MS,
};

/**
 * What Pi's own loader is told once per session: the thinking variant (the line in ASCII), each
 * frame repeated to fill Pi's ticks and coloured as Pi does not colour custom frames. The colour
 * is the theme's at this call, so a later /theme reaches only the editor's own working line.
 */
export function loaderIndicator(paint: Paint): WorkingIndicatorOptions {
  const variant = paint.mode === "ascii" ? LINE : THINKING;
  const held = variant.intervalMs / TICK_MS;
  const accent = paint.theme.colors.accent;
  return {
    frames: variant.frames.flatMap((frame) =>
      Array<string>(held).fill(styled(paint, frame, { fg: accent })),
    ),
    intervalMs: TICK_MS,
  };
}
