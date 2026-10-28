import { expect, test } from "vitest";
import type { RunSnapshot } from "../src/subagent/store.js";
import {
  barRow,
  laneLine,
  laneTree,
  listingLines,
} from "../src/subagent/view.js";

const running: RunSnapshot = {
  id: "abcdef0123",
  agent: "scout",
  description: "look around",
  status: "running",
  startedAt: 0,
  turns: 1,
  toolCalls: 1,
  tokens: 0,
  tool: "grep",
};

test("the listing marks a stalled run, and only while its activity is unknown", () => {
  const line = (activity: RunSnapshot["activity"]) =>
    listingLines([{ ...running, activity }], 3_000)?.[0];
  expect(line("unknown")).toBe(
    '● running scout "look around" · 1 turn · 1 tool · grep · stalled · 3s · abcdef01',
  );
  expect(line("working")).toBe(
    '● running scout "look around" · 1 turn · 1 tool · grep · 3s · abcdef01',
  );
});

test("a stalled run's bar row says stalled, and only while its activity is unknown", () => {
  const now = (activity: RunSnapshot["activity"]) =>
    barRow({ ...running, activity }).now;
  expect(now("unknown")).toBe("stalled");
  expect(now("working")).toBe("grep");
});

test("a queued run's bar row says who it waits behind, and a hostile label arrives inert", () => {
  const queued = barRow({
    ...running,
    status: "queued",
    behind: 'scout "first"',
    description: "x\u001b]52;c;aGk=\u0007\nsecond",
  });
  expect(queued).toMatchObject({ mark: "queued", now: 'behind scout "first"' });
  expect(queued.label).toBe('scout "x second"');
  expect(barRow(running)).toMatchObject({ mark: "running", background: false });
});

test("a run past a quarter of an hour reads 18m58s in the listing, a lane and a tree, never 1138s", () => {
  const ended = {
    ...running,
    status: "done" as const,
    startedAt: 1_000,
    endedAt: 1_139_000,
  };
  expect(listingLines([running], 1_138_900)?.[0]).toContain(" · 18m58s · ");
  const text = (segments: [string, string, boolean?][]) =>
    segments.map(([, s]) => s).join("");
  expect(text(laneLine(ended))).toContain(" · 18m58s · ");
  expect(laneTree([ended]).map(text).join("\n")).toContain(" · 18m58s");
});
