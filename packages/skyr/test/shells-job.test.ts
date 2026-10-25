// The job dir and process-group operations against real shells.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  adoptMoved,
  capLog,
  claimDelivery,
  groupAlive,
  identify,
  lastLines,
  listJobDirs,
  markEnded,
  markHandover,
  readJob,
  readOutcome,
  readOwner,
  reap,
  releaseDelivery,
  stopJobs,
  tailOf,
  takeHandover,
  writeExit,
} from "../src/shells/job.js";
import { scratchDir } from "./session.js";
import {
  deadPid,
  fileAppears,
  finish,
  spawnJob,
  spawnTrapped,
} from "./shells-jobs.js";

/** An identity check that always passes: these jobs are this test's own. */
const same = async () => true;

const spec = (
  root: string,
  over: Partial<Parameters<typeof adoptMoved>[0]> = {},
) => ({
  root,
  owner: "o",
  id: "ab12cd34",
  command: "make",
  cwd: root,
  sessionId: "s1",
  pid: 4242,
  pgid: 4242,
  token: "t",
  startedAt: 5,
  ...over,
});

test("a job record and its owner read back as adoptMoved wrote them, in a root made on demand; a torn, incomplete or missing file reads as nothing", async () => {
  const root = join(scratchDir("shells"), "not", "yet");
  const record = adoptMoved(spec(root));
  expect(record.dir).toBe(join(root, "ab12cd34"));
  expect(await readJob(record.dir)).toEqual(record);
  expect(await readOwner(record.dir)).toEqual({ pid: process.pid, token: "o" });
  writeFileSync(join(record.dir, "job.json"), "{torn");
  writeFileSync(
    join(record.dir, "owner.json"),
    JSON.stringify({ pid: process.pid }),
  );
  expect(await readJob(record.dir)).toBeUndefined();
  writeFileSync(
    join(record.dir, "job.json"),
    JSON.stringify({ id: "ab12cd34" }),
  );
  expect(await readJob(record.dir)).toBeUndefined();
  expect(await readOwner(record.dir)).toBeUndefined();
  expect(await readJob(join(root, "none"))).toBeUndefined();
});

test("adoptMoved fails loudly for an id that already has a job record, and leaves that record alone", async () => {
  const root = scratchDir("shells");
  adoptMoved(spec(root, { command: "first" }));
  expect(() => adoptMoved(spec(root, { command: "second" }))).toThrow(
    /job ab12cd34 already exists/,
  );
  expect((await readJob(join(root, "ab12cd34")))?.command).toBe("first");
});

test.skipIf(process.getuid?.() === 0)(
  "adoptMoved into a root that cannot be written throws and leaves no job record",
  () => {
    const root = scratchDir("shells");
    chmodSync(root, 0o500);
    onTestFinished(() => chmodSync(root, 0o700));
    expect(() => adoptMoved(spec(root))).toThrow(/EACCES/);
    expect(existsSync(join(root, "ab12cd34"))).toBe(false);
  },
);

const stopped = JSON.stringify({ reason: "agent", at: 7 });
test.each([
  ["nothing written", async () => {}, { status: "unknown" }],
  [
    "a torn stop.json",
    async (dir: string) => writeFileSync(join(dir, "stop.json"), "{torn"),
    { status: "unknown" },
  ],
  [
    "an exit of 4",
    (dir: string) => writeExit(dir, 4),
    { status: "failed", exitCode: 4, endedAt: expect.any(Number) },
  ],
  [
    "an exit of 0",
    (dir: string) => writeExit(dir, 0),
    { status: "done", exitCode: 0, endedAt: expect.any(Number) },
  ],
  [
    "an exit and a stop.json, which wins and keeps the code",
    async (dir: string) => {
      await writeExit(dir, 143);
      writeFileSync(join(dir, "stop.json"), stopped);
    },
    { status: "aborted", stopReason: "agent", endedAt: 7, exitCode: 143 },
  ],
])("readOutcome with %s", async (_name, write, expected) => {
  const dir = scratchDir("job");
  await write(dir);
  expect(await readOutcome(dir)).toEqual(expected);
});

test("stopJobs records the stop before its first signal, and kills a job that ignores SIGTERM after the grace", async () => {
  const root = scratchDir("shells");
  const seen = join(scratchDir("seen"), "seen");
  const stopFile = join(root, "ab12cd34", "stop.json");
  const job = await spawnTrapped(
    `trap 'test -f "${stopFile}" && touch "${seen}"' TERM`,
    { root },
  );
  const stopping = stopJobs([job], "agent", same, 150);
  await fileAppears(seen);
  expect(await stopping).toEqual([{ killed: true, survived: false }]);
  expect(groupAlive(job.pgid)).toBe(false);
  expect(await readOutcome(job.dir)).toMatchObject({
    status: "aborted",
    stopReason: "agent",
  });
});

test("stopJobs records the stop of a job whose shell had exited while its group lived on", async () => {
  const job = await spawnJob("sleep 30 & exit 4");
  await finish(job);
  expect(groupAlive(job.pgid)).toBe(true);
  expect(await readOutcome(job.dir)).toMatchObject({ status: "failed" });
  expect(await stopJobs([job], "session", same, 150)).toEqual([
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
  expect(await stopJobs([ended], "agent", same, 150)).toEqual([
    { killed: false, survived: false },
  ]);
  expect(existsSync(join(ended.dir, "stop.json"))).toBe(false);

  const running = await spawnJob("sleep 30", { id: "cd34ef56" });
  await stopJobs([running], "agent", same, 150);
  await stopJobs([running], "session", same, 150);
  expect(await readOutcome(running.dir)).toMatchObject({ stopReason: "agent" });
});

test("stopJobs stops every group even when a check on one of them throws, then rethrows", async () => {
  const bad = await spawnJob("sleep 30", { id: "00000001" });
  const good = await spawnJob("sleep 30", { id: "00000002" });
  // A pgid that is not a number makes the group check throw
  const broken = { ...bad, pgid: Number.NaN };
  await expect(
    stopJobs([broken, good], "session", same, 150),
  ).rejects.toThrow();
  expect(groupAlive(good.pgid)).toBe(false);
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
  vi.stubEnv("TZ", "Pacific/Auckland");
  vi.stubEnv("LC_ALL", "sv_SE.UTF-8");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  expect(await identify(process.pid)).toEqual(plain);
  expect(plain?.pgid).toBeGreaterThan(1);
  expect(plain?.token).not.toBe("");
});

test("identify says nothing for a pid that is gone", async () => {
  expect(await identify(await deadPid())).toBeUndefined();
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

test("listJobDirs gives job dirs and skips dot-names and files, and none for a root not made yet", async () => {
  const root = scratchDir("shells");
  mkdirSync(join(root, "ab12cd34"));
  mkdirSync(join(root, ".pending"));
  writeFileSync(join(root, "error.log"), "");
  expect(await listJobDirs(root)).toEqual([join(root, "ab12cd34")]);
  expect(await listJobDirs(join(root, "nope"))).toEqual([]);
});

test("a handover mark is taken once, by the process that made it", async () => {
  const dir = scratchDir("job");
  expect(await takeHandover(dir)).toBe(false);
  await markHandover(dir);
  expect(await takeHandover(dir)).toBe(true);
  expect(await takeHandover(dir)).toBe(false);
});

test("reap removes job dirs that ended over seven days ago, never a running job's, a young one or a dot-dir", async () => {
  const root = scratchDir("shells");
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const make = (id: string, ageDays: number, file = "exit") => {
    const dir = join(root, id);
    mkdirSync(dir);
    writeFileSync(join(dir, file), "");
    const at = new Date(now - ageDays * day);
    utimesSync(join(dir, file), at, at);
    return dir;
  };
  const old = make("00000001", 8);
  const young = make("00000002", 6);
  const dot = join(root, ".pending");
  mkdirSync(dot);
  utimesSync(dot, new Date(now - 9 * day), new Date(now - 9 * day));
  const running = await spawnJob("sleep 30", { root, id: "00000003" });
  const at = new Date(now - 9 * day);
  utimesSync(join(running.dir, "job.json"), at, at);
  await reap(root, now);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(young)).toBe(true);
  expect(existsSync(dot)).toBe(true);
  expect(existsSync(running.dir)).toBe(true);
});

test("stopJobs signals nothing for a job its identity check refuses, and says so", async () => {
  const job = await spawnJob("sleep 30");
  expect(await stopJobs([job], "pi", async () => false, 150)).toEqual([
    { killed: false, survived: false, skipped: "unverified" },
  ]);
  expect(groupAlive(job.pgid)).toBe(true);
  expect(existsSync(join(job.dir, "stop.json"))).toBe(false);
});
