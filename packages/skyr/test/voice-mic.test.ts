/**
 * The level the recorder's chunks are measured at. It feeds the meter, the speech gate and the
 * blocked-mic check (an RMS of exactly zero), so a wrong scale misreads all three.
 */
import { describe, expect, test } from "vitest";
import { pcmRms } from "../src/voice/mic.js";

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

describe("pcmRms", () => {
  test("a sine at half scale measures half over root two", () => {
    expect(pcmRms(sine(0.5, 1600))).toBeCloseTo(0.5 / Math.SQRT2, 3);
  });

  test("a chunk at an odd byte offset, as pooled Buffers can be, measures the same", () => {
    const odd = sine(0.5, 1600, 1);
    expect(odd.byteOffset % 2).toBe(1);
    expect(pcmRms(odd)).toBeCloseTo(pcmRms(sine(0.5, 1600)), 10);
  });

  test("digital silence and an empty chunk measure exactly zero", () => {
    expect(pcmRms(Buffer.alloc(3200))).toBe(0);
    expect(pcmRms(Buffer.alloc(0))).toBe(0);
  });
});
