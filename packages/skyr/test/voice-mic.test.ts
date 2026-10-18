/**
 * The recorder: which one runs, what its stream delivers and how its failures read, driven by
 * fake recorders in a temp dir that is the only one searched. Then the level its chunks are
 * measured at, which feeds the meter, the speech gate and the blocked-mic check.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, onTestFinished, test } from "vitest";
import { micSource, pcmDbfs } from "../src/voice/mic.js";

/** Whole periods of a sine at `amplitude` of full scale, as s16le samples from byte `offset`. */
function sine(amplitude: number, samples: number, offset = 0): Buffer {
  const buf = Buffer.alloc(offset + samples * 2);
  for (let i = 0; i < samples; i++)
    buf.writeInt16LE(
      Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * i) / 16)),
      offset + i * 2,
    );
  return buf.subarray(offset);
}

describe("pcmDbfs", () => {
  test("a sine at half scale measures its RMS, half over root two, as −9.03 dBFS", () => {
    expect(pcmDbfs(sine(0.5, 1600))).toBeCloseTo(-9.03, 2);
  });

  test("a chunk at an odd byte offset, as pooled Buffers can be, measures the same", () => {
    const odd = sine(0.5, 1600, 1);
    expect(odd.byteOffset % 2).toBe(1);
    expect(pcmDbfs(odd)).toBeCloseTo(pcmDbfs(sine(0.5, 1600)), 10);
  });

  test("digital silence and an empty chunk measure −Infinity", () => {
    expect(pcmDbfs(Buffer.alloc(3200))).toBe(Number.NEGATIVE_INFINITY);
    expect(pcmDbfs(Buffer.alloc(0))).toBe(Number.NEGATIVE_INFINITY);
  });
});

/** A temp dir holding a shell script per name, the only directory `micSource` searches. */
function recorders(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "skyr-mic-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(scripts))
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

/** Everything the stream delivers, until it ends or fails. */
function drain(stream: Readable): Promise<{ data: string; error?: Error }> {
  return new Promise((resolve) => {
    let data = "";
    stream.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    stream.on("end", () => resolve({ data }));
    stream.on("error", (error) => resolve({ data, error }));
  });
}

describe("micSource", () => {
  test("sox rec runs when present, even beside ffmpeg, as 16 kHz mono raw PCM", async () => {
    const dirs = [
      recorders({ rec: 'echo "rec $*"', ffmpeg: 'echo "ffmpeg $*"' }),
    ];
    const { data, error } = await drain(micSource({ dirs }));
    expect(error).toBeUndefined();
    expect(data).toMatch(/^rec .*-c 1 .*-r 16000 -t raw -$/m);
  });

  test("without sox, ffmpeg records from avfoundation instead", async () => {
    const dirs = [recorders({ ffmpeg: 'echo "ffmpeg $*"' })];
    const { data, error } = await drain(micSource({ dirs }));
    expect(error).toBeUndefined();
    expect(data).toMatch(
      /^ffmpeg .*-f avfoundation .*-ar 16000 -f s16le pipe:1$/m,
    );
  });

  test("with neither recorder, it throws naming sox and how to install it", () => {
    expect(() => micSource({ dirs: [recorders({})] })).toThrow(
      "sox not found · brew install sox",
    );
  });

  test("a recorder that can't be started fails the stream with its errno", async () => {
    const dir = recorders({ rec: "exit 0" });
    chmodSync(join(dir, "rec"), 0o644);
    const { error } = await drain(micSource({ dirs: [dir] }));
    expect(error?.message).toBe("can't start rec (EACCES)");
  });

  test("a recorder that exits 0 ends the stream after everything it wrote, without an error", async () => {
    const dirs = [recorders({ rec: "printf 'one '; printf two" })];
    const { data, error } = await drain(micSource({ dirs }));
    expect(error).toBeUndefined();
    expect(data).toBe("one two");
  });
});
