import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { errorRow, sanitize, toolRow } from "../src/tools/render.js";

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

  test("bidi overrides, zero-width and tag characters are dropped", () => {
    expect(sanitize("good\u202e.com\u200b \u{E0041}\u{E0042}done")).toBe(
      "good.com done",
    );
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
