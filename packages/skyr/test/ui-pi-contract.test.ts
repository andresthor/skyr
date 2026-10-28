// Pi behaviour the ui layout rests on. A failure here after a Pi upgrade means the design
// changes, not the test.
import {
  rgbColor,
  styleText,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { piScreen } from "./ui.js";

test("Pi measures a tab as three columns", () => {
  expect(visibleWidth("\t")).toBe(3);
  expect(visibleWidth("a\tb")).toBe(5);
});

test("a bare ✔ is one column and ✔ with VS16 is two", () => {
  const check = String.fromCodePoint(0x2714);
  expect(visibleWidth(check)).toBe(1);
  expect(visibleWidth(`${check}${String.fromCodePoint(0xfe0f)}`)).toBe(2);
});

test("Pi's truncateToWidth puts a reset before its ellipsis, which ends a surrounding background", () => {
  const styled = styleText(
    "hello world",
    { bg: rgbColor(40, 40, 60) },
    "truecolor",
  );
  expect(truncateToWidth(styled, 6, "…")).toContain("\u001b[0m…");
});

test("Pi's regular renderer throws on an over-wide line from the second frame, and the first frame does not", () => {
  const overWide = { invalidate() {}, render: () => ["x".repeat(30)] };
  const screen = piScreen(overWide, 10);
  expect(screen.firstFrameCrash).toBeUndefined();
  expect(screen.crash?.message).toMatch(/exceeds terminal width/);
});
