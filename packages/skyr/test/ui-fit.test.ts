import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { fitToWidth } from "../src/ui/fit.js";
import { CORPUS, WIDTHS_SWEEP } from "./ui.js";

test("fitToWidth never returns a line wider than its width, for every width 0-200 and every corpus string, with … and with no ellipsis", () => {
  for (const width of WIDTHS_SWEEP)
    for (const text of CORPUS)
      for (const ellipsis of ["…", "...", ""])
        expect(
          visibleWidth(fitToWidth(text, width, ellipsis)),
          JSON.stringify({ text, width, ellipsis }),
        ).toBeLessThanOrEqual(width);
});

test("fitToWidth at width 0 or below is the empty string", () => {
  expect(fitToWidth("hello", 0, "…")).toBe("");
  expect(fitToWidth("hello", -3, "")).toBe("");
});

test("an ellipsis wider than the room is left out rather than overflowing", () => {
  expect(fitToWidth("hello", 1, "...")).toBe("h");
  expect(fitToWidth("hello", 2, "…")).toBe("h…");
});

test("fitToWidth never splits a wide character", () => {
  const wide = String.fromCodePoint(0x6f22, 0x5b57);
  expect(fitToWidth(wide, 3, "")).toBe(String.fromCodePoint(0x6f22));
});

test("text that fits comes back unchanged, escapes included", () => {
  const styled = "\x1b[31mred\x1b[0m";
  expect(fitToWidth(styled, 3, "…")).toBe(styled);
  expect(fitToWidth("", 0, "…")).toBe("");
});

test("fitToWidth adds no escape sequence of its own", () => {
  const cut = fitToWidth("\x1b[31mred and more\x1b[0m", 6, "…");
  expect(cut).not.toContain("\x1b[0m");
});
