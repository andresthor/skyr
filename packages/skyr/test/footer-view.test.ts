// The footer's lines, drawn from plain facts: they fit every pane in every tier.
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import {
  type FooterFacts,
  footerLines,
  statusesLine,
} from "../src/chrome/footer-view.js";
import type { Tier } from "../src/ui/caps.js";
import { plainTheme } from "./session.js";
import { CORPUS, WIDTHS_SWEEP } from "./ui.js";

const TIERS: Tier[] = ["color", "mono", "ascii"];
const paint = (mode: Tier = "color") => ({ theme: plainTheme, mode });

const facts: FooterFacts = {
  cwd: "~/projects/skyr",
  branch: "feat-auth-refactor",
  sessionName: "my session",
  context: { tokens: 412_000, percent: 41.2, window: 1_000_000 },
  tokens: {
    input: 412_000,
    output: 38_000,
    cacheRead: 1_234_567,
    cacheWrite: 96_000,
    cacheHit: 93.6,
  },
  turns: 12,
  cost: 1.82,
  model: "claude-sonnet-5-5",
  thinking: "high",
  profile: "experimental",
  clock: "22:05",
  spend: { provider: "anthropic", day: 4.123, month: 101.6 },
};

/** Facts with the context at `percent` of a `window` and nothing else that varies. */
const filled = (percent: number, window = 1_000_000): FooterFacts => ({
  ...facts,
  context: { tokens: (window * percent) / 100, percent, window },
});

/** The second line, which holds the directory, branch, name and token totals. */
const where = (f: FooterFacts, width = 200, mode: Tier = "color") =>
  footerLines(f, "", paint(mode), width)[1] ?? "";

const head = (f: FooterFacts, width = 200, mode: Tier = "color") =>
  footerLines(f, "", paint(mode), width)[0] ?? "";

/** The meter's filled cells of a drawn line. */
const filledCells = (line: string, mode: Tier = "color") =>
  [...line].filter((c) => c === (mode === "ascii" ? "#" : "▪")).length;

test("the line fits every width 0-200 in every tier with hostile directory, branch, name and status text", () => {
  for (const mode of TIERS)
    for (const text of CORPUS)
      for (const width of WIDTHS_SWEEP)
        for (const line of footerLines(
          {
            ...facts,
            cwd: text,
            branch: text,
            sessionName: text,
            model: text,
            thinking: text,
          },
          text,
          paint(mode),
          width,
        ))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

test("the ascii tier draws no escape and no non-ASCII character", () => {
  for (const width of WIDTHS_SWEEP)
    for (const line of footerLines(
      facts,
      "voice: ready",
      paint("ascii"),
      width,
    ))
      expect(line).toMatch(/^[\x20-\x7e]*$/);
});

test("the statuses line is absent when there are none", () => {
  expect(footerLines(facts, "", paint(), 100)).toHaveLength(2);
  expect(statusesLine(new Map(), "color")).toBe("");
  expect(footerLines(facts, "voice: ready", paint(), 100)).toHaveLength(3);
});

test("the session name goes first when the line is too narrow, then the branch", () => {
  const line = (width: number) => footerLines(facts, "", paint(), width)[1];
  expect(line(100)).toContain("my session");
  expect(line(46)).toContain("(feat-auth-refactor)");
  expect(line(46)).not.toContain("my session");
  expect(line(20)).not.toContain("feat-auth");
  expect(line(20)).toContain("~/projects");
});

test("statuses are key-sorted and lose their colour outside the color tier", () => {
  const statuses = new Map([
    ["b", "\u001b[31mtwo\u001b[0m"],
    ["a", "one"],
    ["c", "  "],
  ]);
  expect(statusesLine(statuses, "color")).toBe("one \u001b[31mtwo\u001b[0m");
  expect(statusesLine(statuses, "mono")).toBe("one two");
});

test("line one reads context, turns, cost, model and thinking level", () => {
  expect(head(facts)).toBe(
    " 41% ▪▪▪▪▪▪ ▪▫▫▫ 412k/1M · 12 turns $1.82 · claude-sonnet-5-5 high · experimental 22:05",
  );
  expect(head(facts, 200, "ascii")).toBe(
    " 41% ###### #--- 412k/1M - 12 turns $1.82 - claude-sonnet-5-5 high - experimental 22:05",
  );
});

test("the meter fills monotonically with usage, fine cells first", () => {
  for (const window of [200_000, 1_000_000]) {
    let before = -1;
    for (let percent = 0; percent <= 100; percent += 1) {
      const cells = filledCells(head(filled(percent, window)));
      expect(cells).toBeGreaterThanOrEqual(before);
      before = cells;
    }
    expect(before).toBe(window === 200_000 ? 8 : 10);
  }
  // 128k of 1M is inside the fine zone: only fine cells are filled
  expect(head(filled(12.8))).toContain("▪▪▪▫▫▫ ▫▫▫▫");
});

test("a window of 200k draws one bar and a window of 1M draws fine and coarse cells", () => {
  expect(head(filled(50, 200_000))).toContain("50% ▪▪▪▪▫▫▫▫ 100k/200k");
  expect(head(filled(50))).toMatch(/50% [▪▫]{6} [▪▫]{4} 500k\/1M/);
});

test("past 70 percent the meter is warning and past 90 error, and stays distinct under NO_COLOR", () => {
  const toneOf = (percent: number) => {
    let fg: unknown;
    const theme = {
      ...plainTheme,
      style: (text: string, style: { fg?: unknown }) => {
        if (text.startsWith(`${percent}%`)) fg = style.fg;
        return text;
      },
    };
    footerLines(filled(percent), "", { theme, mode: "color" }, 200);
    return fg;
  };
  expect(toneOf(50)).toBe(plainTheme.colors.text);
  expect(toneOf(75)).toBe(plainTheme.colors.warning);
  expect(toneOf(95)).toBe(plainTheme.colors.error);
  // Mono has no colour: bold carries the warning, and a mark carries the error
  expect(head(filled(95), 200, "mono")).toContain("95%!");
  expect(head(filled(75), 200, "mono")).toContain("75% ");
  expect(head(filled(50), 200, "mono")).not.toContain("!");
  expect(head(filled(95), 200, "color")).not.toContain("!");
});

test("an unknown context reads ? and an empty meter", () => {
  const unknown = {
    ...facts,
    context: { tokens: null, percent: null, window: 1_000_000 },
  };
  expect(head(unknown)).toContain("? ▫▫▫▫▫▫ ▫▫▫▫ ?/1M");
});

test("the clock goes first, then the profile, both before the model prefix", () => {
  const narrowest = (needle: string) =>
    Math.min(...WIDTHS_SWEEP.filter((w) => head(facts, w).includes(needle)));
  const clock = narrowest("22:05");
  const profile = narrowest("experimental");
  const prefix = narrowest("claude-sonnet");
  expect(clock).toBeGreaterThan(profile);
  expect(profile).toBeGreaterThan(prefix);
  // The widest pane that drops both still draws the whole of the rest
  expect(head(facts, prefix)).toContain("claude-sonnet-5-5 high");
  expect(head(facts, prefix)).not.toContain("experimental");
});

test("the ladder drops the model prefix before the context tokens and the meter last", () => {
  const widths = (needle: string) =>
    WIDTHS_SWEEP.filter((w) => head(facts, w).includes(needle));
  const last = (list: number[]) => Math.min(...list);
  // The narrowest pane each part survives in
  const prefix = last(widths("claude-sonnet"));
  const tokens = last(widths("412k/1M"));
  const coarse = last(widths("▪▫▫▫ 412k"));
  const meter = last(widths("▪▪"));
  const model = last(widths("sonnet-5-5"));
  const cost = last(widths("$1.82"));
  expect(prefix).toBeGreaterThan(model);
  expect(coarse).toBeGreaterThan(tokens);
  expect(tokens).toBeGreaterThan(meter);
  expect(meter).toBeGreaterThan(model);
  expect(model).toBeGreaterThan(cost);
  expect(head(facts, 20)).toContain("$1.82");
});

test("turns shorten to t before they go", () => {
  const widths = (needle: RegExp) =>
    WIDTHS_SWEEP.filter((w) => needle.test(head(facts, w)));
  expect(Math.min(...widths(/12 turns/))).toBeGreaterThan(
    Math.min(...widths(/12t /)),
  );
  expect(Math.min(...widths(/12t /))).toBeGreaterThan(
    Math.min(...widths(/\$1\.82/)),
  );
});

test("line one fits widths 0-200 in every tier", () => {
  for (const mode of TIERS)
    for (const percent of [0, 71, 95, 100])
      for (const width of WIDTHS_SWEEP)
        expect(
          visibleWidth(head(filled(percent), width, mode)),
        ).toBeLessThanOrEqual(width);
});

test("line two reads where, the token totals and the cache hit rate, then the provider's spend", () => {
  expect(where(facts)).toBe(
    " ~/projects/skyr (feat-auth-refactor) · my session · ↑412k ↓38k R1.2M W96k CH94% · anthropic Σ $4.12·day  $102·mo",
  );
  expect(where(facts, 200, "ascii")).toContain(
    " - ^412k v38k R1.2M W96k CH94% - anthropic sum $4.12-day  $102-mo",
  );
});

test("the totals leave out what is zero, and CH needs cache use and a response to measure", () => {
  const only = (tokens: FooterFacts["tokens"]) =>
    where({ ...facts, tokens, spend: undefined });
  expect(only({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0 })).toMatch(
    / · ↑5$/,
  );
  expect(
    only({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cacheHit: 0 }),
  ).not.toContain("CH");
  expect(
    only({ input: 5, output: 1, cacheRead: 9, cacheWrite: 0 }),
  ).not.toContain("CH");
  expect(
    only({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
  ).not.toMatch(/ · $/);
});

test("the token group is the first thing line two drops", () => {
  const widths = (needle: string) =>
    WIDTHS_SWEEP.filter((w) => where(facts, w).includes(needle));
  const tokens = Math.min(...widths("CH94%"));
  const name = Math.min(...widths("my session"));
  const branch = Math.min(...widths("feat-auth"));
  expect(tokens).toBeGreaterThan(name);
  expect(name).toBeGreaterThan(branch);
  expect(where(facts, name)).not.toContain("↑");
});

test("the spend group is absent without figures, and a long provider is cut to 16 columns", () => {
  expect(where({ ...facts, spend: undefined })).not.toContain("Σ");
  const spend = { provider: "p".repeat(40), day: 1, month: 2 };
  expect(where({ ...facts, spend })).toContain(
    `${"p".repeat(15)}… Σ $1.00·day  $2.00·mo`,
  );
});

test("line two gives up the tokens, then the name, the provider, the month, the spend and the branch, in that order", () => {
  const narrowest = (needle: string) =>
    Math.min(...WIDTHS_SWEEP.filter((w) => where(facts, w).includes(needle)));
  const order = [
    "CH94%",
    "my session",
    "anthropic Σ",
    "$102·mo",
    "$4.12·day",
    "(feat-auth",
  ].map(narrowest);
  expect(order).toEqual([...order].sort((a, b) => b - a));
  expect(new Set(order).size).toBe(order.length);
  // The provider's name goes before the month does
  expect(where(facts, order[3])).not.toContain("anthropic");
});

test("line two fits widths 0-200 in every tier with a spend group", () => {
  for (const mode of TIERS)
    for (const width of WIDTHS_SWEEP)
      expect(visibleWidth(where(facts, width, mode))).toBeLessThanOrEqual(
        width,
      );
});
