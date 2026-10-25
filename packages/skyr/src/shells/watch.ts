/**
 * The one owner of the live job set. A job is polled only once its shell has exited (`exited`):
 * until the continuation has written `exit`, an empty process group says nothing, since Pi's exec
 * settles after the group empties. A tick then polls its process group; a job ends only when its
 * group is empty, and each end is reported once, from one place, and recorded in the job dir. A
 * group that is empty with no `exit` is looked at once more on the next tick (250 ms) before it
 * counts as lost. A shell that exits while processes it started live on is reported once as
 * lingering; when that group later empties on its own, its end is flagged `afterLinger`. A job
 * whose dir is removed is still watched by its group, and ends as `unknown`.
 */
import { existsSync } from "node:fs";
import { errnoOf } from "../tools/render.js";
import {
  groupAlive,
  type JobRecord,
  markEnded,
  type Outcome,
  readOutcome,
  type StopResult,
  stopJobs,
} from "./job.js";
import type { StopReason } from "./store.js";

const TICK_MS = 250;
const LINGER_MS = 5_000;

export interface JobEnd {
  record: JobRecord;
  outcome: Outcome;
  /** The shell exited and its group is still alive; the record keeps being polled. */
  lingering: boolean;
  /** The group emptied on its own after a linger end, which already told the end: state only. */
  afterLinger: boolean;
  /** Empty when the job dir is gone. */
  tail: string;
}

interface WatcherOptions {
  /** Epoch ms; the linger delay is measured on it. */
  now: () => number;
  /** The wait between SIGTERM and SIGKILL when a stop signals a group. */
  graceMs: number;
  tail: (dir: string) => Promise<string>;
  /** Awaited, so every end of one tick has been handled before `onTick` runs. */
  onEnd: (end: JobEnd) => void | Promise<void>;
  /** Gets what a tick or a stop threw; must not throw itself, since it runs on a timer. */
  onError: (error: unknown) => void;
  onTick: () => void;
}

interface Watcher {
  /**
   * Holds `record`; it is polled once `exited` says its shell is over, or from the next tick when
   * `handedOver`: the old owner's continuation reports to no one, so only polling finds its end.
   */
  add(record: JobRecord, handedOver?: true): void;
  /**
   * The shell of `id` has exited and its `exit` is written (or could not be): polls it now,
   * and on every tick until it ends. An unknown id does nothing.
   */
  exited(id: string): Promise<void>;
  /** Keep ticking until `idle()` returns true, checked after each `onTick`. */
  wake(idle: () => boolean): void;
  /** By unique id prefix; ended records stay until `dispose()`. */
  get(
    idOrPrefix: string,
  ): { record: JobRecord; ended?: Outcome } | "ambiguous" | undefined;
  records(): readonly { record: JobRecord; ended?: Outcome }[];
  /**
   * Stops the given ids, or every record that has not ended, and finalizes those whose group is
   * then gone; their `onEnd` carries `reason`. Results follow `ids` (every record for `"all"`);
   * an unknown or ended id gets `{killed: false, survived: false}` and no signal. When the stop
   * itself throws, it finalizes nothing and the tick goes on polling.
   */
  stop(ids: string[] | "all", reason: StopReason): Promise<StopResult[]>;
  /** Arms the tick; records added before it are not polled until then. */
  start(): void;
  /** Disarms the tick and forgets every record; an in-flight tick or stop reports nothing more. */
  dispose(): void;
}

interface Entry {
  record: JobRecord;
  ended?: Outcome;
  /** The shell has exited, so the tick polls the record. */
  polled: boolean;
  polling: boolean;
  /** The group was empty at the last tick and no `exit` was there. */
  emptySeen: boolean;
  exitSeenAt?: number;
  lingered: boolean;
  /** A stop owns the record until it returns; the tick leaves it alone. */
  stopping: boolean;
}

export function createWatcher(o: WatcherOptions): Watcher {
  const entries = new Map<string, Entry>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let disposed = false;
  let busy = false;
  let idle: (() => boolean) | undefined;

  const sync = () => {
    const wanted =
      started &&
      !disposed &&
      (idle !== undefined ||
        [...entries.values()].some((e) => e.polled && !e.ended));
    if (wanted && !timer) {
      timer = setInterval(() => void tick(), TICK_MS);
      timer.unref();
    } else if (!wanted && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  // A log that cannot be read never holds up an end; a removed one is not an error.
  const readTail = async (dir: string) =>
    existsSync(dir)
      ? o.tail(dir).catch((error: unknown) => {
          if (errnoOf(error) !== "ENOENT") o.onError(error);
          return "";
        })
      : "";

  /** `stop` is set when a stop finalizes; its `reason` when that stop signalled a live group. */
  async function finalize(
    entry: Entry,
    stop?: { reason?: StopReason },
  ): Promise<void> {
    const { dir } = entry.record;
    const tail = await readTail(dir);
    let outcome = await readOutcome(dir).catch((error: unknown): Outcome => {
      o.onError(error);
      return { status: "unknown" };
    });
    // A stop in flight finalizes the record itself, with its reason.
    if (entry.ended || disposed || (entry.stopping && !stop)) return;
    const stopped = stop?.reason;
    if (stopped && outcome.stopReason === undefined)
      // stop.json could not be written (the dir is gone, say), though the group was signalled.
      outcome = {
        ...outcome,
        status: "aborted",
        stopReason: stopped,
        endedAt: o.now(),
      };
    entry.ended = outcome;
    try {
      await o.onEnd({
        record: entry.record,
        outcome,
        lingering: false,
        afterLinger: entry.lingered && outcome.stopReason === undefined,
        tail,
      });
    } finally {
      await markEnded(dir).catch(o.onError);
    }
  }

  /** One poll of a record at a time: the shell's end and the tick can arrive together. */
  async function poll(entry: Entry): Promise<void> {
    if (entry.polling) return;
    entry.polling = true;
    try {
      await pollOnce(entry);
    } finally {
      entry.polling = false;
    }
  }

  async function pollOnce(entry: Entry): Promise<void> {
    const { dir, pgid } = entry.record;
    if (!groupAlive(pgid)) {
      // Not "unknown" yet: the continuation's `exit` may land a moment after the group empties.
      // An unreadable `exit` counts as missing here; `finalize` reports why it cannot be read.
      const lost = await readOutcome(dir).then(
        (outcome) => outcome.status === "unknown",
        () => true,
      );
      if (lost && !entry.emptySeen && existsSync(dir)) {
        entry.emptySeen = true;
        return;
      }
      return finalize(entry);
    }
    if (!existsSync(dir)) return;
    const outcome = await readOutcome(dir);
    if (outcome.exitCode !== undefined) entry.exitSeenAt ??= o.now();
    if (
      entry.lingered ||
      entry.exitSeenAt === undefined ||
      o.now() - entry.exitSeenAt < LINGER_MS
    )
      return;
    const tail = await readTail(dir);
    // A group that emptied meanwhile ends on the next tick instead.
    if (entry.stopping || disposed || !groupAlive(pgid)) return;
    entry.lingered = true;
    await o.onEnd({
      record: entry.record,
      outcome,
      lingering: true,
      afterLinger: false,
      tail,
    });
  }

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      for (const entry of [...entries.values()]) {
        if (entry.ended || entry.stopping || !entry.polled) continue;
        // One record's failure (an unreadable file, say) must not starve the others.
        try {
          await poll(entry);
        } catch (error: unknown) {
          o.onError(error);
        }
        if (disposed) return;
      }
      o.onTick();
      if (idle?.()) idle = undefined;
    } catch (error: unknown) {
      o.onError(error);
    } finally {
      busy = false;
      sync();
    }
  }

  const view = (e: Entry) => ({ record: e.record, ended: e.ended });

  return {
    add(record, handedOver) {
      entries.set(record.id, {
        record,
        polled: handedOver === true,
        polling: false,
        emptySeen: false,
        lingered: false,
        stopping: false,
      });
      sync();
    },
    async exited(id) {
      const entry = entries.get(id);
      if (!entry || entry.ended || entry.stopping || disposed) return;
      entry.polled = true;
      try {
        await poll(entry);
      } catch (error: unknown) {
        o.onError(error);
      }
      sync();
    },
    wake(check) {
      idle = check;
      sync();
    },
    get(idOrPrefix) {
      const found =
        idOrPrefix === ""
          ? []
          : [...entries.values()].filter((e) =>
              e.record.id.startsWith(idOrPrefix),
            );
      if (found.length > 1) return "ambiguous";
      return found[0] && view(found[0]);
    },
    records: () => [...entries.values()].map(view),
    async stop(ids, reason) {
      const asked =
        ids === "all"
          ? [...entries.values()]
          : ids.map((id) => entries.get(id));
      // No identity check: only held records not seen to end are signalled, since an ended
      // record's pgid may belong to a stranger by now.
      const live = asked.filter((e): e is Entry => e !== undefined && !e.ended);
      for (const e of live) e.stopping = true;
      let results: StopResult[];
      try {
        const signalled = live.filter((e) => groupAlive(e.record.pgid));
        results = await stopJobs(
          live.map((e) => e.record),
          reason,
          async () => true,
          o.graceMs,
        );
        for (const e of live) {
          try {
            if (!groupAlive(e.record.pgid))
              await finalize(e, {
                reason: signalled.includes(e) ? reason : undefined,
              });
          } catch (error: unknown) {
            o.onError(error);
          }
        }
      } finally {
        for (const e of live) e.stopping = false;
        sync();
      }
      const byEntry = new Map(live.map((e, i) => [e, results[i]]));
      return asked.map(
        (e) => (e && byEntry.get(e)) ?? { killed: false, survived: false },
      );
    },
    start() {
      started = true;
      sync();
    },
    dispose() {
      disposed = true;
      sync();
      entries.clear();
      idle = undefined;
    },
  };
}
