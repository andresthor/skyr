/**
 * Background jobs on disk and as process groups. A job's directory is its record: the command,
 * the log, the exit status and why it was stopped. Nothing here needs a Pi session; the caller
 * passes in the tail function and words the errors for its reader.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import {
  appendFile,
  type FileHandle,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { errnoOf } from "../tools/render.js";
import type { StopReason } from "./store.js";

const KILL_WAIT_MS = 1_000;
const REAP_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_MS = 50;
const PS_TIMEOUT_MS = 2_000;
/** The size past which a log's writer cuts it with `capLog`. */
export const LOG_CAP = 8 * 1024 * 1024;
const LOG_HEAD = 64 * 1024;
const LOG_TAIL = 256 * 1024;
/** How much of a log's end `tailOf` reads, and how much of its output a running call keeps. */
export const TAIL_READ = 16 * 1024;
const TAIL_LINES = 20;
const TAIL_BYTES = 2 * 1024;
const execFileAsync = promisify(execFile);
const CUT_MARKER = Buffer.from(
  "[skyr: output dropped here to keep this log under 8 MiB]\n",
);

export interface JobRecord {
  id: string;
  dir: string;
  command: string;
  cwd: string;
  sessionId: string;
  /** The shell Pi spawned for the call, `$$` in its first line. */
  pid: number;
  /** The shell's process group, which Pi's detached spawn makes the shell's own. */
  pgid: number;
  /** `ps` start time of `pid` under `LC_ALL=C TZ=UTC`. */
  token: string;
  /** Epoch ms of the call that became the job. */
  startedAt: number;
}

/** What the job dir says about how a job ended; `unknown` while running or when nothing was recorded. */
export interface Outcome {
  status: "done" | "failed" | "aborted" | "unknown";
  exitCode?: number;
  stopReason?: StopReason;
  endedAt?: number;
}

/** `killed`: SIGTERM did not end the group, so SIGKILL was sent. `survived`: it outlived SIGKILL too. */
export interface StopResult {
  killed: boolean;
  survived: boolean;
  /** `isSame` said the group may no longer be the job's, so it was not signalled. */
  skipped?: "unverified";
}

export type TruncateTail = (
  text: string,
  o: { maxLines: number; maxBytes: number },
) => { content: string };

/**
 * Creates `<root>/<id>` and writes `owner.json` and then `job.json` into it, synchronously, so
 * a move commits in one step. A throw leaves no `job.json`; the caller treats the call as not
 * moved. `owner` is this Pi's `identify(process.pid)` token.
 */
export function adoptMoved(
  spec: Omit<JobRecord, "dir"> & { root: string; owner: string },
): JobRecord {
  const { root, owner, ...rest } = spec;
  const dir = join(root, spec.id);
  // Recursive: the log's writer may have made the dir already, but never another job's record.
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, "job.json")))
    throw new Error(`job ${spec.id} already exists in ${root}`);
  writeJsonSync(join(dir, "owner.json"), { pid: process.pid, token: owner });
  writeJsonSync(join(dir, "job.json"), rest);
  return { ...rest, dir };
}

/**
 * The process group and start-time token of `pid`, or undefined when `ps` cannot report it.
 * Throws when `ps` does not answer in time, which says nothing about whether `pid` is gone.
 */
export async function identify(
  pid: number,
): Promise<{ pgid: number; token: string } | undefined> {
  const out = await execFileAsync(
    "ps",
    ["-o", "pgid=", "-o", "lstart=", "-p", String(pid)],
    {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      // Pi's start awaits this; SIGKILL, because a ps that ignores SIGTERM would hold it up
      timeout: PS_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  ).then(
    ({ stdout }) => stdout,
    (error: unknown) => {
      if ((error as { killed?: boolean }).killed)
        throw new Error(`ps did not answer within ${PS_TIMEOUT_MS / 1000} s`);
      // ps exits non-zero for a pid that is gone; a missing ps is the same answer.
      return "";
    },
  );
  const match = /^(\d+)\s+(\S.*)$/.exec(out.trim());
  const pgid = Number(match?.[1]);
  return match?.[2] !== undefined && pgid > 1
    ? { pgid, token: match[2] }
    : undefined;
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error: unknown) {
    if (errnoOf(error) === "ESRCH") return false;
    // EPERM: the group exists and belongs to another user.
    if (errnoOf(error) === "EPERM") return true;
    throw error;
  }
}

/** Records how the shell ended as `<code> <epoch seconds>`; readers see all of it or none. */
export async function writeExit(dir: string, code: number): Promise<void> {
  const target = join(dir, "exit");
  const temp = `${target}.tmp`;
  await writeFile(temp, `${code} ${Math.floor(Date.now() / 1000)}\n`);
  await rename(temp, target);
}

/** Read from the files only: `stop.json` wins over `exit`, and `exitCode` is kept for either. */
export async function readOutcome(dir: string): Promise<Outcome> {
  const exit = /^(\d+) (\d+)\n?$/.exec(
    (await readText(join(dir, "exit"))) ?? "",
  );
  const exitCode = exit ? Number(exit[1]) : undefined;
  const stop = parseStop(await readText(join(dir, "stop.json")));
  if (stop !== undefined)
    return {
      status: "aborted",
      stopReason: stop.reason,
      endedAt: stop.at,
      exitCode,
    };
  if (exit)
    return {
      status: exitCode === 0 ? "done" : "failed",
      exitCode,
      endedAt: Number(exit[2]) * 1000,
    };
  return { status: "unknown" };
}

/**
 * Stops the jobs' process groups: SIGTERM, one shared `graceMs` for all of them, then SIGKILL
 * for the survivors. A job whose group is gone, or for which `isSame` says false, gets no
 * signal and no `stop.json`. Every other job's `stop.json` is written before its first signal,
 * unless one exists, so repeating a stop keeps the first reason. Results are in the order of
 * `jobs`. One job's failure never spares the others: a `stop.json` that cannot be written does
 * not spare its group (the caller then takes the reason from the stop itself), and any other
 * failure is rethrown only after every group has been stopped.
 */
export async function stopJobs(
  jobs: readonly JobRecord[],
  reason: StopReason,
  isSame: (job: JobRecord) => Promise<boolean>,
  graceMs: number,
): Promise<StopResult[]> {
  const unverified = new Set<JobRecord>();
  const checks = await Promise.allSettled(
    jobs.map(async (job): Promise<JobRecord[]> => {
      if (!groupAlive(job.pgid)) return [];
      if (!(await isSame(job))) {
        unverified.add(job);
        return [];
      }
      try {
        // A shell that already exited still gets one: the stop is why its group ended.
        if ((await readOutcome(job.dir)).status !== "aborted")
          await writeJson(join(job.dir, "stop.json"), {
            reason,
            at: Date.now(),
          });
      } catch {
        // The dir is gone, say: the stop goes ahead and its caller records the reason.
      }
      return [job];
    }),
  );
  const live = checks.flatMap((c) => (c.status === "fulfilled" ? c.value : []));
  for (const job of live) signalGroup(job.pgid, "SIGTERM");
  await settle(live, graceMs);
  const stubborn = live.filter((job) => groupAlive(job.pgid));
  for (const job of stubborn) signalGroup(job.pgid, "SIGKILL");
  await settle(stubborn, KILL_WAIT_MS);
  const failed = checks.find((c) => c.status === "rejected");
  if (failed) throw failed.reason;
  return jobs.map((job) => {
    const killed = stubborn.includes(job);
    return {
      killed,
      survived: killed && groupAlive(job.pgid),
      ...(unverified.has(job) && { skipped: "unverified" as const }),
    };
  });
}

/**
 * Cuts `out.log` in place once it passes 8 MiB, keeping the first 64 KiB and the last 256 KiB
 * on line boundaries with a marker between them. Only the log's one writer may call it, between
 * two of its writes: the file is rewritten with no lock.
 */
export async function capLog(dir: string): Promise<void> {
  const path = join(dir, "out.log");
  const size = await stat(path).then(
    (s) => s.size,
    (error: unknown) => {
      // A removed log has nothing to cut.
      if (errnoOf(error) === "ENOENT") return 0;
      throw error;
    },
  );
  if (size <= LOG_CAP) return;
  const file = await open(path, "r");
  let head: Buffer;
  let tail: Buffer;
  try {
    head = await readAt(file, 0, LOG_HEAD);
    tail = await readAt(file, size - LOG_TAIL, LOG_TAIL);
  } finally {
    await file.close();
  }
  // A cut that leaves nothing (output written with \r only) keeps the raw bytes.
  const headEnd = head.lastIndexOf(0x0a);
  if (headEnd !== -1) head = head.subarray(0, headEnd + 1);
  const tailStart = tail.indexOf(0x0a);
  if (tailStart !== -1 && tailStart < tail.length - 1)
    tail = tail.subarray(tailStart + 1);
  await truncate(path, head.length);
  await appendFile(path, Buffer.concat([CUT_MARKER, tail]));
}

/** `text` bounded by Pi's `truncateTail` to its last 20 lines and 2 KiB. */
export function lastLines(text: string, truncateTail: TruncateTail): string {
  return truncateTail(text, { maxLines: TAIL_LINES, maxBytes: TAIL_BYTES })
    .content;
}

/** The last lines of the job's `out.log`, as `lastLines` bounds them. */
export async function tailOf(
  dir: string,
  truncateTail: TruncateTail,
): Promise<string> {
  const file = await open(join(dir, "out.log"), "r");
  try {
    const { size } = await file.stat();
    const text = await readAt(
      file,
      Math.max(0, size - TAIL_READ),
      TAIL_READ,
    ).then((b) => b.toString("utf8"));
    return lastLines(text, truncateTail);
  } finally {
    await file.close();
  }
}

/** Exactly-once guard across Pi instances: true for the one caller that created the marker. */
export async function claimDelivery(
  dir: string,
  sessionId: string,
): Promise<boolean> {
  try {
    await writeFile(join(dir, `delivered.${sessionId}`), "", { flag: "wx" });
    return true;
  } catch (error: unknown) {
    if (errnoOf(error) === "EEXIST") return false;
    throw error;
  }
}

/** Undoes a `claimDelivery` whose delivery did not happen, so a later sweep delivers it. */
export async function releaseDelivery(
  dir: string,
  sessionId: string,
): Promise<void> {
  await rm(join(dir, `delivered.${sessionId}`), { force: true });
}

/**
 * Records that the watcher saw the job's group empty. From then on its pgid may belong to anyone,
 * so nothing signals the job again. A removed dir records nothing.
 */
export async function markEnded(dir: string): Promise<void> {
  await writeFile(join(dir, "ended"), "").catch((error: unknown) => {
    if (errnoOf(error) !== "ENOENT") throw error;
  });
}

/** Absolute paths of the job dirs under `root`, none when it does not exist yet; dot-names are not jobs. */
export async function listJobDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: unknown) => {
      // Not made yet, or not makeable: either way no jobs
      if (errnoOf(error) === "ENOENT" || errnoOf(error) === "ENOTDIR")
        return [];
      throw error;
    },
  );
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => join(root, e.name));
}

/**
 * The job's `job.json`, with `dir` taken from where it was read; undefined when the file is
 * missing, torn or not a job record. Throws for any other read error.
 */
export async function readJob(dir: string): Promise<JobRecord | undefined> {
  const raw = parseJson(await readText(join(dir, "job.json")));
  if (typeof raw !== "object" || raw === null) return undefined;
  const fields: Record<string, unknown> = { ...raw };
  const { id, command, cwd, sessionId, pid, pgid, token, startedAt } = fields;
  return typeof id === "string" &&
    typeof command === "string" &&
    typeof cwd === "string" &&
    typeof sessionId === "string" &&
    isProcess(pid) &&
    isProcess(pgid) &&
    typeof token === "string" &&
    typeof startedAt === "number"
    ? { id, dir, command, cwd, sessionId, pid, pgid, token, startedAt }
    : undefined;
}

/** The Pi recorded by `adoptMoved`; undefined when there is none or it is not readable as one. */
export async function readOwner(
  dir: string,
): Promise<{ pid: number; token: string } | undefined> {
  const raw = parseJson(await readText(join(dir, "owner.json")));
  if (typeof raw !== "object" || raw === null) return undefined;
  const fields: Record<string, unknown> = { ...raw };
  const { pid, token } = fields;
  return isProcess(pid) && typeof token === "string"
    ? { pid, token }
    : undefined;
}

// 0 and 1 would signal this process's own group, or every process.
const isProcess = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n > 1;

/** Whether `sessionId` has already been told this job's end. */
export async function wasDelivered(
  dir: string,
  sessionId: string,
): Promise<boolean> {
  return (await mtimeOf(join(dir, `delivered.${sessionId}`))) !== undefined;
}

export async function hasEnded(dir: string): Promise<boolean> {
  return (await mtimeOf(join(dir, "ended"))) !== undefined;
}

/**
 * Marks a job this process's watcher holds at a `/reload`, so the reloaded instance takes it on
 * without an identity check; it goes unwatched only during the reload. Consumed by `takeHandover`.
 */
export async function markHandover(dir: string): Promise<void> {
  await writeFile(join(dir, `handover.${process.pid}`), "");
}

/** Removes this process's handover mark; true when there was one. */
export async function takeHandover(dir: string): Promise<boolean> {
  const mark = join(dir, `handover.${process.pid}`);
  const found = (await mtimeOf(mark)) !== undefined;
  await rm(mark, { force: true });
  return found;
}

/**
 * Removes job dirs that ended more than 7 days before `now` (epoch ms), aged by `stop.json`,
 * then `exit`, then `job.json`, then the dir itself. A dir whose group is alive is kept.
 */
export async function reap(root: string, now: number): Promise<void> {
  for (const dir of await listJobDirs(root)) {
    const record = await readJob(dir);
    if (record !== undefined && groupAlive(record.pgid)) continue;
    let stamp: number | undefined;
    for (const name of ["stop.json", "exit", "job.json", "."]) {
      stamp = await mtimeOf(join(dir, name));
      if (stamp !== undefined) break;
    }
    if (stamp !== undefined && now - stamp > REAP_MS)
      await rm(dir, { recursive: true, force: true });
  }
}

async function mtimeOf(path: string): Promise<number | undefined> {
  return stat(path).then(
    (s) => s.mtimeMs,
    (error: unknown) => {
      if (errnoOf(error) === "ENOENT") return undefined;
      throw error;
    },
  );
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Torn or foreign: the file says nothing.
    return undefined;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error: unknown) {
    // ESRCH: the group emptied since the check; EPERM: not ours, so `survived` reports it.
    if (errnoOf(error) !== "ESRCH" && errnoOf(error) !== "EPERM") throw error;
  }
}

async function settle(jobs: readonly JobRecord[], ms: number): Promise<void> {
  for (
    let waited = 0;
    waited < ms && jobs.some((job) => groupAlive(job.pgid));
    waited += POLL_MS
  )
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

async function readAt(
  file: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function readText(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if (errnoOf(error) === "ENOENT") return undefined;
    throw error;
  });
}

/** Same-directory temp then rename, so a reader never sees a torn file. */
async function writeJson(target: string, data: unknown): Promise<void> {
  // A unique temp: two stops of one job may write `stop.json` at once.
  const temp = `${target}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, JSON.stringify(data), "utf8");
  await rename(temp, target);
}

function writeJsonSync(target: string, data: unknown): void {
  const temp = `${target}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, JSON.stringify(data), "utf8");
  renameSync(temp, target);
}

function parseStop(
  text: string | undefined,
): { reason: StopReason; at: number } | undefined {
  const raw = parseJson(text);
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("reason" in raw) ||
    !("at" in raw)
  )
    return undefined;
  const { reason, at } = raw;
  return typeof at === "number" &&
    (reason === "agent" ||
      reason === "user" ||
      reason === "session" ||
      reason === "pi")
    ? { reason, at }
    : undefined;
}
