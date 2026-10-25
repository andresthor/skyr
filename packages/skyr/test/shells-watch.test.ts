// The watcher against real bash jobs: the shell's end, linger, exactly-once ends, the late exit,
// a guarded tick and its timer. The interval is fake and fired by hand; each job's shell is
// reported over by the test, as the owner's continuation does in production.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import {
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import {
  groupAlive,
  type JobRecord,
  readOutcome,
  tailOf,
} from "../src/shells/job.js";
import { createWatcher, type JobEnd } from "../src/shells/watch.js";
import {
  appears,
  finish,
  gated,
  gateFile,
  shellOver,
  spawnJob as start,
} from "./shells-jobs.js";

function watch(tail = (dir: string) => tailOf(dir, truncateTail)) {
  const clock = { now: 0 };
  const ends: JobEnd[] = [];
  const errors: unknown[] = [];
  const counts = { ticks: 0 };
  let ticked: (() => void)[] = [];
  const watcher = createWatcher({
    now: () => clock.now,
    graceMs: 150,
    tail,
    onEnd: (end) => {
      ends.push(end);
    },
    onError: (error) => errors.push(error),
    onTick: () => {
      counts.ticks += 1;
      for (const done of ticked) done();
      ticked = [];
    },
  });
  onTestFinished(() => watcher.dispose());
  watcher.start();
  /** Fires the interval once and resolves when that tick's I/O has finished. */
  const tick = async () => {
    const done = new Promise<void>((resolve) => {
      ticked.push(resolve);
    });
    await vi.advanceTimersByTimeAsync(250);
    await done;
  };
  /** Resolves when the next tick's I/O has finished, however it was fired. */
  const tickDone = () =>
    new Promise<void>((resolve) => {
      ticked.push(resolve);
    });
  /** The job's shell exits, its `exit` is written, and the watcher is told, in production order. */
  const over = async (job: JobRecord) => {
    await finish(job);
    await watcher.exited(job.id);
  };
  return { watcher, clock, ends, errors, counts, tick, tickDone, over };
}

/** Resolves once nothing is left in the job's group: what a tick's check sees, whatever the shell did. */
const emptied = (job: JobRecord) => appears(() => !groupAlive(job.pgid));

/** A `tail` that holds every call until `release()`; `reached(n)` resolves at the n-th call. */
function heldTail() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = { n: 0 };
  const tail = async (dir: string) => {
    calls.n += 1;
    await gate;
    return tailOf(dir, truncateTail);
  };
  const reached = (n: number) => appears(() => calls.n >= n);
  return { tail, calls, reached, release: () => release() };
}

beforeEach(() => {
  // Only the tick is fake: stops and the waits below run on real timers.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

test("a shell that exits while its & child runs gets one linger end at 5 s, then a state-only end when the child exits", async () => {
  const flag = gateFile();
  const job = await start(`${gated(flag)} & echo started; exit 0`);
  const w = watch();
  w.watcher.add(job);
  await w.over(job);
  w.clock.now = 4_999;
  await w.tick();
  expect(w.ends).toEqual([]);
  w.clock.now = 5_000;
  await w.tick();
  expect(w.ends).toHaveLength(1);
  expect(w.ends[0]).toMatchObject({
    lingering: true,
    afterLinger: false,
    outcome: { status: "done", exitCode: 0 },
    tail: "started\n",
  });
  writeFileSync(flag, "");
  await emptied(job);
  await w.tick();
  expect(w.ends[1]).toMatchObject({
    lingering: false,
    afterLinger: true,
    outcome: { status: "done", exitCode: 0 },
  });
  expect(w.watcher.get(job.id)).toMatchObject({ ended: { status: "done" } });
  expect(vi.getTimerCount()).toBe(0);
});

test("stopping a lingering job reports the stop with its shell's exit code, and stopping it again signals nothing", async () => {
  const job = await start("sleep 30 & exit 4");
  const w = watch();
  w.watcher.add(job);
  await w.over(job);
  w.clock.now = 5_000;
  await w.tick();
  expect(w.ends).toHaveLength(1);
  expect(await w.watcher.stop([job.id], "agent")).toEqual([
    { killed: false, survived: false },
  ]);
  expect(groupAlive(job.pgid)).toBe(false);
  expect(w.ends).toHaveLength(2);
  expect(w.ends[1]).toMatchObject({
    lingering: false,
    afterLinger: false,
    outcome: { status: "aborted", stopReason: "agent", exitCode: 4 },
  });
  expect(await readOutcome(job.dir)).toEqual(w.ends[1]?.outcome);
  expect(await w.watcher.stop([job.id, "ffffffff"], "user")).toEqual([
    { killed: false, survived: false },
    { killed: false, survived: false },
  ]);
  expect(w.ends).toHaveLength(2);
  expect(w.watcher.get(job.id.slice(0, 3))).toMatchObject({
    ended: { stopReason: "agent" },
  });
});

test("a job that ends once its shell is reported over, with its exit and no tick", async () => {
  const job = await start("echo hi; exit 3");
  const w = watch();
  w.watcher.add(job);
  await w.over(job);
  expect(w.ends).toHaveLength(1);
  expect(w.ends[0]).toMatchObject({
    lingering: false,
    tail: "hi\n",
    outcome: { status: "failed", exitCode: 3 },
  });
  expect(vi.getTimerCount()).toBe(0);
});

test("a job is not polled before its shell is over, however empty its group reads", async () => {
  const job = await start("sleep 30");
  const w = watch();
  w.watcher.add(job);
  process.kill(-job.pgid, "SIGKILL");
  await shellOver(job);
  expect(vi.getTimerCount()).toBe(0);
  expect(w.ends).toEqual([]);
});

test("the shell's end and a user stop both finalizing a job is reported once", async () => {
  const held = heldTail();
  const job = await start("exit 0");
  const w = watch(held.tail);
  w.watcher.add(job);
  const reported = w.over(job);
  await held.reached(1);
  const stopping = w.watcher.stop([job.id], "user");
  await held.reached(2);
  held.release();
  expect(await stopping).toEqual([{ killed: false, survived: false }]);
  await reported;
  expect(w.ends).toHaveLength(1);
  expect(w.ends[0]).toMatchObject({
    lingering: false,
    afterLinger: false,
    outcome: { status: "done", exitCode: 0 },
  });
});

test("a job whose log cannot be read still ends once with an empty tail and the error reported once, and one whose log is gone ends with no error", async () => {
  const broken = await start("exit 1", { id: "00000001" });
  const done = await start("exit 0", { id: "00000002" });
  const gone = await start("exit 0", { id: "00000003" });
  const w = watch(async (dir) => {
    if (dir === broken.dir) throw new Error("unreadable log");
    return tailOf(dir, truncateTail);
  });
  for (const job of [broken, done, gone]) w.watcher.add(job);
  rmSync(join(gone.dir, "out.log"));
  for (const job of [broken, done, gone]) await w.over(job);
  expect(w.errors).toEqual([new Error("unreadable log")]);
  expect(w.ends.map((end) => [end.record.id, end.tail])).toEqual([
    ["00000001", ""],
    ["00000002", ""],
    ["00000003", ""],
  ]);
  expect(w.ends[0]?.outcome).toMatchObject({ status: "failed", exitCode: 1 });
});

test("a record whose poll throws goes to onError, the others keep being watched, and it still ends", async () => {
  const broken = await start("sleep 30", { id: "00000001" });
  const done = await start("echo done; exit 0", { id: "00000002" });
  const w = watch();
  w.watcher.add(broken);
  w.watcher.add(done, true);
  // An exit that is a directory makes every read of it fail with EISDIR.
  mkdirSync(join(broken.dir, "exit"));
  await w.watcher.exited(broken.id);
  expect(w.errors).toMatchObject([{ code: "EISDIR" }]);
  await finish(done);
  await emptied(done);
  await w.tick();
  expect(w.ends.map((end) => end.record.id)).toEqual(["00000002"]);
  process.kill(-broken.pgid, "SIGKILL");
  await emptied(broken);
  // An exit it cannot read is waited for like a missing one: it takes a second tick
  await w.tick();
  await w.tick();
  expect(w.ends[1]).toMatchObject({
    record: { id: "00000001" },
    outcome: { status: "unknown" },
  });
});

test.each([
  ["still finds none", undefined, { status: "unknown" }],
  [
    "finds the exit that landed",
    "7 1700000000\n",
    { status: "failed", exitCode: 7 },
  ],
] as const)(
  "a group that is empty with no exit when the shell is reported over ends only when the next tick (250 ms) %s",
  async (_name, exit, outcome) => {
    const job = await start("sleep 30");
    const w = watch();
    w.watcher.add(job);
    process.kill(-job.pgid, "SIGKILL");
    await emptied(job);
    await w.watcher.exited(job.id);
    expect(w.ends).toEqual([]);
    if (exit) writeFileSync(join(job.dir, "exit"), exit);
    await w.tick();
    expect(w.ends).toHaveLength(1);
    expect(w.ends[0]).toMatchObject({ outcome });
  },
);

test("the group emptying after the shell is reported over ends the job on the next tick, with its exit", async () => {
  const flag = gateFile();
  const job = await start(`${gated(flag)} & exit 6`);
  const w = watch();
  w.watcher.add(job);
  await w.over(job);
  expect(w.ends).toEqual([]);
  writeFileSync(flag, "");
  await emptied(job);
  await w.tick();
  expect(w.ends[0]).toMatchObject({ outcome: { exitCode: 6 } });
});

test("a job whose dir vanished is watched by its group and ends once as unknown, with no errors", async () => {
  const job = await start("sleep 30");
  const w = watch();
  w.watcher.add(job);
  rmSync(job.dir, { recursive: true, force: true });
  await w.watcher.exited(job.id);
  await w.tick();
  expect(w.ends).toEqual([]);
  process.kill(-job.pgid, "SIGTERM");
  await emptied(job);
  await w.tick();
  expect(w.ends).toHaveLength(1);
  expect(w.ends[0]).toMatchObject({
    lingering: false,
    outcome: { status: "unknown" },
    tail: "",
  });
  expect(w.errors).toEqual([]);
});

test("a stop with one job's dir gone still stops the other, and each ends once with the stop's reason", async () => {
  const gone = await start("sleep 30", { id: "00000001" });
  const kept = await start("sleep 30", { id: "00000002" });
  const w = watch();
  w.watcher.add(gone);
  w.watcher.add(kept);
  rmSync(gone.dir, { recursive: true, force: true });
  expect(await w.watcher.stop("all", "session")).toEqual([
    { killed: false, survived: false },
    { killed: false, survived: false },
  ]);
  expect(groupAlive(gone.pgid)).toBe(false);
  expect(groupAlive(kept.pgid)).toBe(false);
  expect(w.ends.map((end) => [end.record.id, end.outcome])).toEqual([
    [
      "00000001",
      expect.objectContaining({ status: "aborted", stopReason: "session" }),
    ],
    [
      "00000002",
      expect.objectContaining({ status: "aborted", stopReason: "session" }),
    ],
  ]);
  expect(w.errors).toEqual([]);
});

test("a slow tick does not overlap the next one", async () => {
  const held = heldTail();
  const flag = gateFile();
  const job = await start(`${gated(flag)} & exit 0`);
  const w = watch(held.tail);
  w.watcher.add(job);
  await w.over(job);
  expect(vi.getTimerCount()).toBe(1);
  writeFileSync(flag, "");
  await emptied(job);
  await vi.advanceTimersByTimeAsync(250);
  await held.reached(1);
  const before = w.counts.ticks;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(held.calls.n).toBe(1);
  expect(w.counts.ticks).toBe(before);
  const done = w.tickDone();
  held.release();
  await done;
  expect(w.counts.ticks).toBe(before + 1);
  expect(w.ends).toHaveLength(1);
});

test("with only ended jobs no timer is armed, and wake keeps one armed until idle", async () => {
  const job = await start("exit 0");
  const w = watch();
  expect(vi.getTimerCount()).toBe(0);
  w.watcher.add(job);
  await w.over(job);
  expect(w.ends).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
  let pending = true;
  w.watcher.wake(() => !pending);
  await w.tick();
  await w.tick();
  expect(vi.getTimerCount()).toBe(1);
  pending = false;
  await w.tick();
  expect(vi.getTimerCount()).toBe(0);
  expect(w.counts.ticks).toBe(3);
});
