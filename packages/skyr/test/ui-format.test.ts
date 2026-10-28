import { expect, test } from "vitest";
import {
  formatClock,
  formatCost,
  formatCount,
  formatDuration,
  formatElapsed,
  formatTokens,
  plural,
  positiveOrZero,
} from "../src/ui/format.js";

test("tokens are exact under a thousand, rounded thousands under a million, then millions to one decimal", () => {
  expect(
    [999, 1_000, 61_499, 999_499, 999_500, 1_234_567].map(formatTokens),
  ).toEqual(["999 tok", "1k tok", "61k tok", "999k tok", "1M tok", "1.2M tok"]);
});

test("formatCount never writes 1000k and keeps one decimal only in M", () => {
  expect(
    [
      0, 850, 1_000, 61_499, 412_000, 999_499, 999_500, 1_000_000, 1_234_567,
      12_345_678,
    ].map(formatCount),
  ).toEqual([
    "0",
    "850",
    "1k",
    "61k",
    "412k",
    "999k",
    "1M",
    "1M",
    "1.2M",
    "12.3M",
  ]);
});

test("formatCost shows cents below $100, whole dollars from $100, and $0.00 for zero", () => {
  expect(
    [0, 1.82, 4.123, 99.99, 99.996, 100, 101.6, 1204.4].map(formatCost),
  ).toEqual([
    "$0.00",
    "$1.82",
    "$4.12",
    "$99.99",
    "$100",
    "$100",
    "$102",
    "$1204",
  ]);
  expect([-1, Number.NaN, Number.POSITIVE_INFINITY].map(formatCost)).toEqual([
    "$0.00",
    "$0.00",
    "$0.00",
  ]);
});

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

test("the clock is local and zero-padded", () => {
  const date = new Date(2026, 0, 5, 3, 7);
  expect(formatClock(date)).toBe("03:07");
});

test("positiveOrZero keeps only finite numbers above zero", () => {
  expect(
    [3, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5", undefined].map(
      positiveOrZero,
    ),
  ).toEqual([3, 0, 0, 0, 0, 0, 0]);
});

test("plural counts with the noun's own form, and only one is singular", () => {
  expect([0, 1, 2].map((n) => plural(n, "turn"))).toEqual([
    "0 turns",
    "1 turn",
    "2 turns",
  ]);
  expect(plural(1, "entry", "entries")).toBe("1 entry");
  expect(plural(3, "entry", "entries")).toBe("3 entries");
});
