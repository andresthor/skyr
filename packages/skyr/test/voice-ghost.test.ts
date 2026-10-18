/**
 * The ghost drawn into Pi's editor rows. `spliceGhost` anchors on the cursor cell a focused
 * editor draws, keeps every row within the width, and must never let
 * an escape byte inside transcription text reach the terminal. The palette it colours with is
 * the theme's own, pinned here too.
 */

import {
  colorToOklch,
  parseColor,
  rgbColor,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { DRY_MS, spliceGhost } from "../src/voice/ghost.js";
import {
  FALLBACK_PALETTE,
  paintFor,
  paletteFromTheme,
  type VoiceMode,
} from "../src/voice/palette.js";
import { CURSOR_CELL, editorRows } from "./voice.js";

const T = FALLBACK_PALETTE;
/** The fallback paint in a given mode, as the old `palette`/`mode` pair read. */
const paint = (mode: VoiceMode = "color", palette = FALLBACK_PALETTE) =>
  paintFor(palette, mode);

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
    paint: paint(),
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
    paint: paint(),
  });
  const botRule = lines.length - 1;
  expect(botRule).toBeGreaterThan(2);
  for (const row of lines) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  // every wrapped row sits between the cursor row and the bottom rule
  const mi = lines.findIndex((l) => l.includes(CURSOR_CELL));
  expect(mi).toBe(1);
  for (let i = mi + 1; i < botRule; i++) expect(lines[i]).toContain("\x1b[3m");
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
    paint: paint(),
  });
  for (const row of lines) {
    expect(visibleWidth(row)).toBeLessThanOrEqual(width);
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
    paint: paint(),
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
    paint: paint(),
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
    spliceGhost(base, { width: 20, ghost: "ghost", paint: paint() }),
  ).toEqual(base);
  expect(
    spliceGhost(base, {
      width: 20,
      ghost: "ghost",
      drying: [{ chars: 2, lead: 0, age: 10 }],
      paint: paint(),
    }),
  ).toEqual(base);
});

test("an idle buffer is returned exactly, and the rules stay Pi's: the ghost never recolours them", () => {
  const base = editorBase("hello", 20);
  expect(spliceGhost(base, { width: 20, paint: paint() })).toEqual(base);
  const decorated = spliceGhost(base, {
    width: 20,
    ghost: "more",
    drying: [{ chars: 3, lead: 0, age: 10 }],
    paint: paint(),
  });
  expect(decorated[0]).toBe(base[0]);
  expect(decorated.at(-1)).toBe(base.at(-1));
  // a span past its drying window colours nothing
  const dried = spliceGhost(base, {
    width: 20,
    drying: [{ chars: 3, lead: 0, age: DRY_MS }],
    paint: paint(),
  });
  expect(dried[1]).toBe(base[1]);
});

test("a committed span is born in the accent colour and dries colourless after DRY_MS", () => {
  const wet = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    drying: [{ chars: 5, lead: 0, age: 0 }],
    paint: paint(),
  });
  const row = wet[1] ?? "";
  // the accent token (#B8F818) at age 0
  expect(row).toContain("\x1b[38;2;184;248;24mhello\x1b[39m");
  expect(row).toContain(CURSOR_CELL);
  const dried = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    drying: [{ chars: 5, lead: 0, age: DRY_MS }],
    paint: paint(),
  });
  expect(dried[1]).toBe(`  hello${CURSOR_CELL}${" ".repeat(32)}`);
});

test("a 256-colour terminal gets 256-colour escapes from the theme, never 24-bit ones", () => {
  const lines = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    ghost: "world",
    drying: [{ chars: 5, lead: 0, age: 50 }],
    paint: paint("color", { ...T, mode: "256color" }),
  });
  const all = lines.join("\n");
  expect(all).not.toContain("\x1b[38;2;");
  expect(all).toContain("\x1b[38;5;");
});

test("NO_COLOR keeps the ghost as italic and faint text, with no colour anywhere", () => {
  const lines = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    ghost: "world",
    drying: [{ chars: 5, lead: 0, age: 50 }],
    paint: paint("mono"),
  });
  const all = lines.join("\n");
  expect(all).not.toContain("\x1b[38;");
  expect(lines[1]).toContain("\x1b[2m\x1b[3m world\x1b[23m\x1b[22m");
});

test("TERM=dumb draws no decoration at all: the rows come back unchanged", () => {
  const base = editorBase("hello", 40, { paddingX: 2 });
  expect(
    spliceGhost(base, {
      width: 40,
      paddingX: 2,
      ghost: "world",
      paint: paint("ascii"),
    }),
  ).toEqual(base);
});

test("the palette is the theme's own colours and colour mode", () => {
  const c = (hex: string) => parseColor(hex);
  const palette = paletteFromTheme({
    colors: {
      accent: c("#88acb5"),
      text: c("#9a9aa7"),
      muted: c("#898a96"),
      dim: c("#72727d"),
      error: c("#cc6666"),
      warning: c("#d7af5f"),
    },
    getColorMode: () => "256color",
  });
  expect(palette.colors).toEqual({
    accent: c("#88acb5"),
    text: c("#9a9aa7"),
    muted: c("#898a96"),
    dim: c("#72727d"),
    error: c("#cc6666"),
    warning: c("#d7af5f"),
  });
  expect(palette.mode).toBe("256color");
  expect(paletteFromTheme(undefined)).toBe(FALLBACK_PALETTE);
});

/** The 24-bit colour each SGR run opens with, in order. */
const runColours = (row: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a run ends at the next escape byte
  [...row.matchAll(/\[38;2;(\d+);(\d+);(\d+)m([^\x1b]*)/g)].map((m) => ({
    rgb: `${m[1]};${m[2]};${m[3]}`,
    text: m[4],
  }));

test("two finals landing 100 ms apart dry on their own clocks, and the space between them stays plain", () => {
  const row =
    spliceGhost(editorBase("one two", 40), {
      width: 40,
      drying: [
        { chars: 3, lead: 1, age: 50 },
        { chars: 3, lead: 0, age: 150 },
      ],
      paint: paint(),
    })[1] ?? "";
  const runs = runColours(row);
  expect(runs.map((r) => r.text)).toEqual(["one", "two"]);
  // the older span is further along its dry than the newer one, not snapped to either end
  expect(runs[0]?.rgb).not.toBe(runs[1]?.rgb);
  expect(stripTerminalSequences(row).startsWith("one two")).toBe(true);
  expect(row).toContain("\x1b[39m \x1b[38;2;");
});

test("a theme whose accent is close to its text still gets a visible flash, in the accent's hue", () => {
  const sequoia = {
    ...T,
    colors: {
      ...T.colors,
      accent: parseColor("#88acb5"),
      text: parseColor("#9a9aa7"),
    },
  };
  const row =
    spliceGhost(editorBase("hello", 40), {
      width: 40,
      drying: [{ chars: 5, lead: 0, age: 0 }],
      paint: paint("color", sequoia),
    })[1] ?? "";
  const [r, g, b] = (runColours(row)[0]?.rgb ?? "").split(";").map(Number);
  const start = colorToOklch(rgbColor(r ?? 0, g ?? 0, b ?? 0));
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
    paint: paint("mono"),
  });
  expect(wet[1]).toContain("\x1b[1mhello\x1b[22m");
  expect(wet.join("")).not.toContain("\x1b[38;");
  const dry = spliceGhost(editorBase("hello", 40), {
    width: 40,
    drying: [{ chars: 5, lead: 0, age: DRY_MS }],
    paint: paint("mono"),
  });
  expect(dry[1]).not.toContain("\x1b[1m");
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
        paint: paint(),
      },
    );
    for (const row of lines)
      expect(visibleWidth(row), `@${width}`).toBeLessThanOrEqual(width);
  }
});
