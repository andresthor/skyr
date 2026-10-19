/** The running subagents, as plain snapshots every live UI surface reads from. */
import type { ChildEvent } from "./runner.js";

export type RunStatus = "queued" | "running" | "done" | "failed" | "aborted";

export interface RunSnapshot {
  id: string;
  toolCallId: string;
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
  byToolCall(toolCallId: string): RunSnapshot | undefined;
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
    byToolCall(toolCallId) {
      for (const run of runs.values())
        if (run.toolCallId === toolCallId) return run;
      return undefined;
    },
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
