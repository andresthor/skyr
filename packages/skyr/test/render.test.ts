import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
  errorRow,
  sanitize,
  stripInvisible,
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
