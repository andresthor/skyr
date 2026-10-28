import { expect, test } from "vitest";
import { formatDuration, formatElapsed } from "../src/ui/format.js";

test("a finished span prints tenths under 10 s, whole seconds under a minute, then minutes and hours", () => {
  expect(
    [
      0, 50, 3_140, 9_949, 9_950, 41_000, 59_499, 59_500, 134_000, 1_138_000,
      3_599_499, 3_599_500, 3_840_000,
    ].map(formatDuration),
  ).toEqual([
    "0.0s",
    "0.1s",
    "3.1s",
    "9.9s",
    "10s",
    "41s",
    "59s",
    "1m00s",
    "2m14s",
    "18m58s",
    "59m59s",
    "1h00m",
    "1h04m",
  ]);
});

test("a running span never shows tenths, so its digits do not flicker", () => {
  expect([999, 16_900, 64_000, 3_840_000].map(formatElapsed)).toEqual([
    "0s",
    "16s",
    "1m04s",
    "1h04m",
  ]);
});

test("1138 seconds never prints as 1138s or 1138.0s", () => {
  expect(formatDuration(1_138_000)).toBe("18m58s");
  expect(formatElapsed(1_138_000)).toBe("18m58s");
});

test("a negative or non-finite span prints zero, never NaN", () => {
  for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(formatDuration(ms)).toBe("0.0s");
    expect(formatElapsed(ms)).toBe("0s");
  }
});
