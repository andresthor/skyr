import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { onTestFinished } from "vitest";
import {
  adoptMoved,
  identify,
  type JobRecord,
  writeExit,
} from "../src/shells/job.js";
import { scratchDir } from "./session.js";

/**
 * Puts a `ps` first on PATH until the test ends that hangs, ignoring SIGTERM, on call `hangAt`
 * (from 0), or on every call without it; every other call runs the real `ps`. Install it after
 * spawning jobs: `spawnJob` asks `ps` too.
 */
export function hangingPs(hangAt?: number): void {
  const bin = scratchDir("bin");
  const calls = join(bin, "calls");
  const hangs = hangAt === undefined ? "true" : `[ "$n" = ${hangAt} ]`;
  writeFileSync(
    join(bin, "ps"),
    [
      "#!/bin/bash",
      `n=$(cat '${calls}' 2>/dev/null || echo 0); echo $((n + 1)) > '${calls}'`,
      `if ${hangs}; then trap '' TERM; while :; do sleep 0.1; done; fi`,
      'exec /bin/ps "$@"',
    ].join("\n"),
  );
  chmodSync(join(bin, "ps"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  onTestFinished(() => {
    process.env.PATH = path;
  });
}

export function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    // macOS answers EPERM for a group whose members are zombies not yet reaped.
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

const shellsOver = new WeakMap<JobRecord, Promise<number>>();

/**
 * A real shell in its own detached group running `command`, adopted as a job in `root`. Its end is
 * left to `finish`, as to a moved call's continuation. The group is killed when the test ends.
 */
export async function spawnJob(
  command: string,
  o: { root?: string; id?: string } = {},
): Promise<JobRecord> {
  const root = o.root ?? scratchDir("shells");
  const id = o.id ?? "ab12cd34";
  const dir = join(root, id);
  // The subshell resets the TERM trap, so a stop kills the command and the shell exits with its code.
  const script = [
    "trap : TERM",
    `( ${command}\n) >> '${dir}/out.log' 2>&1 < /dev/null`,
    "exit $?",
  ].join("\n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "out.log"), "");
  const child = spawn("/bin/bash", ["-c", script], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid as number;
  onTestFinished(() => killGroup(pid));
  const over = new Promise<number>((resolve) => {
    child.on("exit", (code, signal) =>
      resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)),
    );
  });
  // A command that is already over is out of ps's reach; its token is never read.
  const identity = (await identify(pid)) ?? { pgid: pid, token: "gone" };
  const job = adoptMoved({
    root,
    owner: identity.token,
    id,
    command,
    cwd: root,
    sessionId: "s1",
    pid,
    pgid: identity.pgid,
    token: identity.token,
    startedAt: Date.now(),
  });
  shellsOver.set(job, over);
  return job;
}

/** Resolves with the shell's exit code once it has exited; processes it left behind may live on. */
export function shellOver(job: JobRecord): Promise<number> {
  const over = shellsOver.get(job);
  if (!over) throw new Error(`job ${job.id} was not spawned by spawnJob`);
  return over;
}

/** Waits for the shell to exit, then writes its `exit`, as the continuation does in production. */
export async function finish(job: JobRecord): Promise<void> {
  await writeExit(job.dir, await shellOver(job));
}

/**
 * Resolves once `check()` holds. It polls on the real clock because `fs.watch` drops events under
 * load; a throwing check is not yet (the file may be mid-write or gone). The test's timeout is its deadline.
 */
export function appears(check: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const look = () => {
      try {
        if (!check()) return;
      } catch {
        return;
      }
      clearInterval(poll);
      resolve();
    };
    const poll = setInterval(look, 10);
    onTestFinished(() => clearInterval(poll));
    look();
  });
}

/** Resolves with the file's text once it exists. */
export const fileAppears = (path: string) =>
  appears(() => existsSync(path)).then(() => readFileSync(path, "utf8"));

/** Holds a command until `gate` exists; the cap ends one a failed test never released. */
export const gated = (gate: string) =>
  `until [ -e '${gate}' ] || [ $SECONDS -ge 30 ]; do sleep 0.02; done`;

export const gateFile = () => join(scratchDir("gate"), "go");

/** The pid of a child that has already been reaped. */
export async function deadPid(): Promise<number> {
  const child = spawn("true", { stdio: "ignore" });
  await new Promise((resolve) => child.on("close", resolve));
  return child.pid as number;
}

/** A job idling under `trap`, returned once bash has installed it: an earlier signal would kill it. */
export async function spawnTrapped(
  trap: string,
  o: { root?: string; id?: string } = {},
): Promise<JobRecord> {
  const ready = join(scratchDir("ready"), "ready");
  const job = await spawnJob(
    `${trap}\ntouch '${ready}'\nwhile [ $SECONDS -lt 30 ]; do sleep 0.05; done`,
    o,
  );
  await fileAppears(ready);
  return job;
}
