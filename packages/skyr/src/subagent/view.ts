/**
 * Subagents as lines. Running ones, and failed ones, for the bar; running ones for the `/subagents`
 * listing, sanitized; ended ones
 * for a delivered answer and a call's row, sanitized and left for their rows to cut.
 */
import type { BarRow } from "../chrome/bar.js";
import type { Segment } from "../tools/render.js";
import { glyphsOf, tierOf } from "../ui/caps.js";
import { fitToWidth } from "../ui/fit.js";
import { formatDuration, formatElapsed, formatTokens } from "../ui/format.js";
import { sanitize } from "../ui/text.js";
import {
  count,
  endedWithoutAnswer,
  labelOf,
  progressOf,
  type RunSnapshot,
} from "./store.js";

const LISTING_WIDTH = 100;

/** One line per running child, `<mark> <label> · <progress> · <elapsed> · <id>`; undefined when none. */
export function listingLines(
  runs: readonly RunSnapshot[],
  now: number,
): string[] | undefined {
  if (runs.length === 0) return undefined;
  return runs.map((run) => {
    const mark =
      run.status === "queued"
        ? "○ queued"
        : run.background
          ? "↗ running"
          : "● running";
    const progress = progressOf(run);
    const line = `${mark} ${labelOf(run)}${progress ? ` · ${progress}` : ""} · ${formatElapsed(now - run.startedAt)} · ${run.id.slice(0, 8)}`;
    return fitToWidth(
      sanitize(line),
      LISTING_WIDTH,
      glyphsOf(tierOf(process.env)).ellipsis,
    );
  });
}

/** A live run as a bar row; a run that ended without an answer, as a failed one. */
export function barRow(run: RunSnapshot): BarRow {
  const failed = endedWithoutAnswer(run);
  const now =
    run.status === "queued"
      ? run.behind && `behind ${run.behind}`
      : run.activity === "unknown"
        ? "stalled"
        : run.tool;
  return {
    id: run.id,
    mark: failed ? "failed" : run.status === "queued" ? "queued" : "running",
    label: sanitize(labelOf(run)),
    background: run.background === true,
    ...(now && { now: sanitize(now) }),
    ...(failed && { why: sanitize(run.error ?? "failed") }),
    startedAt: run.startedAt,
  };
}

/** An ended run's mark, by the status the model reads, in the order a call's header counts them. */
const MARKS: Record<"done" | "empty" | "failed" | "stopped", Segment> = {
  done: ["success", "✓"],
  empty: ["error", "✗"],
  failed: ["error", "✗"],
  stopped: ["muted", "■"],
};

/** Stopped, answered, ended without an answer, or failed. */
function outcomeOf(run: RunSnapshot): keyof typeof MARKS {
  if (run.status === "aborted") return "stopped";
  if (run.status !== "done") return "failed";
  return run.error === undefined ? "done" : "empty";
}

const markOf = (run: RunSnapshot): Segment => MARKS[outcomeOf(run)];

/**
 * One ended run, `<mark> <label> · <error> · <turns> · <tools> · <tokens> · <time> · <id>`. A
 * recovered run has no counters or start time, so it says so in their place.
 */
export function laneLine(run: RunSnapshot): Segment[] {
  const recovered = run.recovered || run.startedAt === 0;
  const cells = [
    labelOf(run),
    run.error,
    ...(recovered
      ? ["recovered after a restart"]
      : [count(run.turns, "turn"), count(run.toolCalls, "tool")]),
    formatTokens(run.tokens),
    !recovered &&
      run.endedAt !== undefined &&
      formatDuration(run.endedAt - run.startedAt),
    run.id.slice(0, 8),
  ];
  return [
    markOf(run),
    ["text", ` ${sanitize(cells.filter(Boolean).join(" · "))}`],
  ];
}

/**
 * A call's ended runs as rows: a header, then one line per run in call order, each a `laneLine`.
 * The header's mark is the runs' shared one, or ◐ for a mix. A background call's runs had only
 * started, so they show as such, with their ids.
 */
export function laneTree(runs: readonly RunSnapshot[]): Segment[][] {
  const branch = (i: number): Segment => [
    "muted",
    i === runs.length - 1 ? "└ " : "├ ",
  ];
  if (runs.some((run) => run.background))
    return [
      [
        ["accent", `↗ ${count(runs.length, "task")} in the background`],
        ["muted", " · answers arrive as messages"],
      ],
      ...runs.map((run, i): Segment[] => [
        branch(i),
        ["accent", "↗"],
        ["text", ` ${sanitize(`${labelOf(run)} · ${run.id.slice(0, 8)}`)}`],
      ]),
    ];
  const outcomes = runs.map(outcomeOf);
  const counts = Object.keys(MARKS).flatMap((outcome) => {
    const n = outcomes.filter((o) => o === outcome).length;
    return n > 0 ? [`${n} ${outcome}`] : [];
  });
  const [first, ...rest] = runs.map(markOf);
  const mark: Segment =
    first !== undefined && rest.every(([, glyph]) => glyph === first[1])
      ? first
      : ["warning", "◐"];
  const total = runs.reduce((sum, run) => sum + run.tokens, 0);
  const wall =
    Math.max(...runs.map((run) => run.endedAt ?? run.startedAt)) -
    Math.min(...runs.map((run) => run.startedAt));
  return [
    [
      mark,
      [
        "muted",
        ` ${counts.join(", ")} · ${formatTokens(total)} · ${formatDuration(wall)}`,
      ],
    ],
    ...runs.map((run, i): Segment[] => [branch(i), ...laneLine(run)]),
  ];
}
