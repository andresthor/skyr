/**
 * The bar as lines: a pulse while anything runs or a failure is unseen, and one tab of rows when
 * opened. Pure: it is handed what to draw and when it is, and no line it returns is wider than
 * the pane.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { glyphsOf, type Mark, tierOf } from "../ui/caps.js";
import { fitToWidth } from "../ui/fit.js";
import { formatDuration, formatElapsed, plural } from "../ui/format.js";
import { keyLabel } from "../ui/hint.js";
import { markToken, type Paint, selected, styled } from "../ui/palette.js";
import type { BarRow, BarTab } from "./bar.js";

/** The bar's shortcuts, named once for the hint that shows them and the registration that binds them. */
export const BAR_KEYS = { toggle: "alt+a", switchTab: "alt+s" } as const;

/** A background run that failed, and whether the user has opened the bar on it. */
export interface FailedRow {
  readonly row: BarRow;
  readonly tab: BarTab;
  readonly seen: boolean;
}

export interface BarView {
  readonly open: boolean;
  readonly tab: BarTab;
  readonly agents: readonly BarRow[];
  readonly shells: readonly BarRow[];
  /** Oldest first. */
  readonly failed: readonly FailedRow[];
  /** Per tab, by row id, for live and listed failed rows: the smallest free number from 1. */
  readonly slots: Readonly<Record<BarTab, ReadonlyMap<string, number>>>;
  /** The id of the highlighted row of `tab`; undefined draws no highlight. */
  readonly focused: string | undefined;
  /** Where the open tab's window of rows started last: kept while the highlight stays inside it. */
  readonly top: number;
}

/** The rows the open tab lists, in the order it lists them: failed rows first, then live rows oldest first. */
export function tabRows(
  view: Pick<BarView, "agents" | "shells" | "failed">,
  tab: BarTab,
): readonly BarRow[] {
  return [
    ...view.failed.filter((f) => f.tab === tab).map((f) => f.row),
    ...view[tab],
  ];
}

const NOUN: Record<BarTab, string> = { agents: "agent", shells: "shell" };
const MAX_PIPS = 8;
/** The terminal rows the bar leaves to everything else: transcript, working line, editor, footer. */
const RESERVED_ROWS = 7;
/** The header and the bar's own trailing blank line. */
const FRAME_LINES = 2;
/** The fewest body lines worth opening the tab for; below them the listing goes in a notice. */
const MIN_BODY = 3;
const MIN_WIDTH = 44;
const MAX_ROWS = 8;
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

/** `text` in a theme colour, as a piece. */
const inkOf =
  (paint: Paint) =>
  (text: string, fg: keyof Paint["theme"]["colors"], bold = false): Piece => ({
    out: styled(paint, text, { fg: paint.theme.colors[fg], bold }),
    cols: visibleWidth(text),
  });

function join(pieces: readonly Piece[], between = 0): Piece {
  return {
    out: pieces.map((p) => p.out).join(" ".repeat(between)),
    cols:
      pieces.reduce((sum, p) => sum + p.cols, 0) +
      between * Math.max(0, pieces.length - 1),
  };
}

/**
 * What the bar draws for `view`: nothing at rest; the pulse, closed or when the terminal is too
 * short or narrow for the tab (`tabBody`); else the open tab's header and as many rows as fit.
 * Each ends in the bar's own blank line.
 */
export function barLines(
  view: BarView,
  paint: Paint,
  width: number,
  termRows: number,
  now: number,
): string[] {
  const unseen = view.failed.filter((f) => !f.seen);
  const body = tabBody(termRows, width);
  if (view.open && body !== undefined)
    return [...tabLines(view, paint, width, body, now), ""];
  if (!view.open && atRest(view, unseen)) return [];
  return [
    fitToWidth(
      pulse(view, unseen, paint, width, now),
      width,
      glyphsOf(paint.mode).ellipsis,
    ),
    "",
  ];
}

const atRest = (view: BarView, unseen: readonly FailedRow[]) =>
  view.agents.length + view.shells.length + unseen.length === 0;

/**
 * How many lines an open tab may draw below its header on a pane of `width` columns in a
 * terminal of `termRows`, or undefined when it has no room to list at all. The one answer to
 * whether the tab fits, so the bar's keys and its drawing cannot disagree.
 */
export function tabBody(termRows: number, width: number): number | undefined {
  const body = Math.min(MAX_ROWS, termRows - RESERVED_ROWS - FRAME_LINES);
  return width >= MIN_WIDTH && body >= MIN_BODY ? body : undefined;
}

/** How many rows a window shows in `body` lines: all of them, or all but one line for the "+N more". */
export const windowSize = (count: number, body: number) =>
  count > body ? body - 1 : count;

/**
 * Where a window of `size` rows over `count` starts: `top` kept while `at` (the highlighted
 * index, or -1) is inside it, else moved just far enough to show it.
 */
export function windowStart(
  top: number,
  at: number,
  size: number,
  count: number,
): number {
  const start = Math.min(Math.max(top, 0), Math.max(count - size, 0));
  if (at < 0) return start;
  if (at < start) return at;
  return at >= start + size ? at - size + 1 : start;
}

/** One line per row for a notice, where the bar cannot list them: slot, mark, label, what it does or why it failed, id. */
export function noticeLines(
  rows: readonly BarRow[],
  tab: BarTab,
  slots: ReadonlyMap<string, number>,
): string[] {
  const { mark, sep } = glyphsOf(tierOf(process.env));
  const prefix = tab === "shells" ? "$" : "";
  return rows.map((row) =>
    [
      `${prefix}${slots.get(row.id) ?? "?"} ${mark[row.mark]} ${row.label}${row.background ? " &" : ""}`,
      ...(row.mark === "failed"
        ? [row.why ?? "failed"]
        : row.now
          ? [row.now]
          : []),
      row.id.slice(0, 8),
    ].join(sep),
  );
}

/** `<mark> <label> · <why> · <id>`, in the tier's glyphs: a failed row for a notice, where the bar cannot list it. */
export function failureLine(row: BarRow): string {
  const { mark, sep } = glyphsOf(tierOf(process.env));
  return [
    `${mark.failed} ${row.label}`,
    row.why ?? "failed",
    row.id.slice(0, 8),
  ].join(sep);
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
  const glyphs = glyphsOf(paint.mode);
  const ink = inkOf(paint);
  const pip = (mark: Mark) => ink(glyphs.mark[mark], markToken[mark]);
  const space = width < 100 ? 2 : 3;
  const inner = width - 2;

  const idle = atRest(view, unseen);
  const groups = (pips: boolean) =>
    idle
      ? ink("nothing running", "muted")
      : join(
          (["agents", "shells"] as const).flatMap((tab) => {
            const rows = view[tab];
            if (rows.length === 0) return [];
            const title = plural(rows.length, NOUN[tab]);
            const shown = rows.slice(0, MAX_PIPS).map((row) => pip(row.mark));
            const more =
              rows.length > MAX_PIPS
                ? [ink(`+${rows.length - MAX_PIPS}`, "muted")]
                : [];
            return [
              join(
                [
                  ink(title, "text", true),
                  ...(pips ? [...shown, ...more] : []),
                ],
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
        ...(parts.hint ? [ink(keyLabel(BAR_KEYS.toggle), "muted")] : []),
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

/** Which columns a pane of `width` columns has room for, and how wide the label is. */
function columnsOf(width: number) {
  return {
    label: width >= 100 ? 24 : width >= 60 ? 18 : 12,
    turns: width >= 80,
    tools: width >= 100,
    id: width >= 110,
  };
}

/**
 * The open tab: a header, then its rows on a grid whose columns line up on every row.
 * ```
 *  AGENTS 3  SHELLS 2                                   alt+s switch · alt+a close
 *  • 1  "Correctness review"  › bash                6 turns   9 tools   1m12s  a1f3e0d2
 * ```
 * Failed rows come first, then live rows oldest first.
 */
function tabLines(
  view: BarView,
  paint: Paint,
  width: number,
  body: number,
  now: number,
): string[] {
  const glyphs = glyphsOf(paint.mode);
  const ink = inkOf(paint);
  /** `text` cut to `cols` columns and padded to them, or padded on the left when `right`. */
  const cell = (text: string, cols: number, right = false): string => {
    const cut = fitToWidth(text, cols, glyphs.ellipsis);
    const fill = " ".repeat(Math.max(0, cols - visibleWidth(cut)));
    return right ? fill + cut : cut + fill;
  };
  const columns = columnsOf(width);

  const rowsOf = (tab: BarTab) => tabRows(view, tab);
  const header = (): string => {
    const pill = (tab: BarTab, title: string): Piece => {
      const text = `${title} ${rowsOf(tab).length}`;
      if (tab !== view.tab) return ink(` ${text} `, "muted");
      return {
        out: selected(paint, ` ${text} `, `[${text}]`),
        cols: visibleWidth(text) + 2,
      };
    };
    const tabs = join([pill("agents", "AGENTS"), pill("shells", "SHELLS")], 2);
    const keys = join([
      ink(keyLabel(BAR_KEYS.switchTab), "muted"),
      ink(" switch", "dim"),
      ink(glyphs.sep, "dim"),
      ink(keyLabel(BAR_KEYS.toggle), "muted"),
      ink(" close", "dim"),
    ]);
    const room = width - 2 - tabs.cols;
    const right = keys.cols + 2 <= room;
    return join([
      gap(1),
      tabs,
      ...(right ? [gap(room - keys.cols), keys, gap(1)] : []),
    ]).out;
  };

  /** Text with no style: a highlighted row is styled whole, so its parts carry none of their own. */
  const bare = (text: string): Piece => ({
    out: text,
    cols: visibleWidth(text),
  });

  const label = columns.label + 2;
  /** A row opens with the pip, its mark, the slot and the label; a lead starts where they end. */
  const rowLeft = (put: typeof ink, r: BarRow, slotOf: string): Piece =>
    join([
      gap(1),
      put(glyphs.mark[r.mark], markToken[r.mark]),
      gap(1),
      put(cell(slotOf, 2), "accent"),
      gap(1),
      put(cell(r.label + (r.background ? " &" : ""), label), "text"),
      gap(2),
    ]);

  const row = (r: BarRow, slotOf: string, focused: boolean): string => {
    const put: typeof ink = focused ? (text) => bare(text) : ink;
    const left = rowLeft(put, r, slotOf);
    const time =
      r.endedAt === undefined
        ? formatElapsed(now - r.startedAt)
        : formatDuration(r.endedAt - r.startedAt);
    const right = join([
      ...(columns.turns
        ? [
            gap(2),
            put(
              cell(
                r.turns === undefined ? "" : plural(r.turns, "turn"),
                8,
                true,
              ),
              "muted",
            ),
          ]
        : []),
      ...(columns.tools
        ? [
            gap(2),
            put(
              cell(
                r.tools === undefined ? "" : plural(r.tools, "tool"),
                8,
                true,
              ),
              "muted",
            ),
          ]
        : []),
      gap(2),
      put(cell(time, 6, true), "muted"),
      ...(columns.id
        ? [gap(2), put(cell(r.id.slice(0, 8), 8, true), "dim")]
        : []),
      gap(1),
    ]);
    const room = width - left.cols - right.cols;
    // Cut as plain text, then inked: a cut styled string would leave its closing codes behind
    const cut = (text: string, space: number) =>
      fitToWidth(text, space, glyphs.ellipsis);
    const what: Piece =
      r.mark === "failed"
        ? put(cut(r.why ?? "failed", room), "error", true)
        : r.now === undefined
          ? gap(0)
          : join([
              put(`${glyphs.now} `, "accent"),
              put(cut(r.now, room - visibleWidth(glyphs.now) - 1), "text"),
            ]);
    // Under four columns the cell is blank, so time and id still line up
    const shown =
      room < 4
        ? " ".repeat(Math.max(0, room))
        : what.out + " ".repeat(Math.max(0, room - what.cols));
    const line = left.out + shown + right.out;
    if (!focused) return line;
    // ascii has no styles, so its highlight is a marker in the pad column
    return selected(paint, line, `>${line.slice(1)}`);
  };

  const entries = rowsOf(view.tab);
  const size = windowSize(entries.length, body);
  const start = windowStart(
    view.top,
    entries.findIndex((r) => r.id === view.focused),
    size,
    entries.length,
  );
  const shown = entries.slice(start, start + size);
  const slotOf = (r: BarRow) =>
    `${view.tab === "shells" ? "$" : ""}${view.slots[view.tab].get(r.id) ?? ""}`;
  const hidden = entries.length - shown.length;
  const [first] = shown;
  // The "+N more" line starts where a row's lead does: the first shown row gives the column
  const more =
    hidden > 0 && first !== undefined
      ? " ".repeat(rowLeft(ink, first, slotOf(first)).cols) +
        ink(`+${hidden} more`, "dim").out
      : undefined;
  // The count sits on the side where rows are hidden; below wins when both sides hide some
  const hiddenBelow = start + size < entries.length;
  return [
    header(),
    ...(more && !hiddenBelow ? [more] : []),
    ...shown.map((r) => row(r, slotOf(r), r.id === view.focused)),
    ...(more && hiddenBelow ? [more] : []),
    ...(entries.length === 0 ? [` ${ink("nothing running", "dim").out}`] : []),
  ];
}
