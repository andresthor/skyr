// The job dir and process-group operations against real shells.
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import { expect, onTestFinished, test } from "vitest";
import {
  adoptMoved,
  capLog,
  claimDelivery,
  groupAlive,
  identify,
  lastLines,
  markEnded,
  readOutcome,
  releaseDelivery,
  stopJobs,
  tailOf,
  writeExit,
} from "../src/shells/job.js";
import { scratchDir } from "./session.js";
import {
  fileAppears,
  finish,
  killGroup,
  shellOver,
  spawnJob,
} from "./shells-jobs.js";

test("adoptMoved writes the owner and then the job record into a new dir, and gives the record back", () => {
  const root = scratchDir("shells");
  const record = adoptMoved({
    root,
    owner: "Mon Jan  1 00:00:00 2024",
    id: "ab12cd34",
    command: "sleep 9",
    cwd: "/repo",
    sessionId: "s1",
    pid: 4242,
    pgid: 4242,
    token: "Mon Jan  1 00:00:01 2024",
    startedAt: 5,
  });
  expect(record.dir).toBe(join(root, "ab12cd34"));
  expect(
    JSON.parse(readFileSync(join(record.dir, "job.json"), "utf8")),
  ).toEqual({
    id: "ab12cd34",
    command: "sleep 9",
    cwd: "/repo",
    sessionId: "s1",
    pid: 4242,
    pgid: 4242,
    token: "Mon Jan  1 00:00:01 2024",
    startedAt: 5,
  });
  expect(
    JSON.parse(readFileSync(join(record.dir, "owner.json"), "utf8")),
  ).toEqual({ pid: process.pid, token: "Mon Jan  1 00:00:00 2024" });
});

test.skipIf(process.getuid?.() === 0)(
  "adoptMoved into a root that cannot be written throws and leaves no job record",
  () => {
    const root = scratchDir("shells");
    chmodSync(root, 0o500);
    onTestFinished(() => chmodSync(root, 0o700));
    expect(() =>
      adoptMoved({
        root,
        owner: "t",
        id: "ab12cd34",
        command: "true",
        cwd: root,
        sessionId: "s1",
        pid: 4242,
        pgid: 4242,
        token: "t",
        startedAt: 1,
      }),
    ).toThrow(/EACCES/);
    expect(existsSync(join(root, "ab12cd34"))).toBe(false);
  },
);

test("an exit written by writeExit reads back as the code and the second it was written", async () => {
  const dir = scratchDir("job");
  await writeExit(dir, 4);
  expect(await readOutcome(dir)).toMatchObject({
    status: "failed",
    exitCode: 4,
    endedAt: expect.any(Number),
  });
  await writeExit(dir, 0);
  expect(await readOutcome(dir)).toMatchObject({ status: "done", exitCode: 0 });
  expect(existsSync(join(dir, "exit.tmp"))).toBe(false);
});

test("a stop.json wins over exit, keeps the exit code, and an unreadable one says nothing", async () => {
  const dir = scratchDir("job");
  expect(await readOutcome(dir)).toEqual({ status: "unknown" });
  writeFileSync(join(dir, "stop.json"), "{torn");
  expect(await readOutcome(dir)).toEqual({ status: "unknown" });
  await writeExit(dir, 143);
  writeFileSync(
    join(dir, "stop.json"),
    JSON.stringify({ reason: "agent", at: 7 }),
  );
  expect(await readOutcome(dir)).toEqual({
    status: "aborted",
    stopReason: "agent",
    endedAt: 7,
    exitCode: 143,
  });
});

test("a group SIGTERM records 143 and exit 3 records 3", async () => {
  const slept = await spawnJob("sleep 30");
  process.kill(-slept.pgid, "SIGTERM");
  await finish(slept);
  expect(await readOutcome(slept.dir)).toMatchObject({
    status: "failed",
    exitCode: 143,
  });
  const three = await spawnJob("exit 3", { id: "cd34ef56" });
  await finish(three);
  expect(await readOutcome(three.dir)).toMatchObject({
    status: "failed",
    exitCode: 3,
  });
});

test("stopJobs records the stop before its first signal and kills a job that ignores SIGTERM after the grace", async () => {
  const root = scratchDir("shells");
  const seen = join(scratchDir("seen"), "seen");
  const stopFile = join(root, "ab12cd34", "stop.json");
  const job = await spawnJob(
    `trap 'test -f "${stopFile}" && touch "${seen}"' TERM; while [ $SECONDS -lt 30 ]; do sleep 1; done`,
    { root },
  );
  const stopping = stopJobs([job], "agent", 150);
  await fileAppears(seen);
  expect(await stopping).toEqual([{ killed: true, survived: false }]);
  expect(groupAlive(job.pgid)).toBe(false);
  expect(await readOutcome(job.dir)).toMatchObject({
    status: "aborted",
    stopReason: "agent",
  });
}, 10_000);

test("stopJobs records the stop of a job whose shell had exited while its group lived on", async () => {
  const job = await spawnJob("sleep 30 & exit 4");
  await finish(job);
  expect(groupAlive(job.pgid)).toBe(true);
  expect(await readOutcome(job.dir)).toMatchObject({ status: "failed" });
  expect(await stopJobs([job], "session", 150)).toEqual([
    { killed: false, survived: false },
  ]);
  expect(groupAlive(job.pgid)).toBe(false);
  expect(await readOutcome(job.dir)).toMatchObject({
    status: "aborted",
    stopReason: "session",
    exitCode: 4,
  });
});

test("stopJobs leaves alone a job that already ended, and a repeated stop keeps the first reason", async () => {
  const ended = await spawnJob("exit 0");
  await finish(ended);
  expect(await stopJobs([ended], "agent", 150)).toEqual([
    { killed: false, survived: false },
  ]);
  expect(existsSync(join(ended.dir, "stop.json"))).toBe(false);

  const running = await spawnJob("sleep 30", { id: "cd34ef56" });
  await stopJobs([running], "agent", 150);
  await stopJobs([running], "session", 150);
  expect(await readOutcome(running.dir)).toMatchObject({ stopReason: "agent" });
});

test("stopJobs still stops every other job when one job's stop.json cannot be written", async () => {
  const gone = await spawnJob("sleep 30", { id: "00000001" });
  const kept = await spawnJob("sleep 30", { id: "00000002" });
  rmSync(gone.dir, { recursive: true, force: true });
  const results = await stopJobs([gone, kept], "session", 150);
  expect(results).toEqual([
    { killed: false, survived: false },
    { killed: false, survived: false },
  ]);
  expect(groupAlive(gone.pgid)).toBe(false);
  expect(groupAlive(kept.pgid)).toBe(false);
  expect(await readOutcome(kept.dir)).toMatchObject({
    status: "aborted",
    stopReason: "session",
  });
});

test("capLog keeps the head, the marker and the latest lines of a log, with no NUL bytes", async () => {
  const dir = scratchDir("job");
  const log = join(dir, "out.log");
  const line = "noise noise noise noise noise noise noise\n";
  writeFileSync(
    log,
    `BANNER\n${line.repeat(Math.ceil((9 * 1024 * 1024) / line.length))}SUMMARY\n`,
  );
  await capLog(dir);
  const cut = statSync(log).size;
  expect(cut).toBeLessThan(8 * 1024 * 1024);
  const text = readFileSync(log, "utf8");
  expect(text.startsWith("BANNER\nnoise")).toBe(true);
  const marker = text.indexOf(
    "[skyr: output dropped here to keep this log under 8 MiB]\n",
  );
  expect(marker).toBeGreaterThan(0);
  expect(text.indexOf("SUMMARY\n")).toBeGreaterThan(marker);
  expect(text.endsWith("SUMMARY\n")).toBe(true);
  expect(text.includes("\0")).toBe(false);
  await capLog(dir);
  expect(statSync(log).size).toBe(cut);
});

test("tailOf gives the last 20 lines of a log, and lastLines bounds any text the same way", async () => {
  const dir = scratchDir("job");
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(dir, "out.log"), `${lines.join("\n")}\n`);
  const tail = await tailOf(dir, truncateTail);
  expect(tail.trimEnd().split("\n")).toEqual(lines.slice(30));
  expect(lastLines(lines.join("\n"), truncateTail).split("\n")).toHaveLength(
    20,
  );
  expect(
    lastLines("x".repeat(10_000), truncateTail).length,
  ).toBeLessThanOrEqual(2 * 1024);
});

test("identify gives the same token whatever the caller's time zone and locale", async () => {
  const plain = await identify(process.pid);
  const saved = { tz: process.env.TZ, lc: process.env.LC_ALL };
  process.env.TZ = "Pacific/Auckland";
  process.env.LC_ALL = "sv_SE.UTF-8";
  try {
    expect(await identify(process.pid)).toEqual(plain);
  } finally {
    for (const [key, value] of [
      ["TZ", saved.tz],
      ["LC_ALL", saved.lc],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  expect(plain?.pgid).toBeGreaterThan(1);
  expect(plain?.token).not.toBe("");
});

test("identify says nothing for a pid that is gone", async () => {
  const child = spawn("true", { stdio: "ignore" });
  await new Promise((resolve) => child.on("close", resolve));
  expect(await identify(child.pid as number)).toBeUndefined();
});

test("groupAlive tells a live group from one that is gone", async () => {
  const job = await spawnJob("sleep 30");
  expect(groupAlive(job.pgid)).toBe(true);
  killGroup(job.pgid);
  await shellOver(job);
  expect(groupAlive(job.pgid)).toBe(false);
});

test("claimDelivery is true once per session until released, and per session", async () => {
  const dir = scratchDir("job");
  expect(await claimDelivery(dir, "s1")).toBe(true);
  expect(await claimDelivery(dir, "s1")).toBe(false);
  expect(await claimDelivery(dir, "s2")).toBe(true);
  await releaseDelivery(dir, "s1");
  expect(await claimDelivery(dir, "s1")).toBe(true);
});

test("markEnded records an end, and in a removed dir records nothing and does not throw", async () => {
  const dir = scratchDir("job");
  await markEnded(dir);
  expect(existsSync(join(dir, "ended"))).toBe(true);
  await expect(markEnded(join(dir, "gone"))).resolves.toBeUndefined();
});

test("adoptMoved makes the root too when it does not exist yet", () => {
  const root = join(scratchDir("shells"), "not", "yet");
  const record = adoptMoved({
    root,
    owner: "t",
    id: "ab12cd34",
    command: "true",
    cwd: root,
    sessionId: "s1",
    pid: 4242,
    pgid: 4242,
    token: "t",
    startedAt: 1,
  });
  expect(existsSync(join(record.dir, "job.json"))).toBe(true);
});

test("adoptMoved fails loudly for an id that already has a job record, and leaves that record alone", () => {
  const root = scratchDir("shells");
  const spec = {
    root,
    owner: "t",
    id: "ab12cd34",
    command: "first",
    cwd: root,
    sessionId: "s1",
    pid: 4242,
    pgid: 4242,
    token: "t",
    startedAt: 1,
  };
  adoptMoved(spec);
  expect(() => adoptMoved({ ...spec, command: "second" })).toThrow(
    /job ab12cd34 already exists/,
  );
  expect(
    JSON.parse(readFileSync(join(root, "ab12cd34", "job.json"), "utf8"))
      .command,
  ).toBe("first");
});

test("stopJobs stops every group even when a check on one of them throws, then rethrows", async () => {
  const bad = await spawnJob("sleep 30", { id: "00000001" });
  const good = await spawnJob("sleep 30", { id: "00000002" });
  // A pgid that is not a number makes the group check throw
  const broken = { ...bad, pgid: Number.NaN };
  await expect(stopJobs([broken, good], "session", 150)).rejects.toThrow();
  expect(groupAlive(good.pgid)).toBe(false);
});
