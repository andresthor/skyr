/**
 * Microphone capture: 16 kHz s16le mono PCM from a spawned recorder — sox `rec` first, and
 * ffmpeg only as a fallback for machines without sox: its input is avfoundation, so the
 * fallback is macOS-only.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { errnoOf } from "../errno.js";
import { micFailed, VoiceError } from "./errors.js";

/** The capture rate: the recorder arguments, the PCM format string and the chunk size derive from it. */
export const SAMPLE_RATE_HZ = 16_000;
/** s16le full scale: 0 dBFS. */
const FULL_SCALE = 32_768;

const REC_ARGS = [
  "-q",
  "-V1",
  "--buffer",
  "2048",
  "-c",
  "1",
  "-b",
  "16",
  "-e",
  "signed-integer",
  "-r",
  `${SAMPLE_RATE_HZ}`,
  "-t",
  "raw",
  "-",
];
const FFMPEG_ARGS = [
  "-loglevel",
  "error",
  "-f",
  "avfoundation",
  "-i",
  ":default",
  "-ac",
  "1",
  "-ar",
  `${SAMPLE_RATE_HZ}`,
  "-f",
  "s16le",
  "pipe:1",
];

/** GUI-launched terminals often lack Homebrew on PATH, so absolute locations are probed first. */
const probeDirs = () => [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  ...(process.env.PATH ?? "").split(":").filter(Boolean),
];

function findBinary(bin: string, dirs: readonly string[]): string | undefined {
  return dirs.map((d) => `${d}/${bin}`).find((p) => existsSync(p));
}

/** Seam for tests: the directories searched for a recorder, in order; Homebrew's, then PATH by default. */
export interface MicDeps {
  dirs?: readonly string[];
}

/**
 * Spawns sox `rec`, or ffmpeg when no directory in `dirs` holds rec, and returns its stdout;
 * `dirs` defaults to the real search path. Throws `VoiceError` when neither is found. The stream
 * fails with a `VoiceError` when the recorder can't start, exits non-zero or dies on a signal,
 * which is how a busy device or a permission problem shows, and ends after the last chunk when
 * it exits 0. Destroying the stream kills the recorder.
 */
export function micSource({ dirs = probeDirs() }: MicDeps = {}): Readable {
  const rec = findBinary("rec", dirs);
  const recorder = rec || findBinary("ffmpeg", dirs);
  // ffmpeg works too, but only on macOS, so the hint names sox
  if (recorder === undefined)
    throw new VoiceError("sox not found · brew install sox");
  const [cmd, args] =
    recorder === rec ? [recorder, REC_ARGS] : [recorder, FFMPEG_ARGS];

  const child: ChildProcess = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const out = new PassThrough();
  // ended from "close" below: a stream that ended on its own would drop the exit's error
  child.stdout?.pipe(out, { end: false });
  child.on("error", (error: unknown) =>
    out.destroy(
      new VoiceError(
        `can't start ${basename(cmd)} (${errnoOf(error) ?? "error"})`,
      ),
    ),
  );
  // "close", not "exit": it waits for stdout, so every chunk is through before the stream ends
  child.on("close", (code) => {
    // destroyed already: stopped by its reader, or failed to start
    if (out.destroyed) return;
    if (code === 0) out.end();
    // a signal, not a status code, leaves nothing to name
    else
      out.destroy(
        code === null
          ? micFailed()
          : new VoiceError(
              `microphone unavailable (${basename(cmd)} exited ${code})`,
            ),
      );
  });
  const destroy = out.destroy.bind(out);
  out.destroy = (err?: Error) => {
    child.kill("SIGTERM");
    return destroy(err);
  };
  return out;
}

/** A 16-bit PCM chunk's RMS level in dBFS; digital silence and an empty chunk are −Infinity. */
export function pcmDbfs(buf: Buffer): number {
  // readInt16LE rather than an Int16Array view: pooled Buffers can sit at odd offsets
  const n = buf.length >> 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    sum += v * v;
  }
  return 20 * Math.log10(Math.sqrt(sum / (n || 1)) / FULL_SCALE);
}
