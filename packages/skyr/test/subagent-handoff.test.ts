// What a closing session leaves for the one that replaces it in the same process.
import { expect, test } from "vitest";
import {
  type ChildRecord,
  leaveStopped,
  takeStopped,
} from "../src/subagent/handoff.js";
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

const record = (id: string, extra: Partial<ChildRecord> = {}): ChildRecord => ({
  id,
  description: `job ${id}`,
  model: "faux/faux-1",
  tools: ["read"],
  cwd: "/w",
  key: "/w",
  trusted: true,
  systemPrompt: "",
  sessionFile: `/s/${id}.jsonl`,
  ...extra,
});

/** A slot as an earlier build might have left it. */
const plant = (value: unknown) => Reflect.set(globalThis, SLOT, value);

test("a hand-over is taken once: the second take finds nothing", () => {
  leaveStopped(
    "/s/a.jsonl",
    "reload",
    [run("one"), run("two")],
    [record("one")],
  );

  expect(takeStopped("/s/a.jsonl")).toEqual({
    reason: "reload",
    runs: [run("one"), run("two")],
    records: [record("one")],
  });
  expect(takeStopped("/s/a.jsonl")).toBeUndefined();
});

test("a hand-over for another session file is dropped, and the slot is empty afterwards", () => {
  leaveStopped("/s/a.jsonl", "new", [run("one")], [record("one")]);

  expect(takeStopped("/s/b.jsonl")).toBeUndefined();
  expect(takeStopped("/s/a.jsonl")).toBeUndefined();
});

test("a session that saves no file neither leaves nor takes a hand-over", () => {
  leaveStopped(undefined, "reload", [run("one")], [record("one")]);
  expect(takeStopped(undefined)).toBeUndefined();

  leaveStopped("/s/a.jsonl", "reload", [run("one")], [record("one")]);
  expect(takeStopped(undefined)).toBeUndefined();
  expect(takeStopped("/s/a.jsonl")).toBeUndefined();
});

test("a slot of another shape or version is dropped, never thrown on", () => {
  const good = { v: 2, parentFile: "/s/a.jsonl", reason: "reload" };
  const { startedAt: _, ...unstarted } = run("one");
  const cases: unknown[] = [
    "x",
    null,
    { ...good, v: 1, runs: [run("one")], records: [] },
    { ...good, runs: "x", records: [] },
    { ...good, runs: [], records: "x" },
    { ...good, reason: 7, runs: [run("one")], records: [] },
    { v: 2, reason: "reload", runs: [run("one")], records: [] },
  ];
  for (const slot of cases) {
    plant(slot);
    expect(takeStopped("/s/a.jsonl"), JSON.stringify(slot)).toBeUndefined();
  }

  // Of a sound slot, only the runs and records with every field read survive.
  const { sessionFile: __, ...unsaved } = record("two");
  plant({
    ...good,
    runs: [
      run("one"),
      unstarted,
      { ...run("two"), worktree: { path: "/w", branch: "b" } },
    ],
    records: [
      record("one"),
      unsaved,
      { ...record("three"), tools: ["read", 7] },
      { ...record("four"), trusted: "yes" },
      { ...record("five"), worktree: { path: "/w", branch: "b" } },
      record("six", { worktree: { path: "/w", branch: "b", sha: "abc" } }),
      { ...record("seven"), settledAt: "soon" },
    ],
  });
  const taken = takeStopped("/s/a.jsonl");
  expect(taken?.runs).toEqual([run("one")]);
  expect(taken?.records.map((r) => r.id)).toEqual(["one", "six"]);
});

test("nothing is left when nothing was stopped and nothing can be continued", () => {
  leaveStopped("/s/a.jsonl", "reload", [], []);

  expect(takeStopped("/s/a.jsonl")).toBeUndefined();
});

test("children that can be continued cross without any stopped run", () => {
  leaveStopped("/s/a.jsonl", "reload", [], [record("one")]);

  expect(takeStopped("/s/a.jsonl")).toEqual({
    reason: "reload",
    runs: [],
    records: [record("one")],
  });
});

test("a run's live-only activity is not carried over", () => {
  leaveStopped(
    "/s/a.jsonl",
    "reload",
    [run("one", { activity: "working" })],
    [],
  );

  expect(takeStopped("/s/a.jsonl")?.runs).toEqual([run("one")]);
});

test("a record missing any one field is dropped", () => {
  const whole = record("one", {
    agent: "scout",
    worktree: { path: "/w", branch: "b", sha: "abc" },
    settledAt: 5,
  });
  // Optional fields may be absent; every other key must be there.
  const required = Object.keys(whole).filter(
    (key) => !["agent", "worktree", "settledAt"].includes(key),
  );
  expect(required.length).toBeGreaterThan(0);
  for (const key of required) {
    const { [key as keyof ChildRecord]: _, ...partial } = whole;
    plant({
      v: 2,
      parentFile: "/s/a.jsonl",
      reason: "reload",
      runs: [],
      records: [partial],
    });
    expect(takeStopped("/s/a.jsonl")?.records, key).toEqual([]);
  }

  leaveStopped("/s/a.jsonl", "reload", [], [whole]);
  expect(takeStopped("/s/a.jsonl")?.records).toEqual([whole]);
});
