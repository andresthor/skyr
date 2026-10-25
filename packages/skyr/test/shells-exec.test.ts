// movingOperations against Pi's own local shell operations: a call that settles in time is Pi's,
// one still running at the limit becomes a job. Children wait on gate files, never on the clock.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import { loadPi } from "../src/pi.js";
import { Moved, movingOperations } from "../src/shells/exec.js";
import { groupAlive, identify, type JobRecord } from "../src/shells/job.js";
import { scratchDir } from "./session.js";
import {
  appears,
  fileAppears,
  gated,
  gateFile,
  killGroup,
} from "./shells-jobs.js";

// Only the limit is fake, so a test fires it by hand and counts what is left armed.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const settled = () => new Promise((resolve) => setImmediate(resolve));
const dirsOf = (root: string) =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);

async function expectMoved(call: Promise<unknown>): Promise<Moved> {
  const error = await call;
  expect(error).toBeInstanceOf(Moved);
  return error as Moved;
}

type Options = {
  command?: (gate: string) => string;
  root?: string;
  cwd?: string;
  pending?: boolean;
} & Omit<Partial<Parameters<typeof movingOperations>[0]>, "command">;

async function rig(o: Options = {}) {
  const {
    command: make,
    root: given,
    cwd,
    pending,
    identify: who,
    ...rest
  } = o;
  const pi = await loadPi();
  const gate = gateFile();
  const command =
    make?.(gate) ?? `echo before; ${gated(gate)}; echo after; exit 4`;
  const root = given ?? scratchDir("shells");
  const pidDir = join(root, ".pending");
  if (pending !== false) mkdirSync(pidDir, { recursive: true });
  const limitMs = o.limitMs ?? 80;
  const moved: JobRecord[] = [];
  const calls: Promise<unknown>[] = [];
  const ends: Promise<JobRecord>[] = [];
  const ended = new Map<string, (job: JobRecord) => void>();
  let attempted = false;
  const ops = movingOperations({
    ops: pi.createLocalBashOperations(),
    limitMs,
    root,
    sessionId: "s1",
    command,
    background: false,
    truncateTail: pi.truncateTail,
    owner: () => "owner-token",
    identify: async (pid) => {
      try {
        return await (who ?? identify)(pid);
      } finally {
        setImmediate(() => {
          attempted = true;
        });
      }
    },
    ...rest,
    onMoved: (job) => {
      o.onMoved?.(job);
      moved.push(job);
      ends.push(new Promise((done) => ended.set(job.id, done)));
    },
    onExited: (job) => ended.get(job.id)?.(job),
  });
  const chunks: Buffer[] = [];
  const release = () => writeFileSync(gate, "");
  // A test that fails halfway must not leave its shell running into the next test's fake clock.
  onTestFinished(async () => {
    release();
    for (const job of moved) killGroup(job.pgid);
    await Promise.all([...calls, ...ends]);
  });
  /** Resolves once the shell has written its pid, which a call cannot move without. */
  const pidWritten = () =>
    appears(() =>
      readdirSync(pidDir).some((name) =>
        readFileSync(join(pidDir, name), "utf8"),
      ),
    );
  const run = (signal?: AbortSignal, timeout?: number) => {
    const call = ops
      .exec(command, cwd ?? root, {
        onData: (data) => chunks.push(data),
        signal,
        timeout,
        env: process.env,
      })
      .catch((error: unknown) => error);
    calls.push(call);
    return call;
  };
  /** The limit is fake, so it must not fire before the shell has written its pid. */
  const fire = async () => {
    if (pending !== false) await pidWritten();
    vi.advanceTimersByTime(limitMs);
  };
  return {
    root,
    moved,
    ended: () => Promise.all(ends),
    release,
    run,
    fire,
    pidWritten,
    identified: () => appears(() => attempted),
    output: () => Buffer.concat(chunks).toString("utf8"),
    /** A background call: the shell has written its pid, and the 5 ms poll sees it. */
    startsNow: async (signal?: AbortSignal, timeout?: number) => {
      const call = run(signal, timeout);
      await pidWritten();
      await vi.advanceTimersByTimeAsync(5);
      return expectMoved(call);
    },
    /** Starts a call, lets it reach the limit, and gives the `Moved` it rejects with. */
    reachesLimit: async (signal?: AbortSignal, timeout?: number) => {
      const call = run(signal, timeout);
      await fire();
      return expectMoved(call);
    },
  };
}

/** A root the shell can write its pid into but the move cannot make a job dir in; no rig options. */
function lock(root: string): Options {
  mkdirSync(join(root, ".pending"));
  chmodSync(root, 0o500);
  onTestFinished(() => chmodSync(root, 0o700));
  return {};
}

test("a call still running at the limit moves, unaffected by Esc after: its tail, job and log come back, and its exit is recorded", async () => {
  const r = await rig();
  const controller = new AbortController();
  const { job, tail } = await r.reachesLimit(controller.signal);
  expect(tail).toBe("before\n");
  expect(job.id).toMatch(/^[0-9a-f]{8}$/);
  expect(job.command).toContain("echo before");
  expect(r.moved).toEqual([job]);
  // Esc after the move is no longer the call's: the job runs on
  controller.abort();
  await settled();
  expect(groupAlive(job.pgid)).toBe(true);

  r.release();
  expect(await fileAppears(join(job.dir, "exit"))).toMatch(/^4 \d+\n$/);
  expect(await r.ended()).toEqual([job]);
  expect(readFileSync(join(job.dir, "out.log"), "utf8")).toBe(
    "before\nafter\n",
  );
  expect(readdirSync(join(r.root, ".pending"))).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

test("a call that settles before the limit is Pi's result, with no job dir, no pid file and no timer left", async () => {
  const r = await rig({ limitMs: 60_000 });
  r.release();
  expect(await r.run()).toEqual({ exitCode: 4 });
  expect(r.output()).toBe("before\nafter\n");
  expect(readdirSync(r.root)).toEqual([".pending"]);
  expect(readdirSync(join(r.root, ".pending"))).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

test("a call that settles while the identity is being read returns Pi's result and leaves no dir", async () => {
  let asked: number | undefined;
  let answer = (_: Awaited<ReturnType<typeof identify>>) => {};
  const r = await rig({
    identify: (pid) =>
      new Promise((resolve) => {
        asked = pid;
        answer = resolve;
      }),
  });
  const call = r.run();
  await r.fire();
  await appears(() => asked !== undefined);
  // The answer a move would accept, taken while the shell still lives
  const real = await identify(asked as number);
  r.release();
  expect(await call).toEqual({ exitCode: 4 });
  answer(real);
  await settled();
  expect(r.moved).toEqual([]);
  expect(dirsOf(r.root)).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

type Setup = (live: { on: boolean }, root: string) => Options;
const elsewhere = async (pid: number) => ({ pgid: pid + 1, token: "t" });
const throws = () => {
  throw new Error("tracking failed");
};
const cannotMove: [string, Setup, identifies: boolean][] = [
  ["ps names no identity", () => ({ identify: async () => undefined }), true],
  ["pid leads no group", () => ({ identify: elsewhere }), true],
  [
    "session ends while its identity is read",
    (live) => ({
      owner: () => (live.on ? "owner-token" : undefined),
      identify: async (pid) => {
        const identity = await identify(pid);
        live.on = false;
        return identity;
      },
    }),
    true,
  ],
  ["onMoved throws", () => ({ onMoved: throws }), true],
  ["session has no owner yet", () => ({ owner: () => undefined }), false],
  ["pid dir is missing", () => ({ pending: false }), false],
];
if (process.getuid?.() !== 0)
  cannotMove.push([
    "job record cannot be written",
    (_live, root) => lock(root),
    true,
  ]);

test.each(cannotMove)(
  "a call whose %s runs on as Pi's: output and exit unchanged, nothing moves",
  async (_name, setup, identifies) => {
    const root = scratchDir("shells");
    const r = await rig({ root, ...setup({ on: true }, root) });
    const call = r.run();
    await r.fire();
    await (identifies ? r.identified() : settled());
    r.release();
    expect(await call).toEqual({ exitCode: 4 });
    expect(r.moved).toEqual([]);
    expect(r.output()).toBe("before\nafter\n");
    expect(dirsOf(root)).toEqual([]);
  },
);

test.skipIf(process.getuid?.() === 0)(
  "a record that cannot be written leaves the call its Esc",
  async () => {
    const root = scratchDir("shells");
    lock(root);
    const r = await rig({ root });
    const controller = new AbortController();
    const call = r.run(controller.signal);
    await r.fire();
    await r.identified();
    await settled();
    expect(r.moved).toEqual([]);
    controller.abort();
    expect(await call).toEqual(new Error("aborted"));
  },
);

test.each([
  ["before the limit", { limitMs: 60_000 }, false],
  ["already pressed", {}, true],
  ["during the pid poll", { background: true }, false],
] as const)(
  "Esc %s is Pi's abort: nothing moves and nothing is left behind",
  async (_name, o, early) => {
    const r = await rig(o);
    const controller = new AbortController();
    if (early) controller.abort();
    const call = r.run(controller.signal);
    controller.abort();
    expect(await call).toEqual(new Error("aborted"));
    expect(r.moved).toEqual([]);
    expect(dirsOf(r.root)).toEqual([]);
    expect(readdirSync(join(r.root, ".pending"))).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("a megabyte of output before the move opens the log before the move, and the log keeps all of it", async () => {
  const ready = join(scratchDir("files"), "ready");
  const root = scratchDir("shells");
  let dirsBeforeMove: string[] = [];
  const r = await rig({
    root,
    command: (gate) =>
      `head -c 1048576 /dev/zero | tr '\\0' x; touch '${ready}'; ${gated(gate)}`,
    identify: async (pid) => {
      await fileAppears(ready);
      dirsBeforeMove = dirsOf(root);
      return identify(pid);
    },
  });
  const { job } = await r.reachesLimit();
  expect(dirsBeforeMove).toHaveLength(1);
  r.release();
  await fileAppears(join(job.dir, "exit"));
  expect(statSync(join(job.dir, "out.log")).size).toBe(1_048_576);
});

test.each([
  ["a deadline", "timeout:5", 124, "after\n"],
  ["an abort", "aborted", 137, "after\n"],
  ["a spawn error", "spawn ENOENT", 1, "after\nspawn ENOENT\n"],
] as const)(
  "a moved call that ends in %s gets the exit its continuation owes it",
  async (_name, message, code, logEnd) => {
    const real = (await loadPi()).createLocalBashOperations();
    const failing: BashOperations = {
      exec: async (command, cwd, options) => {
        await real.exec(command, cwd, options);
        throw new Error(message);
      },
    };
    const r = await rig({ ops: failing });
    const { job } = await r.reachesLimit();
    r.release();
    expect(await fileAppears(join(job.dir, "exit"))).toMatch(
      new RegExp(`^${code} \\d+\n$`),
    );
    expect(
      readFileSync(join(job.dir, "out.log"), "utf8").endsWith(logEnd),
    ).toBe(true);
  },
);

test("a failure in the continuation is written to error.log, and the job's end is still reported", async () => {
  const r = await rig();
  const { job } = await r.reachesLimit();
  // A directory where the exit file goes makes writing it fail
  mkdirSync(join(job.dir, "exit"));
  r.release();
  expect(await r.ended()).toEqual([job]);
  expect(readFileSync(join(r.root, "error.log"), "utf8")).toContain(job.id);
});

test.each([
  ["foreground", {}, "reachesLimit"],
  ["background", { background: true }, "startsNow"],
] as const)(
  "a %s call's timeout is the moved job's deadline",
  async (_name, o, start) => {
    const r = await rig({ command: () => "echo before; sleep 30", ...o });
    const { job } = await r[start](undefined, 0.3);
    // Pi's own deadline timer, armed with the call, is on the same fake clock
    vi.advanceTimersByTime(300);
    expect(await fileAppears(join(job.dir, "exit"))).toMatch(/^124 /);
  },
);

test("a moved job's log is cut by its own writer at 8 MiB: head and tail stay, and nothing written after is lost", async () => {
  const r = await rig({
    command: (gate) =>
      `echo START; ${gated(gate)}; yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 9437184; echo END`,
  });
  const { job } = await r.reachesLimit();
  r.release();
  await fileAppears(join(job.dir, "exit"));
  const text = readFileSync(join(job.dir, "out.log"), "utf8");
  expect(text.length).toBeLessThan(8 * 1024 * 1024);
  expect(text.startsWith("START\n0123456789")).toBe(true);
  expect(text.endsWith("END\n")).toBe(true);
}, 30_000);

test("a call that prints nothing, to a root whose path has a quote in it, still moves and has a log to point at", async () => {
  const root = mkdtempSync(join(tmpdir(), "skyr-test-it's-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const r = await rig({ root, command: gated });
  const { job } = await r.reachesLimit();
  expect(readFileSync(join(job.dir, "out.log"), "utf8")).toBe("");
});

test("a background call moves as soon as the shell has written its pid, within the call's first moments", async () => {
  const r = await rig({ background: true, limitMs: 60_000 });
  const start = Date.now();
  const moved = await r.startsNow();
  expect(moved.immediate).toBe(true);
  expect(moved.job.startedAt).toBeLessThan(start + 100);
  expect(vi.getTimerCount()).toBe(0);
});

test("a background call that cannot move at once moves at the limit, counted from the call's start", async () => {
  let ready = false;
  const r = await rig({
    background: true,
    limitMs: 10_000,
    // ps naming nothing makes the move fail whenever the poll tries it
    identify: async (pid) => (ready ? identify(pid) : undefined),
  });
  const start = Date.now();
  const call = r.run();
  await vi.advanceTimersByTimeAsync(4_000);
  ready = true;
  await r.pidWritten();
  await vi.advanceTimersByTimeAsync(6_000);
  const moved = await expectMoved(call);
  expect(moved.immediate).toBe(false);
  expect(moved.job.startedAt).toBe(start);
  expect(Date.now() - start).toBe(10_000);
});

test("a background call that settles during the pid poll leaves no timer", async () => {
  const r = await rig({ background: true, command: () => "echo hi" });
  expect(await r.run()).toEqual({ exitCode: 0 });
  expect(r.moved).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  ["has no pid file", { pending: false }],
  ["has no owner", { owner: () => undefined }],
] as const)(
  "a background call that %s is an ordinary call: it stays in the foreground at the limit",
  async (_name, o) => {
    const r = await rig({ background: true, ...o });
    const call = r.run();
    // Past the 2 s the pid poll waits, so the limit has fired
    await vi.advanceTimersByTimeAsync(2_500);
    r.release();
    expect(await call).toEqual({ exitCode: 4 });
    expect(r.moved).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("a background call in a bad cwd is Pi's error and records no job", async () => {
  const r = await rig({
    background: true,
    cwd: join(scratchDir("cwd"), "missing"),
  });
  const error = await r.run();
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(Moved);
  expect(dirsOf(r.root)).toEqual([]);
});
