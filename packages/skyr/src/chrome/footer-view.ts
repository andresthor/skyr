/**
 * The footer as lines: pure, handed its facts and the pane, drawing nothing wider than the pane.
 * A line that does not fit gives up its groups one step at a time, in the order its ladder lists.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { glyphsOf } from "../ui/caps.js";
import { fitToWidth } from "../ui/fit.js";
import { type Paint, styled } from "../ui/palette.js";
import { sanitize, sanitizeStyled } from "../ui/text.js";

/** What the footer shows, every string already sanitized by its source. */
export interface FooterFacts {
  readonly cwd: string;
  readonly branch?: string;
  readonly sessionName?: string;
}

type Ink = keyof Paint["theme"]["colors"];

/**
 * The first drawing of a line that fits `room`, as `steps` take groups away in order; the last
 * drawing when none fits, for the caller to cut.
 */
function degrade<S>(
  start: S,
  steps: readonly ((state: S) => S)[],
  draw: (state: S) => string,
  room: number,
): string {
  let state = start;
  let line = draw(state);
  for (const step of steps) {
    if (visibleWidth(line) <= room) break;
    state = step(state);
    line = draw(state);
  }
  return line;
}

interface Where {
  name: boolean;
  branch: boolean;
}

const WHERE_STEPS: readonly ((state: Where) => Where)[] = [
  (state) => ({ ...state, name: false }),
  (state) => ({ ...state, branch: false }),
];

/**
 * The extension statuses on one line, sorted by key with `localeCompare` as Pi's footer lists
 * them; colour stays in the `color` tier, and every other sequence goes in all of them. "" when
 * there are none.
 */
export function statusesLine(
  statuses: ReadonlyMap<string, string>,
  mode: Paint["mode"],
): string {
  const clean = mode === "color" ? sanitizeStyled : sanitize;
  return [...statuses]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => clean(text).trim())
    .filter((text) => text !== "")
    .join(" ");
}

/**
 * The footer's lines for a pane of `width` columns: the line of where the session is, then the
 * statuses line when `statuses` has any. Each is padded by one column and fits the pane.
 */
export function footerLines(
  facts: FooterFacts,
  statuses: string,
  paint: Paint,
  width: number,
): string[] {
  const { colors } = paint.theme;
  const glyphs = glyphsOf(paint.mode);
  const ink = (text: string, fg: Ink) =>
    styled(paint, text, { fg: colors[fg] });
  const room = width - 1;
  const row = (line: string) =>
    room <= 0 ? "" : ` ${fitToWidth(line, room, glyphs.ellipsis)}`;

  const where = degrade<Where>(
    { name: true, branch: true },
    WHERE_STEPS,
    (show) => {
      const parts = [ink(facts.cwd, "muted")];
      if (show.branch && facts.branch)
        parts.push(ink(`(${facts.branch})`, "accent"));
      const place = parts.join(" ");
      return show.name && facts.sessionName
        ? `${place} ${ink(glyphs.mark.running, "dim")} ${ink(facts.sessionName, "muted")}`
        : place;
    },
    room,
  );
  return [row(where), ...(statuses === "" ? [] : [row(statuses)])];
}
