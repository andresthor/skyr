import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  elapsed,
  errorRow,
  sanitize,
  stripInvisible,
  type Timing,
  took,
  toolRow,
} from "../src/tools/render.js";

const plain = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const OSC52 = "\u001b]52;c;cHduZWQ=\u0007";

describe("sanitize", () => {
  test("an OSC 52 sequence never survives", () => {
    const text = sanitize(`https://x.dev/${OSC52}`);
    expect(text).not.toContain(OSC52);
    expect(text).not.toMatch(/\p{Cc}/u);
  });

  test("C1 controls are dropped and whitespace collapses to spaces", () => {
    expect(sanitize("a\tb\n\nc\u009b31md")).toBe("a b c31md");
  });

  test("an OSC 8 hyperlink leaves neither escape nor payload", () => {
    const text = sanitize(
      "see \u001b]8;;https://evil.test\u0007docs\u001b]8;;\u0007",
    );
    expect(text).toBe("see docs");
  });

  test("an emoji sequence keeps its joiners", () => {
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F466}";
    expect(sanitize(`fetched ${family}`)).toBe(`fetched ${family}`);
  });

  test("bidi overrides, zero-width and tag characters are dropped", () => {
    expect(sanitize("good\u202e.com\u200b \u{E0041}\u{E0042}done")).toBe(
      "good.com done",
    );
  });

  test("a lone surrogate and interlinear annotation marks are dropped, a paired emoji kept", () => {
    const text = sanitize("a\uD800b\uDC00c \uFFF9note\uFFFA\uFFFB 🎉");
    expect(text).toBe("abc note 🎉");
    expect(visibleWidth(text)).toBe(11);
  });
});

describe("stripInvisible", () => {
  test("keeps newlines and tabs, so a page's markdown survives", () => {
    expect(stripInvisible("# Title\n\n\tindented\n")).toBe(
      "# Title\n\n\tindented\n",
    );
  });

  test("drops a carriage return", () => {
    expect(stripInvisible("a\r\nb")).toBe("a\nb");
  });

  test("drops tag characters, which are invisible to a reader", () => {
    expect(stripInvisible("ok\u{E0041}\u{E0042}done")).toBe("okdone");
  });

  test("drops bidi overrides and isolates, which reorder text invisibly", () => {
    expect(stripInvisible("good\u202e.com\u2066x\u2069")).toBe("good.comx");
  });

  test("drops zero-width space, byte-order mark and word joiner", () => {
    expect(stripInvisible("a\u200bb\ufeffc\u2060d")).toBe("abcd");
  });

  test("drops the Arabic, left-to-right and right-to-left marks", () => {
    expect(stripInvisible("a\u061cb\u200ec\u200fd")).toBe("abcd");
  });

  test("drops the soft hyphen and the Mongolian vowel separator", () => {
    expect(stripInvisible("co\u00ADop\u180Eerate")).toBe("cooperate");
  });

  test("drops the deprecated bidi formatting characters", () => {
    expect(stripInvisible("a\u206Ab\u206Fc")).toBe("abc");
  });

  test("keeps ZWJ and ZWNJ, which carry meaning", () => {
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F466}";
    const persian = "\u0628\u200c\u0631";
    expect(stripInvisible(`${family} ${persian}`)).toBe(`${family} ${persian}`);
  });

  test("drops C0 and C1 controls", () => {
    expect(stripInvisible("a\u0001b\u009bc")).toBe("abc");
  });
});

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

  test("a row rebuilt from a saved session is never timed", () => {
    const state: Timing = {};
    expect(elapsed(call(state, false))).toEqual([]);
    expect(took({ state })).toEqual([]);
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
