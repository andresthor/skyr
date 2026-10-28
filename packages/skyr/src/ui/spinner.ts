/**
 * The working spinner. Pi's loader ticks every 80 ms and is told once per session; the editor
 * picks the glyph from the clock, so every interval is a whole number of ticks.
 */
import type {
  CustomEditor,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import type { Tier } from "./caps.js";
import { type Paint, styled } from "./palette.js";

/** Pi's loader tick; the editor redraws on it, so no frame can be shorter. */
const TICK_MS = 80;

/** What kind of status Pi is showing: the main agent working, retrying, compacting or summarising a branch. */
export type StatusKind = NonNullable<
  Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]
>["kind"];

/** What the spinner shows: the agent's own work, or one of Pi's retry, compaction and branch-summary statuses. */
export type Situation = "thinking" | "retry";

interface SpinnerVariant {
  readonly frames: readonly string[];
  readonly intervalMs: number;
}

/** A star that swells and fades. */
const THINKING: SpinnerVariant = {
  frames: ["·", "✧", "✦", "✦", "✧", "·"],
  intervalMs: 240,
};

const SPARKLE: SpinnerVariant = {
  frames: ["✶", "✸", "✹", "✺", "✹", "✷"],
  intervalMs: 160,
};

/** The ASCII tier's spinner in every situation. */
const LINE: SpinnerVariant = {
  frames: ["-", "\\", "|", "/"],
  intervalMs: TICK_MS,
};

/** A status other than the main agent working is Pi's own: a retry, a compaction or a summary. */
export const situationOf = (kind: StatusKind): Situation =>
  kind === "working" ? "thinking" : "retry";

export function variantFor(situation: Situation, tier: Tier): SpinnerVariant {
  if (tier === "ascii") return LINE;
  return situation === "retry" ? SPARKLE : THINKING;
}

/** The frame `sinceMs` after the indicator appeared; a boundary sits half a tick off Pi's ticks, so a tick that comes less than half a tick early or late shows the same frame. */
export function frameAt(variant: SpinnerVariant, sinceMs: number): string {
  const slot = Math.floor(
    (Math.max(0, sinceMs) + TICK_MS / 2) / variant.intervalMs,
  );
  return variant.frames[slot % variant.frames.length] ?? "";
}

/**
 * What Pi's own loader is told once per session: the thinking variant (the line in ASCII), each
 * frame repeated to fill Pi's ticks and coloured as Pi does not colour custom frames. The colour
 * is the theme's at this call.
 */
export function loaderIndicator(paint: Paint): WorkingIndicatorOptions {
  const variant = variantFor("thinking", paint.mode);
  const held = variant.intervalMs / TICK_MS;
  const accent = paint.theme.colors.accent;
  return {
    frames: variant.frames.flatMap((frame) =>
      Array<string>(held).fill(styled(paint, frame, { fg: accent })),
    ),
    intervalMs: TICK_MS,
  };
}
