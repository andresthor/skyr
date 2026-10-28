// The bar's lines, drawn from plain rows: nothing at rest, a pulse while anything runs.
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import type { BarRow } from "../src/chrome/bar.js";
import { type BarView, barLines } from "../src/chrome/bar-view.js";
import type { Tier } from "../src/ui/caps.js";
import { keyLabel } from "../src/ui/hint.js";
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
  agents: [],
  shells: [],
  failed: [],
  ...rows,
});

const none = view({});

/** The pulse's text, as a terminal shows it. */
const textOf = (lines: string[]) => lines.map(stripTerminalSequences);

test("the bar is absent at rest: no rows draw no lines", () => {
  expect(barLines(none, plain(), 100, 0)).toEqual([]);
  expect(barLines(none, plain(), 0, 0)).toEqual([]);
});

test("a pulse is one row plus the bar's own trailing blank", () => {
  const lines = barLines(
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
  const [pulse] = textOf(barLines(THREE, plain(), 120, 64_000));
  expect(pulse).toMatch(
    /^ 3 agents • □ • {3}1 shell • {3}› read {2,}1m04s {2}/,
  );
  expect(pulse?.trimEnd().endsWith(keyLabel("alt+a"))).toBe(true);
});

test("groups sit 3 spaces apart, 2 under 100 columns", () => {
  expect(textOf(barLines(THREE, plain(), 120, 0))[0]).toContain("•   1 shell");
  const narrow = textOf(barLines(THREE, plain(), 90, 0))[0];
  expect(narrow).toContain("•  1 shell");
  expect(narrow).not.toContain("•   1 shell");
});

test("more than eight rows show eight pips and a count of the rest", () => {
  const many = view({
    agents: Array.from({ length: 11 }, (_, i) => row({ id: `id${i}` })),
  });
  const [pulse] = textOf(barLines(many, plain(), 120, 0));
  expect(pulse).toContain("11 agents • • • • • • • • +3");
});

/** The widest pane at which `part` is gone, scanning down from 150 columns. */
function goneAt(shown: BarView, part: RegExp): number {
  for (let width = 150; width >= 1; width--) {
    const [pulse = ""] = textOf(barLines(shown, plain(), width, 64_000));
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
    const [pulse = ""] = textOf(barLines(long, plain(), width, 0));
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
          { row: failure, seen: true },
          { row: failure, seen: false },
          { row: failure, seen: false },
        ],
      });
      for (const width of WIDTHS_SWEEP)
        for (const line of barLines(hostile, testPaint(mode), width, 3_700_000))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
});

test("the ascii tier draws the pulse with no escape and no non-ASCII character", () => {
  const lines = barLines(
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
  expect(textOf(barLines(marks, testPaint("mono"), 120, 0))[0]).toContain(
    "3 agents □ • ×",
  );
  expect(textOf(barLines(marks, testPaint("ascii"), 120, 0))[0]).toContain(
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
      { row: FAILED, seen: false },
      { row: { ...FAILED, id: "dead0002" }, seen: false },
    ],
  });

  const [pulse] = textOf(barLines(led, plain(), 140, 64_000));
  expect(pulse).toMatch(
    /^ × "Data review" · 429 rate limited · unseen {2}\+1 {3}2 agents • • {2,}1m04s {2}/,
  );
  expect(pulse).not.toContain("› read");
  const reason = styledRuns(barLines(led, testPaint(), 140, 0)[0] ?? "").find(
    (run) => run.text === "429 rate limited",
  );
  expect(reason).toMatchObject({ bold: true });
});

test("a failure the user has seen no longer leads", () => {
  const seen = view({
    agents: [row({ now: "read" })],
    failed: [{ row: FAILED, seen: true }],
  });
  expect(textOf(barLines(seen, plain(), 140, 0))[0]).toContain("› read");
  expect(
    barLines(view({ failed: [{ row: FAILED, seen: true }] }), plain(), 140, 0),
  ).toEqual([]);
});

test("with only unseen failures the pulse still shows", () => {
  const lines = barLines(
    view({ failed: [{ row: FAILED, seen: false }] }),
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
      { row: { ...FAILED, label: '"A very long review name"' }, seen: false },
    ],
  });
  const [pulse = ""] = textOf(barLines(led, plain(), 60, 0));
  expect(pulse).toContain("429 rate limited · unseen");
  expect(pulse).toContain("…");
});
