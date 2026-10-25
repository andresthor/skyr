// A shell session against real jobs: how an end reaches the model, and how a job is stopped. The
// watcher's interval and the clock are fake and driven by hand; everything else runs on real
// files and processes, and each job's shell is reported over by the test, as the owner's
// continuation does in production.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import {
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import { groupAlive, type JobRecord, readOutcome } from "../src/shells/job.js";
import { createShellSession, stopHandedOver } from "../src/shells/session.js";
import type { ShellSnapshot } from "../src/shells/store.js";
import { scratchDir } from "./session.js";
import {
  appears,
  deadPid,
  fileAppears,
  finish,
  shellOver,
  spawnJob,
  spawnTrapped,
} from "./shells-jobs.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function harness(
  o: {
    graceMs?: number;
    root?: string;
    sessionId?: string;
    reload?: boolean;
    /** Leave the sweep to the test, once it has set its jobs up. */
    hold?: boolean;
  } = {},
) {
  const root = o.root ?? scratchDir("shells");
  const sent: {
    text: string;
    jobs: ShellSnapshot[];
    triggerTurn: boolean;
  }[] = [];
  let idleWaiters: (() => void)[] = [];
  const state = { idle: true, strandOnce: undefined as string | undefined };
  const session = createShellSession({
    root,
    sessionId: o.sessionId ?? "s1",
    reload: o.reload ?? false,
    owner: "owner-token",
    graceMs: o.graceMs ?? 100,
    pi: { truncateTail, formatSize },
    send: (text, jobs, how) => {
      sent.push({ text, jobs, ...how });
    },
    isIdle: () => {
      for (const done of idleWaiters) done();
      idleWaiters = [];
      // A prompt that starts while the end is being claimed
      if (state.strandOnce && existsSync(state.strandOnce)) {
        state.strandOnce = undefined;
        return false;
      }
      return state.idle;
    },
  });
  onTestFinished(() => session.stop());
  if (!o.hold) await session.start();
  /** One watcher tick, with its I/O finished: the tick ends by asking whether the session is idle. */
  const tick = async () => {
    // No interval armed: whatever re-arms it is still on its way
    if (vi.getTimerCount() === 0) {
      await new Promise((resolve) => setImmediate(resolve));
      return;
    }
    const done = new Promise<void>((resolve) => {
      idleWaiters.push(resolve);
    });
    await vi.advanceTimersByTimeAsync(250);
    await done;
  };
  /** Ticks until `n` messages have been sent. */
  const delivered = async (n: number) => {
    while (sent.length < n) await tick();
  };
  /** The job's shell exits, its `exit` is written, and the session is told, in production order. */
  const over = async (job: JobRecord) => {
    await finish(job);
    await session.exited(job);
  };
  return { root, sent, state, session, tick, delivered, over };
}

test("the session's owner is this Pi's token until it has stopped", async () => {
  const h = await harness();
  expect(h.session.owner()).toBe("owner-token");
  await h.session.stop();
  expect(h.session.owner()).toBeUndefined();
});

test("a job that ends is told once, to an idle session, with its code, command, last output and log", async () => {
  const h = await harness();
  const job = await spawnJob("echo hi; exit 3", { root: h.root });
  h.session.track(job);
  await h.over(job);
  await h.delivered(1);
  const [message] = h.sent;
  expect(message?.text.split("\n")).toEqual([
    expect.stringMatching(
      /^\[background job "echo hi; exit 3" \(id ab12cd34\): exited with code 3 after \d+s\]$/,
    ),
    `$ echo hi; exit 3   (in ${job.cwd})`,
    "hi",
    `Log: ${join(job.dir, "out.log")} (3B)`,
  ]);
  expect(message?.jobs).toMatchObject([
    { id: "ab12cd34", status: "failed", exitCode: 3 },
  ]);
  // Nothing is left to poll once the end is told
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.sent).toHaveLength(1);
});

test("an end is held while the session is busy, and told at the first tick after it goes idle", async () => {
  const h = await harness();
  h.state.idle = false;
  const job = await spawnJob("exit 0", { root: h.root });
  h.session.track(job);
  await h.over(job);
  await h.tick();
  await h.tick();
  expect(h.sent).toEqual([]);
  h.state.idle = true;
  await h.delivered(1);
  expect(h.sent[0]?.text).toContain("exited with code 0");
});

test("a send that a prompt overtook during the claim is released and told on a later tick", async () => {
  const h = await harness();
  const job = await spawnJob("exit 0", { root: h.root });
  const marker = join(job.dir, "delivered.s1");
  h.state.strandOnce = marker;
  h.session.track(job);
  await h.over(job);
  await h.delivered(1);
  // A claim that was not released could not have been made again
  expect(h.state.strandOnce).toBeUndefined();
  expect(existsSync(marker)).toBe(true);
  expect(h.sent).toHaveLength(1);
});

test("two ends waiting for an idle session are told in one message", async () => {
  const h = await harness();
  h.state.idle = false;
  const a = await spawnJob("exit 0", { root: h.root, id: "aaaa0001" });
  const b = await spawnJob("exit 1", { root: h.root, id: "bbbb0002" });
  h.session.track(a);
  h.session.track(b);
  await h.over(a);
  await h.over(b);
  await h.tick();
  expect(h.sent).toEqual([]);
  h.state.idle = true;
  await h.delivered(1);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]?.text.split("\n\n---\n\n")).toHaveLength(2);
  expect(h.sent[0]?.jobs.map((j) => j.id)).toEqual(["aaaa0001", "bbbb0002"]);
});

test("an end names the jobs that still run", async () => {
  const h = await harness();
  const done = await spawnJob("exit 0", { root: h.root, id: "aaaa0001" });
  const live = await spawnJob("sleep 30", { root: h.root, id: "bbbb0002" });
  h.session.track(done);
  h.session.track(live);
  await h.over(done);
  await h.delivered(1);
  expect(h.sent[0]?.text).toMatch(
    /\nStill running: bbbb0002 "sleep 30" \(\d+s\)\. You will be told when each ends; do not poll\.$/,
  );
});

test("a shell that exits and leaves processes running is told once as lingering, five seconds on", async () => {
  const h = await harness();
  const job = await spawnJob("sleep 30 & exit 3", { root: h.root });
  h.session.track(job);
  await h.over(job);
  await h.tick();
  expect(h.sent).toEqual([]);
  vi.setSystemTime(Date.now() + 5_000);
  await h.delivered(1);
  expect(h.sent[0]?.text.split("\n")[0]).toMatch(
    /^\[background job "sleep 30 & exit 3" \(id ab12cd34\): its shell exited with code 3 after \d+s; processes remain in its process group\. Stop it with bash_stop\.\]$/,
  );
  expect(h.sent[0]?.jobs[0]).toMatchObject({ lingering: true });
});

test.each([
  ["exit 124 reads as timed out", "exit 124", /\): timed out after \d+s\]\n/],
  ["no output says so", "exit 0", /\n\(no output\)\nLog: /],
])("an end told with %s", async (_name, command, expected) => {
  const h = await harness();
  const job = await spawnJob(command, { root: h.root });
  h.session.track(job);
  await h.over(job);
  await h.delivered(1);
  expect(h.sent[0]?.text).toMatch(expected);
});

test("stop ends every running job, a job that ignores SIGTERM after the grace, and tells no one", async () => {
  const h = await harness();
  const calm = await spawnTrapped("", { root: h.root, id: "aaaa0001" });
  const stubborn = await spawnTrapped("trap '' TERM", {
    root: h.root,
    id: "bbbb0002",
  });
  h.session.track(calm);
  h.session.track(stubborn);
  await h.session.stop();
  await Promise.all([shellOver(calm), shellOver(stubborn)]);
  expect(groupAlive(calm.pgid)).toBe(false);
  expect(groupAlive(stubborn.pgid)).toBe(false);
  expect(await readOutcome(stubborn.dir)).toMatchObject({
    status: "aborted",
    stopReason: "session",
  });
  expect(vi.getTimerCount()).toBe(0);
  expect(h.sent).toEqual([]);
});

test("bash_stop's stop ends the job, words how, and the job is not told again", async () => {
  const h = await harness();
  const ready = join(scratchDir("ready"), "ready");
  const job = await spawnJob(`echo working; touch '${ready}'; sleep 30`, {
    root: h.root,
  });
  h.session.track(job);
  await fileAppears(ready);
  const stopping = h.session.stopJob("ab12");
  await h.over(job);
  const { text, job: snapshot } = await stopping;
  const lines = text.split("\n");
  const log = join(job.dir, "out.log");
  expect(lines[0]).toMatch(
    /^Stopped job ab12cd34 ".*" after \d+s \(SIGTERM; exit code 143\)\. Last output:$/,
  );
  expect(lines[1]).toBe("working");
  expect(lines.at(-1)).toBe(`Log: ${log}`);
  expect(snapshot).toMatchObject({ status: "aborted", stopReason: "agent" });
  // Nothing is left to poll: the stop was the job's end
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.sent).toEqual([]);
});

test("a stop whose job files cannot be read still reports the stop it made", async () => {
  const h = await harness();
  const job = await spawnJob("sleep 30", { root: h.root });
  h.session.track(job);
  // A directory where the stop record goes: reading it fails with EISDIR
  mkdirSync(join(job.dir, "stop.json"));
  const { text } = await h.session.stopJob(job.id);
  expect(text).toMatch(/^Stopped job ab12cd34 ".*" after \d+s \(SIGTERM\)/);
  expect(groupAlive(job.pgid)).toBe(false);
});

test("bash_stop says when a job ignored SIGTERM and needed SIGKILL", async () => {
  const h = await harness();
  const job = await spawnTrapped("trap '' TERM", { root: h.root });
  h.session.track(job);
  const stopping = h.session.stopJob(job.id);
  await h.over(job);
  expect((await stopping).text).toContain("ignored SIGTERM");
  expect(groupAlive(job.pgid)).toBe(false);
});

test("bash_stop on a job that already ended is a normal result, and claims its end so it is not told too", async () => {
  const h = await harness();
  h.state.idle = false;
  const job = await spawnJob("exit 3", { root: h.root });
  h.session.track(job);
  await h.over(job);
  await h.tick();
  const { text } = await h.session.stopJob(job.id);
  expect(text).toMatch(
    /^Job ab12cd34 had already ended: exited with code 3 after \d+s\. Nothing to stop\.$/,
  );
  h.state.idle = true;
  await h.tick();
  expect(h.sent).toEqual([]);
});

test("bash_stop on an unknown id names what runs, and on an ambiguous prefix the ids it matches", async () => {
  const h = await harness();
  await expect(h.session.stopJob("abcd1234")).rejects.toThrow(
    'bash_stop: no job "abcd1234". Running: none.',
  );
  const a = await spawnJob("sleep 30", { root: h.root, id: "ab000001" });
  const b = await spawnJob("sleep 31", { root: h.root, id: "ab000002" });
  h.session.track(a);
  h.session.track(b);
  await expect(h.session.stopJob("ff")).rejects.toThrow(
    /^bash_stop: no job "ff"\. Running: ab000001 "sleep 30" \(\d+s\), ab000002 "sleep 31" \(\d+s\)\.$/,
  );
  await expect(h.session.stopJob("ab")).rejects.toThrow(
    'bash_stop: "ab" matches more than one job: ab000001, ab000002; pass the full id.',
  );
  await expect(h.session.stopJob("")).rejects.toThrow("bash_stop: no job");
  expect(groupAlive(a.pgid)).toBe(true);
});

// The sweep. It signals processes, so every job here lives in a temp root, a forged owner is a
// pid that is certainly gone, and every real child is a test job whose group is killed afterwards.

const writeOwner = (job: JobRecord, owner: { pid: number; token: string }) =>
  writeFileSync(join(job.dir, "owner.json"), JSON.stringify(owner));

/** The owner this test's sessions have: this process and their token. */
const ownedHere = (job: JobRecord) =>
  writeOwner(job, { pid: process.pid, token: "owner-token" });

/** A job whose owning Pi is gone: its owner record names a dead pid. */
async function orphan(command: string, o: { root?: string; id?: string }) {
  const job = await spawnJob(command, o);
  writeOwner(job, { pid: await deadPid(), token: "no such token" });
  return job;
}

test("a job whose owner is gone, with no exit, is told once as ended with Pi, by its own session", async () => {
  const h = await harness({ hold: true });
  const job = await orphan("exit 0", { root: h.root });
  await shellOver(job);
  await h.session.start();
  await h.delivered(1);
  expect(h.sent[0]?.text.split("\n")[0]).toMatch(
    /^\[background job "exit 0" \(id ab12cd34\): ended with Pi after \d+s; its exit status was lost\]$/,
  );
  // Found in a resumed session, not in the one that asked for a reload
  expect(h.sent[0]?.triggerTurn).toBe(false);
  const again = await harness({ root: h.root });
  await again.tick();
  expect(again.sent).toEqual([]);
  expect(h.sent).toHaveLength(1);
});

test("a quiet survivor of a gone Pi is stopped by another session's sweep and told by its own", async () => {
  const root = scratchDir("shells");
  const job = await orphan("sleep 30", { root });
  const other = await harness({ root, sessionId: "other", hold: true });
  await other.session.start();
  await shellOver(job);
  expect(groupAlive(job.pgid)).toBe(false);
  expect(await readOutcome(job.dir)).toMatchObject({
    status: "aborted",
    stopReason: "pi",
  });
  expect(other.sent).toEqual([]);
  const own = await harness({ root, hold: true });
  await own.session.start();
  await own.delivered(1);
  expect(own.sent[0]?.text).toMatch(
    /\): ended with Pi after \d+s; its exit status was lost\]\n/,
  );
}, 15_000);

test("a dir with no owner record is never touched", async () => {
  const root = scratchDir("shells");
  const job = await spawnJob("sleep 30", { root });
  rmSync(join(job.dir, "owner.json"));
  const h = await harness({ root, hold: true });
  await h.session.start();
  await h.tick();
  expect(groupAlive(job.pgid)).toBe(true);
  expect(existsSync(join(job.dir, "stop.json"))).toBe(false);
  expect(h.sent).toEqual([]);
});

test("a job whose pid no longer carries its token is never signalled", async () => {
  const root = scratchDir("shells");
  const job = await orphan("sleep 30", { root });
  const forged = { ...job, token: "someone else's start time" };
  writeFileSync(
    join(job.dir, "job.json"),
    JSON.stringify({ ...forged, dir: undefined }),
  );
  const h = await harness({ root, hold: true });
  await h.session.start();
  expect(groupAlive(job.pgid)).toBe(true);
  expect(existsSync(join(job.dir, "stop.json"))).toBe(false);
});

test.each([
  ["a recorded exit", true],
  ["no exit at all, as when it lost the race with process.exit", false],
])("a stop at the session's end beats %s", async (_name, withExit) => {
  const h = await harness({ hold: true });
  const job = await orphan("exit 0", { root: h.root });
  await shellOver(job);
  if (withExit) await finish(job);
  writeFileSync(
    join(job.dir, "stop.json"),
    JSON.stringify({ reason: "session", at: Date.now() }),
  );
  await h.session.start();
  await h.delivered(1);
  expect(h.sent[0]?.text.split("\n")[0]).toMatch(
    /^\[background job "exit 0" \(id ab12cd34\): stopped when the session that started it ended\]$/,
  );
});

test("a job that ended during a busy turn, then quit, is told once when the session is resumed", async () => {
  const first = await harness();
  first.state.idle = false;
  const job = await spawnJob("exit 3", { root: first.root });
  ownedHere(job);
  first.session.track(job);
  await first.over(job);
  await first.tick();
  await first.session.stop();
  expect(first.sent).toEqual([]);
  const resumed = await harness({ root: first.root });
  await resumed.delivered(1);
  expect(resumed.sent[0]?.text).toContain("exited with code 3");
  const later = await harness({ root: first.root });
  await later.tick();
  expect(later.sent).toEqual([]);
});

test.each<[string, { reload?: boolean; sessionId?: string }, boolean]>([
  ["a reload's next session", { reload: true }, true],
  ["a later session with the same id, reload or not", {}, true],
  ["a session with another id", { sessionId: "new" }, false],
])("a handed-over job is taken by %s", async (_name, o, takes) => {
  const first = await harness();
  const job = await spawnTrapped("", { root: first.root });
  ownedHere(job);
  first.session.track(job);
  await first.session.stop({ handOver: true });
  const next = await harness({ root: first.root, ...o });
  // A session of another id leaves the mark for the one that started the job
  const taker = takes ? next : await harness({ root: first.root });
  process.kill(-job.pgid, "SIGTERM");
  await finish(job);
  // Every process of the group is gone before the first tick looks, so the end is not a lingering one
  await appears(() => !groupAlive(job.pgid));
  await taker.delivered(1);
  expect(taker.sent[0]?.text).toMatch(
    /\): exited with code 143 after \d+s\]\n/,
  );
  expect(taker.sent[0]?.triggerTurn).toBe(true);
  expect(first.sent).toEqual([]);
  if (taker !== next) {
    await next.tick();
    expect(next.sent).toEqual([]);
  }
});

test("a job ended in the gap of a reload is told once", async () => {
  const first = await harness();
  const job = await spawnJob("exit 5", { root: first.root });
  ownedHere(job);
  first.session.track(job);
  await first.session.stop({ handOver: true });
  await finish(job);
  const next = await harness({ root: first.root, reload: true });
  await next.delivered(1);
  expect(next.sent[0]?.text).toContain("exited with code 5");
  expect(next.sent).toHaveLength(1);
});

test("after a compaction the model is told which jobs still run, and no turn starts", async () => {
  const h = await harness();
  h.session.rollCall();
  expect(h.sent).toEqual([]);
  const job = await spawnJob("sleep 30", { root: h.root });
  h.session.track(job);
  h.session.rollCall();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]?.triggerTurn).toBe(false);
  expect(h.sent[0]?.text).toMatch(
    new RegExp(
      `^\\[background jobs still running: ab12cd34 "sleep 30" \\(\\d+s\\), log ${join(job.dir, "out.log")}\\. You will be told when each ends; do not poll\\.\\]$`,
    ),
  );
});

test("jobs handed over to a Pi where no session will serve them are stopped for the session's end, and told later", async () => {
  const first = await harness();
  const job = await spawnJob("sleep 30", { root: first.root });
  ownedHere(job);
  first.session.track(job);
  await first.session.stop({ handOver: true });
  await stopHandedOver(first.root, "owner-token", 100);
  await shellOver(job);
  expect(groupAlive(job.pgid)).toBe(false);
  expect(await readOutcome(job.dir)).toMatchObject({
    status: "aborted",
    stopReason: "session",
  });
  expect(existsSync(join(job.dir, `handover.${process.pid}`))).toBe(false);
  const resumed = await harness({ root: first.root });
  await resumed.delivered(1);
  expect(resumed.sent[0]?.text).toContain(
    "stopped when the session that started it ended",
  );
});

test("survivors whose identity cannot be confirmed are not marked ended, and are told once as left running", async () => {
  const root = scratchDir("shells");
  const job = await orphan("sleep 30 & exit 0", { root });
  await shellOver(job);
  const h = await harness({ root, hold: true });
  await h.session.start();
  await h.delivered(1);
  expect(h.sent[0]?.text.split("\n")[0]).toContain(
    `processes remain in its process group ${job.pgid}`,
  );
  expect(groupAlive(job.pgid)).toBe(true);
  expect(existsSync(join(job.dir, "ended"))).toBe(false);
  expect(existsSync(join(job.dir, "stop.json"))).toBe(false);
  const again = await harness({ root });
  await again.tick();
  expect(again.sent).toEqual([]);
});

test("a user's stop ends the job, and the model is told in a message that starts no turn", async () => {
  const h = await harness();
  const job = await spawnJob("sleep 30", { root: h.root });
  h.session.track(job);
  const stopping = h.session.stopByUser("ab12");
  await h.over(job);
  expect(await stopping).toBe("shells: stopped ab12cd34");
  await h.delivered(1);
  expect(h.sent[0]?.text.split("\n")[0]).toMatch(
    /^\[background job "sleep 30" \(id ab12cd34\): stopped by the user after \d+s\]$/,
  );
  expect(h.sent[0]?.triggerTurn).toBe(false);
});

test("a user's stop of an id nothing matches says what runs, and signals nothing", async () => {
  const h = await harness();
  const job = await spawnJob("sleep 30", { root: h.root });
  h.session.track(job);
  expect(await h.session.stopByUser("ff")).toBe(
    'shells: nothing matches "ff"; running: ab12cd34',
  );
  expect(groupAlive(job.pgid)).toBe(true);
});
