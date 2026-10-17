/**
 * The ghost's contract with pi-tui. `CURSOR_CELL` must be exactly the end-of-line fake-cursor
 * cell a focused editor emits; `spliceGhost` anchors on it, keeps every row within the width,
 * and must never let an escape byte inside transcription text reach the terminal.
 */
import {
  CURSOR_MARKER,
  parseColor,
  renderFakeCursor,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import {
  CURSOR_CELL,
  cellWidth,
  DRY_MS,
  FALLBACK_PALETTE,
  paletteFromTheme,
  spliceGhost,
  stripAnsi,
} from "../src/voice/indicator.js";

const T = FALLBACK_PALETTE;

/**
 * [top rule, ...text rows, bottom rule], as Pi's focused editor renders it around the plain
 * text; the cursor cell sits at end of the line it belongs to.
 */
function editorBase(
  text: string,
  width: number,
  { focused = true, paddingX = 0 } = {},
): string[] {
  const pad = " ".repeat(paddingX);
  const rows = ["─".repeat(width)];
  for (const line of text.split("\n")) {
    const textWidth = paddingX + line.length + (focused ? 1 : 0);
    rows.push(
      `${pad}${line}${focused ? CURSOR_CELL : ""}${" ".repeat(Math.max(0, width - textWidth))}`,
    );
  }
  rows.push("─".repeat(width));
  return rows;
}

test("CURSOR_CELL is CURSOR_MARKER followed by the fake-cursor space, per the pinned pi-tui", () => {
  expect(CURSOR_CELL).toBe(`${CURSOR_MARKER}${renderFakeCursor(" ")}`);
});

test("the ghost lands right after the cursor cell, on the cursor's own row", () => {
  const lines = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    ghost: "world",
    palette: T,
  });
  expect(lines).toHaveLength(3);
  const row = lines[1] ?? "";
  expect(row.startsWith(`  hello${CURSOR_CELL}`)).toBe(true);
  // the cursor cell's own space renders as the caret's blank column right after "hello",
  // so the visible text is the buffer, the caret, then the ghost's leading space
  expect(stripAnsi(row).startsWith("  hello  world")).toBe(true);
  expect(cellWidth(row)).toBe(40);
});

test("a ghost too wide for the cursor row wraps below it and never passes the bottom rule", () => {
  const width = 16;
  const paddingX = 2;
  const lines = spliceGhost(editorBase("hi", width, { paddingX }), {
    width,
    paddingX,
    ghost: "one two three four five",
    palette: T,
  });
  const botRule = lines.length - 1;
  expect(botRule).toBeGreaterThan(2);
  for (const row of lines) expect(cellWidth(row)).toBeLessThanOrEqual(width);
  // every wrapped row sits between the cursor row and the bottom rule
  const mi = lines.findIndex((l) => l.includes(CURSOR_CELL));
  expect(mi).toBe(1);
  for (let i = mi + 1; i < botRule; i++) expect(lines[i]).toContain("\x1b[3m");
  expect(lines[botRule]).toBe("─".repeat(width));
  // no word of the ghost is lost, though it may be re-wrapped in order
  expect(stripAnsi(lines.join("\n")).replace(/\s+/g, "")).toContain(
    "onetwothreefourfive",
  );
});

test("a cursor row with room only in the padding still keeps every row within width", () => {
  const width = 10;
  const paddingX = 2;
  const ghost = "你好🎉🙂 e\u0301xtraaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const lines = spliceGhost(editorBase("ok", width, { paddingX }), {
    width,
    paddingX,
    ghost,
    palette: T,
  });
  for (const row of lines) {
    expect(cellWidth(row)).toBeLessThanOrEqual(width);
    // cuts land on plain text: no dangling SGR bytes at a row end
    // biome-ignore lint/suspicious/noControlCharactersInRegex: naming escape bytes is the point of this probe
    expect(row).not.toMatch(/\x1b\[[\d;]*$/);
  }
  expect(lines.length).toBeGreaterThan(2);
});

test("escape bytes in the ghost text never reach any rendered row", () => {
  const ghost = "hi \x1b[31mred\x1b[0m \x1b_pi:evil\x07 tail";
  const lines = spliceGhost(editorBase("x", 30, { paddingX: 1 }), {
    width: 30,
    paddingX: 1,
    ghost,
    palette: T,
  });
  const all = lines.join("\n");
  expect(all).not.toContain("\x1b[31m");
  expect(all).not.toContain("\x1b[0m");
  expect(all).not.toContain("_pi:evil");
  expect(stripAnsi(all).replace(/\s+/g, "")).toContain("hiredtail");
});

test("an editor without the cursor cell draws no ghost and no wet colouring", () => {
  const base = editorBase("hello", 20, { focused: false });
  expect(spliceGhost(base, { width: 20, ghost: "ghost", palette: T })).toEqual(
    base,
  );
  expect(
    spliceGhost(base, {
      width: 20,
      ghost: "ghost",
      firm: { chars: 2, age: 10 },
      palette: T,
    }),
  ).toEqual(base);
});

test("an idle buffer is returned exactly; only the rules turn brand-green while live", () => {
  const base = editorBase("hello", 20);
  expect(spliceGhost(base, { width: 20, palette: T })).toEqual(base);
  const live = spliceGhost(base, { width: 20, live: true, palette: T });
  expect(live[0]).toBe(`\x1b[38;2;63;92;18m${"─".repeat(20)}\x1b[39m`);
  expect(live[1]).toBe(base[1]);
  // a firm span past its drying window colours nothing, even while live
  const dried = spliceGhost(base, {
    width: 20,
    live: true,
    firm: { chars: 3, age: DRY_MS },
    palette: T,
  });
  expect(dried[1]).toBe(base[1]);
});

test("a committed span is born brand-lime at the cursor and dries colourless after DRY_MS", () => {
  const wet = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    firm: { chars: 5, age: 0 },
    palette: T,
  });
  const row = wet[1] ?? "";
  // the accent token (#B8F818) at age 0
  expect(row).toContain("\x1b[38;2;184;248;24mhello\x1b[39m");
  expect(row).toContain(CURSOR_CELL);
  const dried = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    firm: { chars: 5, age: DRY_MS },
    palette: T,
  });
  expect(dried[1]).toBe(`  hello${CURSOR_CELL}${" ".repeat(32)}`);
});

test("a 256-colour terminal gets 256-colour escapes from the theme, never 24-bit ones", () => {
  const palette = { ...T, mode: "256color" as const };
  const lines = spliceGhost(editorBase("hello", 40, { paddingX: 2 }), {
    width: 40,
    paddingX: 2,
    ghost: "world",
    firm: { chars: 5, age: 50 },
    live: true,
    palette,
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
    firm: { chars: 5, age: 50 },
    live: true,
    palette: T,
    mode: "mono",
  });
  const all = lines.join("\n");
  expect(all).not.toContain("\x1b[38;");
  expect(lines[1]).toContain("\x1b[2m\x1b[3m world\x1b[23m\x1b[22m");
  // TERM=dumb draws no decoration at all
  const base = editorBase("hello", 40, { paddingX: 2 });
  expect(
    spliceGhost(base, {
      width: 40,
      paddingX: 2,
      ghost: "world",
      mode: "ascii",
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
      border: c("#679dc0"),
      error: c("#cc6666"),
    },
    getColorMode: () => "256color",
  });
  expect(palette.colors.accent).toEqual(c("#88acb5"));
  expect(palette.mode).toBe("256color");
  expect(paletteFromTheme(undefined)).toBe(FALLBACK_PALETTE);
});
