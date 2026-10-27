import { expect, test } from "vitest";
import type { RunSnapshot } from "../src/subagent/store.js";
import { widgetLines } from "../src/subagent/view.js";

const running: RunSnapshot = {
  id: "abcdef0123",
  toolCallId: "t1",
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
    "● running scout · 1 turn · 1 tool · grep · stalled · 3s · abcdef01",
  );
  expect(line("working")).toBe(
    "● running scout · 1 turn · 1 tool · grep · 3s · abcdef01",
  );
});
