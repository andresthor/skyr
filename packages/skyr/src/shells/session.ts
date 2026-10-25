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
  hasEnded,
  identify,
  type JobRecord,
  listJobDirs,
  markEnded,
  markHandover,
  type Outcome,
  readJob,
  readOutcome,
  readOwner,
  reap,
  releaseDelivery,
  type StopResult,
  stopJobs,
  tailOf,
  takeHandover,
  wasDelivered,
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
  /**
   * Sweeps the job root, then arms the watcher. The sweep takes on this Pi's jobs handed over by
   * a `/reload`, starts stopping the survivors of a Pi that is gone without waiting for them, and
   * queues the ends of this session's jobs that were never told. A dir with no owner record is
   * skipped.
   */
  start(): Promise<void>;
  /**
   * Stops every running job (SIGTERM, then SIGKILL after `graceMs`) and everything that polls
   * or retries, and waits for the sweep's stop of survivors. With `handOver`, for a `/reload`,
   * the jobs are marked for the next session of this Pi and left running. Awaited by the caller;
   * nothing is told to the model afterwards.
   */
  stop(o?: { handOver?: boolean }): Promise<void>;
  /**
   * Stops the running job `target` names (an id or a unique prefix), or all of them, for the
   * user. Gives the words for the user; the model is told of it in a message that starts no turn.
   */
  stopByUser(target: string): Promise<string>;
  /** Every job, oldest start first. */
  jobs(): readonly ShellSnapshot[];
  /** Calls `listener` synchronously after every change to the jobs; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Tells the model which jobs still run, after a `/compact` dropped what it knew; starts no turn. */
  rollCall(): void;
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

/** How a job ended, for the model: `exited with code 2 after 41s`. A stop reason wins over the exit. */
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
      switch (outcome.stopReason) {
        case "session":
          return "stopped when the session that started it ended";
        case "pi":
          return `ended with Pi after ${after}; its exit status was lost`;
        case "user":
          return `stopped by the user after ${after}`;
        default:
          return `stopped at your request after ${after}`;
      }
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
  /** Whether telling it starts a turn: not for what a sweep finds when a session is resumed. */
  wantsTurn: boolean;
}

/** All `bash_stop` knows once its signal emptied the group and the job's files cannot be read. */
const SIGNALLED: Outcome = { status: "aborted", stopReason: "agent" };

/** A job's pid still carries the start time recorded for it: the pid was not reused. */
const sameStart = async (job: JobRecord) =>
  (await identify(job.pid))?.token === job.token;

/**
 * Stops the jobs a `/reload` handed to this Pi when no session will serve them (the new
 * `session_start` returns early or steps aside), so nothing outlives skyr's ownership. `owner`
 * is this Pi's token; one stop for all, reason `session`.
 */
export async function stopHandedOver(
  root: string,
  owner: string,
  graceMs: number,
): Promise<void> {
  const handed: JobRecord[] = [];
  for (const dir of await listJobDirs(root)) {
    const [record, recorded] = await Promise.all([
      readJob(dir),
      readOwner(dir),
    ]);
    if (
      record &&
      recorded?.pid === process.pid &&
      recorded.token === owner &&
      (await takeHandover(dir))
    )
      handed.push(record);
  }
  if (handed.length > 0)
    await stopJobs(handed, "session", async () => true, graceMs);
}

export function createShellSession(o: {
  root: string;
  sessionId: string;
  /** This Pi's `identify(process.pid)` token, recorded with every job. */
  owner: string;
  /** Milliseconds between SIGTERM and SIGKILL when a job is stopped. */
  graceMs: number;
  pi: Pick<PiModule, "truncateTail" | "formatSize">;
  /** The `session_start` reason was `reload`: jobs handed over by the last session are taken on. */
  reload: boolean;
  /** Delivers `text` to the model as a message. May throw on a stale session. */
  send(
    text: string,
    jobs: ShellSnapshot[],
    how: { triggerTurn: boolean },
  ): void;
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
  /** The sweep's stop of a gone Pi's survivors, still under way or over. */
  let stopping: Promise<void> = Promise.resolve();

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
      // A stale session: an end still undelivered is told when the job's session next starts.
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
        { triggerTurn: sent.some((i) => i.wantsTurn) },
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
    if (
      end.afterLinger ||
      outcome.stopReason === "agent" ||
      outcome.stopReason === "session"
    )
      return store.put(job);
    const head = lingering
      ? `its shell exited with code ${outcome.exitCode} after ${duration((outcome.endedAt ?? Date.now()) - record.startedAt)}; processes remain in its process group. Stop it with bash_stop.`
      : ending(outcome, record.startedAt, Date.now());
    const text = await report(record, head, end.tail);
    if (closed) return;
    // With the push: whoever sees the end in the store finds its delivery pending.
    store.put(job);
    // The user who stopped it knows; the model reads of it on its next turn
    pending.push({
      dir: record.dir,
      text,
      job,
      wantsTurn: outcome.stopReason !== "user",
    });
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
          : await readOutcome(record.dir).catch(() => SIGNALLED);
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
    const { exitCode } = await readOutcome(record.dir).catch(() => SIGNALLED);
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

  /** Holds a job this Pi started, whose shell is not over yet or whose end only polling finds. */
  function hold(job: JobRecord, handedOver?: true): void {
    store.put(snapshotOf(job));
    watcher.add(job, handedOver);
    let resolve = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    shellsOver.set(job.id, { promise, resolve });
    // Nothing reports a handed-over job's shell over; its exit is read from the file
    if (handedOver) resolve();
  }

  /**
   * Queues the end of one of this session's jobs that was never told. `head` replaces the words
   * for how it ended; `ownerAlive` is asked only when the exit status alone cannot say.
   */
  async function tellUndelivered(
    record: JobRecord,
    how: { head?: string; ownerAlive?: () => Promise<boolean> } = {},
  ): Promise<void> {
    if (await wasDelivered(record.dir, o.sessionId)) return;
    let outcome = await readOutcome(record.dir);
    // Killed with Pi, or no exit at all: only a gone owner makes that the end of the job
    const silent =
      outcome.stopReason === undefined &&
      (outcome.status === "unknown" ||
        outcome.exitCode === 137 ||
        outcome.exitCode === 143);
    if (silent && !(await how.ownerAlive?.()))
      outcome = { ...outcome, status: "aborted", stopReason: "pi" };
    const tail = await tailOf(record.dir, o.pi.truncateTail).catch(() => "");
    pending.push({
      dir: record.dir,
      text: await report(
        record,
        how.head ?? ending(outcome, record.startedAt, Date.now()),
        tail,
      ),
      job: snapshotOf(record, { outcome, lingering: false }),
      wantsTurn: o.reload,
    });
  }

  /** Looks at one job dir; gives the job back when its owner is gone and it still runs. */
  async function inspect(dir: string): Promise<JobRecord | undefined> {
    const record = await readJob(dir);
    const owner = await readOwner(dir);
    // No owner record is no evidence that the owner is gone
    if (!record || !owner) return;
    const mine = record.sessionId === o.sessionId;
    const here = owner.pid === process.pid && owner.token === o.owner;
    // A mark for this pid and token was left by this process, whatever session starts now:
    // hold the job, so it never runs unowned. Consumed whatever happens.
    const handedOver = mine && here && (await takeHandover(dir));
    const ended = await hasEnded(dir);
    if (handedOver && !ended) return void hold(record, true);
    const ownerAlive = async () =>
      here || (await identify(owner.pid))?.token === owner.token;
    if (!ended && groupAlive(record.pgid)) {
      // Another live Pi's job, or this Pi's under another session
      return (await ownerAlive()) ? undefined : record;
    }
    if (!ended && here && (await readOutcome(dir)).status === "unknown")
      // This Pi's continuation may still be writing the exit
      return;
    await markEnded(dir).catch(complain);
    if (mine) await tellUndelivered(record, { ownerAlive });
  }

  /** What follows the stop of a survivor whose owner is gone. */
  async function afterStop(
    record: JobRecord,
    result: StopResult | undefined,
  ): Promise<void> {
    const mine = record.sessionId === o.sessionId;
    if (result?.skipped && groupAlive(record.pgid)) {
      // Not marked ended: the group is not known to be the job's, so it may still be running
      if (mine)
        await tellUndelivered(record, {
          head: `its owner is gone and processes remain in its process group ${record.pgid}, which could not be confirmed as the job's, so they were not signalled; tell the user, and do not signal them yourself (they can check ps -g ${record.pgid})`,
        });
      return;
    }
    await markEnded(record.dir).catch(complain);
    if (mine) await tellUndelivered(record);
  }

  async function sweep(): Promise<void> {
    await reap(o.root, Date.now()).catch(complain);
    const survivors: JobRecord[] = [];
    for (const dir of await listJobDirs(o.root).catch(() => [])) {
      try {
        const survivor = await inspect(dir);
        if (survivor) survivors.push(survivor);
      } catch (error: unknown) {
        complain(error);
      }
    }
    // A session closed during the inspect has no stop left to wait for this one
    if (survivors.length === 0 || closed) return;
    // Not awaited: Pi waits for session_start, and a survivor may ignore SIGTERM for the grace
    stopping = stopSurvivors(survivors).catch(complain);
  }

  async function stopSurvivors(survivors: JobRecord[]): Promise<void> {
    // One call, so the grace periods of several survivors do not add up
    const results = await stopJobs(survivors, "pi", sameStart, o.graceMs).catch(
      (error: unknown) => {
        complain(error);
        return undefined;
      },
    );
    for (const [i, record] of survivors.entries()) {
      // After a failed stop, a group still alive is left to the next sweep, not marked ended
      if (!results && groupAlive(record.pgid)) continue;
      await afterStop(record, results?.[i]).catch(complain);
    }
    if (!closed && pending.length > 0) {
      wake();
      flushIfIdle();
    }
  }

  return {
    async start() {
      await sweep();
      if (closed) return;
      watcher.start();
      if (pending.length > 0) {
        wake();
        flushIfIdle();
      }
    },
    rollCall() {
      const running = store.jobs().filter(active);
      if (closed || running.length === 0) return;
      const lines = running.map((j) => `${jobLine(j)}, log ${j.log}`);
      try {
        o.send(
          `[background jobs still running: ${lines.join("; ")}. You will be told when each ends; do not poll.]`,
          running,
          { triggerTurn: false },
        );
      } catch (error: unknown) {
        complain(error);
      }
    },
    async stop(how) {
      closed = true;
      pending = [];
      if (how?.handOver) {
        // The next session's sweep would find these survivors again, still mid-stop
        await stopping;
        for (const { record, ended } of watcher.records())
          if (!ended) await markHandover(record.dir).catch(complain);
        watcher.dispose();
        return;
      }
      // At once: survivors are a gone Pi's and the watcher's jobs this one's, so no job is in both
      await Promise.all([
        stopping,
        watcher.stop("all", "session").catch(complain),
      ]);
      watcher.dispose();
    },
    async stopByUser(target) {
      const running = store.jobs().filter(active);
      const matches =
        target === "all"
          ? running
          : running.filter((j) => target !== "" && j.id.startsWith(target));
      const ids = matches.map((j) => j.id);
      if (ids.length === 0 || (target !== "all" && ids.length > 1))
        return `shells: ${ids.length === 0 ? "nothing matches" : "more than one id matches"} ${quoted(target, 40)}; running: ${running.map((j) => j.id).join(", ") || "none"}`;
      await watcher.stop(ids, "user");
      return `shells: stopped ${ids.join(", ")}`;
    },
    jobs: () => store.jobs(),
    subscribe: (listener) => store.subscribe(listener),
    owner: () => (closed ? undefined : o.owner),
    track: (job) => hold(job),
    exited(job) {
      shellsOver.get(job.id)?.resolve();
      return watcher.exited(job.id);
    },
    stopJob,
  };
}
