/**
 * The jobs as lines: the widget above the editor and the `/shells` listing. Lines are sanitized
 * but not cut to a width; the caller fits them to its surface.
 */
import { sanitize } from "../ui/text.js";
import { active, duration, type ShellSnapshot, titleOf } from "./store.js";

/** One line per running or lingering job, `$ <title> · <elapsed> · <id>`; undefined when none. */
export function widgetLines(
  jobs: readonly ShellSnapshot[],
  now: number,
): string[] | undefined {
  const lines = jobs
    .filter(active)
    .map(
      (job) =>
        `$ ${titleOf(job.command)} · ${duration(now - job.startedAt)} · ${sanitize(job.id)}${job.lingering ? " · lingering" : ""}`,
    );
  return lines.length > 0 ? lines : undefined;
}

function state(job: ShellSnapshot, now: number): string {
  if (job.lingering)
    return `running for ${duration(now - job.startedAt)}, lingering`;
  const after = duration((job.endedAt ?? now) - job.startedAt);
  switch (job.status) {
    case "running":
      return `running for ${duration(now - job.startedAt)}`;
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
