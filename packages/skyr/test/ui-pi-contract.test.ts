// Pi behaviour the ui layout rests on. A failure here after a Pi upgrade means the design
// changes, not the test.
import {
  rgbColor,
  stripTerminalSequences,
  styleText,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, onTestFinished, test, vi } from "vitest";
import { piScreen, realIndicator } from "./ui.js";

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

const KINDS = ["working", "retry", "compaction", "branchSummary"] as const;

test("a status indicator's border text is its spinner, a space, then its message, for all four kinds and for frames that carry colour", () => {
  const coloured = {
    frames: ["a", "b"].map((frame) =>
      styleText(frame, { fg: rgbColor(184, 248, 24) }, "truecolor"),
    ),
  };
  for (const kind of KINDS)
    for (const indicator of [undefined, coloured]) {
      const made = realIndicator(kind, "Doing a thing", { indicator });
      const border = made.renderInBorder(200);
      expect(border.startsWith(`${made.renderSpinnerInBorder(200)} `)).toBe(
        true,
      );
      expect(stripTerminalSequences(border).endsWith(" Doing a thing")).toBe(
        true,
      );
    }
});

test("an indicator given frames draws them verbatim, and one built without options ticks every 80 ms", () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const wrap = (text: string) => `<${text}>`;
  const given = realIndicator("working", "Working", {
    indicator: { frames: ["a", "b"], intervalMs: 200 },
    color: wrap,
  });
  expect(given.renderSpinnerInBorder(20)).toBe("a");
  vi.advanceTimersByTime(200);
  expect(given.renderSpinnerInBorder(20)).toBe("b");

  const requestRender = vi.fn();
  realIndicator("working", "Working", { requestRender });
  const built = requestRender.mock.calls.length;
  vi.advanceTimersByTime(79);
  expect(requestRender).toHaveBeenCalledTimes(built);
  vi.advanceTimersByTime(1);
  expect(requestRender).toHaveBeenCalledTimes(built + 1);
});

test("setting an indicator's frames restarts it at frame 0", () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const made = realIndicator("working", "Working", {
    indicator: { frames: ["a", "b", "c"], intervalMs: 100 },
  });
  vi.advanceTimersByTime(200);
  expect(made.renderSpinnerInBorder(20)).toBe("c");
  made.setIndicator({ frames: ["x", "y"], intervalMs: 100 });
  expect(made.renderSpinnerInBorder(20)).toBe("x");
});

test("an indicator with one frame starts no timer", () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  realIndicator("working", "Working", { indicator: { frames: ["*"] } });
  expect(vi.getTimerCount()).toBe(0);
});
