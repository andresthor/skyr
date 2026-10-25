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
  watch,
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
import { fileAppears, killGroup } from "./shells-jobs.js";

// Only the limit is fake, so a test fires it by hand and counts what is left armed.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const settled = () => new Promise((resolve) => setImmediate(resolve));

/** Resolves once `dir` has an entry; the shell writes its pid there before anything else runs. */
function entryAppears(dir: string): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(dir, () => {
      if (readdirSync(dir).length > 0) {
        watcher.close();
        resolve();
      }
    });
    if (readdirSync(dir).length > 0) {
      watcher.close();
      resolve();
    }
  });
}

const dirsOf = (root: string) =>
  readdirSync(root).filter((name) => !name.startsWith("."));

/** The error a call rejects with, or undefined when it resolved. */
const rejection = (call: Promise<unknown>) =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

async function rig(
  o: {
    command?: string;
    root?: string;
    pending?: boolean;
  } & Partial<Parameters<typeof movingOperations>[0]> = {},
) {
  const pi = await loadPi();
  const gate = join(scratchDir("gate"), "go");
  const command =
    o.command ??
    `echo before; until [ -e '${gate}' ] || [ $SECONDS -ge 30 ]; do sleep 0.02; done; echo after; exit 4`;
  const root = o.root ?? scratchDir("shells");
  if (o.pending !== false)
    mkdirSync(join(root, ".pending"), { recursive: true });
  const limitMs = o.limitMs ?? 80;
  const moved: JobRecord[] = [];
  const exited: JobRecord[] = [];
  let exitedOnce = () => {};
  const exitedP = new Promise<void>((resolve) => {
    exitedOnce = resolve;
  });
  onTestFinished(() => {
    for (const job of moved) killGroup(job.pgid);
  });
  const ops = movingOperations({
    ops: pi.createLocalBashOperations(),
    limitMs,
    root,
    sessionId: "s1",
    command,
    truncateTail: pi.truncateTail,
    owner: () => "owner-token",
    identify,
    ...o,
    onMoved: (job) => {
      moved.push(job);
      o.onMoved?.(job);
    },
    onExited: (job) => {
      exited.push(job);
      exitedOnce();
    },
  });
  const chunks: Buffer[] = [];
  // The limit is fake, so it must not fire before the shell has written its pid.
  const fire = async () => {
    if (o.pending !== false) await entryAppears(join(root, ".pending"));
    vi.advanceTimersByTime(limitMs);
  };
  const run = (signal?: AbortSignal, timeout?: number) =>
    ops.exec(command, root, {
      onData: (data) => chunks.push(data),
      signal,
      timeout,
      env: process.env,
    });
  return {
    root,
    moved,
    exited,
    exitedP,
    release: () => writeFileSync(gate, ""),
    output: () => Buffer.concat(chunks).toString("utf8"),
    run,
    fire,
    /** Starts a call, lets it reach the limit, and gives what it rejects with. */
    reachesLimit: async (signal?: AbortSignal, timeout?: number) => {
      const call = rejection(run(signal, timeout));
      await fire();
      return call;
    },
  };
}

test("a call still running at the limit moves: its tail, job and log come back, and its exit is recorded", async () => {
  const r = await rig();
  const error = await r.reachesLimit();
  expect(error).toBeInstanceOf(Moved);
  const { job, tail } = error as Moved;
  expect(tail).toBe("before\n");
  expect(job.id).toMatch(/^[0-9a-f]{8}$/);
  expect(job.command).toContain("echo before");
  expect(r.moved).toEqual([job]);
  expect(r.exited).toEqual([]);
  expect(groupAlive(job.pgid)).toBe(true);

  r.release();
  expect(await fileAppears(join(job.dir, "exit"))).toMatch(/^4 \d+\n$/);
  await r.exitedP;
  expect(r.exited).toEqual([job]);
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
  let identityAsked = () => {};
  const asked = new Promise<void>((resolve) => {
    identityAsked = resolve;
  });
  let answer = (_: { pgid: number; token: string }) => {};
  const held = new Promise<{ pgid: number; token: string }>((resolve) => {
    answer = resolve;
  });
  const r = await rig({
    identify: async () => {
      identityAsked();
      return held;
    },
  });
  const call = r.run();
  await r.fire();
  await asked;
  r.release();
  expect(await call).toEqual({ exitCode: 4 });
  answer({ pgid: 1234, token: "late" });
  await settled();
  expect(r.moved).toEqual([]);
  expect(readdirSync(r.root)).toEqual([".pending"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("a call whose identity ps cannot name stays in the foreground", async () => {
  const r = await rig({ identify: async () => undefined });
  const call = r.run();
  await r.fire();
  await settled();
  r.release();
  expect(await call).toEqual({ exitCode: 4 });
  expect(r.moved).toEqual([]);
  expect(readdirSync(r.root)).toEqual([".pending"]);
});

test("a call whose pid is not the leader of its own group does not move", async () => {
  const r = await rig({
    identify: async (pid) => ({ pgid: pid + 1, token: "t" }),
  });
  const call = r.run();
  await r.fire();
  await settled();
  r.release();
  expect(await call).toEqual({ exitCode: 4 });
  expect(r.moved).toEqual([]);
});

test("a session that ended while the identity was read takes no call", async () => {
  let live = true;
  const r = await rig({
    owner: () => (live ? "owner-token" : undefined),
    identify: async (pid) => {
      const identity = await identify(pid);
      live = false;
      return identity;
    },
  });
  const call = r.run();
  await r.fire();
  await settled();
  r.release();
  expect(await call).toEqual({ exitCode: 4 });
  expect(r.moved).toEqual([]);
  expect(readdirSync(r.root)).toEqual([".pending"]);
});

test("a call before the session knows its owner never moves", async () => {
  const r = await rig({ owner: () => undefined });
  const call = r.run();
  await r.fire();
  await settled();
  r.release();
  expect(await call).toEqual({ exitCode: 4 });
  expect(r.moved).toEqual([]);
});

test.skipIf(process.getuid?.() === 0)(
  "a record that cannot be written means no move: the call keeps its output and its Esc",
  async () => {
    let attempted = () => {};
    const tried = new Promise<void>((resolve) => {
      attempted = resolve;
    });
    const r = await rig({
      identify: async (pid) => {
        const identity = await identify(pid);
        // After the answer is used, so the move has failed by the time this runs.
        setImmediate(attempted);
        return identity;
      },
    });
    chmodSync(r.root, 0o500);
    onTestFinished(() => chmodSync(r.root, 0o700));
    const controller = new AbortController();
    const call = r.reachesLimit(controller.signal);
    await tried;
    await settled();
    expect(r.moved).toEqual([]);
    controller.abort();
    expect(await call).toEqual(new Error("aborted"));
    expect(r.output().startsWith("before\n")).toBe(true);
  },
);

test.skipIf(process.getuid?.() === 0)(
  "a call that fails to move still gets all of its output and Pi's exit",
  async () => {
    let attempted = () => {};
    const tried = new Promise<void>((resolve) => {
      attempted = resolve;
    });
    const r = await rig({
      identify: async (pid) => {
        const identity = await identify(pid);
        setImmediate(attempted);
        return identity;
      },
    });
    chmodSync(r.root, 0o500);
    onTestFinished(() => chmodSync(r.root, 0o700));
    const call = r.run();
    await r.fire();
    await tried;
    await settled();
    r.release();
    expect(await call).toEqual({ exitCode: 4 });
    expect(r.output()).toBe("before\nafter\n");
  },
);

test("Esc before the move is Pi's abort and leaves no dir", async () => {
  const r = await rig({ limitMs: 60_000 });
  const controller = new AbortController();
  const call = rejection(r.run(controller.signal));
  controller.abort();
  expect(await call).toEqual(new Error("aborted"));
  expect(readdirSync(r.root)).toEqual([".pending"]);
  expect(readdirSync(join(r.root, ".pending"))).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

test("Esc after the move leaves the job running", async () => {
  const r = await rig();
  const controller = new AbortController();
  const error = await r.reachesLimit(controller.signal);
  expect(error).toBeInstanceOf(Moved);
  const { job } = error as Moved;
  controller.abort();
  await settled();
  expect(groupAlive(job.pgid)).toBe(true);
  r.release();
  expect(await fileAppears(join(job.dir, "exit"))).toMatch(/^4 /);
});

test("Esc already pressed is Pi's abort and moves nothing", async () => {
  const r = await rig();
  const controller = new AbortController();
  controller.abort();
  expect(await rejection(r.run(controller.signal))).toEqual(
    new Error("aborted"),
  );
  expect(r.moved).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

test("a megabyte of output before the move opens the log before the move, and the log keeps all of it", async () => {
  const files = scratchDir("files");
  const [ready, go] = [join(files, "ready"), join(files, "go")];
  const root = scratchDir("shells");
  let dirsBeforeMove: string[] = [];
  const r = await rig({
    root,
    command: `head -c 1048576 /dev/zero | tr '\\0' x; touch '${ready}'; until [ -e '${go}' ] || [ $SECONDS -ge 30 ]; do sleep 0.02; done`,
    identify: async (pid) => {
      await fileAppears(ready);
      dirsBeforeMove = dirsOf(root);
      return identify(pid);
    },
  });
  const error = await r.reachesLimit();
  expect(error).toBeInstanceOf(Moved);
  expect(dirsBeforeMove).toHaveLength(1);
  const { job } = error as Moved;
  writeFileSync(go, "");
  await fileAppears(join(job.dir, "exit"));
  expect(statSync(join(job.dir, "out.log")).size).toBe(1_048_576);
});

test("a megabyte of output from a call that settles in time leaves no dir behind", async () => {
  const r = await rig({
    limitMs: 60_000,
    command: "head -c 1048576 /dev/zero | tr '\\0' x",
  });
  expect(await r.run()).toEqual({ exitCode: 0 });
  expect(r.output()).toHaveLength(1_048_576);
  expect(readdirSync(r.root)).toEqual([".pending"]);
});

test.each([
  ["a deadline", "timeout:5", 124],
  ["an abort", "aborted", 137],
  ["a spawn error", "spawn /bin/zsh ENOENT", 1],
] as const)(
  "a moved call that ends in %s gets the exit its continuation owes it",
  async (_name, message, code) => {
    const pi = await loadPi();
    const real = pi.createLocalBashOperations();
    const failing: BashOperations = {
      exec: async (command, cwd, options) => {
        await real.exec(command, cwd, options);
        throw new Error(message);
      },
    };
    const r = await rig({ ops: failing });
    const error = await r.reachesLimit();
    expect(error).toBeInstanceOf(Moved);
    const { job } = error as Moved;
    r.release();
    expect(await fileAppears(join(job.dir, "exit"))).toMatch(
      new RegExp(`^${code} \\d+\n$`),
    );
    const log = readFileSync(join(job.dir, "out.log"), "utf8");
    expect(log.endsWith(code === 1 ? `after\n${message}\n` : "after\n")).toBe(
      true,
    );
  },
);

test("a real deadline longer than the limit ends the moved job with 124", async () => {
  const r = await rig({ command: "echo before; sleep 30" });
  const error = await r.reachesLimit(undefined, 0.3);
  expect(error).toBeInstanceOf(Moved);
  const { job } = error as Moved;
  // Pi's own deadline timer, armed with the call, is on the same fake clock
  vi.advanceTimersByTime(300);
  expect(await fileAppears(join(job.dir, "exit"))).toMatch(/^124 /);
  await settled();
  expect(groupAlive(job.pgid)).toBe(false);
});

test("a moved job's log is cut by its own writer at 8 MiB: head, marker and tail stay, and nothing written after is lost", async () => {
  const files = scratchDir("files");
  const go = join(files, "go");
  const r = await rig({
    command: `echo START; until [ -e '${go}' ] || [ $SECONDS -ge 30 ]; do sleep 0.02; done; yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 9437184; echo END`,
  });
  const error = await r.reachesLimit();
  expect(error).toBeInstanceOf(Moved);
  const { job } = error as Moved;
  writeFileSync(go, "");
  await fileAppears(join(job.dir, "exit"));
  const text = readFileSync(join(job.dir, "out.log"), "utf8");
  expect(text.length).toBeLessThan(8 * 1024 * 1024);
  expect(text.startsWith("START\n0123456789")).toBe(true);
  expect(
    text.split("[skyr: output dropped here to keep this log under 8 MiB]\n"),
  ).toHaveLength(2);
  expect(text.endsWith("END\n")).toBe(true);
  expect(text.includes("\0")).toBe(false);
}, 30_000);

test("a call to a root whose path has a quote in it still moves", async () => {
  const root = mkdtempSync(join(tmpdir(), "skyr-test-it's-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const r = await rig({ root });
  const error = await r.reachesLimit();
  expect(error).toBeInstanceOf(Moved);
  r.release();
  await fileAppears(join((error as Moved).job.dir, "exit"));
});

test("a call whose pid dir is missing runs unchanged: nothing is printed and nothing moves", async () => {
  const r = await rig({ pending: false });
  const call = r.run();
  await r.fire();
  await settled();
  r.release();
  expect(await call).toEqual({ exitCode: 4 });
  expect(r.output()).toBe("before\nafter\n");
  expect(r.moved).toEqual([]);
});

test("a moved job that never prints still has a log to point at", async () => {
  const r = await rig({
    command:
      "until [ -e /nonexistent ] || [ $SECONDS -ge 30 ]; do sleep 0.02; done",
  });
  const error = await r.reachesLimit();
  expect(error).toBeInstanceOf(Moved);
  const { job } = error as Moved;
  expect(readFileSync(join(job.dir, "out.log"), "utf8")).toBe("");
  killGroup(job.pgid);
});

test("an onMoved that throws leaves the call in the foreground with its output", async () => {
  const r = await rig({
    onMoved: () => {
      throw new Error("tracking failed");
    },
  });
  const call = r.run();
  await r.fire();
  await settled();
  r.release();
  expect(await call).toEqual({ exitCode: 4 });
  expect(r.output()).toBe("before\nafter\n");
});
