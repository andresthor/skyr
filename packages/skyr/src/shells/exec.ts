/**
 * Pi's own local shell operations with one addition: a call still running at the limit is not
 * killed but kept running in this process as a background job. Pi stays in charge of the
 * process (spawn, pipes, kill); the move rejects Pi's `exec` with `Moved` while the inner run
 * carries on, and its end is recorded in the job dir by a continuation that only touches files.
 */
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { errnoOf } from "../tools/render.js";
import {
  adoptMoved,
  capLog,
  type identify,
  type JobRecord,
  LOG_CAP,
  lastLines,
  TAIL_READ,
  type TruncateTail,
  writeExit,
} from "./job.js";

/** Output a call keeps in memory while it has no log; past it the log is opened and fed. */
const HEAD_CAP = 256 * 1024;
const START_POLL_MS = 5;
const START_WAIT_MS = 2_000;

/** Rejects Pi's `exec` once the call has become a job; the tool turns it into the moved result. */
export class Moved extends Error {
  constructor(
    readonly job: JobRecord,
    /** The call's last output, from memory. */
    readonly tail: string,
    /** Moved by `background`, as against at the limit. */
    readonly immediate: boolean,
  ) {
    super(`moved to the background as job ${job.id}`);
  }
}

/**
 * Appends `cause` to `<root>/error.log`, where failures nobody is awaiting end up. Never throws:
 * it runs on timers and stream events.
 */
export function logError(root: string, id: string, cause: unknown): void {
  const text = cause instanceof Error ? (cause.stack ?? cause.message) : cause;
  try {
    appendFileSync(
      join(root, "error.log"),
      `${new Date().toISOString()} ${id} ${String(text)}\n`,
    );
  } catch {
    // The root is the unwritable thing; there is no other place to say so.
  }
}

interface LogWriter {
  write(chunk: Buffer): void;
  /** Resolves once everything written is on disk and the file is closed. */
  close(): Promise<void>;
}

/**
 * The one writer of a job's `out.log`. Writes run one after another, and past 8 MiB the writer
 * itself cuts the file between two writes, so nothing is lost to the cut.
 */
function logWriter(dir: string, fail: (error: unknown) => void): LogWriter {
  const path = join(dir, "out.log");
  let file: Promise<FileHandle> | undefined;
  let bytes = 0;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>) => {
    chain = chain.then(step).catch(fail);
  };
  return {
    write(chunk) {
      enqueue(async () => {
        file ??= open(path, "a");
        await (await file).write(chunk);
        bytes += chunk.length;
        if (bytes > LOG_CAP) {
          await capLog(dir);
          bytes = (await stat(path)).size;
        }
      });
    },
    async close() {
      enqueue(async () => {
        await (await file)?.close();
      });
      await chain;
    },
  };
}

/**
 * @param opts.command The model's command, as the job's record and title show it.
 * @param opts.owner This Pi's identity token, or undefined while a call must not move (the
 *   session is not up, or has ended); read when the limit fires.
 * @param opts.identify Names the shell's process group and start time at the move.
 * @param opts.background Move as soon as the shell has written its pid instead of at the limit;
 *   with no pid within two seconds, or no owner, the call is an ordinary one that moves at the limit.
 * @param opts.onMoved Called once, synchronously, after the job is on disk; must not throw.
 * @param opts.onExited Called once, after a moved job's `exit` is written or could not be; the
 *   owning process learns the shell's end here. A reload that replaced the owner leaves it a
 *   no-op.
 */
export function movingOperations(opts: {
  ops: BashOperations;
  limitMs: number;
  root: string;
  sessionId: string;
  command: string;
  background: boolean;
  truncateTail: TruncateTail;
  owner(): string | undefined;
  identify: typeof identify;
  onMoved(job: JobRecord): void;
  onExited(job: JobRecord): void | Promise<void>;
}): BashOperations {
  const { root } = opts;
  return {
    exec(command, cwd, { onData, signal, timeout, env }) {
      const id = randomBytes(4).toString("hex");
      const dir = join(root, id);
      const pidFile = join(root, ".pending", id);
      const startedAt = Date.now();
      const fail = (error: unknown) => logError(root, id, error);

      const own = new AbortController();
      const forward = () => own.abort();
      if (signal?.aborted) own.abort();
      else signal?.addEventListener("abort", forward, { once: true });

      const head: Buffer[] = [];
      let headBytes = 0;
      let recent = Buffer.alloc(0);
      let log: LogWriter | undefined;
      let logBroken = false;
      let moved: JobRecord | undefined;
      let settled = false;

      const openLog = () => {
        try {
          mkdirSync(dir, { recursive: true });
          // A silent job still has a log to point at.
          writeFileSync(join(dir, "out.log"), "");
          log = logWriter(dir, fail);
          for (const chunk of head) log.write(chunk);
        } catch (error: unknown) {
          logBroken = true;
          fail(error);
        }
        head.length = 0;
        headBytes = 0;
      };

      const tee = (data: Buffer) => {
        if (!moved) {
          recent = Buffer.concat([recent, data]);
          if (recent.length > TAIL_READ)
            recent = recent.subarray(recent.length - TAIL_READ);
          onData(data);
        }
        if (log) log.write(data);
        else if (!logBroken) {
          head.push(data);
          headBytes += data.length;
          if (headBytes > HEAD_CAP) openLog();
        }
      };

      // Braced, so a shell that cannot write the file says nothing and the call is unchanged.
      const prefix = `{ echo $$ >'${pidFile.replaceAll("'", "'\\''")}'; } 2>/dev/null; `;
      const run = opts.ops.exec(`${prefix}${command}`, cwd, {
        onData: tee,
        signal: own.signal,
        timeout,
        env,
      });

      return new Promise((resolve, reject) => {
        const finish = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", forward);
          rmSync(pidFile, { force: true });
        };

        async function tryMove(immediate: boolean): Promise<void> {
          if (opts.owner() === undefined) return;
          const pid = readPid(pidFile);
          if (pid === undefined) return;
          // A ps that does not answer is no identity, so the call stays Pi's
          const identity = await opts.identify(pid).catch(() => undefined);
          // The session may have ended during the await. Pi spawns the shell detached, so it leads
          // its own group; any other group means `pid` is not the shell.
          const owner = opts.owner();
          if (
            settled ||
            logBroken ||
            signal?.aborted ||
            owner === undefined ||
            identity?.pgid !== pid
          )
            return;
          const tail = lastLines(recent.toString("utf8"), opts.truncateTail);
          // No await from here: the record, Esc and Pi's feed change hands in one step.
          const job = adoptMoved({
            root,
            owner,
            id,
            command: opts.command,
            cwd,
            sessionId: opts.sessionId,
            pid,
            pgid: identity.pgid,
            token: identity.token,
            startedAt,
          });
          // Anything that can throw comes before `moved`, which Pi's call cannot come back from.
          const rejection = new Moved(job, tail, immediate);
          opts.onMoved(job);
          signal?.removeEventListener("abort", forward);
          moved = job;
          if (!log) openLog();
          reject(rejection);
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        /** The limit counts from the call's start, whatever the wait for a pid took. */
        const armLimit = () => {
          timer = setTimeout(
            () => {
              tryMove(false).catch(fail);
            },
            Math.max(0, opts.limitMs - (Date.now() - startedAt)),
          );
        };
        const nap = (ms: number) =>
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ms);
          });

        /** Waits for the shell's pid, moves at once, and otherwise falls back to the limit. */
        async function startNow(): Promise<void> {
          try {
            while (
              Date.now() - startedAt < START_WAIT_MS &&
              !settled &&
              opts.owner() !== undefined
            ) {
              if (readPid(pidFile) !== undefined) {
                await tryMove(true);
                break;
              }
              await nap(START_POLL_MS);
            }
          } finally {
            if (!settled && !moved) armLimit();
          }
        }

        if (opts.background) startNow().catch(fail);
        else armLimit();

        // The continuation: touches files only, so a reload that replaced this instance does not
        // matter to it.
        async function ended(code: number, note?: string): Promise<void> {
          try {
            if (note) log?.write(Buffer.from(`${note}\n`));
            await log?.close();
            await writeExit(dir, code);
          } catch (error: unknown) {
            fail(error);
          }
          try {
            if (moved) await opts.onExited(moved);
          } catch (error: unknown) {
            fail(error);
          }
        }

        async function settle(
          unmoved: () => void,
          code: number,
          note?: string,
        ): Promise<void> {
          settled = true;
          try {
            finish();
          } catch (error: unknown) {
            fail(error);
          }
          if (moved) return ended(code, note);
          try {
            await log?.close();
            // Also a dir `adoptMoved` left behind when it failed part-way.
            rmSync(dir, { recursive: true, force: true });
          } catch (error: unknown) {
            fail(error);
          }
          unmoved();
        }

        run.then(
          (result) => settle(() => resolve(result), result.exitCode ?? 1),
          (error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            const [code, note] = message.startsWith("timeout:")
              ? [124, undefined]
              : message === "aborted"
                ? [137, undefined]
                : [1, message];
            return settle(() => reject(error), code, note);
          },
        );
      });
    },
  };
}

/** The shell's `$$` from the call's pid file; undefined while the file is missing or not a pid. */
function readPid(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  } catch (error: unknown) {
    if (errnoOf(error) === "ENOENT") return undefined;
    throw error;
  }
}
