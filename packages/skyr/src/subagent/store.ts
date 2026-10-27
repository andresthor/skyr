/**
 * The running subagents, as plain snapshots every live UI surface reads from, and the words that
 * name a run and its progress.
 */
import type { TaskItem } from "../tengi.js";
import { clip } from "../tools/render.js";
import type { ChildEvent } from "./runner.js";

export type RunStatus = "queued" | "running" | "done" | "failed" | "aborted";

export interface RunSnapshot {
  id: string;
  /** Absent for an ad-hoc child. */
  agent?: string;
  description: string;
  status: RunStatus;
  /** Epoch milliseconds when the call began, including any time queued. */
  startedAt: number;
  endedAt?: number;
  turns: number;
  toolCalls: number;
  /** Every token the child has used so far, cached input included (its usage's `totalTokens`). */
  tokens: number;
  /** Name of the child's latest tool call. */
  tool?: string;
  /** Set by the store while running: `unknown` once the child's heartbeat goes stale, which is no evidence either way. */
  activity?: "working" | "unknown";
  /** Label of the writer directly ahead; present only while queued. */
  behind?: string;
  /** The call returned at once; the answer is delivered as a message. */
  background?: true;
  /** The child writes in its own fresh git worktree, not the parent's tree. */
  worktree?: { path: string; branch: string };
  /** Delivered from a recovered job dir after a restarted session; not a live child. */
  recovered?: true;
  sessionFile?: string;
  spillFile?: string;
}

type RunEvent =
  | { type: "start"; snapshot: RunSnapshot }
  | { type: "end" }
  | ChildEvent;

export interface RunStore {
  /**
   * `start` creates or replaces an entry, marking a running one `working`, and `end` removes it;
   * events for an unknown id, such as a child's late progress after `clear`, are ignored.
   * Snapshots already handed out never change.
   */
  apply(id: string, event: RunEvent): void;
  /** Undefined once the child has ended. */
  get(id: string): RunSnapshot | undefined;
  running(): readonly RunSnapshot[];
  /** Calls `listener` synchronously after every change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  clear(): void;
}

export function createRunStore(): RunStore {
  const runs = new Map<string, RunSnapshot>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };

  return {
    apply(id, event) {
      if (event.type === "start") {
        const { snapshot } = event;
        runs.set(
          id,
          snapshot.status === "running"
            ? { ...snapshot, activity: "working" }
            : snapshot,
        );
        return changed();
      }
      const run = runs.get(id);
      if (!run) return;
      if (event.type === "end") runs.delete(id);
      else if (event.type === "tool")
        runs.set(id, {
          ...run,
          tool: event.name,
          toolCalls: run.toolCalls + 1,
        });
      else if (event.type === "stalled")
        runs.set(id, {
          ...run,
          activity: event.stalled ? "unknown" : "working",
        });
      else if (event.type === "turn")
        runs.set(id, {
          ...run,
          turns: run.turns + 1,
          tokens: event.usage.totalTokens,
        });
      changed();
    },
    get: (id) => runs.get(id),
    running: () => [...runs.values()],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      if (runs.size === 0) return;
      runs.clear();
      changed();
    },
  };
}

/** A run's turns, tools and state, or why it waits; empty for a queued run with nobody ahead. */
export function progressOf(run: RunSnapshot): string {
  if (run.status === "queued") return run.behind ? `behind ${run.behind}` : "";
  return [
    count(run.turns, "turn"),
    count(run.toolCalls, "tool"),
    run.tool,
    run.worktree && "worktree",
    run.activity === "unknown" && "stalled",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function taskOf(run: RunSnapshot): TaskItem {
  const detail = progressOf(run);
  return {
    id: run.id,
    title: labelOf(run),
    status: run.status,
    ...(detail ? { detail } : {}),
    startedAt: run.startedAt,
  };
}

/** `scout "Map store"` for an agent's run, `"Map store"` for an ad-hoc one. */
export const labelOf = (run: { agent?: string; description: string }) =>
  `${run.agent ? `${run.agent} ` : ""}"${clip(run.description)}"`;

export const count = (n: number, noun: string) =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;
