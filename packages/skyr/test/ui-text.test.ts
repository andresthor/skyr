import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { quoted, sanitize, stripInvisible } from "../src/ui/text.js";

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

describe("quoted", () => {
  test("controls, quotes and backslashes show as JSON escapes", () => {
    expect(quoted('a\u0007"b\\', 40)).toBe('"a\\u0007\\"b\\\\"');
  });

  test("every other invisible character shows as its \\u escape, a tag character as its two surrogates", () => {
    expect(quoted("a\u009bb\u202ec\u200bd\ufeff\u{E0041}", 40)).toBe(
      '"a\\u009bb\\u202ec\\u200bd\\ufeff\\udb40\\udc41"',
    );
  });

  test("ZWJ and ZWNJ stay as they are", () => {
    const family = "\u{1F468}\u200d\u{1F469}";
    const persian = "\u0628\u200c\u0631";
    expect(quoted(`${family} ${persian}`, 40)).toBe(`"${family} ${persian}"`);
  });
});
