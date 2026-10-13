/** Microphone capture: 16 kHz s16le mono PCM from a spawned recorder. */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { PassThrough, type Readable } from "node:stream";
import { VoiceError } from "./errors.js";

export type AudioSource = () => Readable;

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
  "16000",
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
  "16000",
  "-f",
  "s16le",
  "pipe:1",
];

/** GUI-launched terminals often lack Homebrew on PATH, so absolute locations are probed first. */
export function findBinary(
  bin: string,
  path = process.env.PATH ?? "",
): string | undefined {
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    ...path.split(":").filter(Boolean),
  ];
  return dirs.map((d) => `${d}/${bin}`).find((p) => existsSync(p));
}

/**
 * Spawns sox `rec` (ffmpeg as a fallback) and returns its stdout. Destroying the
 * stream kills the recorder. A recorder that exits on its own before it is
 * stopped surfaces as `mic` error, which is how a missing or busy device shows.
 */
export function micSource(): Readable {
  const rec = findBinary("rec");
  const recorder = rec || findBinary("ffmpeg");
  if (recorder === undefined)
    throw new VoiceError("recorder", "needs sox · brew install sox");
  const [cmd, args] =
    recorder === rec ? [recorder, REC_ARGS] : [recorder, FFMPEG_ARGS];

  const child: ChildProcess = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const out = new PassThrough();
  let stopped = false;
  child.stdout?.pipe(out);
  child.on("error", () =>
    out.destroy(new VoiceError("mic", "no microphone found")),
  );
  child.on("exit", (code) => {
    if (!stopped && code !== 0)
      out.destroy(new VoiceError("mic", "no microphone found"));
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
  return Math.sqrt(sum / (n || 1)) / 32768;
}
