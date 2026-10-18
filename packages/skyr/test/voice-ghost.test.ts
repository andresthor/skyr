/**
 * The ghost drawn into Pi's editor rows. `spliceGhost` anchors on the cursor cell a focused
 * editor draws, keeps every row to the width, never lets an escape byte inside transcription
 * text reach the terminal, and colours only with the theme's own colours, in its colour mode.
 */

import {
  colorToOklch,
  parseColor,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { DRY_MS, spliceGhost } from "../src/voice/ghost.js";
import {
  CURSOR_CELL,
  editorRows,
  styledRuns,
  testPaint,
  testTheme,
} from "./voice.js";

const PLAIN_RUN = { bold: false, dim: false, italic: false };

/** [top rule, ...text rows, bottom rule], as Pi's editor renders it around the plain text. */
const editorBase = (
  text: string,
  width: number,
  o: { focused?: boolean; paddingX?: number } = {},
): string[] => [
  "─".repeat(width),
  ...editorRows(text, width, o),
  "─".repeat(width),
];

test("the ghost lands right after the cursor cell, on the cursor's own row", () => {
  const lines = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    ghost: "world",
    paint: testPaint(),
  });
  expect(lines).toHaveLength(3);
  const row = lines[1] ?? "";
  expect(row.startsWith(`  hello${CURSOR_CELL}`)).toBe(true);
  // the cursor cell's own space renders as the caret's blank column right after "hello",
  // so the visible text is the buffer, the caret, then the ghost's leading space
  expect(stripTerminalSequences(row).startsWith("  hello  world")).toBe(true);
  expect(visibleWidth(row)).toBe(40);
});

test("a ghost too wide for the cursor row wraps below it and never passes the bottom rule", () => {
  const width = 16;
  const paddingX = 2;
  const lines = spliceGhost(editorBase("hi", width, { paddingX }), {
    width,
    paddingX,
    ghost: "one two three four five",
    paint: testPaint(),
  });
  const botRule = lines.length - 1;
  expect(botRule).toBeGreaterThan(2);
  for (const row of lines) expect(visibleWidth(row)).toBe(width);
  // every wrapped row sits between the cursor row and the bottom rule, and carries ghost text
  const mi = lines.findIndex((l) => l.includes(CURSOR_CELL));
  expect(mi).toBe(1);
  for (let i = mi + 1; i < botRule; i++)
    expect(
      styledRuns(lines[i] ?? "").some(
        (r) => r.italic && r.dim && r.text.trim(),
      ),
    ).toBe(true);
  expect(lines[botRule]).toBe("─".repeat(width));
  // no word of the ghost is lost, though it may be re-wrapped in order
  expect(
    stripTerminalSequences(lines.join("\n")).replace(/\s+/g, ""),
  ).toContain("onetwothreefourfive");
});

test("a cursor row with room only in the padding still keeps every row within width", () => {
  const width = 10;
  const paddingX = 2;
  const ghost = "你好🎉🙂 e\u0301xtraaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const lines = spliceGhost(editorBase("ok", width, { paddingX }), {
    width,
    paddingX,
    ghost,
    paint: testPaint(),
  });
  for (const row of lines) {
    expect(visibleWidth(row)).toBe(width);
    // cuts land on plain text: no dangling SGR bytes at a row end
    // biome-ignore lint/suspicious/noControlCharactersInRegex: naming escape bytes is the point of this probe
    expect(row).not.toMatch(/\x1b\[[\d;]*$/);
  }
  expect(lines.length).toBeGreaterThan(2);
});

test("escape bytes in the ghost text never reach any rendered row", () => {
  const ghost = "hi \x1b[31mred\x1b[0m \x1b_pi:evil\x07 \x1b[2J\u202etail";
  const lines = spliceGhost(editorBase("x", 30, { paddingX: 1 }), {
    width: 30,
    paddingX: 1,
    ghost,
    paint: testPaint(),
  });
  const all = lines.join("\n");
  expect(all).not.toContain("\x1b[31m");
  expect(all).not.toContain("\x1b[0m");
  expect(all).not.toContain("_pi:evil");
  expect(stripTerminalSequences(all).replace(/\s+/g, "")).toContain(
    "hiredtail",
  );
});

test("a newline or tab in the ghost never reaches a row: the ghost is one display line", () => {
  const lines = spliceGhost(editorBase("x", 30), {
    width: 30,
    ghost: "first line\nsecond\tthird",
    paint: testPaint(),
  });
  for (const line of lines) {
    expect(line).not.toMatch(/[\n\t]/);
    expect(visibleWidth(line)).toBe(30);
  }
  expect(stripTerminalSequences(lines.join(" "))).toContain(
    "first line second third",
  );
});

test("an editor without the cursor cell draws no ghost and no wet colouring", () => {
  const base = editorBase("hello", 20, { focused: false });
  expect(
    spliceGhost(base, { width: 20, ghost: "ghost", paint: testPaint() }),
  ).toEqual(base);
  expect(
    spliceGhost(base, {
      width: 20,
      ghost: "ghost",
      drying: [{ chars: 2, lead: 0, age: 10 }],
      paint: testPaint(),
    }),
  ).toEqual(base);
});

test("an idle buffer is returned exactly, and the rules stay Pi's: the ghost never recolours them", () => {
  const base = editorBase("hello", 20);
  expect(spliceGhost(base, { width: 20, paint: testPaint() })).toEqual(base);
  const decorated = spliceGhost(base, {
    width: 20,
    ghost: "more",
    drying: [{ chars: 3, lead: 0, age: 10 }],
    paint: testPaint(),
  });
  expect(decorated[0]).toBe(base[0]);
  expect(decorated.at(-1)).toBe(base.at(-1));
  // a span past its drying window colours nothing
  const dried = spliceGhost(base, {
    width: 20,
    drying: [{ chars: 3, lead: 0, age: DRY_MS }],
    paint: testPaint(),
  });
  expect(dried[1]).toBe(base[1]);
});

test("a committed span is born in the accent colour and dries colourless after DRY_MS", () => {
  const wet = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    drying: [{ chars: 5, lead: 0, age: 0 }],
    paint: testPaint(),
  });
  const row = wet[1] ?? "";
  // the theme's accent (#B8F818) at age 0, on the committed word alone
  expect(styledRuns(row)).toContainEqual(
    expect.objectContaining({ text: "hello", fg: parseColor("#B8F818") }),
  );
  expect(styledRuns(row).filter((r) => r.fg)).toHaveLength(1);
  expect(row).toContain(CURSOR_CELL);
  const dried = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    drying: [{ chars: 5, lead: 0, age: DRY_MS }],
    paint: testPaint(),
  });
  expect(dried[1]).toBe(`  hello${CURSOR_CELL}${" ".repeat(32)}`);
});

test("a 256-colour terminal gets 256-colour escapes from the theme, never 24-bit ones", () => {
  const lines = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    ghost: "world",
    drying: [{ chars: 5, lead: 0, age: 50 }],
    paint: testPaint("color", testTheme({ colorMode: "256color" })),
  });
  const coloured = styledRuns(lines.join("\n")).filter((r) => r.fg);
  // the wet span and the ghost
  expect(coloured.length).toBeGreaterThanOrEqual(2);
  for (const run of coloured) expect(run.fg?.kind).toBe("indexed");
});

test("NO_COLOR keeps the ghost as italic and faint text, with no colour anywhere", () => {
  const lines = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    ghost: "world",
    drying: [{ chars: 5, lead: 0, age: 50 }],
    paint: testPaint("mono"),
  });
  const runs = styledRuns(lines.join("\n"));
  expect(runs.filter((r) => r.fg)).toEqual([]);
  expect(styledRuns(lines[1] ?? "")).toContainEqual(
    expect.objectContaining({ text: " world", italic: true, dim: true }),
  );
});

test("TERM=dumb draws no decoration at all: the rows come back unchanged", () => {
  const base = editorBase("hello", 40, { paddingX: 2 });
  expect(
    spliceGhost(base, {
      width: 40,
      paddingX: 2,
      ghost: "world",
      paint: testPaint("ascii"),
    }),
  ).toEqual(base);
});

test("the ghost and a fresh commit draw in the theme's own dim and accent", () => {
  const accent = parseColor("#d75f87");
  const dim = parseColor("#72727d");
  const row =
    spliceGhost(editorBase("hello", 40), {
      width: 40,
      ghost: "world",
      drying: [{ chars: 5, lead: 0, age: 0 }],
      paint: testPaint("color", testTheme({ colors: { accent, dim } })),
    })[1] ?? "";
  expect(styledRuns(row)).toContainEqual(
    expect.objectContaining({ text: "hello", fg: accent }),
  );
  expect(styledRuns(row)).toContainEqual(
    expect.objectContaining({ text: " world", fg: dim }),
  );
});

test("two finals landing 100 ms apart dry on their own clocks, and the space between them stays plain", () => {
  const row =
    spliceGhost(editorBase("one two", 40), {
      width: 40,
      drying: [
        { chars: 3, lead: 1, age: 50 },
        { chars: 3, lead: 0, age: 150 },
      ],
      paint: testPaint(),
    })[1] ?? "";
  const [older, between, newer] = styledRuns(row);
  expect(older).toMatchObject({ text: "one", fg: { kind: "rgb" } });
  expect(between).toEqual({ text: " ", ...PLAIN_RUN });
  expect(newer).toMatchObject({ text: "two", fg: { kind: "rgb" } });
  // the older span is further along its dry than the newer one, not snapped to either end
  expect(older?.fg).not.toEqual(newer?.fg);
});

test("a theme whose accent is close to its text still gets a visible flash, in the accent's hue", () => {
  const sequoia = testTheme({
    colors: { accent: parseColor("#88acb5"), text: parseColor("#9a9aa7") },
  });
  const row =
    spliceGhost(editorBase("hello", 40), {
      width: 40,
      drying: [{ chars: 5, lead: 0, age: 0 }],
      paint: testPaint("color", sequoia),
    })[1] ?? "";
  const wet = styledRuns(row).find((r) => r.text === "hello")?.fg;
  if (!wet) throw new Error("the fresh commit drew no colour");
  const start = colorToOklch(wet);
  const accent = colorToOklch(sequoia.colors.accent);
  const text = colorToOklch(sequoia.colors.text);
  const lab = (c: typeof start) => [
    c.l,
    c.c * Math.cos((c.h * Math.PI) / 180),
    c.c * Math.sin((c.h * Math.PI) / 180),
  ];
  const [l1 = 0, a1 = 0, b1 = 0] = lab(start);
  const [l2 = 0, a2 = 0, b2 = 0] = lab(text);
  expect(Math.hypot(l1 - l2, a1 - a2, b1 - b2)).toBeGreaterThanOrEqual(0.15);
  expect(Math.abs(start.h - accent.h)).toBeLessThan(5);
});

test("under NO_COLOR a fresh commit is bold until it dries, with no colour", () => {
  const wet = spliceGhost(editorBase("hello", 40), {
    width: 40,
    drying: [{ chars: 5, lead: 0, age: 100 }],
    paint: testPaint("mono"),
  });
  expect(styledRuns(wet[1] ?? "")).toContainEqual({
    text: "hello",
    ...PLAIN_RUN,
    bold: true,
  });
  expect(styledRuns(wet.join("")).filter((r) => r.fg)).toEqual([]);
  const dry = spliceGhost(editorBase("hello", 40), {
    width: 40,
    drying: [{ chars: 5, lead: 0, age: DRY_MS }],
    paint: testPaint("mono"),
  });
  expect(styledRuns(dry[1] ?? "").filter((r) => r.bold)).toEqual([]);
});

test("emoji with a variation selector never push a ghost or drying row past the width", () => {
  // from 14 the fixture's own unwrapped row fits; Pi's editor wraps anything narrower itself
  for (const width of [14, 20, 30, 41]) {
    const lines = spliceGhost(
      editorBase("see ▶️ here", width, { paddingX: 1 }),
      {
        width,
        paddingX: 1,
        ghost: `${"▶️ ".repeat(12)}©️®️‼️ done`,
        drying: [{ chars: 4, lead: 1, age: 50 }],
        paint: testPaint(),
      },
    );
    for (const row of lines) expect(visibleWidth(row), `@${width}`).toBe(width);
  }
});
