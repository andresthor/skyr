/**
 * One Pi session's background jobs: the live set, the watcher, and the telling of each end to
 * the model. Nothing here talks to Pi's API; the caller hands in how to send a message and
 * whether the session is idle, so the unit starts and stops without a fake Pi.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PiModule } from "../pi.js";
import { oneLine, quoted } from "../tools/render.js";
import { logError } from "./exec.js";
import {
  claimDelivery,
  groupAlive,
  type JobRecord,
  type Outcome,
  readOutcome,
  releaseDelivery,
  tailOf,
} from "./job.js";
import {
  active,
  createShellStore,
  duration,
  type ShellSnapshot,
  titleOf,
} from "./store.js";
import { createWatcher, type JobEnd } from "./watch.js";

const COMMAND_CHARS = 200;
/** How long a stop waits for the continuation to record the exit it caused. */
const EXIT_WAIT_MS = 1_000;

export interface ShellSession {
  /** Arms the watcher. */
  start(): void;
  /**
   * Stops every running job (SIGTERM, then SIGKILL after `graceMs`) and everything that polls
   * or retries. Awaited by the caller; nothing is told to the model afterwards.
   */
  stop(): Promise<void>;
  /** This Pi's identity token; undefined after `stop`. */
  owner(): string | undefined;
  /** Takes on a job that has just been recorded on disk. */
  track(job: JobRecord): void;
  /** The job's shell has exited and its `exit` is written: from here its end can be found. */
  exited(job: JobRecord): Promise<void>;
  /**
   * Stops a job by id or unique id prefix and words the result for the model. Stopping a job that
   * has ended is not an error; an unknown or ambiguous id, and a job that outlives SIGKILL, throw.
   */
  stopJob(idOrPrefix: string): Promise<{ text: string; job: ShellSnapshot }>;
}

/** How a job ended, for the model: `exited with code 2 after 41s`. */
function ending(outcome: Outcome, startedAt: number, now: number): string {
  const after = duration((outcome.endedAt ?? now) - startedAt);
  switch (outcome.status) {
    case "done":
    case "failed":
      // 124 is what `timeout` exits with, and what a moved call's deadline writes
      return outcome.exitCode === 124
        ? `timed out after ${after}`
        : `exited with code ${outcome.exitCode} after ${after}`;
    case "aborted":
      return `stopped after ${after}`;
    case "unknown":
      return `ended after ${after}; its exit status was lost`;
  }
}

/** The job as a snapshot: running, or as `end` says it ended. */
export function snapshotOf(
  record: JobRecord,
  end?: { outcome: Outcome; lingering: boolean },
): ShellSnapshot {
  const running: ShellSnapshot = {
    id: record.id,
    command: record.command,
    cwd: record.cwd,
    log: join(record.dir, "out.log"),
    startedAt: record.startedAt,
    status: "running",
  };
  if (!end) return running;
  const { outcome } = end;
  return {
    ...running,
    ...(end.lingering
      ? { lingering: true as const }
      : { status: outcome.status, endedAt: outcome.endedAt }),
    ...(outcome.exitCode !== undefined && { exitCode: outcome.exitCode }),
    ...(outcome.stopReason !== undefined && { stopReason: outcome.stopReason }),
  };
}

/** An end waiting for the session to be idle. */
interface Pending {
  dir: string;
  text: string;
  job: ShellSnapshot;
}

export function createShellSession(o: {
  root: string;
  sessionId: string;
  /** This Pi's `identify(process.pid)` token, recorded with every job. */
  owner: string;
  /** Milliseconds between SIGTERM and SIGKILL when a job is stopped. */
  graceMs: number;
  pi: Pick<PiModule, "truncateTail" | "formatSize">;
  /** Delivers `text` to the model as a message that starts a turn. May throw on a stale session. */
  send(text: string, jobs: ShellSnapshot[]): void;
  isIdle(): boolean;
}): ShellSession {
  const store = createShellStore();
  let closed = false;
  /** Settles when a job's continuation has recorded its end. */
  const shellsOver = new Map<
    string,
    { promise: Promise<void>; resolve(): void }
  >();
  // Ends waiting for the session to be idle. Claimed only at the send, so ends a quit drops
  // stay unclaimed.
  let pending: Pending[] = [];

  /** Never throws: it runs from the watcher's timer and from promise continuations. */
  const complain = (error: unknown) => logError(o.root, "shells", error);

  const watcher = createWatcher({
    now: Date.now,
    graceMs: o.graceMs,
    tail: (dir) => tailOf(dir, o.pi.truncateTail),
    onEnd: (end) => deliver(end).catch(complain),
    onError: complain,
    onTick: flushIfIdle,
  });

  // Keeps the tick going while an end waits, so a send that /compact or /tree stranded is retried.
  const wake = () => watcher.wake(() => pending.length === 0);

  function idle(): boolean {
    try {
      return !closed && o.isIdle();
    } catch {
      // A stale session: its next one delivers nothing for this, so there is no one to tell.
      return false;
    }
  }

  function flushIfIdle(): void {
    if (idle()) void flush().catch(complain);
  }

  /** One message for every pending end, each claimed just before the send. */
  async function flush(): Promise<void> {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const sent: Pending[] = [];
    const marked: Pending[] = [];
    for (const item of batch) {
      const claimed = await claimDelivery(item.dir, o.sessionId).catch(
        // A dir that cannot be marked (cleaned up, say): told twice beats never told.
        () => "unmarked" as const,
      );
      if (claimed === false) continue;
      sent.push(item);
      if (claimed === true) marked.push(item);
    }
    const release = () =>
      Promise.all(
        marked.map((item) =>
          releaseDelivery(item.dir, o.sessionId).catch(complain),
        ),
      );
    if (sent.length === 0) return;
    if (closed) return void (await release());
    if (!idle()) {
      // A prompt started during the claims; a send now would become a steer, which Esc drops.
      await release();
      pending = [...sent, ...pending];
      wake();
      return;
    }
    try {
      o.send(
        sent.map((i) => i.text).join("\n\n---\n\n"),
        sent.map((i) => i.job),
      );
    } catch (error: unknown) {
      await release();
      complain(error);
    }
  }

  async function report(
    record: JobRecord,
    head: string,
    tail: string,
  ): Promise<string> {
    const log = join(record.dir, "out.log");
    const size = await stat(log).then(
      (s) => o.pi.formatSize(s.size),
      () => "missing",
    );
    const others = store
      .jobs()
      .filter((j) => j.id !== record.id && active(j))
      .map(jobLine);
    return [
      `[background job "${titleOf(record.command)}" (id ${record.id}): ${head}]`,
      `$ ${oneLine(record.command, COMMAND_CHARS)}   (in ${record.cwd})`,
      tail.trimEnd() || "(no output)",
      `Log: ${log} (${size})`,
      ...(others.length > 0
        ? [
            `Still running: ${others.join(", ")}. You will be told when each ends; do not poll.`,
          ]
        : []),
    ].join("\n");
  }

  async function deliver(end: JobEnd): Promise<void> {
    if (closed) return;
    const { record, outcome, lingering } = end;
    const job = snapshotOf(record, { outcome, lingering });
    // A linger end told the model already; a stop has its own result, or no one to tell.
    if (end.afterLinger || outcome.stopReason !== undefined)
      return store.put(job);
    const head = lingering
      ? `its shell exited with code ${outcome.exitCode} after ${duration((outcome.endedAt ?? Date.now()) - record.startedAt)}; processes remain in its process group. Stop it with bash_stop.`
      : ending(outcome, record.startedAt, Date.now());
    const text = await report(record, head, end.tail);
    if (closed) return;
    // With the push: whoever sees the end in the store finds its delivery pending.
    store.put(job);
    pending.push({ dir: record.dir, text, job });
    // Sent by the tick that found the end, once all of that tick's ends are in one batch.
    wake();
  }

  const jobLine = (j: ShellSnapshot) =>
    `${j.id} "${titleOf(j.command)}" (${duration(Date.now() - j.startedAt)})`;

  async function stopJob(target: string) {
    const found = watcher.get(target);
    if (found === "ambiguous")
      throw new Error(
        `bash_stop: ${quoted(target, 40)} matches more than one job: ${watcher
          .records()
          .filter((r) => r.record.id.startsWith(target))
          .map((r) => r.record.id)
          .join(", ")}; pass the full id.`,
      );
    if (found === undefined) {
      const running = store.jobs().filter(active).map(jobLine);
      throw new Error(
        `bash_stop: no job ${quoted(target, 40)}. Running: ${running.join(", ") || "none"}.`,
      );
    }
    const { record } = found;
    const log = join(record.dir, "out.log");
    const snapshot = () => store.jobs().find((j) => j.id === record.id);
    // The end is told here, so the delivery must never tell it again.
    const alreadyEnded = async (how: string) => {
      await claimDelivery(record.dir, o.sessionId).catch(() => false);
      return {
        text: `Job ${record.id} had already ended: ${how}`,
        job: snapshot() ?? snapshotOf(record),
      };
    };
    if (found.ended)
      return alreadyEnded(
        `${ending(found.ended, record.startedAt, Date.now())}. Nothing to stop.`,
      );

    const [result] = await watcher.stop([record.id], "agent");
    const after = watcher.get(record.id);
    // A shutdown during the stop disposes the watcher; the files still say how it ended.
    const outcome =
      after !== undefined && after !== "ambiguous"
        ? after.ended
        : groupAlive(record.pgid)
          ? undefined
          : await readOutcome(record.dir);
    if (outcome === undefined)
      throw new Error(
        `bash_stop: job ${record.id} did not stop: ${result?.survived ? "processes remain in its group after SIGKILL" : "its process group is still alive"}. Tell the user; do not signal it yourself. Log: ${log}`,
      );
    if (outcome.stopReason !== "agent")
      return alreadyEnded(
        `${ending(outcome, record.startedAt, Date.now())}. Nothing to stop.`,
      );
    await claimDelivery(record.dir, o.sessionId).catch(() => false);
    // The stop returns when the group is empty; the exit and the end of the log follow.
    const over = shellsOver.get(record.id);
    if (over) {
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        over.promise,
        new Promise((resolve) => {
          giveUp = setTimeout(resolve, EXIT_WAIT_MS);
        }),
      ]);
      clearTimeout(giveUp);
    }
    const { exitCode } = await readOutcome(record.dir);
    const how = result?.killed
      ? `it ignored SIGTERM and was killed with SIGKILL after ${o.graceMs / 1000} s`
      : `SIGTERM${exitCode !== undefined ? `; exit code ${exitCode}` : ""}`;
    const tail = await tailOf(record.dir, o.pi.truncateTail).catch(() => "");
    return {
      text: [
        `Stopped job ${record.id} "${titleOf(record.command)}" after ${duration((outcome.endedAt ?? Date.now()) - record.startedAt)} (${how}). Last output:`,
        tail.trimEnd() || "(no output)",
        `Log: ${log}`,
      ].join("\n"),
      job: snapshot() ?? snapshotOf(record, { outcome, lingering: false }),
    };
  }

  return {
    start() {
      if (!closed) watcher.start();
    },
    async stop() {
      closed = true;
      pending = [];
      await watcher.stop("all", "session").catch(complain);
      watcher.dispose();
    },
    owner: () => (closed ? undefined : o.owner),
    track(job) {
      store.put(snapshotOf(job));
      watcher.add(job);
      let resolve = () => {};
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      shellsOver.set(job.id, { promise, resolve });
    },
    exited(job) {
      shellsOver.get(job.id)?.resolve();
      return watcher.exited(job.id);
    },
    stopJob,
  };
}
