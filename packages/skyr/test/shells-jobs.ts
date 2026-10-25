import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";
import {
  adoptMoved,
  identify,
  type JobRecord,
  writeExit,
} from "../src/shells/job.js";
import { scratchDir } from "./session.js";

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
 * A real shell in its own detached group running `command`, its output in `out.log`, and a job
 * record for it adopted into `root`. Like Pi's shell it leaves its end to someone else: `finish`
 * records it the way a moved call's continuation does. The group is killed when the test ends.
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

/** Resolves with the file's text once it exists; watches its dir, so it never polls. */
export function fileAppears(path: string): Promise<string> {
  return new Promise((resolve) => {
    const watcher = watch(dirname(path), () => {
      if (existsSync(path)) {
        watcher.close();
        resolve(readFileSync(path, "utf8"));
      }
    });
    if (existsSync(path)) {
      watcher.close();
      resolve(readFileSync(path, "utf8"));
    }
  });
}
