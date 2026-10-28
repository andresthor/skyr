/**
 * The bar as lines: a pulse while anything runs. Pure: it is handed what to draw and when it is,
 * and no line it returns is wider than the pane.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { glyphsOf, type Mark } from "../ui/caps.js";
import { fitToWidth } from "../ui/fit.js";
import { formatElapsed } from "../ui/format.js";
import { keyLabel } from "../ui/hint.js";
import { type Paint, styled } from "../ui/palette.js";
import type { BarRow, BarTab } from "./bar.js";

export interface BarView {
  readonly agents: readonly BarRow[];
  readonly shells: readonly BarRow[];
}

const NOUN: Record<BarTab, string> = { agents: "agent", shells: "shell" };
const MARK_TOKEN = {
  queued: "dim",
  running: "accent",
  failed: "error",
} as const;
const MAX_PIPS = 8;
const MIN_LEAD = 8;

/** Text already styled, and the columns it takes. */
interface Piece {
  out: string;
  cols: number;
}

const gap = (cols: number): Piece => ({ out: " ".repeat(cols), cols });

function join(pieces: readonly Piece[], between = 0): Piece {
  return {
    out: pieces.map((p) => p.out).join(" ".repeat(between)),
    cols:
      pieces.reduce((sum, p) => sum + p.cols, 0) +
      between * Math.max(0, pieces.length - 1),
  };
}

/**
 * What the bar draws for `view`: nothing at rest, else the pulse and the bar's own trailing blank.
 */
export function barLines(
  view: BarView,
  paint: Paint,
  width: number,
  now: number,
): string[] {
  if (view.agents.length + view.shells.length === 0) return [];
  return [
    fitToWidth(
      pulse(view, paint, width, now),
      width,
      glyphsOf(paint.mode).ellipsis,
    ),
    "",
  ];
}

/** Which parts of the pulse are drawn; the pane's width takes them away in this order. */
interface Parts {
  lead: boolean;
  pips: boolean;
  elapsed: boolean;
  hint: boolean;
}

const DROPS: readonly Parts[] = [
  { lead: true, pips: true, elapsed: true, hint: true },
  { lead: false, pips: true, elapsed: true, hint: true },
  { lead: false, pips: false, elapsed: true, hint: true },
  { lead: false, pips: false, elapsed: false, hint: true },
  { lead: false, pips: false, elapsed: false, hint: false },
];

/**
 * `3 agents • • □   1 shell •   › read        1m04s  alt+a`: a group per tab with live rows, the
 * newest agent action, then the oldest row's elapsed time and the key that opens the bar.
 */
function pulse(
  view: BarView,
  paint: Paint,
  width: number,
  now: number,
): string {
  const { colors } = paint.theme;
  const ink = (text: string, fg: keyof typeof colors, bold = false): Piece => ({
    out: styled(paint, text, { fg: colors[fg], bold }),
    cols: visibleWidth(text),
  });
  const glyphs = glyphsOf(paint.mode);
  const space = width < 100 ? 2 : 3;
  const inner = width - 2;

  const groups = (pips: boolean) =>
    join(
      (["agents", "shells"] as const).flatMap((tab) => {
        const rows = view[tab];
        if (rows.length === 0) return [];
        const title = `${rows.length} ${NOUN[tab]}${rows.length === 1 ? "" : "s"}`;
        const shown = rows.slice(0, MAX_PIPS).map((row) => pip(row.mark));
        const more =
          rows.length > MAX_PIPS
            ? [ink(`+${rows.length - MAX_PIPS}`, "muted")]
            : [];
        return [
          join(
            [ink(title, "text", true), ...(pips ? [...shown, ...more] : [])],
            1,
          ),
        ];
      }),
      space,
    );
  const pip = (mark: Mark) => ink(glyphs.mark[mark], MARK_TOKEN[mark]);

  const live = [...view.agents, ...view.shells];
  const oldest = Math.min(...live.map((row) => row.startedAt));
  const action = view.agents.filter((row) => row.now !== undefined).at(-1)?.now;

  const compose = (parts: Parts): Piece | undefined => {
    const left = groups(parts.pips);
    const right = join(
      [
        ...(parts.elapsed ? [ink(formatElapsed(now - oldest), "muted")] : []),
        ...(parts.hint ? [ink(keyLabel("alt+a"), "muted")] : []),
      ],
      2,
    );
    const reserved = right.cols > 0 ? right.cols + 2 : 0;
    let lead: Piece | undefined;
    if (parts.lead && action !== undefined) {
      const room = inner - left.cols - space - reserved;
      if (room < MIN_LEAD) return undefined;
      const prefix = `${glyphs.now} `;
      lead = join([
        ink(prefix, "accent"),
        ink(
          fitToWidth(action, room - visibleWidth(prefix), glyphs.ellipsis),
          "muted",
        ),
      ]);
    }
    const used = left.cols + (lead ? space + lead.cols : 0);
    if (used + reserved > inner) return undefined;
    return join([
      gap(1),
      left,
      ...(lead ? [gap(space), lead] : []),
      ...(right.cols > 0
        ? [gap(inner - used - right.cols), right, gap(1)]
        : []),
    ]);
  };

  for (const parts of DROPS) {
    const line = compose(parts);
    if (line) return line.out;
  }
  return join([gap(1), groups(false)]).out;
}
