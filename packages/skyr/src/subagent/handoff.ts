/**
 * What a session leaves for the one that replaces it in the same process. Pi re-evaluates the
 * extension on `/reload` and keeps the process, so a module variable is lost where `globalThis`
 * survives; a new session in another file finds nothing it may read.
 */
import { isRun, type RunSnapshot } from "./store.js";

const SLOT = Symbol.for("skyr.subagent.stopped");

/** The background runs a session's end stopped, and why. */
interface Stopped {
  v: 1;
  /** The session file they belong to: another session never reads them. */
  parentFile: string;
  reason: string;
  runs: RunSnapshot[];
}

/**
 * Leaves `runs` for the next session on `parentFile`, replacing what an earlier call left. Does
 * nothing when the session saves no file or `runs` is empty.
 */
export function leaveStopped(
  parentFile: string | undefined,
  reason: string,
  runs: readonly RunSnapshot[],
): void {
  if (parentFile === undefined || runs.length === 0) return;
  const stopped: Stopped = {
    v: 1,
    parentFile,
    reason,
    runs: runs.map(({ activity: _, ...run }) => run),
  };
  Reflect.set(globalThis, SLOT, stopped);
}

// A leftover from an earlier build of skyr in this process is not this shape.
const sound = (run: unknown): run is RunSnapshot =>
  isRun(run) &&
  (run.worktree === undefined ||
    [run.worktree.path, run.worktree.branch, run.worktree.sha].every(
      (field) => typeof field === "string",
    ));

/**
 * What the previous session left for `parentFile`, or undefined. The slot is emptied by the
 * first call, whoever it was left for.
 */
export function takeStopped(
  parentFile: string | undefined,
): { reason: string; runs: RunSnapshot[] } | undefined {
  const slot: unknown = Reflect.get(globalThis, SLOT);
  Reflect.deleteProperty(globalThis, SLOT);
  if (typeof slot !== "object" || slot === null) return undefined;
  const fields: Record<string, unknown> = { ...slot };
  const { v, parentFile: owner, reason, runs } = fields;
  if (
    v !== 1 ||
    parentFile === undefined ||
    owner !== parentFile ||
    typeof reason !== "string" ||
    !Array.isArray(runs)
  )
    return undefined;
  return { reason, runs: runs.filter(sound) };
}
