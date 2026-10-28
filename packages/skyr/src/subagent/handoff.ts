/**
 * What a session leaves for the one that replaces it in the same process: the background runs it
 * stopped and the children it can still continue. Pi re-evaluates the extension on `/reload` and
 * keeps the process, so a module variable is lost where `globalThis` survives; a new session in
 * another file finds nothing it may read.
 */
import { isRun, type RunSnapshot } from "./store.js";
import type { WorktreePlan } from "./worktree.js";

const SLOT = Symbol.for("skyr.subagent.stopped");

/** A child's calling facts, for a second run through its saved session. */
export interface ChildRecord {
  id: string;
  agent?: string;
  description: string;
  model: string;
  tools: string[];
  cwd: string;
  key: string;
  trusted: boolean;
  systemPrompt: string;
  sessionFile: string;
  /** A bare writer's worktree: a continued run writes the same tree again. */
  worktree?: WorktreePlan;
  /** Epoch ms until which a stopped child may still be writing its session. */
  settledAt?: number;
}

/** What a session's end left behind, and why it ended. */
interface Stopped {
  v: 2;
  /** The session file they belong to: another session never reads them. */
  parentFile: string;
  reason: string;
  /** The background runs it stopped. */
  runs: RunSnapshot[];
  /** The children it could continue, finished or stopped. */
  records: ChildRecord[];
}

/**
 * Leaves `runs` and `records` for the next session on `parentFile`, replacing what an earlier
 * call left. Does nothing when the session saves no file or has neither.
 */
export function leaveStopped(
  parentFile: string | undefined,
  reason: string,
  runs: readonly RunSnapshot[],
  records: readonly ChildRecord[],
): void {
  if (parentFile === undefined || (runs.length === 0 && records.length === 0))
    return;
  const stopped: Stopped = {
    v: 2,
    parentFile,
    reason,
    runs: runs.map(({ activity: _, ...run }) => run),
    records: [...records],
  };
  Reflect.set(globalThis, SLOT, stopped);
}

const strings = (...fields: unknown[]) =>
  fields.every((field) => typeof field === "string");

// What follows checks a slot an earlier build of skyr may have left in this process.
function isWorktree(value: unknown): value is WorktreePlan {
  if (typeof value !== "object" || value === null) return false;
  const plan: Record<string, unknown> = { ...value };
  return strings(plan.path, plan.branch, plan.sha);
}

const soundRun = (run: unknown): run is RunSnapshot =>
  isRun(run) && (run.worktree === undefined || isWorktree(run.worktree));

function soundRecord(value: unknown): value is ChildRecord {
  if (typeof value !== "object" || value === null) return false;
  const record: Record<string, unknown> = { ...value };
  return (
    strings(
      record.id,
      record.description,
      record.model,
      record.cwd,
      record.key,
      record.systemPrompt,
      record.sessionFile,
    ) &&
    (record.agent === undefined || typeof record.agent === "string") &&
    (record.settledAt === undefined || Number.isFinite(record.settledAt)) &&
    Array.isArray(record.tools) &&
    strings(...record.tools) &&
    typeof record.trusted === "boolean" &&
    (record.worktree === undefined || isWorktree(record.worktree))
  );
}

/**
 * What the previous session left for `parentFile`, or undefined. The slot is emptied by the
 * first call, whoever it was left for.
 */
export function takeStopped(
  parentFile: string | undefined,
): { reason: string; runs: RunSnapshot[]; records: ChildRecord[] } | undefined {
  const slot: unknown = Reflect.get(globalThis, SLOT);
  Reflect.deleteProperty(globalThis, SLOT);
  if (typeof slot !== "object" || slot === null) return undefined;
  const fields: Record<string, unknown> = { ...slot };
  const { v, parentFile: owner, reason, runs, records } = fields;
  if (
    v !== 2 ||
    parentFile === undefined ||
    owner !== parentFile ||
    typeof reason !== "string" ||
    !Array.isArray(runs) ||
    !Array.isArray(records)
  )
    return undefined;
  return {
    reason,
    runs: runs.filter(soundRun),
    records: records.filter(soundRecord),
  };
}
