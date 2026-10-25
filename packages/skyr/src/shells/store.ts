/**
 * The background jobs as plain snapshots, and the words that name them. Snapshots hold facts only
 * (epoch ms, nothing rendered or derived), so a snapshot can be drawn or published as it is.
 */
import { oneLine } from "../tools/render.js";

type ShellStatus = "running" | "done" | "failed" | "aborted" | "unknown";
/** `pi`: stopped by a later session's cleanup after the Pi that started the job was gone. */
export type StopReason = "agent" | "user" | "session" | "pi";

export interface ShellSnapshot {
  /** 8 hex chars; the only id the model sees. */
  id: string;
  command: string;
  cwd: string;
  /** Absolute path of the job's `out.log`. */
  log: string;
  /** Epoch milliseconds, of the call that became the job. */
  startedAt: number;
  status: ShellStatus;
  endedAt?: number;
  /** Absent while running, or when the exit status was lost. */
  exitCode?: number;
  /** Present iff `status` is `aborted`. */
  stopReason?: StopReason;
  /** The shell exited; its process group still has members. */
  lingering?: true;
}

export interface ShellStore {
  /** Creates or replaces the entry for the snapshot's id, holding a copy. */
  put(snapshot: ShellSnapshot): void;
  /** Every job, oldest start first. Snapshots already handed out never change. */
  jobs(): readonly ShellSnapshot[];
}

export function createShellStore(): ShellStore {
  const jobs = new Map<string, ShellSnapshot>();
  return {
    put(snapshot) {
      jobs.set(snapshot.id, { ...snapshot });
    },
    jobs: () => [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt),
  };
}

const TITLE_CHARS = 60;
// `cd <dir> &&`, with the dir bare or quoted
const CD_PREFIX = /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/;

/**
 * A job's name for the model and the user: the command's first non-empty line without leading
 * `cd <dir> &&`, on one line and clipped.
 */
export function titleOf(command: string): string {
  const line =
    command
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  return oneLine(line.replace(CD_PREFIX, "") || line, TITLE_CHARS);
}

/** Running, or lingering: its shell exited and its process group still has members. */
export const active = (job: ShellSnapshot) =>
  job.status === "running" || job.lingering === true;

/** A span of milliseconds, whole seconds: `41s`, `12m05s`, `4h00m`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
