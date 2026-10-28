import { expect, onTestFinished, test, vi } from "vitest";
import { failureLine } from "../src/chrome/bar-view.js";
import type { RunSnapshot } from "../src/subagent/store.js";
import {
  barRow,
  headRecord,
  laneRecord,
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
    '• running scout "look around" · 1 turn · 1 tool · grep · stalled · 3s · abcdef01',
  );
  expect(line("working")).toBe(
    '• running scout "look around" · 1 turn · 1 tool · grep · 3s · abcdef01',
  );
});

test("a stalled run's bar row says stalled, and only while its activity is unknown", () => {
  const now = (activity: RunSnapshot["activity"]) =>
    barRow({ ...running, activity }).now;
  expect(now("unknown")).toBe("stalled");
  expect(now("working")).toBe("grep");
});

test("a run that ended in failure or without an answer is a failed row with its reason; a stopped one is not", () => {
  const ended = (fields: Partial<RunSnapshot>) =>
    barRow({ ...running, endedAt: 4_000, ...fields });
  expect(ended({ status: "failed", error: "429 rate limited" })).toMatchObject({
    mark: "failed",
    why: "429 rate limited",
  });
  expect(
    ended({ status: "done", error: "ended without an answer" }),
  ).toMatchObject({
    mark: "failed",
  });
  expect(ended({ status: "aborted", error: "stopped by the user" }).mark).toBe(
    "running",
  );
  expect(ended({ status: "done" }).why).toBeUndefined();
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

test("a run past a quarter of an hour reads 18m58s in the listing and a lane record, never 1138s", () => {
  const ended = {
    ...running,
    status: "done" as const,
    startedAt: 1_000,
    endedAt: 1_139_000,
  };
  expect(listingLines([running], 1_138_900)?.[0]).toContain(" · 18m58s · ");
  expect(laneRecord(ended).facts.map((f) => f.text)).toContain("18m58s");
});

test("a lane record carries its label, reason, counters, tokens, time and id, in the order they drop", () => {
  const record = laneRecord({
    ...running,
    status: "failed",
    error: "boom",
    startedAt: 1_000,
    endedAt: 4_000,
    turns: 2,
    toolCalls: 3,
    tokens: 31_000,
  });
  expect(record).toMatchObject({
    mark: "failed",
    subject: ['scout "look around"'],
    handle: "abcdef01",
  });
  expect(record.facts).toEqual([
    { text: "boom", kind: "explain" },
    { text: "2 turns", kind: "measure" },
    { text: "3 tools", kind: "measure" },
    { text: "31k tok", kind: "measure" },
    { text: "3.0s", kind: "measure" },
  ]);
});

test("a recovered lane says so instead of counters and time, and a hostile label arrives inert", () => {
  const record = laneRecord({
    ...running,
    status: "done",
    recovered: true,
    description: "x\u001b]52;c;aGk=\u0007\nsecond",
    endedAt: 9_000,
  });
  expect(record.subject).toEqual(['scout "x second"']);
  expect(record.facts.map((f) => f.text)).toEqual([
    "recovered after a restart",
    "0 tok",
  ]);
});

test("a lane stopped by the user is stopped, an empty answer is a failure", () => {
  const mark = (over: Partial<RunSnapshot>) =>
    laneRecord({ ...running, ...over }).mark;
  expect(mark({ status: "done" })).toBe("done");
  expect(mark({ status: "done", error: "ended without an answer" })).toBe(
    "failed",
  );
  expect(mark({ status: "aborted", error: "stopped by the user" })).toBe(
    "stopped",
  );
  expect(mark({ status: "failed", error: "x" })).toBe("failed");
});

test("a head record is the lanes' shared mark, or mixed for a mix, and leaves out the wall of a recovered call", () => {
  const done = {
    ...running,
    status: "done" as const,
    startedAt: 1_000,
    endedAt: 3_000,
  };
  expect(headRecord([done, done]).mark).toBe("done");
  expect(headRecord([done, { ...done, status: "aborted" }]).mark).toBe("mixed");
  expect(headRecord([done, done]).facts.map((f) => f.kind)).toEqual([
    "extra",
    "explain",
    "measure",
    "measure",
  ]);
  expect(
    headRecord([done, { ...done, recovered: true }]).facts.map((f) => f.kind),
  ).toEqual(["extra", "explain", "measure"]);
});

test("under TERM=dumb the listing and a failure notice use the tier's glyphs and separator", () => {
  vi.stubEnv("TERM", "dumb");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const queued = { ...running, status: "queued" as const };
  const lines = [
    ...(listingLines([queued, { ...running, background: true }], 3_000) ?? []),
    failureLine({
      id: "abcdef0123",
      mark: "failed",
      label: "scout",
      background: false,
      startedAt: 0,
      why: "exit 1",
    }),
  ];
  expect(lines[0]).toMatch(/^o queued scout "look around" - /);
  expect(lines[1]).toMatch(/^\* running & scout "look around" - /);
  expect(lines[2]).toBe("x scout - exit 1 - abcdef01");
  expect(lines[2]).toMatch(/^[\x20-\x7e]*$/);
});
