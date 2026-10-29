/** The ledger row of Pi's `bash`, and of the job skyr's `bash` moves to the background. */
import { isShellSnapshot, titleOf } from "../../shells/store.js";
import { shellRow } from "../../shells/view.js";
import type { Fact } from "../../ui/record.js";
import {
  durationFact,
  failedRow,
  type Head,
  type Row,
  type ToolView,
} from "../../ui/row.js";
import { sanitize } from "../../ui/text.js";
import {
  detailsOf,
  limited,
  numOf,
  outputLines,
  strOf,
  textOf,
  withoutNotice,
} from "./shapes.js";

interface BashArgs {
  command: string;
  timeout: number;
}

const TAIL_LINES = 3;

/** The notice Pi ends truncated output with. */
const CUT = /\n\n\[Showing [^\n]*\]$/;

/** The sentence Pi ends a failed call's text with, as a paragraph of its own. */
const STATUS =
  /(?:^|\n\n)Command (?:exited with code (-?\d+)|(aborted)|timed out after (\d+(?:\.\d+)?) seconds|(terminated without an exit code))$/;

/** Why a failed call failed, from Pi's status sentence; the structured exit code never reaches a renderer. */
function statusOf(
  text: string,
): { why: string; stopped: boolean; output: string } | undefined {
  const found = STATUS.exec(text);
  if (!found) return undefined;
  const [, code, aborted, seconds] = found;
  const output = text.slice(0, found.index);
  if (code !== undefined)
    return { why: `exit ${code}`, stopped: false, output };
  if (aborted) return { why: "aborted", stopped: true, output };
  if (seconds !== undefined)
    return { why: `timed out after ${seconds}s`, stopped: false, output };
  return { why: "no exit status", stopped: false, output };
}

/** Where Pi kept the full output of a cut call, as the line a rail ends with. */
const logLines = (path: string | undefined): string[] =>
  path === undefined ? [] : [`log ${sanitize(path)}`];

const BASH_DETAILS = {
  truncation: "truncation",
  fullOutputPath: "string",
} as const;

export function bashView({
  args,
  settled,
  partial,
  expanded,
}: ToolView<BashArgs>): Row | undefined {
  const head: Head = {
    verb: "bash",
    subject: [titleOf(strOf(args.command) ?? "")],
    subjectKind: "text",
  };
  if (!settled) {
    const timeout = numOf(args.timeout);
    const tail = outputLines(textOf(partial ?? [])).slice(-TAIL_LINES);
    return {
      head: {
        ...head,
        mark: "running",
        facts:
          timeout === undefined
            ? []
            : [{ text: `timeout ${timeout}s`, kind: "extra" }],
      },
      ...(tail.length > 0
        ? {
            rail: { lines: tail, collapsed: TAIL_LINES, ink: "muted" as const },
          }
        : {}),
    };
  }
  const details = detailsOf(settled.details, BASH_DETAILS);
  if (!details) return undefined;
  if (isShellSnapshot(details.job))
    return shellRow(details.job, { verb: "bash", expanded });
  const text = textOf(settled.content);
  const cut = limited(details);
  const fullOutput = strOf(details.fullOutputPath);
  if (settled.isError) {
    const status = statusOf(text);
    if (!status) return failedRow(head, settled, "bash");
    // A thrown failure carries no details, but its text keeps the notice for cut output
    const cutHere = cut || CUT.test(status.output);
    const output = cutHere ? withoutNotice(status.output) : status.output;
    return {
      head: {
        ...head,
        mark: status.stopped ? "stopped" : "failed",
        facts: [
          { text: status.why, kind: "explain" },
          ...(cutHere ? [{ text: "truncated", kind: "extra" } as const] : []),
          ...durationFact(settled),
        ],
      },
      rail: {
        lines: outputLines(output),
        foot: logLines(fullOutput),
        collapsed: TAIL_LINES,
        tail: true,
        ink: "muted",
      },
    };
  }
  const output = cut ? withoutNotice(text) : text;
  const facts: Fact[] = [
    ...(cut ? [{ text: "truncated", kind: "extra" } as const] : []),
    ...durationFact(settled),
  ];
  const lines = outputLines(output);
  return {
    head: { ...head, mark: "done", facts },
    // The tail the running row showed stays: the transcript must not jump when a call settles
    ...(lines.length > 0 && output.trim() !== "(no output)"
      ? {
          rail: {
            lines,
            foot: logLines(fullOutput),
            collapsed: TAIL_LINES,
            tail: true,
            ink: "muted" as const,
          },
        }
      : {}),
  };
}
