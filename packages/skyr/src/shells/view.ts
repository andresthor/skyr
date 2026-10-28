/**
 * The jobs as rows: a bar row for each running, lingering or failed job, and the `/shells` listing.
 * Strings are sanitized but not cut to a width; the caller fits them to its surface.
 */
import type { BarRow } from "../chrome/bar.js";
import { glyphsOf, type Mark, tierOf } from "../ui/caps.js";
import { formatDuration, formatElapsed } from "../ui/format.js";
import type { Fact } from "../ui/record.js";
import type { Row } from "../ui/row.js";
import { sanitize } from "../ui/text.js";
import { active, type ShellSnapshot, titleOf } from "./store.js";

/** A running or lingering job as a bar row; a job that exited non-zero, as a failed one. */
export function barRow(job: ShellSnapshot): BarRow {
  const failed = job.status === "failed";
  return {
    id: sanitize(job.id),
    mark: failed ? "failed" : "running",
    label: titleOf(job.command),
    background: true,
    ...(job.lingering && { now: "lingering" }),
    ...(failed && {
      why: job.exitCode === undefined ? "failed" : `exit ${job.exitCode}`,
    }),
    startedAt: job.startedAt,
    ...(job.endedAt !== undefined && { endedAt: job.endedAt }),
  };
}

function state(job: ShellSnapshot, now: number): string {
  if (job.lingering)
    return `running for ${formatElapsed(now - job.startedAt)}, lingering`;
  const after = formatDuration((job.endedAt ?? now) - job.startedAt);
  switch (job.status) {
    case "running":
      return `running for ${formatElapsed(now - job.startedAt)}`;
    case "done":
    case "failed":
      return `exited ${job.exitCode} after ${after}`;
    case "aborted":
      return `stopped after ${after}`;
    case "unknown":
      return `ended after ${after}, exit status lost`;
  }
}

/** Every job, running and lingering first, each as `<id> "<title>"`, its state and its log, joined by the tier's separator. */
export function listingLines(
  jobs: readonly ShellSnapshot[],
  now: number,
): string[] {
  if (jobs.length === 0) return ["No background jobs in this session."];
  const { sep } = glyphsOf(tierOf(process.env));
  return [...jobs.filter(active), ...jobs.filter((job) => !active(job))].map(
    (job) =>
      [
        `${sanitize(job.id)} "${titleOf(job.command)}"`,
        state(job, now),
        sanitize(job.log),
      ].join(sep),
  );
}

/** How a job's life ended, for a transcript record: its mark and the words that explain it. */
function endOf(job: ShellSnapshot): { mark: Mark; why: string; exit?: string } {
  const exit = job.exitCode === undefined ? undefined : `exit ${job.exitCode}`;
  if (job.lingering) return { mark: "mixed", why: "lingering", exit };
  switch (job.status) {
    case "running":
      return { mark: "running", why: "still running" };
    case "done":
      return { mark: "done", why: exit ?? "exited" };
    case "failed":
      return { mark: "failed", why: exit ?? "failed" };
    case "aborted":
      return {
        mark: "stopped",
        why: `stopped by ${
          {
            user: "you",
            agent: "the agent",
            session: "the session ending",
            pi: "Pi ending",
          }[job.stopReason ?? "agent"]
        }`,
      };
    case "unknown":
      return { mark: "mixed", why: "exit status lost" };
  }
}

/**
 * A job as a transcript record. `bash` is the message that told the model how a job ended, or
 * that it still runs; `stop` is the result of `bash_stop`. Only facts the snapshot holds are
 * shown, so a saved session draws the same on every resume. Expanded, the job's log is named.
 */
export function shellRow(
  job: ShellSnapshot,
  { verb, expanded }: { verb: "bash" | "stop"; expanded: boolean },
): Row {
  const { mark, why, exit } = endOf(job);
  const ended = mark !== "running";
  const { from } = glyphsOf(tierOf(process.env));
  const took =
    job.endedAt === undefined
      ? []
      : [
          {
            text: formatDuration(job.endedAt - job.startedAt),
            kind: "measure",
          } as const,
        ];
  const exited: Fact[] =
    exit !== undefined && why !== exit ? [{ text: exit, kind: "measure" }] : [];
  const facts: Fact[] =
    verb === "bash"
      ? [
          ...(ended
            ? [
                {
                  text: `${from} delivered`,
                  kind: mark === "done" ? "explain" : "extra",
                  accent: true,
                } as const,
              ]
            : []),
          { text: why, kind: mark === "done" ? "measure" : "explain" },
          ...exited,
          ...took,
        ]
      : [
          ...(mark === "stopped" && job.stopReason === "agent"
            ? [{ text: "stopped", kind: "explain" } as const]
            : [
                { text: "already ended", kind: "explain" } as const,
                { text: why, kind: "explain" } as const,
              ]),
          ...exited,
          ...took,
        ];
  return {
    head: {
      mark,
      verb,
      background: verb === "bash",
      subject: [titleOf(job.command)],
      subjectKind: "text",
      facts,
      handle: sanitize(job.id),
    },
    ...(expanded
      ? {
          rail: {
            lines: [`log ${sanitize(job.log)}`],
            collapsed: 0,
            ink: "muted" as const,
          },
        }
      : {}),
  };
}
