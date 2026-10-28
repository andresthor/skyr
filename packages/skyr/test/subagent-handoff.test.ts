// What a closing session leaves for the one that replaces it in the same process.
import { expect, test } from "vitest";
import { leaveStopped, takeStopped } from "../src/subagent/handoff.js";
import type { RunSnapshot } from "../src/subagent/store.js";

const SLOT = Symbol.for("skyr.subagent.stopped");

const run = (id: string, extra: Partial<RunSnapshot> = {}): RunSnapshot => ({
  id,
  description: `job ${id}`,
  status: "running",
  startedAt: 1,
  turns: 0,
  toolCalls: 0,
  tokens: 0,
  background: true,
  ...extra,
});

/** A slot as an earlier build might have left it. */
const plant = (value: unknown) => Reflect.set(globalThis, SLOT, value);

test("a hand-over is taken once: the second take finds nothing", () => {
  leaveStopped("/s/a.jsonl", "reload", [run("one"), run("two")]);

  expect(takeStopped("/s/a.jsonl")).toEqual({
    reason: "reload",
    runs: [run("one"), run("two")],
  });
  expect(takeStopped("/s/a.jsonl")).toBeUndefined();
});

test("a hand-over for another session file is dropped, and the slot is empty afterwards", () => {
  leaveStopped("/s/a.jsonl", "new", [run("one")]);

  expect(takeStopped("/s/b.jsonl")).toBeUndefined();
  expect(takeStopped("/s/a.jsonl")).toBeUndefined();
});

test("a session that saves no file neither leaves nor takes a hand-over", () => {
  leaveStopped(undefined, "reload", [run("one")]);
  expect(takeStopped(undefined)).toBeUndefined();

  leaveStopped("/s/a.jsonl", "reload", [run("one")]);
  expect(takeStopped(undefined)).toBeUndefined();
  expect(takeStopped("/s/a.jsonl")).toBeUndefined();
});

test("a slot of another shape or version is dropped, never thrown on", () => {
  const good = { v: 1, parentFile: "/s/a.jsonl", reason: "reload" };
  const { startedAt: _, ...unstarted } = run("one");
  const cases: unknown[] = [
    "x",
    null,
    { ...good, v: 2, runs: [run("one")] },
    { ...good, runs: "x" },
    { ...good, reason: 7, runs: [run("one")] },
    { v: 1, reason: "reload", runs: [run("one")] },
  ];
  for (const slot of cases) {
    plant(slot);
    expect(takeStopped("/s/a.jsonl"), JSON.stringify(slot)).toBeUndefined();
  }

  // Of a sound slot, only the runs with every field read survive.
  plant({
    ...good,
    runs: [
      run("one"),
      unstarted,
      { ...run("two"), worktree: { path: "/w", branch: "b" } },
    ],
  });
  expect(takeStopped("/s/a.jsonl")?.runs).toEqual([run("one")]);
});

test("nothing is left when no background run was stopped", () => {
  leaveStopped("/s/a.jsonl", "reload", []);

  expect(takeStopped("/s/a.jsonl")).toBeUndefined();
});

test("a run's live-only activity is not carried over", () => {
  leaveStopped("/s/a.jsonl", "reload", [run("one", { activity: "working" })]);

  expect(takeStopped("/s/a.jsonl")?.runs).toEqual([run("one")]);
});
