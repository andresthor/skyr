/**
 * The level the recorder's chunks are measured at. It feeds the meter, the speech gate and the
 * blocked-mic check (digital silence, −Infinity dBFS), so a wrong scale misreads all three.
 */
import { describe, expect, test } from "vitest";
import { pcmDbfs } from "../src/voice/mic.js";

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
