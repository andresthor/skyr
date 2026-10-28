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
};

test("the line fits every width 0-200 in every tier with hostile directory, branch, name and status text", () => {
  for (const mode of TIERS)
    for (const text of CORPUS)
      for (const width of WIDTHS_SWEEP)
        for (const line of footerLines(
          { cwd: text, branch: text, sessionName: text },
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
  expect(footerLines(facts, "", paint(), 100)).toHaveLength(1);
  expect(statusesLine(new Map(), "color")).toBe("");
  expect(footerLines(facts, "voice: ready", paint(), 100)).toHaveLength(2);
});

test("the session name goes first when the line is too narrow, then the branch", () => {
  const line = (width: number) => footerLines(facts, "", paint(), width)[0];
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
