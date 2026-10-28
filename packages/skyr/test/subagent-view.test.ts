import { expect, test } from "vitest";
import type { RunSnapshot } from "../src/subagent/store.js";
import { laneLine, laneTree, widgetLines } from "../src/subagent/view.js";

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

test("the widget line marks a stalled run, and only while its activity is unknown", () => {
  const line = (activity: RunSnapshot["activity"]) =>
    widgetLines([{ ...running, activity }], 3_000)?.[0];
  expect(line("unknown")).toBe(
    '● running scout "look around" · 1 turn · 1 tool · grep · stalled · 3s · abcdef01',
  );
  expect(line("working")).toBe(
    '● running scout "look around" · 1 turn · 1 tool · grep · 3s · abcdef01',
  );
});

test("a run past a quarter of an hour reads 18m58s in the widget, a lane and a tree, never 1138s", () => {
  const ended = {
    ...running,
    status: "done" as const,
    startedAt: 1_000,
    endedAt: 1_139_000,
  };
  expect(widgetLines([running], 1_138_900)?.[0]).toContain(" · 18m58s · ");
  const text = (segments: [string, string, boolean?][]) =>
    segments.map(([, s]) => s).join("");
  expect(text(laneLine(ended))).toContain(" · 18m58s · ");
  expect(laneTree([ended]).map(text).join("\n")).toContain(" · 18m58s");
});
