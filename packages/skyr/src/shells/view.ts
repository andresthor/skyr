/**
 * The jobs as rows: a bar row for each running, lingering or failed job, and the `/shells` listing.
 * Strings are sanitized but not cut to a width; the caller fits them to its surface.
 */
import type { BarRow } from "../chrome/bar.js";
import { formatDuration, formatElapsed } from "../ui/format.js";
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

/** Every job, running and lingering first, each as `<id> "<title>" · <state> · <log>`. */
export function listingLines(
  jobs: readonly ShellSnapshot[],
  now: number,
): string[] {
  if (jobs.length === 0) return ["No background jobs in this session."];
  return [...jobs.filter(active), ...jobs.filter((job) => !active(job))].map(
    (job) =>
      `${sanitize(job.id)} "${titleOf(job.command)}" · ${state(job, now)} · ${sanitize(job.log)}`,
  );
}
