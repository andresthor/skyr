import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { Mark, Tier } from "../src/ui/caps.js";
import type { Paint } from "../src/ui/palette.js";
import {
  drawRail,
  drawRecord,
  type Fact,
  type RecordSpec,
} from "../src/ui/record.js";
import { sanitize } from "../src/ui/text.js";
import { CORPUS, WIDTHS_SWEEP } from "./ui.js";
import { testTheme } from "./voice.js";

const paintOf = (mode: Tier): Paint => ({ theme: testTheme(), mode });
const TIERS: Tier[] = ["color", "mono", "ascii"];
const ESC = "\u001b";
const plain = (line: string) => stripTerminalSequences(line);

const measure = (text: string): Fact => ({ text, kind: "measure" });
const extra = (text: string): Fact => ({ text, kind: "extra" });
const explain = (text: string): Fact => ({ text, kind: "explain" });

const SPEC: RecordSpec = {
  mark: "done",
  verb: "fetch",
  subject: ["internal.corp/wiki/runbook"],
  subjectKind: "path",
  facts: [measure("12 KB"), extra("truncated"), measure("0.9s")],
  handle: "df69d6ea",
};

describe("drawRecord", () => {
  test("a record is never wider than its width, 0 to 200, for every corpus string in every field and every tier", () => {
    for (const mode of TIERS)
      for (const raw of CORPUS) {
        const text = sanitize(raw);
        const spec: RecordSpec = {
          mark: "failed",
          branch: "mid",
          verb: "fetch",
          background: true,
          subject: [text, text.slice(0, 3)],
          subjectKind: "path",
          facts: [explain(text), measure(text), extra(text)],
          handle: "df69d6ea",
        };
        for (const width of WIDTHS_SWEEP)
          for (const pad of [0, 1])
            expect(
              visibleWidth(drawRecord(paintOf(mode), spec, width, pad)),
            ).toBeLessThanOrEqual(width);
      }
  });

  test("the subject is never cut while a measure or extra fact remains", () => {
    const subject = "a-long-subject-that-needs-room";
    const spec: RecordSpec = {
      ...SPEC,
      subject: [subject],
      subjectKind: "text",
    };
    for (const width of WIDTHS_SWEEP) {
      const line = plain(drawRecord(paintOf("color"), spec, width, 1));
      if (/12 KB|truncated|0\.9s/.test(line)) expect(line).toContain(subject);
    }
  });

  test("facts drop in the decided order as the width shrinks and never come back", () => {
    const spec: RecordSpec = {
      ...SPEC,
      subject: ["a-long-subject-that-needs-room", "a-shorter-one", "short"],
      subjectKind: "text",
    };
    const parts = [
      "df69d6ea",
      "truncated",
      "a-long-subject-that-needs-room",
      "0.9s",
      "12 KB",
    ];
    const goneAt = new Map<string, number>();
    for (let width = 120; width >= 0; width--) {
      const line = plain(drawRecord(paintOf("color"), spec, width, 1));
      for (const part of parts) {
        const present = line.includes(part);
        if (!present && !goneAt.has(part)) goneAt.set(part, width);
        if (present) expect(goneAt.has(part), part).toBe(false);
      }
    }
    const order = [...goneAt.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([part]) => part);
    expect(order).toEqual(parts);
  });

  test("a path subject keeps its last segment when cut", () => {
    const spec: RecordSpec = {
      ...SPEC,
      subject: ["internal.corp/wiki/engineering/runbook"],
      facts: [],
      handle: undefined,
    };
    const line = plain(drawRecord(paintOf("color"), spec, 34, 1));
    expect(line).toContain("/runbook");
    expect(line).toContain("…");
    expect(visibleWidth(line)).toBeLessThanOrEqual(34);
  });

  test("the verb column is not padded under 40 columns", () => {
    const spec: RecordSpec = { ...SPEC, facts: [], handle: undefined };
    expect(plain(drawRecord(paintOf("color"), spec, 39, 0))).toBe(
      "✓ fetch internal.corp/wiki/runbook",
    );
    expect(plain(drawRecord(paintOf("color"), spec, 60, 0))).toBe(
      "✓ fetch    internal.corp/wiki/runbook",
    );
  });

  test("a failure's explaining fact is bold in mono and the ascii tier emits no escape", () => {
    const spec: RecordSpec = {
      ...SPEC,
      mark: "failed",
      facts: [explain("403 forbidden")],
      handle: undefined,
    };
    const mono = drawRecord(paintOf("mono"), spec, 80, 1);
    expect(mono).toContain("\u001b[1m403 forbidden");
    expect(mono).not.toMatch(new RegExp(`${ESC}\\[3[0-9];|${ESC}\\[38`));
    const ascii = drawRecord(paintOf("ascii"), spec, 80, 1);
    expect(ascii).not.toContain("\u001b");
    expect(ascii).toContain("x fetch");
  });

  test("a delivered fact is accent, and a muted fact is not", () => {
    const spec: RecordSpec = {
      ...SPEC,
      facts: [
        { text: "<- delivered", kind: "explain", accent: true },
        { text: "plain", kind: "measure" },
      ],
      handle: undefined,
    };
    const accent = paintOf("color").theme.colors.accent;
    const line = drawRecord(paintOf("color"), spec, 80, 1);
    const painted = paintOf("color").theme.style("<- delivered", {
      fg: accent,
    });
    expect(line).toContain(painted);
    const muted = paintOf("color").theme.style("plain", {
      fg: paintOf("color").theme.colors.muted,
    });
    expect(line).toContain(muted);
  });

  test("no record paints a background", () => {
    for (const mode of TIERS)
      for (const mark of ["done", "failed", "running"] as Mark[]) {
        const line = drawRecord(paintOf(mode), { ...SPEC, mark }, 100, 1);
        expect(line).not.toMatch(
          new RegExp(`${ESC}\\[(4[0-7]|48|10[0-7])[;m]`),
        );
      }
  });

  test("states stay distinct with colour stripped: each mark has its own glyph", () => {
    const marks: Mark[] = [
      "queued",
      "running",
      "failed",
      "done",
      "stopped",
      "mixed",
    ];
    for (const mode of ["mono", "ascii"] as const) {
      const glyphs = marks.map(
        (mark) =>
          plain(drawRecord(paintOf(mode), { ...SPEC, mark }, 80, 0)).trim()[0],
      );
      // mixed shares the warning bang with no other mark
      expect(new Set(glyphs).size).toBe(marks.length);
    }
  });

  test("an explaining fact is kept while the subject is cut above its floor, and gives way below it", () => {
    const spec: RecordSpec = {
      mark: "failed",
      verb: "fetch",
      subject: ["internal.corp/wiki/engineering/handbook/runbook"],
      subjectKind: "path",
      facts: [explain("HTTP 404 not found"), measure("0.4s")],
    };
    for (let width = 40; width <= 90; width++) {
      const line = plain(drawRecord(paintOf("color"), spec, width, 1));
      expect(line, String(width)).toContain("HTTP 404 not found");
      expect(line, String(width)).toContain("/runbook");
    }
    const tight = plain(drawRecord(paintOf("color"), spec, 24, 1));
    expect(tight).not.toContain("HTTP 404 not found");
  });

  test("a path cut keeps its basename, or its end when the basename alone does not fit", () => {
    const spec: RecordSpec = {
      ...SPEC,
      subject: ["x.dev/docs/a-very-long-file-name-indeed.md"],
      facts: [],
      handle: undefined,
    };
    expect(plain(drawRecord(paintOf("color"), spec, 24, 0))).toMatch(
      /…-name-indeed\.md$/,
    );
    const url: RecordSpec = {
      ...spec,
      subject: ["host.test?query=aaaaaaaaaaaaaaaaaaaa&id=12345"],
    };
    expect(plain(drawRecord(paintOf("color"), url, 28, 0))).toMatch(
      /id=12345$/,
    );
  });

  test("every string is sanitized by the drawing, and a fact left empty draws no separator", () => {
    const spec: RecordSpec = {
      ...SPEC,
      verb: "fe\u001b]52;c;aGk=\u0007tch",
      subject: ["a\u001b[2Jb"],
      facts: [measure("x\u001b[2Jy"), measure(""), measure("\u001b[2J")],
      handle: "\u001bab12",
    };
    const line = drawRecord(paintOf("ascii"), spec, 80, 0);
    expect(line).not.toContain(ESC);
    expect(line).not.toContain("52;c");
    expect(plain(line)).toMatch(/^\+ fetch +ab +xy +ab12$/);
  });

  test("a child record is indented under its parent and carries no verb", () => {
    const spec: RecordSpec = {
      mark: "done",
      branch: "last",
      subject: ['"Data review"'],
      subjectKind: "text",
      facts: [measure("9 turns")],
    };
    expect(plain(drawRecord(paintOf("color"), spec, 60, 0))).toMatch(
      /^ {2}└ ✓ "Data review" +9 turns$/,
    );
    expect(plain(drawRecord(paintOf("ascii"), spec, 60, 0))).toMatch(
      /^ {2}` \+ "Data review" +9 turns$/,
    );
  });

  test("a background record draws & after its verb", () => {
    const spec: RecordSpec = { ...SPEC, background: true, facts: [] };
    expect(plain(drawRecord(paintOf("color"), spec, 80, 0))).toMatch(
      /^✓ fetch & +internal/,
    );
  });
});

describe("drawRail", () => {
  test("a rail line is dim and cut with the tier's ellipsis", () => {
    const theme = testTheme();
    const [line] = drawRail(
      { theme, mode: "color" },
      ["a rather long line of text"],
      "muted",
      16,
      1,
    );
    expect(plain(line ?? "")).toBe("   │ a rather …");
    expect(line).toContain(theme.style("│ ", { fg: theme.colors.dim }));
    const [ascii] = drawRail(
      { theme, mode: "ascii" },
      ["a rather long line of text"],
      "text",
      16,
      1,
    );
    expect(ascii).toBe("   | a rathe...");
  });

  test("a rail line is never wider than its width", () => {
    for (const mode of TIERS)
      for (const raw of CORPUS)
        for (const width of WIDTHS_SWEEP)
          for (const line of drawRail(
            paintOf(mode),
            [sanitize(raw)],
            "muted",
            width,
            1,
          ))
            expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});
