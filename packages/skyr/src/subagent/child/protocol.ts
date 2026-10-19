/** The job-dir protocol both sides of the boundary speak: one definition, defined here only. */
import { rename, writeFile } from "node:fs/promises";

/** Bump this when the snapshot or result fields change; readers refuse other versions. */
export const PROTOCOL = 1;

/** `activity.json`: counters and the heartbeat clock; never a control channel. */
export interface Snapshot {
  v: number;
  id: string;
  turns: number;
  toolCalls: number;
  activity: string | undefined;
  tokens: number;
  startedAt: number;
  /** The child's own clock, so a stalled verdict keys on heartbeat age, not event silence. */
  now: number;
  pid: number;
}

/** `result.json`: one final verdict, with the labels a recovered delivery needs. */
export interface StoredResult {
  v: number;
  status: "done" | "failed" | "aborted";
  text: string | undefined;
  error: string | undefined;
  usage: import("./types.js").Usage;
  sessionFile: string | undefined;
  description: string;
  agent?: string;
}

export const zeroUsage = (): import("./types.js").Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** Atomic write: same-directory temp then rename, so a reader never sees a torn file. */
export async function writeJson(target: string, data: unknown): Promise<void> {
  const temp = `${target}.tmp-${process.pid}`;
  await writeFile(temp, JSON.stringify(data), "utf8");
  await rename(temp, target);
}

/** Shape-checked read of a stored result: anything the protocol does not speak is absent. */
export function readStoredResult(raw: unknown): StoredResult | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.v !== PROTOCOL) return undefined;
  if (r.status !== "done" && r.status !== "failed" && r.status !== "aborted")
    return undefined;
  if (r.text !== undefined && typeof r.text !== "string") return undefined;
  if (r.error !== undefined && typeof r.error !== "string") return undefined;
  if (typeof r.description !== "string" || r.description === "")
    return undefined;
  if (typeof r.usage !== "object" || r.usage === null) return undefined;
  const usage = r.usage as {
    input?: unknown;
    output?: unknown;
    totalTokens?: unknown;
  };
  if (
    typeof usage.input !== "number" ||
    typeof usage.output !== "number" ||
    typeof usage.totalTokens !== "number"
  )
    return undefined;
  return r as unknown as StoredResult;
}

export const readSnapshot = (raw: string): Snapshot | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const r = parsed as Record<string, unknown>;
  if (r.v !== PROTOCOL || typeof r.id !== "string") return undefined;
  return parsed as Snapshot;
};
