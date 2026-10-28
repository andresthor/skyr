/** What the terminal can show: its tier of glyphs and colour, and whether it draws widgets at all (`canDraw`). */

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
