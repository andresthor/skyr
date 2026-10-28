/**
 * What each provider's calls cost today and over the last 30 days, read from the session files
 * under one agent dir. Scans run in slices that yield, never enter a git worktree a writer
 * checked out, and read only the new end of a file that grew, so the footer can ask for a
 * rescan after every run without a stall.
 */
import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { errnoOf } from "../errno.js";
import { positiveOrZero } from "../ui/format.js";
import { clip, describeCause } from "../ui/text.js";

interface SpendFigures {
  readonly day: number;
  readonly month: number;
}

export interface Spend {
  /**
   * `provider`'s spend today and over the last 30 local days; undefined until the first scan has
   * published. Providers are never summed: no total of different billing exists.
   */
  figures(provider: string, now: Date): SpendFigures | undefined;
  /**
   * Scans again in bounded slices; a call during a scan queues one more scan, not several. The
   * promise settles when the scans it started or queued have ended, stopped or not, and never rejects.
   */
  refresh(): Promise<void>;
  /** Ends the scan in flight without publishing; idempotent. */
  stop(): void;
}

/**
 * Session files sit at most this deep below the root: cwd dir, parent, child, nested child, and
 * a few more generations of children. A file deeper than this is not counted.
 */
const MAX_DEPTH = 6;
const SLICE_MS = 8;
const CHUNK_BYTES = 256 * 1024;
/** What identifies a file across scans: a rewrite in place changes it, an append does not. */
const HEAD_BYTES = 256;
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
/** One day past the window, so the local day boundary never decides what to open. */
const STALE_MS = (WINDOW_DAYS + 1) * DAY_MS;
const LINES_PER_CHECK = 64;

type Days = Map<string, number>;
type ByProvider = Map<string, Days>;

/** Local `YYYY-MM-DD`: the key a day's spend is kept under, and sorts as dates do. */
const formatDay = (date: Date): string =>
  [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

/**
 * One call's cost. A session forked or cloned from another repeats its entries, `id` and
 * timestamp and all; ids alone are not unique across unrelated files.
 */
interface Charge {
  readonly id: string | undefined;
  readonly stamp: string;
  readonly provider: string;
  readonly day: string;
  readonly cost: number;
}

/** Why a scan left a session file out: the file, relative to the root, and the cause. */
export interface SpendProblem {
  readonly file: string;
  readonly cause: string;
}

/** What one file added up to, and how far into it that is. */
interface Counted {
  readonly mtimeMs: number;
  readonly size: number;
  /** Where the first line not yet counted starts: before a partial last line. */
  readonly offset: number;
  readonly head: string;
  readonly charges: readonly Charge[];
}

/** The field `key` of `value` when it is an object that has one. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** Who a session line charged, when, and how much; undefined for a line that names no provider. */
function chargeOf(line: string, earliest: number): Charge | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // A line cut by a crash, or not JSON at all, is not a charge
    return undefined;
  }
  const type = field(entry, "type");
  const message = field(entry, "message");
  const holder =
    type === "usage"
      ? entry
      : type === "message" && field(message, "role") === "assistant"
        ? message
        : undefined;
  const provider = field(holder, "provider");
  const cost = field(field(field(holder, "usage"), "cost"), "total");
  const stamp = field(entry, "timestamp");
  if (typeof provider !== "string" || typeof stamp !== "string")
    return undefined;
  const at = Date.parse(stamp);
  if (Number.isNaN(at) || at < earliest) return undefined;
  const id = field(entry, "id");
  return {
    id: typeof id === "string" ? id : undefined,
    stamp,
    provider,
    day: formatDay(new Date(at)),
    cost: positiveOrZero(cost),
  };
}

/** Every charge once: entries a fork copied from its source count in whichever file is read first. */
function totalOf(files: Iterable<Counted>): ByProvider {
  const total: ByProvider = new Map();
  const counted = new Set<string>();
  for (const { charges } of files)
    for (const { id, stamp, provider, day, cost } of charges) {
      if (id !== undefined) {
        const key = `${id}\0${stamp}`;
        if (counted.has(key)) continue;
        counted.add(key);
      }
      const days = total.get(provider) ?? new Map<string, number>();
      total.set(provider, days);
      days.set(day, (days.get(day) ?? 0) + cost);
    }
  return total;
}

/**
 * `root` is `<agentDir>/sessions`. `onChange` follows every publish; `onProblem` gets the first
 * file a scan could not read other than for its absence, with the cause; a file that fails keeps
 * the charges it last gave until it reads again or goes, and so do the files under a directory
 * that cannot be listed. `clock` (ms) and `yieldNow` are the scan's seams for time.
 */
export function createSpend(
  root: string,
  handlers: { onChange(): void; onProblem(problem: SpendProblem): void },
  deps: { clock?: () => number; yieldNow?: () => Promise<void> } = {},
): Spend {
  const clock = deps.clock ?? performance.now.bind(performance);
  const yieldNow =
    deps.yieldNow ?? (() => new Promise<void>((done) => setImmediate(done)));
  const cache = new Map<string, Counted>();
  let published: ByProvider | undefined;
  let stopped = false;
  let running = false;
  let pending = false;
  let idle: Promise<void> = Promise.resolve();

  async function scan(): Promise<void> {
    const seen = new Set<string>();
    const earliest = Date.now() - STALE_MS;
    let problem: SpendProblem | undefined;
    /** Notes why `path` was left out; false when it simply is not there. */
    const skip = (path: string, error: unknown): boolean => {
      const code = errnoOf(error);
      if (code === "ENOENT") return false;
      problem ??= {
        file: relative(root, path) || ".",
        cause: code ?? clip(describeCause(error), 80),
      };
      return true;
    };
    let sliceStart = clock();
    const slice = async () => {
      if (clock() - sliceStart < SLICE_MS) return;
      await yieldNow();
      sliceStart = clock();
    };

    const files: string[] = [];
    // A directory that cannot be listed says nothing about the files under it
    const unlisted: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (skip(dir, error)) unlisted.push(dir + sep);
        return;
      }
      for (const entry of entries) {
        if (stopped) return;
        await slice();
        if (entry.isDirectory()) {
          // A writer's git worktree sits beside its session files and can hold a whole repo
          if (depth + 1 < MAX_DEPTH && entry.name !== "worktrees")
            await walk(join(dir, entry.name), depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl"))
          files.push(join(dir, entry.name));
      }
    };

    /**
     * Adds the charges of `path` past what `prior` counted; undefined when the file is older than
     * the window or the scan stopped.
     */
    const count = async (path: string): Promise<Counted | undefined> => {
      const info = await stat(path);
      if (info.mtimeMs < earliest) return undefined;
      const prior = cache.get(path);
      if (prior?.mtimeMs === info.mtimeMs && prior.size === info.size)
        return prior;
      const handle = await open(path, "r");
      try {
        const headBuffer = Buffer.alloc(Math.min(HEAD_BYTES, info.size));
        await handle.read(headBuffer, 0, headBuffer.length, 0);
        const head = headBuffer.toString("latin1");
        // Session files are append-only: the same start and no shrinking mean only the end is new
        const resume =
          prior !== undefined &&
          info.size >= prior.size &&
          head.startsWith(prior.head);
        const charges: Charge[] = resume ? [...prior.charges] : [];
        let position = resume ? prior.offset : 0;
        // A line spans chunks as pieces, so a huge one is joined once, not at every chunk
        let pieces: Buffer[] = [];
        let carried = 0;
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        let parsed = 0;
        while (position < info.size) {
          await slice();
          if (stopped) return undefined;
          const want = Math.min(CHUNK_BYTES, info.size - position);
          const { bytesRead } = await handle.read(buffer, 0, want, position);
          if (bytesRead === 0) break;
          position += bytesRead;
          const chunk = buffer.subarray(0, bytesRead);
          const cut = chunk.lastIndexOf(0x0a);
          if (cut === -1) {
            pieces.push(Buffer.from(chunk));
            carried += bytesRead;
            continue;
          }
          const text = Buffer.concat([
            ...pieces,
            chunk.subarray(0, cut),
          ]).toString("utf8");
          pieces =
            cut + 1 < bytesRead ? [Buffer.from(chunk.subarray(cut + 1))] : [];
          carried = bytesRead - cut - 1;
          for (const line of text.split("\n")) {
            if (!line.includes('"cost"')) continue;
            const charge = chargeOf(line, earliest);
            if (charge) charges.push(charge);
            parsed += 1;
            if (parsed % LINES_PER_CHECK === 0) await slice();
          }
        }
        return {
          mtimeMs: info.mtimeMs,
          size: info.size,
          offset: position - carried,
          head,
          charges,
        };
      } finally {
        await handle.close();
      }
    };

    await walk(root, 0);
    for (const path of files) {
      if (stopped) return;
      await slice();
      try {
        const counted = await count(path);
        if (!counted) continue;
        cache.set(path, counted);
        seen.add(path);
      } catch (error) {
        // A file that fails keeps what it last gave, until it reads again or is gone
        if (skip(path, error)) seen.add(path);
      }
    }
    if (stopped) return;
    for (const path of cache.keys())
      if (!seen.has(path) && !unlisted.some((dir) => path.startsWith(dir)))
        cache.delete(path);
    published = totalOf(cache.values());
    handlers.onChange();
    if (problem !== undefined) handlers.onProblem(problem);
  }

  async function run(): Promise<void> {
    try {
      do {
        pending = false;
        await scan();
      } while (pending && !stopped);
    } catch (cause) {
      handlers.onProblem({
        file: ".",
        cause: clip(describeCause(cause), 80),
      });
    } finally {
      running = false;
    }
  }

  return {
    figures(provider, now) {
      if (!published) return undefined;
      const today = formatDay(now);
      const first = formatDay(
        new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() - (WINDOW_DAYS - 1),
        ),
      );
      let day = 0;
      let month = 0;
      for (const [key, cost] of published.get(provider) ?? []) {
        if (key === today) day = cost;
        if (key >= first && key <= today) month += cost;
      }
      return { day, month };
    },
    refresh() {
      if (stopped) return Promise.resolve();
      if (running) {
        pending = true;
        return idle;
      }
      running = true;
      idle = run();
      return idle;
    },
    stop() {
      stopped = true;
    },
  };
}
