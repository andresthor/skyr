/**
 * The bar as lines: a pulse while anything runs or a failure is unseen. Pure: it is handed what
 * to draw and when it is, and no line it returns is wider than the pane.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { glyphsOf, type Mark } from "../ui/caps.js";
import { fitToWidth } from "../ui/fit.js";
import { formatElapsed } from "../ui/format.js";
import { keyLabel } from "../ui/hint.js";
import { type Paint, styled } from "../ui/palette.js";
import type { BarRow, BarTab } from "./bar.js";

/** A background run that failed, and whether the user has opened the bar on it. */
export interface FailedRow {
  readonly row: BarRow;
  readonly seen: boolean;
}

export interface BarView {
  readonly agents: readonly BarRow[];
  readonly shells: readonly BarRow[];
  /** Oldest first. */
  readonly failed: readonly FailedRow[];
}

const NOUN: Record<BarTab, string> = { agents: "agent", shells: "shell" };
const MARK_TOKEN = {
  queued: "dim",
  running: "accent",
  failed: "error",
} as const;
const MAX_PIPS = 8;
/** The least a lead may be cut to; below it the lead goes. */
const MIN_LEAD = 8;
/** The least of a failure's label worth showing beside its reason. */
const MIN_LABEL = 4;

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

/** What the bar draws for `view`: nothing at rest, else the pulse and the bar's own trailing blank. */
export function barLines(
  view: BarView,
  paint: Paint,
  width: number,
  now: number,
): string[] {
  const unseen = view.failed.filter((f) => !f.seen);
  if (view.agents.length + view.shells.length + unseen.length === 0) return [];
  return [
    fitToWidth(
      pulse(view, unseen, paint, width, now),
      width,
      glyphsOf(paint.mode).ellipsis,
    ),
    "",
  ];
}

/** Which parts of the pulse are drawn; the pane's width takes them away in this order. */
interface Parts {
  lead: boolean;
  groups: boolean;
  pips: boolean;
  elapsed: boolean;
  hint: boolean;
}

const FULL: Parts = {
  lead: true,
  groups: true,
  pips: true,
  elapsed: true,
  hint: true,
};

/** The lead is the first to go for an action, and the last for a failure. */
const ACTION_DROPS: readonly Parts[] = [
  FULL,
  { ...FULL, lead: false },
  { ...FULL, lead: false, pips: false },
  { ...FULL, lead: false, pips: false, elapsed: false },
  { ...FULL, lead: false, pips: false, elapsed: false, hint: false },
];
const FAILURE_DROPS: readonly Parts[] = [
  FULL,
  { ...FULL, pips: false },
  { ...FULL, pips: false, elapsed: false },
  { ...FULL, pips: false, elapsed: false, hint: false },
  { ...FULL, pips: false, elapsed: false, hint: false, groups: false },
];

/**
 * ```
 * 3 agents • • □   1 shell •   › read                       1m04s  alt+a
 * × "Data review" · 429 rate limited · unseen  +1   3 agents • •  1m04s  alt+a
 * ```
 * A group per tab with live rows, a lead (the newest agent action, or the newest unseen failure,
 * which comes first), then the oldest row's elapsed time and the key that opens the bar.
 */
function pulse(
  view: BarView,
  unseen: readonly FailedRow[],
  paint: Paint,
  width: number,
  now: number,
): string {
  const { colors } = paint.theme;
  const glyphs = glyphsOf(paint.mode);
  const ink = (text: string, fg: keyof typeof colors, bold = false): Piece => ({
    out: styled(paint, text, { fg: colors[fg], bold }),
    cols: visibleWidth(text),
  });
  const pip = (mark: Mark) => ink(glyphs.mark[mark], MARK_TOKEN[mark]);
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

  const live = [...view.agents, ...view.shells];
  const oldest = Math.min(...live.map((row) => row.startedAt));
  const failure = unseen.at(-1)?.row;
  const action = view.agents.filter((row) => row.now !== undefined).at(-1)?.now;

  /** The lead cut to `room` columns, or undefined when it would be cut past use. */
  const leadIn = (room: number): Piece | undefined => {
    if (failure) {
      const mark = ink(`${glyphs.mark.failed} `, "error");
      const reason = [
        ink(glyphs.sep, "muted"),
        ink(failure.why ?? "failed", "error", true),
        ink(`${glyphs.sep}unseen`, "muted"),
        ...(unseen.length > 1 ? [ink(`  +${unseen.length - 1}`, "muted")] : []),
      ];
      const label = room - join([mark, ...reason]).cols;
      if (label < MIN_LABEL) return undefined;
      return join([
        mark,
        ink(fitToWidth(failure.label, label, glyphs.ellipsis), "text"),
        ...reason,
      ]);
    }
    if (action === undefined || room < MIN_LEAD) return undefined;
    const prefix = `${glyphs.now} `;
    return join([
      ink(prefix, "accent"),
      ink(
        fitToWidth(action, room - visibleWidth(prefix), glyphs.ellipsis),
        "muted",
      ),
    ]);
  };

  const compose = (parts: Parts): Piece | undefined => {
    const left = parts.groups ? groups(parts.pips) : gap(0);
    const right = join(
      [
        ...(parts.elapsed && live.length > 0
          ? [ink(formatElapsed(now - oldest), "muted")]
          : []),
        ...(parts.hint ? [ink(keyLabel("alt+a"), "muted")] : []),
      ],
      2,
    );
    const reserved = right.cols > 0 ? right.cols + 2 : 0;
    const between = left.cols > 0 ? space : 0;
    const wanted =
      parts.lead && (failure !== undefined || action !== undefined);
    const lead = wanted
      ? leadIn(inner - left.cols - between - reserved)
      : undefined;
    if (wanted && !lead) return undefined;
    const used = left.cols + (lead ? between + lead.cols : 0);
    if (used + reserved > inner) return undefined;
    const sides = failure
      ? [...(lead ? [lead, gap(between)] : []), left]
      : [left, ...(lead ? [gap(between), lead] : [])];
    return join([
      gap(1),
      ...sides,
      ...(right.cols > 0
        ? [gap(inner - used - right.cols), right, gap(1)]
        : []),
    ]);
  };

  for (const parts of failure ? FAILURE_DROPS : ACTION_DROPS) {
    const line = compose(parts);
    if (line) return line.out;
  }
  return join([gap(1), failure ? (leadIn(Infinity) ?? gap(0)) : groups(false)])
    .out;
}
