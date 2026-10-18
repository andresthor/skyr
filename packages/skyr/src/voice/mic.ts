/**
 * Microphone capture: 16 kHz s16le mono PCM from a spawned recorder — sox `rec` first, and
 * ffmpeg only as a fallback for machines without sox: its input is avfoundation, so the
 * fallback is macOS-only.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { errnoOf } from "../tools/render.js";
import { micFailed, VoiceError } from "./errors.js";

/** The capture format everything else derives: chunk arithmetic, the speech gate, the PCM string. */
export const SAMPLE_RATE_HZ = 16_000;
/** s16le full scale; PCM RMS and the speech gate are fractions of it. */
export const FULL_SCALE = 32_768;

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
function findBinary(bin: string): string | undefined {
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
  ];
  return dirs.map((d) => `${d}/${bin}`).find((p) => existsSync(p));
}

/**
 * Spawns sox `rec` (ffmpeg as a fallback) and returns its stdout. Destroying the
 * stream kills the recorder. A recorder that exits on its own before it is
 * stopped surfaces as a "microphone unavailable" error, which is how a busy device
 * or a permission problem shows.
 */
export function micSource(): Readable {
  const rec = findBinary("rec");
  const recorder = rec || findBinary("ffmpeg");
  // ffmpeg works too, but only on macOS, so the hint names sox
  if (recorder === undefined)
    throw new VoiceError("sox not found · brew install sox");
  const [cmd, args] =
    recorder === rec ? [recorder, REC_ARGS] : [recorder, FFMPEG_ARGS];

  const child: ChildProcess = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const out = new PassThrough();
  let stopped = false;
  child.stdout?.pipe(out);
  child.on("error", (error: unknown) =>
    out.destroy(
      new VoiceError(
        `can't start ${basename(cmd)} (${errnoOf(error) ?? "error"})`,
      ),
    ),
  );
  child.on("exit", (code) => {
    // a signal, not a status code, leaves nothing to name
    if (!stopped && code !== 0)
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
    stopped = stopped || !err;
    child.kill("SIGTERM");
    return destroy(err);
  };
  return out;
}

/** RMS of a 16-bit PCM chunk, 0..1 of full scale. */
export function pcmRms(buf: Buffer): number {
  // readInt16LE rather than an Int16Array view: pooled Buffers can sit at odd offsets
  const n = buf.length >> 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / (n || 1)) / FULL_SCALE;
}

/** An RMS that is 0..1 of full scale, in dBFS; silence is −Infinity. */
export function dbfs(rms: number): number {
  return 20 * Math.log10(rms);
}
