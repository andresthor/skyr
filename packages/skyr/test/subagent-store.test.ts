import { expect, test } from "vitest";
import { createRunStore, type RunSnapshot } from "../src/subagent/store.js";

const running: RunSnapshot = {
  id: "c1",
  toolCallId: "t1",
  description: "look around",
  status: "running",
  startedAt: 0,
  turns: 0,
  toolCalls: 0,
  tokens: 0,
};

test("a turn's token count is everything the child has used so far, cached input included", () => {
  const store = createRunStore();
  store.apply("c1", { type: "start", snapshot: running });
  store.apply("c1", {
    type: "turn",
    usage: {
      input: 5,
      output: 7,
      cacheRead: 100,
      cacheWrite: 8,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  expect(store.byToolCall("t1")?.tokens).toBe(120);
});

test("a running child counts as working, a queued one has no activity yet", () => {
  const store = createRunStore();
  store.apply("c1", {
    type: "start",
    snapshot: { ...running, status: "queued" },
  });
  expect(store.byToolCall("t1")?.activity).toBeUndefined();
  store.apply("c1", { type: "start", snapshot: running });
  expect(store.byToolCall("t1")?.activity).toBe("working");
});

test("a stale heartbeat makes a running child's activity unknown, and a fresh one working again", () => {
  const store = createRunStore();
  store.apply("c1", { type: "start", snapshot: running });

  store.apply("c1", { type: "stalled", stalled: true });
  expect(store.byToolCall("t1")?.activity).toBe("unknown");
  store.apply("c1", { type: "stalled", stalled: false });
  expect(store.byToolCall("t1")?.activity).toBe("working");
});

test("a tool call names the tool and counts it, leaving activity alone", () => {
  const store = createRunStore();
  store.apply("c1", { type: "start", snapshot: running });
  store.apply("c1", { type: "stalled", stalled: true });

  store.apply("c1", { type: "tool", name: "grep" });
  expect(store.byToolCall("t1")).toMatchObject({
    tool: "grep",
    toolCalls: 1,
    activity: "unknown",
  });
});
