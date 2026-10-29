// The bar's lines, drawn from plain rows: nothing at rest, a pulse while anything runs.
import {
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import type { BarRow } from "../src/chrome/bar.js";
import { type BarView, barLines } from "../src/chrome/bar-view.js";
import type { Tier } from "../src/ui/caps.js";
import { keyLabel } from "../src/ui/hint.js";
import type { Paint } from "../src/ui/palette.js";
import { sanitize } from "../src/ui/text.js";
import { plainTheme } from "./session.js";
import { CORPUS, WIDTHS_SWEEP } from "./ui.js";
import { styledRuns, testPaint } from "./voice.js";

const TIERS: Tier[] = ["color", "mono", "ascii"];
const plain = (mode: Tier = "color") => ({ theme: plainTheme, mode });

const row = (fields: Partial<BarRow> = {}): BarRow => ({
  id: "a1f3e0d2a1f3e0d2",
  mark: "running",
  label: '"Correctness review"',
  background: false,
  startedAt: 0,
  ...fields,
});

/** The key hint, as a pattern. */
const HINT = keyLabel("alt+a").replace("+", "\\+");

/** A view of `rows`, with nothing left that is not named. */
const view = (rows: Partial<BarView>): BarView => ({
  open: false,
  tab: "agents",
  agents: [],
  shells: [],
  failed: [],
  slots: { agents: new Map(), shells: new Map() },
  focused: undefined,
  top: 0,
  ...rows,
});

/** `barLines` on a terminal tall enough for the open bar, unless said otherwise. */
const draw = (
  shown: BarView,
  paint: Paint,
  width: number,
  now: number,
  termRows = 40,
) => barLines(shown, paint, width, termRows, now);

const none = view({});

/** The pulse's text, as a terminal shows it. */
const textOf = (lines: string[]) => lines.map(stripTerminalSequences);

test("the bar is absent at rest: no rows draw no lines", () => {
  expect(draw(none, plain(), 100, 0)).toEqual([]);
  expect(draw(none, plain(), 0, 0)).toEqual([]);
});

test("a pulse is one row plus the bar's own trailing blank", () => {
  const lines = draw(
    view({ agents: [row({ now: "read" })] }),
    plain(),
    100,
    64_000,
  );

  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  expect(lines[0]).toMatch(
    new RegExp(`^ 1 agent •   › read {2,}1m04s {2}${HINT} $`),
  );
  expect(visibleWidth(lines[0] ?? "")).toBe(100);
});

const THREE = view({
  agents: [
    row({ now: "pnpm test --filter auth", startedAt: 0 }),
    row({ mark: "queued", startedAt: 5_000 }),
    row({ now: "read", startedAt: 10_000 }),
  ],
  shells: [row({ startedAt: 20_000, background: true })],
});

test("the pulse shows a group per tab with a pip per row, the newest action, the oldest elapsed and the key", () => {
  const [pulse] = textOf(draw(THREE, plain(), 120, 64_000));
  expect(pulse).toMatch(
    /^ 3 agents • □ • {3}1 shell • {3}› read {2,}1m04s {2}/,
  );
  expect(pulse?.trimEnd().endsWith(keyLabel("alt+a"))).toBe(true);
});

test("groups sit 3 spaces apart, 2 under 100 columns", () => {
  expect(textOf(draw(THREE, plain(), 120, 0))[0]).toContain("•   1 shell");
  const narrow = textOf(draw(THREE, plain(), 90, 0))[0];
  expect(narrow).toContain("•  1 shell");
  expect(narrow).not.toContain("•   1 shell");
});

test("more than eight rows show eight pips and a count of the rest", () => {
  const many = view({
    agents: Array.from({ length: 11 }, (_, i) => row({ id: `id${i}` })),
  });
  const [pulse] = textOf(draw(many, plain(), 120, 0));
  expect(pulse).toContain("11 agents • • • • • • • • +3");
});

/** The widest pane at which `part` is gone, scanning down from 150 columns. */
function goneAt(shown: BarView, part: RegExp): number {
  for (let width = 150; width >= 1; width--) {
    const [pulse = ""] = textOf(draw(shown, plain(), width, 64_000));
    if (!part.test(pulse)) return width;
  }
  return 0;
}

test("the pulse drops its lead, then its pips, then elapsed, then the hint as the pane narrows", () => {
  const gone = {
    lead: goneAt(THREE, /›/),
    pips: goneAt(THREE, /[•□]/),
    elapsed: goneAt(THREE, /1m04s/),
    hint: goneAt(THREE, new RegExp(HINT)),
    counts: goneAt(THREE, /3 agents.*1 shell/),
  };
  expect(gone.lead).toBeGreaterThan(gone.pips);
  expect(gone.pips).toBeGreaterThan(gone.elapsed);
  expect(gone.elapsed).toBeGreaterThan(gone.hint);
  expect(gone.hint).toBeGreaterThan(gone.counts);
});

test("a lead that cannot show whole is cut to at least eight columns, ending in the ellipsis", () => {
  const long = view({
    agents: [
      row({ now: "pnpm test --filter @scope/package-with-a-long-name" }),
    ],
  });
  const cut = Array.from({ length: 100 }, (_, i) => i + 20).flatMap((width) => {
    const [pulse = ""] = textOf(draw(long, plain(), width, 0));
    const lead = /› (\S.*?)(?: {2,}|$)/.exec(pulse)?.[1];
    return lead?.endsWith("…") ? [visibleWidth(`› ${lead}`)] : [];
  });
  expect(cut.length).toBeGreaterThan(0);
  expect(Math.min(...cut)).toBeGreaterThanOrEqual(8);
});

const HOSTILE_NOWS = [
  ...CORPUS.map(sanitize),
  "漢字".repeat(40),
  "🙂".repeat(40),
];

test("the pulse fits every width 0-200 for hostile labels in every tier", () => {
  for (const mode of TIERS)
    for (const now of HOSTILE_NOWS) {
      const failure = { ...row({ label: now, mark: "failed" }), why: now };
      const hostile = view({
        agents: [row({ now }), row({ now: "x", mark: "queued" })],
        shells: [row({ label: now, now })],
        failed: [
          { row: failure, tab: "agents" as const, seen: true },
          { row: failure, tab: "agents" as const, seen: false },
          { row: failure, tab: "agents" as const, seen: false },
        ],
      });
      for (const width of WIDTHS_SWEEP)
        for (const line of draw(hostile, testPaint(mode), width, 3_700_000))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
});

test("the ascii tier draws the pulse with no escape and no non-ASCII character", () => {
  const lines = draw(
    { ...THREE, agents: [row({ now: "bash" }), row({ mark: "queued" })] },
    testPaint("ascii"),
    120,
    64_000,
  );
  for (const line of lines) expect(line).toMatch(/^[\x20-\x7e]*$/);
  expect(lines[0]).toContain("> bash");
  expect(lines[0]).toContain("* o");
});

test("states stay distinct with colour stripped: queued, running and failed have their own marks", () => {
  const marks = view({
    agents: [
      row({ mark: "queued" }),
      row({ mark: "running" }),
      row({ mark: "failed" }),
    ],
  });
  expect(textOf(draw(marks, testPaint("mono"), 120, 0))[0]).toContain(
    "3 agents □ • ×",
  );
  expect(textOf(draw(marks, testPaint("ascii"), 120, 0))[0]).toContain(
    "3 agents o * x",
  );
});

const FAILED = row({
  id: "dead0001",
  label: '"Data review"',
  mark: "failed",
  why: "429 rate limited",
});

test("an unseen failure leads the pulse, its reason in bold", () => {
  const led = view({
    agents: [row({ now: "read" }), row()],
    failed: [
      { row: FAILED, tab: "agents" as const, seen: false },
      {
        row: { ...FAILED, id: "dead0002" },
        tab: "agents" as const,
        seen: false,
      },
    ],
  });

  const [pulse] = textOf(draw(led, plain(), 140, 64_000));
  expect(pulse).toMatch(
    /^ × "Data review" · 429 rate limited · unseen {2}\+1 {3}2 agents • • {2,}1m04s {2}/,
  );
  expect(pulse).not.toContain("› read");
  const reason = styledRuns(draw(led, testPaint(), 140, 0)[0] ?? "").find(
    (run) => run.text === "429 rate limited",
  );
  expect(reason).toMatchObject({ bold: true });
});

test("a failure the user has seen no longer leads", () => {
  const seen = view({
    agents: [row({ now: "read" })],
    failed: [{ row: FAILED, tab: "agents" as const, seen: true }],
  });
  expect(textOf(draw(seen, plain(), 140, 0))[0]).toContain("› read");
  expect(
    draw(
      view({ failed: [{ row: FAILED, tab: "agents" as const, seen: true }] }),
      plain(),
      140,
      0,
    ),
  ).toEqual([]);
});

test("with only unseen failures the pulse still shows", () => {
  const lines = draw(
    view({ failed: [{ row: FAILED, tab: "agents" as const, seen: false }] }),
    plain(),
    100,
    0,
  );

  expect(lines).toHaveLength(2);
  expect(textOf(lines)[0]).toMatch(
    new RegExp(`^ × "Data review" · 429 rate limited · unseen +${HINT} $`),
  );
});

test("a failure keeps its reason and 'unseen' as the pane narrows, cutting its label first", () => {
  const led = view({
    agents: [row()],
    failed: [
      {
        row: { ...FAILED, label: '"A very long review name"' },
        tab: "agents" as const,
        seen: false,
      },
    ],
  });
  const [pulse = ""] = textOf(draw(led, plain(), 60, 0));
  expect(pulse).toContain("429 rate limited · unseen");
  expect(pulse).toContain("…");
});

// The open bar: a header and one tab's rows on a grid.

const AGENT_ROWS: BarRow[] = [
  row({
    id: "a1f3e0d2a1f3e0d2",
    now: "bash",
    turns: 6,
    tools: 9,
    startedAt: 0,
  }),
  row({
    id: "9c2e4b119c2e4b11",
    label: '"漢字レビュー"',
    background: true,
    now: "read src/auth/session.ts",
    turns: 1,
    tools: 12,
    startedAt: 0,
  }),
  row({
    id: "b4d60f3cb4d60f3c",
    mark: "queued",
    label: '"Data review"',
    now: 'behind "Correctness review"',
    turns: 0,
    tools: 0,
    startedAt: 0,
  }),
];

/** An open AGENTS tab over `AGENT_ROWS`, slots as the bar hands them out. */
const OPEN = view({
  open: true,
  agents: AGENT_ROWS,
  shells: [row({ id: "7a40cb12", label: "pnpm dev", background: true })],
  slots: {
    agents: new Map(
      AGENT_ROWS.map((r, i) => [r.id, i === 2 ? 12 : i + 1] as const),
    ),
    shells: new Map([["7a40cb12", 1]]),
  },
});

const GRID_ROWS = (lines: string[]) => lines.slice(1, 1 + AGENT_ROWS.length);

/** The columns `text` spans from `start`, as a terminal shows them. */
const at = (line: string, start: number, length: number) =>
  stripTerminalSequences(sliceByColumn(line, start, length, true));

test("columns line up: mark, slot, label, now, time and id start at the same column on every row", () => {
  const lines = textOf(draw(OPEN, plain(), 150, 64_000));

  const rows = GRID_ROWS(lines);
  expect(rows).toHaveLength(3);
  for (const line of rows) expect(visibleWidth(line)).toBe(150);
  // pad 1 · mark 1 · sp · slot 2 · sp · label 26 · sp 2 · now · turns 8 · tools 8 · time 6 · id 8 · pad
  expect(rows.map((l) => at(l, 1, 1))).toEqual(["•", "•", "□"]);
  expect(rows.map((l) => at(l, 3, 2))).toEqual(["1 ", "2 ", "12"]);
  expect(rows.map((l) => at(l, 6, 26).trimEnd())).toEqual([
    '"Correctness review"',
    '"漢字レビュー" &',
    '"Data review"',
  ]);
  expect(rows.map((l) => at(l, 34, 6))).toEqual(["› bash", "› read", "› behi"]);
  expect(rows.map((l) => at(l, 150 - 1 - 8, 8))).toEqual([
    "a1f3e0d2",
    "9c2e4b11",
    "b4d60f3c",
  ]);
  expect(rows.map((l) => at(l, 150 - 1 - 8 - 2 - 6, 6))).toEqual([
    " 1m04s",
    " 1m04s",
    " 1m04s",
  ]);
  expect(rows.map((l) => at(l, 150 - 1 - 8 - 2 - 6 - 2 - 8, 8))).toEqual([
    " 9 tools",
    "12 tools",
    " 0 tools",
  ]);
});

test("a shells row's slot is $n and its columns without turns and tools stay blank", () => {
  const lines = textOf(draw({ ...OPEN, tab: "shells" }, plain(), 150, 64_000));

  expect(lines[0]).toMatch(/^ {2}AGENTS 3 {4}SHELLS 1 /);
  const [shell] = GRID_ROWS(lines);
  expect(at(shell ?? "", 3, 2)).toBe("$1");
  expect(shell).toMatch(/pnpm dev &/);
  expect(visibleWidth(shell ?? "")).toBe(150);
});

test("columns drop as the pane narrows: id under 110, tools under 100, turns under 80, all but time under 60", () => {
  const shows = (width: number) => {
    const [first = ""] = GRID_ROWS(textOf(draw(OPEN, plain(), width, 64_000)));
    return {
      id: first.includes("a1f3e0d2"),
      tools: first.includes("9 tools"),
      turns: first.includes("6 turns"),
      time: first.includes("1m04s"),
      width: visibleWidth(first),
    };
  };

  expect(shows(150)).toEqual({
    id: true,
    tools: true,
    turns: true,
    time: true,
    width: 150,
  });
  expect(shows(109)).toEqual({
    id: false,
    tools: true,
    turns: true,
    time: true,
    width: 109,
  });
  expect(shows(99)).toEqual({
    id: false,
    tools: false,
    turns: true,
    time: true,
    width: 99,
  });
  expect(shows(79)).toEqual({
    id: false,
    tools: false,
    turns: false,
    time: true,
    width: 79,
  });
  expect(shows(59)).toEqual({
    id: false,
    tools: false,
    turns: false,
    time: true,
    width: 59,
  });
  // Below 44 columns the pulse stands in for the grid
  const narrow = textOf(draw(OPEN, plain(), 43, 64_000));
  expect(narrow).toHaveLength(2);
  expect(narrow[0]).toContain("3 agents");
  expect(narrow.join("\n")).not.toContain("AGENTS");
});

test("more than eight rows show seven and a count of the rest", () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    row({ id: `id${i}`, now: "x" }),
  );
  const lines = textOf(
    draw(view({ open: true, agents: many }), plain(), 120, 0),
  );

  expect(lines).toHaveLength(1 + 7 + 1 + 1);
  expect(lines.at(-2)).toMatch(/^ {34}\+3 more$/);
  expect(lines.at(-1)).toBe("");
});

test("failed rows come first, with their reason and how long they ran", () => {
  const failed = row({
    id: "dead0001",
    mark: "failed",
    label: '"Data review"',
    why: "429 rate limited",
    startedAt: 0,
    endedAt: 41_000,
  });
  const lines = textOf(
    draw(
      view({
        open: true,
        agents: [row({ now: "read" })],
        failed: [{ row: failed, tab: "agents", seen: true }],
        slots: {
          agents: new Map([
            ["dead0001", 1],
            ["a1f3e0d2a1f3e0d2", 2],
          ]),
          shells: new Map(),
        },
      }),
      plain(),
      150,
      64_000,
    ),
  );

  expect(lines[1]).toMatch(
    /^ × 1 {2}"Data review" +429 rate limited .* 41s {2}dead0001 $/,
  );
  expect(lines[2]).toContain("• 2");
  expect(lines[0]).toMatch(/^ {2}AGENTS 2 /);
});

test("an open bar with nothing to list says so under its header", () => {
  const lines = textOf(draw(view({ open: true }), plain(), 100, 0));

  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/^ {2}AGENTS 0 {4}SHELLS 0 .* switch · .*close $/);
  expect(lines[1]).toBe(" nothing running");
});

test("the header's keys drop first when the pane is narrow", () => {
  const [header = ""] = textOf(draw(OPEN, plain(), 44, 0));
  expect(header).toMatch(/^ {2}AGENTS 3 {4}SHELLS 1 $/);
});

test("under 12 terminal rows an open bar draws the pulse", () => {
  const short = textOf(draw(OPEN, plain(), 120, 64_000, 11));
  expect(short).toHaveLength(2);
  expect(short[0]).toMatch(/^ 3 agents .*1 shell /);
  expect(draw(OPEN, plain(), 120, 64_000, 12)[0]).toContain("AGENTS");
});

const TEN = Array.from({ length: 10 }, (_, i) =>
  row({ id: `id${i}`, label: `row${i}`, now: "x" }),
);
const MORE = /^ +\+\d+ more$/;

test("a 24-row pane lists seven of ten rows and counts the rest below", () => {
  const lines = textOf(
    draw(view({ open: true, agents: TEN }), plain(), 120, 0, 24),
  );
  expect(lines).toHaveLength(1 + 7 + 1 + 1);
  expect(lines.at(-2)).toMatch(/\+3 more$/);
});

test("a 12-row pane lists two of ten rows, the least that is worth the tab, and fits its rows", () => {
  const lines = textOf(
    draw(view({ open: true, agents: TEN }), plain(), 120, 0, 12),
  );
  expect(lines).toHaveLength(1 + 2 + 1 + 1);
  expect(lines[1]).toContain("row0");
  expect(lines[3]).toMatch(/\+8 more$/);
  const all = textOf(
    draw(view({ open: true, agents: TEN.slice(0, 3) }), plain(), 120, 0, 12),
  );
  expect(all.filter((l) => /row\d/.test(l))).toHaveLength(3);
  expect(all.some((l) => MORE.test(l))).toBe(false);
});

test("an 8-row pane draws the pulse, not the tab", () => {
  const lines = textOf(
    draw(view({ open: true, agents: TEN }), plain(), 120, 0, 8),
  );
  expect(lines).toHaveLength(2);
  expect(lines.join("\n")).not.toContain("AGENTS");
});

test("the window keeps its start while the highlight stays inside it, and the count sits where rows are hidden", () => {
  const at = (top: number, focused: string) =>
    textOf(
      draw(
        view({ open: true, agents: TEN, top, focused }),
        plain(),
        120,
        0,
        24,
      ),
    );
  const firstRow = (lines: string[]) =>
    lines.find((l) => /row\d/.test(l))?.match(/row\d/)?.[0];

  const inside = at(2, "id5");
  expect(firstRow(inside)).toBe("row2");
  expect(inside.at(-2)).toMatch(/\+3 more$/);

  const end = at(3, "id9");
  expect(firstRow(end)).toBe("row3");
  expect(end[1]).toMatch(MORE);
  expect(end.at(-2)).toContain("row9");

  expect(firstRow(at(3, "id1"))).toBe("row1");
});

test("a cut failure reason keeps its row's style only on the reason", () => {
  const failed = row({
    id: "dead0001",
    mark: "failed",
    why: "provider exploded while streaming a very long answer",
    startedAt: 0,
    endedAt: 41_000,
  });
  const lines = draw(
    view({
      open: true,
      failed: [{ row: failed, tab: "agents", seen: true }],
      slots: { agents: new Map([["dead0001", 1]]), shells: new Map() },
    }),
    testPaint(),
    80,
    0,
  );
  const runs = styledRuns(lines[1] ?? "");
  const cut = runs.find((r) => r.text.includes("provider"));
  expect(cut?.bold).toBe(true);
  expect(cut?.text.trimEnd().endsWith("…")).toBe(true);
  expect(runs.filter((r) => r.bold).map((r) => r.text)).toEqual([cut?.text]);
});

test("open and idle, the pulse reads nothing running with the key", () => {
  const [pulse = ""] = textOf(draw(view({ open: true }), plain(), 100, 0, 11));
  expect(pulse).toMatch(new RegExp(`^ nothing running +${HINT} $`));
});

test("no bar line is a rule: no row is only ─ or -", () => {
  for (const mode of TIERS)
    for (const open of [true, false])
      for (const line of draw({ ...OPEN, open }, testPaint(mode), 100, 0))
        expect(/^[\s─-]+$/.test(line) && line.trim() !== "").toBe(false);
});

test("every expanded line fits 0-200 columns in every tier with hostile labels", () => {
  for (const mode of TIERS)
    for (const text of HOSTILE_NOWS) {
      const hostile = row({
        label: text,
        now: text,
        why: text,
        turns: 1000,
        tools: 99999,
        endedAt: 3_700_000,
      });
      const shown = view({
        open: true,
        agents: [hostile, row({ background: true, label: text })],
        shells: [hostile],
        failed: [
          { row: { ...hostile, mark: "failed" }, tab: "agents", seen: true },
        ],
        slots: {
          agents: new Map([[hostile.id, 12345]]),
          shells: new Map([[hostile.id, 12345]]),
        },
      });
      for (const tab of ["agents", "shells"] as const)
        for (const width of WIDTHS_SWEEP)
          for (const line of draw(
            { ...shown, tab },
            testPaint(mode),
            width,
            3_700_000,
          ))
            expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
});

test("the ascii tier draws the tabs as [AGENTS n] with no escape", () => {
  const lines = draw(OPEN, testPaint("ascii"), 120, 64_000);

  expect(lines[0]).toMatch(/^ \[AGENTS 3\] {3}SHELLS 1 /);
  // The second row's label is CJK on purpose; the escape check covers every line
  for (const line of [lines[0], lines[1], lines[3]])
    expect(line).toMatch(/^[\x20-\x7e]*$/);
  for (const line of lines) expect(line).not.toContain("\x1b");
  expect(lines[1]).toContain("* 1");
  const marks = lines.slice(1, 4).map((l) => l[1]);
  expect(marks).toEqual(["*", "*", "o"]);
});

test("the colour tier marks the active tab with the selected background, mono with inverse", () => {
  const colour = draw(OPEN, testPaint("color"), 120, 0)[0] ?? "";
  const mono = draw(OPEN, testPaint("mono"), 120, 0)[0] ?? "";
  expect(colour).toContain("48;2;");
  expect(mono).not.toContain("48;");
  expect(mono).toContain("\x1b[7");
});

/** `OPEN` with the second row highlighted. */
const FOCUSED = { ...OPEN, focused: AGENT_ROWS[1]?.id };

test("the focused row is drawn apart from the rest in every tier: selectedBg in color, inverse in mono, a '>' in the pad column in ascii", () => {
  const colour = draw(FOCUSED, testPaint("color"), 120, 0);
  expect(colour[2]).toContain("48;2;42;45;58");
  expect(colour[1]).not.toContain("48;2;");
  expect(colour[3]).not.toContain("48;2;");

  const mono = draw(FOCUSED, testPaint("mono"), 120, 0);
  expect(mono[2]).toContain("\x1b[7");
  expect(mono[2]).not.toContain("48;2;");
  expect(mono[1]).not.toContain("\x1b[7");

  // The second row's label is CJK on purpose, so the plain-ASCII check looks at the first
  const ascii = draw(
    { ...OPEN, focused: AGENT_ROWS[0]?.id },
    testPaint("ascii"),
    120,
    0,
  );
  expect(ascii.map((l) => l.charAt(0))).toEqual([" ", ">", " ", " ", ""]);
  expect(ascii[1]).toMatch(/^[\x20-\x7e]*$/);
});

test("the highlight is one unbroken style to the edge in color", () => {
  const line = draw(FOCUSED, testPaint("color"), 120, 0)[2] ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the background reset is what this counts
  expect(line.match(/\x1b\[49m/g)).toHaveLength(1);
  expect(visibleWidth(line)).toBe(120);
});

test("focus moves no column: the focused row keeps every column of its neighbours", () => {
  for (const mode of TIERS) {
    const rows = (shown: BarView) =>
      GRID_ROWS(textOf(draw(shown, testPaint(mode), 150, 64_000)));
    const before = rows(OPEN);
    const after = rows(FOCUSED);
    // Only the ascii marker changes the text, and only in the pad column
    expect(
      after.map((l, i) => (i === 1 && mode === "ascii" ? l.slice(1) : l)),
    ).toEqual(
      before.map((l, i) => (i === 1 && mode === "ascii" ? l.slice(1) : l)),
    );
    expect(after.map(visibleWidth)).toEqual(before.map(visibleWidth));
  }
});

test("with nothing focused the open bar draws exactly as before", () => {
  for (const mode of TIERS) {
    const none = draw(OPEN, testPaint(mode), 120, 0);
    const missing = draw(
      { ...OPEN, focused: "an id no row has" },
      testPaint(mode),
      120,
      0,
    );
    expect(missing).toEqual(none);
  }
});

test("the window scrolls to keep the focused row in view past eight rows and still counts the rest", () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    row({ id: `id${i}`, label: `row${i}`, now: "x" }),
  );
  const shown = (focused: string | undefined) =>
    textOf(
      draw(
        view({ open: true, agents: many, focused }),
        testPaint("ascii"),
        120,
        0,
      ),
    );
  const labels = (lines: string[]) =>
    lines.filter((l) => /row\d/.test(l)).map((l) => /row\d/.exec(l)?.[0]);

  expect(labels(shown(undefined))).toEqual([
    "row0",
    "row1",
    "row2",
    "row3",
    "row4",
    "row5",
    "row6",
  ]);
  expect(labels(shown("id6"))).toEqual([
    "row0",
    "row1",
    "row2",
    "row3",
    "row4",
    "row5",
    "row6",
  ]);
  const end = shown("id9");
  expect(labels(end)).toEqual([
    "row3",
    "row4",
    "row5",
    "row6",
    "row7",
    "row8",
    "row9",
  ]);
  expect(end.find((l) => l.startsWith(">"))).toContain("row9");
  expect(end[1]).toMatch(/\+3 more$/);
});

test("every line fits 0-200 columns in every tier with a hostile label focused", () => {
  for (const mode of TIERS)
    for (const text of HOSTILE_NOWS) {
      const hostile = row({
        label: text,
        now: text,
        turns: 1000,
        tools: 99999,
      });
      const shown = view({
        open: true,
        agents: [hostile],
        slots: { agents: new Map([[hostile.id, 12345]]), shells: new Map() },
        focused: hostile.id,
      });
      for (const width of WIDTHS_SWEEP)
        for (const line of draw(shown, testPaint(mode), width, 3_700_000))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
});
