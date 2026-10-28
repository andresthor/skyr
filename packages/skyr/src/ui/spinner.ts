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

/** What the spinner shows: what the main agent is doing, or one of Pi's retry, compaction and branch-summary statuses. */
export type Situation = "thinking" | "tool" | "subagents" | "retry";

interface SpinnerVariant {
  readonly frames: readonly string[];
  readonly intervalMs: number;
}

/** A star that swells and fades. */
const THINKING: SpinnerVariant = {
  frames: ["·", "✧", "✦", "✦", "✧", "·"],
  intervalMs: 240,
};

/** Sand filling a glass, while the agent only waits on subagents (cli-spinners `sand`). */
const SAND: SpinnerVariant = {
  // Each frame is one braille cell
  frames: [..."⠁⠂⠄⡀⡈⡐⡠⣀⣁⣂⣄⣌⣔⣤⣥⣦⣮⣶⣷⣿⡿⠿⢟⠟⡛⠛⠫⢋⠋⠍⡉⠉⠑⠡⢁"],
  intervalMs: TICK_MS,
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

/**
 * A status other than the main agent working is retry; no main-agent tool running is thinking;
 * only `subagent` calls running is subagents; any other tool running is tool.
 */
export function situationOf(
  kind: StatusKind,
  tools: readonly string[],
): Situation {
  if (kind !== "working") return "retry";
  if (tools.length === 0) return "thinking";
  return tools.every((name) => name === "subagent") ? "subagents" : "tool";
}

export function variantFor(situation: Situation, tier: Tier): SpinnerVariant {
  if (tier === "ascii") return LINE;
  switch (situation) {
    case "thinking":
      return THINKING;
    case "tool":
      return LINE;
    case "subagents":
      return SAND;
    case "retry":
      return SPARKLE;
  }
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
