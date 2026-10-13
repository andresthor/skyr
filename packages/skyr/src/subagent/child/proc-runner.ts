/** The subprocess runner: one child process per run, talking the job-dir file protocol. */
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildEvent, ChildResult, ChildSpec, Runner } from "./types.js";

/** Seconds a child gets between SIGTERM and SIGKILL once its abort fires. */
const GRACE_MS = 3_000;
/** Heartbeat age that marks a row stalled; nothing kills a stalled child. */
const STALLED_MS = 15_000;
const POLL_MS = 500;
const PROTOCOL = 1;

interface Snapshot {
  v: number;
  id: string;
  turns: number;
  toolCalls: number;
  activity: string | undefined;
  tokens: number;
  startedAt: number;
  now: number;
  pid: number;
}

interface StoredResult extends ChildResult {
  v: number;
  description: string;
  agent?: string;
}

const ZERO: ChildResult["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Shape-checked read of a stored result: anything the protocol does not speak is absent. */
export const readStoredResult = (raw: unknown): StoredResult | undefined => {
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
  const usage = r.usage as { input?: unknown; output?: unknown };
  if (typeof usage.input !== "number" || typeof usage.output !== "number")
    return undefined;
  return r as unknown as StoredResult;
};

const readSnapshot = (raw: string): Snapshot | undefined => {
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

const abortedResult = (): ChildResult => ({
  status: "aborted",
  text: undefined,
  error: undefined,
  usage: ZERO,
  sessionFile: undefined,
});

/** The actual exit code of a child: null on a signal death. */
const exited = (child: ReturnType<typeof spawn>): Promise<number | null> =>
  new Promise((resolve) => child.once("exit", (code) => resolve(code)));

/**
 * Builds the subprocess runner against a child entry that ships beside this module. The
 * caller selects it: a smoke probe and the platform decide capability, not a version.
 */
export function processRunner(
  entryPath: string,
  o?: { stalledMs?: number; loader?: string[] },
): Runner {
  return {
    run(spec, signal, onEvent) {
      return (async () => {
        if (platform() === "win32")
          throw new Error("no subprocess runner on this platform");
        const jobDir =
          spec.session !== undefined && "dir" in spec.session
            ? join(spec.session.dir, "jobs", spec.id)
            : await mkdtemp(join(tmpdir(), "skyr-job-"));
        await mkdir(jobDir, { recursive: true });
        await writeJson(join(jobDir, "spec.json"), spec);

        const child = spawn(
          process.execPath,
          [...(o?.loader ?? []), entryPath, jobDir],
          {
            // Nothing raw reaches the parent's terminal: stdout is dropped; stderr joins
            // only a failure message, clipped, when the child dies without reporting.
            stdio: ["ignore", "ignore", "pipe"],
            env: process.env,
          },
        );
        // Kept to a report-sized tail: the child's stderr joins only a failure message.
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-400);
        });

        const last = { turns: 0, toolCalls: 0 };
        let stalled = false;
        const stalledMs = o?.stalledMs ?? STALLED_MS;
        const poll = setInterval(() => {
          void (async () => {
            const snap = await readFile(
              join(jobDir, "activity.json"),
              "utf8",
            ).then(readSnapshot, () => undefined);
            if (snap === undefined) return;
            while (snap.toolCalls > last.toolCalls) {
              // Delta tool calls share the snapshot's latest activity name.
              onEvent({ type: "tool", name: snap.activity ?? "" });
              last.toolCalls += 1;
            }
            if (snap.turns !== last.turns) {
              last.turns = snap.turns;
              onEvent({
                type: "turn",
                usage: {
                  input: snap.tokens,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: snap.tokens,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
              });
            }
            const age = Date.now() - snap.now;
            if (age > stalledMs && !stalled) {
              stalled = true;
              onEvent({ type: "stalled", stalled: true });
            } else if (stalled && age <= stalledMs) {
              stalled = false;
              onEvent({ type: "stalled", stalled: false });
            }
          })();
        }, POLL_MS);

        // Abort: SIGTERM (the child aborts its session, writes an aborted result, exits),
        // then a grace period, then SIGKILL. A kill leaves no result; the parent speaks.
        const escalateTimer: { t?: NodeJS.Timeout } = {};
        const side = () => {
          child.kill("SIGTERM");
          escalateTimer.t = setTimeout(() => child.kill("SIGKILL"), GRACE_MS);
          escalateTimer.t.unref?.();
        };
        if (signal.aborted) side();
        else signal.addEventListener("abort", side, { once: true });

        try {
          const code = await exited(child);
          const parsed = await readFile(
            join(jobDir, "result.json"),
            "utf8",
          ).then(
            (raw: string) => JSON.parse(raw) as unknown,
            () => undefined,
          );
          const result =
            parsed === undefined ? undefined : readStoredResult(parsed);
          if (result === undefined) {
            // Nothing reported: the child never started or died mid-run. Escalation's
            // signal is the outcome.
            if (signal.aborted) return abortedResult();
            throw new Error(
              `the subagent child died without reporting (exit code ${code ?? "signal"}${stderr ? `: ${stderr.slice(0, 200).trim()}` : ""})`,
            );
          }
          return {
            status: result.status,
            text: result.text,
            error: result.error,
            usage: result.usage,
            sessionFile: result.sessionFile,
          };
        } finally {
          clearInterval(poll);
          if (escalateTimer.t) clearTimeout(escalateTimer.t);
          // The parent reads the result in the same turn it arrives; leftovers (a parent
          // crash) are reaped on the next session start.
          await rm(jobDir, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      })();
    },
  };
}

async function writeJson(target: string, data: unknown): Promise<void> {
  const temp = `${target}.tmp-${process.pid}`;
  await writeFile(temp, JSON.stringify(data), "utf8");
  await rename(temp, target);
}
