/**
 * Subagents as lines. Running ones, and failed ones, for the bar; running ones for the `/subagents`
 * listing, sanitized; ended ones as ledger records, for a call's row and a delivered answer.
 */
import type { BarRow } from "../chrome/bar.js";
import { glyphsOf, type Mark, tierOf } from "../ui/caps.js";
import { fitToWidth } from "../ui/fit.js";
import {
  formatDuration,
  formatElapsed,
  formatTokens,
  plural,
} from "../ui/format.js";
import type { Fact, RecordSpec } from "../ui/record.js";
import type { Row } from "../ui/row.js";
import { sanitize, sanitizeBlock } from "../ui/text.js";
import {
  endedWithoutAnswer,
  labelOf,
  progressOf,
  type RunSnapshot,
} from "./store.js";

const LISTING_WIDTH = 100;

/** One line per running child, `<mark> <state> <label> · <progress> · <elapsed> · <id>` with the tier's mark and separator; undefined when none. */
export function listingLines(
  runs: readonly RunSnapshot[],
  now: number,
): string[] | undefined {
  if (runs.length === 0) return undefined;
  const { mark, sep, ellipsis } = glyphsOf(tierOf(process.env));
  return runs.map((run) => {
    // The background flag leads, since the width may cut the label
    const state =
      run.status === "queued"
        ? `${mark.queued} queued`
        : `${mark.running} running${run.background ? " &" : ""}`;
    const progress = progressOf(run);
    const line = [
      `${state} ${labelOf(run)}`,
      ...(progress ? [progress] : []),
      formatElapsed(now - run.startedAt),
      run.id.slice(0, 8),
    ].join(sep);
    return fitToWidth(sanitize(line), LISTING_WIDTH, ellipsis);
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
    turns: run.turns,
    tools: run.toolCalls,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
  };
}

/** An ended run's mark, by the status the model reads, in the order a call's header counts them. */
const OUTCOME_MARK = {
  done: "done",
  empty: "failed",
  failed: "failed",
  stopped: "stopped",
} as const satisfies Record<string, Mark>;

/** Stopped, answered, ended without an answer, or failed. */
function outcomeOf(run: RunSnapshot): keyof typeof OUTCOME_MARK {
  if (run.status === "aborted") return "stopped";
  if (run.status !== "done") return "failed";
  return run.error === undefined ? "done" : "empty";
}

/** The 8 characters of a run's id that a record, a frame and a lookup share. */
export const idOf = (run: RunSnapshot) => sanitize(run.id.slice(0, 8));

/** A recovered run has no counters or start time. */
const recoveredRun = (run: RunSnapshot) => run.recovered || run.startedAt === 0;

/**
 * One ended run as a ledger record: its label, why it gave no answer if it gave none, its
 * counters, tokens and time, and its id. A recovered run says so in place of counters and time.
 */
export function laneRecord(
  run: RunSnapshot,
  branch?: RecordSpec["branch"],
): RecordSpec {
  const recovered = recoveredRun(run);
  const facts: Fact[] = [
    ...(run.error ? [fact(run.error, "explain")] : []),
    ...(recovered
      ? [fact("recovered after a restart", "measure")]
      : [
          fact(plural(run.turns, "turn"), "measure"),
          fact(plural(run.toolCalls, "tool"), "measure"),
        ]),
    fact(formatTokens(run.tokens), "measure"),
    ...(!recovered && run.endedAt !== undefined
      ? [fact(formatDuration(run.endedAt - run.startedAt), "measure")]
      : []),
  ];
  return {
    mark: OUTCOME_MARK[outcomeOf(run)],
    ...(branch && { branch }),
    subject: [sanitize(labelOf(run))],
    subjectKind: "text",
    facts,
    handle: idOf(run),
  };
}

/** A call's ended runs as the head of its lane tree: the shared mark or `mixed`, and the totals. */
export function headRecord(runs: readonly RunSnapshot[]): RecordSpec {
  const outcomes = runs.map(outcomeOf);
  const counts = Object.keys(OUTCOME_MARK).flatMap((outcome) => {
    const n = outcomes.filter((o) => o === outcome).length;
    return n > 0 ? [`${n} ${outcome}`] : [];
  });
  const marks = new Set(outcomes.map((o) => OUTCOME_MARK[o]));
  const [only] = marks;
  const agents = [...new Set(runs.flatMap((run) => run.agent ?? []))];
  const tokens = runs.reduce((sum, run) => sum + run.tokens, 0);
  const wall = runs.some(recoveredRun)
    ? undefined
    : Math.max(...runs.map((run) => run.endedAt ?? run.startedAt)) -
      Math.min(...runs.map((run) => run.startedAt));
  return {
    mark: marks.size === 1 && only ? only : "mixed",
    subject: [plural(runs.length, "lane")],
    subjectKind: "text",
    facts: [
      ...(agents.length > 0
        ? [fact(sanitize(agents.join(", ")), "extra")]
        : []),
      ...counts.map((count) => fact(count, "explain")),
      fact(formatTokens(tokens), "measure"),
      ...(wall === undefined ? [] : [fact(formatDuration(wall), "measure")]),
    ],
  };
}

/** A background run as the call that started it shows it: queued or running, with its id. */
export function startedRecord(
  run: RunSnapshot,
  branch?: RecordSpec["branch"],
): RecordSpec {
  return {
    mark: run.status === "queued" ? "queued" : "running",
    ...(branch && { branch }),
    subject: [sanitize(labelOf(run))],
    subjectKind: "text",
    facts: [],
    handle: idOf(run),
  };
}

const fact = (text: string, kind: Fact["kind"]): Fact => ({
  text: sanitize(text),
  kind,
});

/**
 * A delivered answer as the record of the run that gave it: its lane, `← delivered`, and under it
 * the answer, which is shown only for a run that gave one. Delivery explains the mark of a run
 * that answered and is decoration on one that did not, where its reason comes first.
 */
export function deliveredRecord(
  run: RunSnapshot,
  body: string | undefined,
): Row {
  const { from } = glyphsOf(tierOf(process.env));
  const lane = laneRecord(run);
  const answered = outcomeOf(run) === "done";
  return {
    head: {
      ...lane,
      verb: "agent",
      background: true,
      facts: [
        {
          text: `${from} delivered`,
          kind: answered ? "explain" : "extra",
          accent: true,
        },
        ...lane.facts,
      ],
    },
    ...(answered && body
      ? {
          rail: {
            lines: sanitizeBlock(body).split("\n"),
            collapsed: 2,
            ink: "markdown" as const,
          },
        }
      : {}),
  };
}
