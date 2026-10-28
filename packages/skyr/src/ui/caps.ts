/** What the terminal can show: its tier of glyphs and colour, and whether it draws widgets at all (`canDraw`). */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** `mono` is NO_COLOR (glyphs and attributes, no colour), `ascii` is TERM=dumb. */
export type Tier = "color" | "mono" | "ascii";

/**
 * TERM=dumb gets ASCII; NO_COLOR forbids colour, not glyphs or italics, unless FORCE_COLOR overrides it.
 */
export function tierOf(env: NodeJS.ProcessEnv): Tier {
  if (env.TERM === "dumb") return "ascii";
  const forcedOn =
    env.FORCE_COLOR !== undefined &&
    env.FORCE_COLOR !== "0" &&
    env.FORCE_COLOR !== "false";
  return env.NO_COLOR !== undefined && env.NO_COLOR !== "" && !forcedOn
    ? "mono"
    : "color";
}

/** What a row of the bar or the transcript is doing; each has its own glyph, so a state never rests on colour. */
export type Mark =
  | "queued"
  | "running"
  | "failed"
  | "done"
  | "stopped"
  | "mixed";

export interface Glyphs {
  /** What a cut line ends in. */
  readonly ellipsis: string;
  readonly mark: Readonly<Record<Mark, string>>;
  /** Leads a current action. */
  readonly now: string;
  /** Marks something that came back to the transcript from elsewhere. */
  readonly from: string;
  /** Between a question and its answer. */
  readonly to: string;
  /** The left edge of the lines under a record. */
  readonly rail: string;
  /** What leads a child record: one that has siblings after it, and the last one. */
  readonly branch: { readonly mid: string; readonly last: string };
  /** Between the facts of a line, spaces included. */
  readonly sep: string;
  /** A horizontal rule. */
  readonly rule: string;
  /** Marks a sum over time. */
  readonly sum: string;
  /** Tokens sent to the model and received from it. */
  readonly flow: { readonly up: string; readonly down: string };
  /** The cells of a gauge, filled and empty. */
  readonly meter: { readonly on: string; readonly off: string };
}

const UNICODE: Glyphs = {
  ellipsis: "…",
  mark: {
    queued: "□",
    running: "•",
    failed: "×",
    done: "✓",
    stopped: "■",
    mixed: "!",
  },
  now: "›",
  from: "←",
  to: "→",
  rail: "│",
  branch: { mid: "├", last: "└" },
  sep: " · ",
  rule: "─",
  sum: "Σ",
  flow: { up: "↑", down: "↓" },
  meter: { on: "▪", off: "▫" },
};

const ASCII: Glyphs = {
  ellipsis: "...",
  mark: {
    queued: "o",
    running: "*",
    failed: "x",
    done: "+",
    stopped: "#",
    mixed: "!",
  },
  now: ">",
  from: "<-",
  to: "->",
  rail: "|",
  branch: { mid: "|", last: "`" },
  sep: " - ",
  rule: "-",
  sum: "sum",
  flow: { up: "^", down: "v" },
  meter: { on: "#", off: "-" },
};

export const glyphsOf = (tier: Tier): Glyphs =>
  tier === "ascii" ? ASCII : UNICODE;

/**
 * Whether widgets and working indicators can be drawn: the terminal UI only. `ctx.hasUI` is also
 * true in rpc, where component factories are ignored.
 */
export function canDraw(ctx: Pick<ExtensionContext, "mode">): boolean {
  return ctx.mode === "tui";
}
