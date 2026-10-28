import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  elapsed,
  errorRow,
  type Timing,
  took,
  toolRow,
} from "../src/tools/render.js";

const plain = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

describe("toolRow", () => {
  test("stays within the width for wide characters, with an ellipsis", () => {
    const [line = ""] = toolRow(plain, [
      ["muted", "日本語のテキスト🙂🙂🙂"],
    ]).render(10);
    expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    expect(line).toContain("...");
  });

  test("paints each segment, bold where asked", () => {
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}`,
      bold: (text: string) => `*${text}*`,
    } as unknown as Theme;
    const [line = ""] = toolRow(theme, [
      ["toolTitle", "web_fetch ", true],
      ["muted", "x.dev"],
    ]).render(200);
    expect(line.trimEnd()).toBe("<toolTitle>*web_fetch *<muted>x.dev");
  });
});

describe("errorRow", () => {
  test("keeps the first line and leaves no hyperlink payload behind", () => {
    const [line = ""] = errorRow(plain, [
      { type: "text", text: `boom \u001b]8;;https://evil\u001b\\link\nmore` },
    ]).render(200);
    expect(line.trimEnd()).toBe("boom link");
  });
});

describe("row timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // the ticker is shared across rows: past the tick limit, every row a test left running drops
    vi.advanceTimersByTime(5 * 60_000);
    vi.useRealTimers();
  });

  const call = (
    state: Timing,
    executionStarted: boolean,
    invalidate = () => {},
  ) => ({
    state,
    executionStarted,
    invalidate,
  });

  test("a row rebuilt from a saved session never ticks, and shows the duration Pi recorded", () => {
    const state: Timing = {};
    expect(elapsed(call(state, false))).toEqual([]);
    expect(took({ state, durationMs: 4_200 })).toEqual([["muted", " · 4.2s"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a row rebuilt from a session saved without durations shows no time", () => {
    expect(took({ state: {}, durationMs: undefined })).toEqual([]);
  });

  test("a final result shows Pi's recorded duration over the row's own clock", () => {
    const state: Timing = {};
    elapsed(call(state, true));
    vi.advanceTimersByTime(2_300);
    expect(took({ state, durationMs: 2_000 })).toEqual([["muted", " · 2.0s"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a running call ticks each second, and its result stops the clock", () => {
    const state: Timing = {};
    const invalidate = vi.fn();
    expect(elapsed(call(state, true, invalidate))).toEqual([
      ["muted", " · 0.0s"],
    ]);
    vi.advanceTimersByTime(2_300);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(elapsed(call(state, true, invalidate))).toEqual([
      ["muted", " · 2.3s"],
    ]);

    expect(took({ state })).toEqual([["muted", " · 2.3s"]]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(took({ state })).toEqual([["muted", " · 2.3s"]]);
    expect(elapsed(call(state, true, invalidate))).toEqual([]);
  });

  test("a call rendered again while running keeps one clock", () => {
    const state: Timing = {};
    elapsed(call(state, true));
    vi.advanceTimersByTime(1_000);
    elapsed(call(state, true));
    expect(vi.getTimerCount()).toBe(1);
  });

  test("running rows share one ticker, which stops with the last row", () => {
    const first: Timing = {};
    const second: Timing = {};
    const redrawn = { first: vi.fn(), second: vi.fn() };
    elapsed(call(first, true, redrawn.first));
    elapsed(call(second, true, redrawn.second));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(redrawn.first).toHaveBeenCalledTimes(1);
    expect(redrawn.second).toHaveBeenCalledTimes(1);

    took({ state: first });
    vi.advanceTimersByTime(1_000);
    expect(redrawn.first).toHaveBeenCalledTimes(1);
    expect(redrawn.second).toHaveBeenCalledTimes(2);
    took({ state: second });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a row Pi drops before its result stops ticking on its own", () => {
    const invalidate = vi.fn();
    elapsed(call({}, true, invalidate));
    vi.advanceTimersByTime(10 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(invalidate.mock.calls.length).toBeLessThan(301);
  });

  test("a partial result keeps the clock running until the final one", () => {
    const state: Timing = {};
    elapsed(call(state, true));
    vi.advanceTimersByTime(1_000);
    expect(took({ state, isPartial: true })).toEqual([["muted", " · 1.0s"]]);
    expect(vi.getTimerCount()).toBe(1);
    expect(took({ state })).toEqual([["muted", " · 1.0s"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a failure row carries the time after the message", () => {
    const row = errorRow(
      plain,
      [{ type: "text", text: "tool: failed\nmore" }],
      [["muted", " · 1.5s"]],
    );
    expect(row.render(200)[0]?.trimEnd()).toBe("tool: failed · 1.5s");
  });
});
