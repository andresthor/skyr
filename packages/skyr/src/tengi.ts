/**
 * What an ACP host running this Pi (tengi) serves extensions over Pi's event bus. The query is
 * answered inside the asking `emit`, so it is synchronous and safe to repeat at every use.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface HostCapabilities {
  /** The client can show forms, and `tengi:form?` is served. */
  formRequests: boolean;
  /** `tengi:tasks` is forwarded, and the client shows task lists. */
  taskLists: boolean;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The host's v1 answer to this query, or `undefined` when nothing answered: plain Pi, or a stale
 * extension API after a reload. Never throws, because Pi offers a tool whose `prepareLoadout`
 * throws and a store listener's throw would escape Pi's handlers.
 */
export function hostCapabilities(
  events: ExtensionAPI["events"],
): HostCapabilities | undefined {
  const id = randomUUID();
  let caps: HostCapabilities | undefined;
  let off: (() => void) | undefined;
  try {
    off = events.on("tengi:capabilities", (data) => {
      if (!isRecord(data) || data.id !== id || data.v !== 1) return;
      // Every listener sees every reply; a capability any host serves counts
      caps = {
        formRequests:
          caps?.formRequests === true ||
          (data.forms === true && data.formRequests === true),
        taskLists: caps?.taskLists === true || data.taskLists === true,
      };
    });
    events.emit("tengi:capabilities?", { id });
  } catch {
    return undefined;
  } finally {
    off?.();
  }
  return caps;
}

/** One entry of a host's task list. */
export interface TaskItem {
  id: string;
  title: string;
  status: string;
  detail?: string;
  startedAt?: number;
}

/**
 * Publishes `items` as `source`'s ACP task list, when the host forwards one; plain Pi answers
 * nothing. The host replaces the source's whole list, so an empty one clears it.
 */
export function publishTasks(
  events: ExtensionAPI["events"],
  source: string,
  items: TaskItem[],
): void {
  if (!hostCapabilities(events)?.taskLists) return;
  try {
    events.emit("tengi:tasks", { source, items });
  } catch {
    // A stale extension API after a reload throws here, outside any handler; the next
    // session's store publishes afresh
  }
}
