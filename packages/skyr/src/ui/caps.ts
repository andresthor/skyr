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

/** What a row of the bar is doing; each has its own glyph, so a state never rests on colour. */
export type Mark = "queued" | "running" | "failed";

export interface Glyphs {
  /** What a cut line ends in. */
  readonly ellipsis: string;
  readonly mark: Readonly<Record<Mark, string>>;
  /** Leads a current action. */
  readonly now: string;
  /** Between the facts of a line, spaces included. */
  readonly sep: string;
}

const UNICODE: Glyphs = {
  ellipsis: "…",
  mark: { queued: "□", running: "•", failed: "×" },
  now: "›",
  sep: " · ",
};

const ASCII: Glyphs = {
  ellipsis: "...",
  mark: { queued: "o", running: "*", failed: "x" },
  now: ">",
  sep: " - ",
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
