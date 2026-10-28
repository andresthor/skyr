import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  stripTerminalSequences,
  TruncatedText,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RunSnapshot } from "../src/subagent/store.js";
import { laneLine } from "../src/subagent/view.js";
import {
  elapsed,
  errorRow,
  type Segment,
  segmentRow,
  type Timing,
  took,
  toolRow,
} from "../src/tools/render.js";
import { CORPUS, piScreen, WIDTHS_SWEEP } from "./ui.js";

const plain = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

describe("toolRow", () => {
  describe("cut to the width", () => {
    // Real escapes, so a reset inside the row would show
    const painting = {
      fg: (color: string, text: string) =>
        `\u001b[${color === "muted" ? 90 : 36}m${text}\u001b[39m`,
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    } as unknown as Theme;
    const text = "https://example.test/a/very/long/path/that/cannot/fit";

    afterEach(() => vi.unstubAllEnvs());

    test("stays within the width for wide characters, with an ellipsis", () => {
      vi.stubEnv("TERM", "xterm-256color");
      const [line = ""] = toolRow(plain, [
        ["muted", "日本語のテキスト🙂🙂🙂"],
      ]).render(10);
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
      expect(line).toContain("…");
    });

    test("a cut row ends in … and puts no reset inside its colours", () => {
      vi.stubEnv("TERM", "xterm-256color");
      const [line = ""] = toolRow(painting, [
        ["toolTitle", "web_fetch ", true],
        ["muted", text],
      ]).render(30);
      expect(line).not.toContain("\u001b[0m");
      expect(stripTerminalSequences(line)).toBe(
        "web_fetch https://example.tes…",
      );
      expect(visibleWidth(line)).toBe(30);
    });

    test("under TERM=dumb a cut row ends in ...", () => {
      vi.stubEnv("TERM", "dumb");
      const [line = ""] = toolRow(plain, [["muted", text]]).render(20);
      expect(line).toBe("https://example.t...");
    });

    test.each(["xterm-256color", "dumb"])(
      "a row is never wider than its width, 0 to 200, with every corpus string, under TERM=%s",
      (term) => {
        vi.stubEnv("TERM", term);
        for (const width of WIDTHS_SWEEP)
          for (const s of CORPUS) {
            const [line = ""] = toolRow(painting, [
              ["toolTitle", s, true],
              ["muted", s],
            ]).render(width);
            expect(
              visibleWidth(line),
              JSON.stringify({ s, width }),
            ).toBeLessThanOrEqual(width);
          }
      },
    );

    test.each([20, 40])(
      "Pi's renderer takes a tool row and a lane in its card at %i columns",
      (width) => {
        const run: RunSnapshot = {
          id: "0123456789abcdef",
          description: "漢字".repeat(30),
          status: "done",
          startedAt: 1_000,
          endedAt: 5_000,
          turns: 2,
          toolCalls: 3,
          tokens: 1_234_567,
        };
        const card = new Box(1, 1, (t) => `\x1b[48;5;17m${t}\x1b[49m`);
        card.addChild(segmentRow(painting, laneLine(run)));
        const row = toolRow(painting, [
          ["toolTitle", "web_fetch ", true],
          ["muted", text],
        ]);
        for (const term of ["xterm-256color", "dumb"]) {
          vi.stubEnv("TERM", term);
          expect(piScreen(row, width).crash).toBeUndefined();
          expect(piScreen(card, width).crash).toBeUndefined();
        }
      },
    );

    test("an uncut row is its text in its colours, padded to the width, as TruncatedText draws it", () => {
      const row = [
        ["toolTitle", "web_fetch ", true],
        ["muted", "x.dev"],
      ] satisfies Segment[];
      const before = new TruncatedText(
        `${painting.fg("toolTitle", painting.bold("web_fetch "))}${painting.fg("muted", "x.dev")}`,
      );
      expect(toolRow(painting, row).render(40)).toEqual(before.render(40));
    });
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
    // the clock is shared across rows: past the tick limit, every row a test left running drops
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
      ["muted", " · 0s"],
    ]);
    vi.advanceTimersByTime(2_300);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(elapsed(call(state, true, invalidate))).toEqual([
      ["muted", " · 2s"],
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
    expect(took({ state, isPartial: true })).toEqual([["muted", " · 1s"]]);
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
