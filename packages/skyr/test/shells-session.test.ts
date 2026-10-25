// A shell session against real jobs: how an end reaches the model, and how a job is stopped. The
// watcher's interval and the clock are fake and driven by hand; everything else runs on real
// files and processes, and each job's shell is reported over by the test, as the owner's
// continuation does in production.
import { existsSync } from "node:fs";
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
import { createShellSession } from "../src/shells/session.js";
import type { ShellSnapshot } from "../src/shells/store.js";
import { scratchDir } from "./session.js";
import { fileAppears, finish, shellOver, spawnJob } from "./shells-jobs.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

function harness(o: { graceMs?: number } = {}) {
  const root = scratchDir("shells");
  const sent: { text: string; jobs: ShellSnapshot[] }[] = [];
  let idleWaiters: (() => void)[] = [];
  const state = { idle: true, strandOnce: undefined as string | undefined };
  const session = createShellSession({
    root,
    sessionId: "s1",
    owner: "owner-token",
    graceMs: o.graceMs ?? 100,
    pi: { truncateTail, formatSize },
    send: (text, jobs) => {
      sent.push({ text, jobs });
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
  session.start();
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
  const h = harness();
  expect(h.session.owner()).toBe("owner-token");
  await h.session.stop();
  expect(h.session.owner()).toBeUndefined();
});

test("a job that ends is told once, to an idle session, with its code, command, last output and log", async () => {
  const h = harness();
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
  const h = harness();
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
  const h = harness();
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
  const h = harness();
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
  const h = harness();
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
  const h = harness();
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

test("a job that exited 124 reads as timed out", async () => {
  const h = harness();
  const job = await spawnJob("exit 124", { root: h.root });
  h.session.track(job);
  await h.over(job);
  await h.delivered(1);
  expect(h.sent[0]?.text).toMatch(/\): timed out after \d+s\]\n/);
});

test("a job with no output says so", async () => {
  const h = harness();
  const job = await spawnJob("exit 0", { root: h.root });
  h.session.track(job);
  await h.over(job);
  await h.delivered(1);
  expect(h.sent[0]?.text).toContain("\n(no output)\nLog: ");
});

test("stop ends every running job, a job that ignores SIGTERM after the grace, and tells no one", async () => {
  const h = harness({ graceMs: 100 });
  const calm = await spawnJob("sleep 30", { root: h.root, id: "aaaa0001" });
  const stubborn = await spawnJob(
    "trap '' TERM; while [ $SECONDS -lt 30 ]; do sleep 1; done",
    { root: h.root, id: "bbbb0002" },
  );
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
}, 10_000);

test("bash_stop's stop ends the job, words how, and the job is not told again", async () => {
  const h = harness();
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

test("bash_stop says when a job ignored SIGTERM and needed SIGKILL", async () => {
  const h = harness({ graceMs: 100 });
  const job = await spawnJob(
    "trap '' TERM; while [ $SECONDS -lt 30 ]; do sleep 1; done",
    { root: h.root },
  );
  h.session.track(job);
  const stopping = h.session.stopJob(job.id);
  await h.over(job);
  const { text } = await stopping;
  expect(text).toContain(
    "(it ignored SIGTERM and was killed with SIGKILL after 0.1 s)",
  );
  expect(groupAlive(job.pgid)).toBe(false);
}, 10_000);

test("bash_stop ends a job whose shell has already exited and left processes running", async () => {
  const h = harness();
  const job = await spawnJob("sleep 30 & exit 0", { root: h.root });
  h.session.track(job);
  await h.over(job);
  expect(groupAlive(job.pgid)).toBe(true);
  const { text } = await h.session.stopJob(job.id);
  expect(text).toMatch(/^Stopped job ab12cd34 .* \(SIGTERM; exit code 0\)\./);
  expect(groupAlive(job.pgid)).toBe(false);
});

test("bash_stop on a job that already ended is a normal result, and claims its end so it is not told too", async () => {
  const h = harness();
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
  const h = harness();
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

test("bash_stop with nothing running says so", async () => {
  const h = harness();
  await expect(h.session.stopJob("abcd1234")).rejects.toThrow(
    'bash_stop: no job "abcd1234". Running: none.',
  );
});
