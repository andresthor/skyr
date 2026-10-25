import { expect, test } from "vitest";
import type { ShellSnapshot } from "../src/shells/store.js";
import { listingLines, widgetLines } from "../src/shells/view.js";

const job = (id: string, fields: Partial<ShellSnapshot>): ShellSnapshot => ({
  id,
  command: "npm run dev",
  cwd: "/repo",
  log: `/jobs/${id}/out.log`,
  startedAt: 0,
  status: "running",
  ...fields,
});

const running = job("aaaa0001", { startedAt: 1_000 });
const lingering = job("bbbb0002", {
  command: "cd /repo && make watch",
  status: "done",
  lingering: true,
  exitCode: 0,
});
const done = job("cccc0003", { status: "done", exitCode: 0, endedAt: 41_000 });
const failed = job("dddd0004", {
  status: "failed",
  exitCode: 2,
  endedAt: 5_000,
});
const stopped = job("eeee0005", {
  status: "aborted",
  stopReason: "user",
  endedAt: 7_000,
});
const lost = job("ffff0006", { status: "unknown", endedAt: 9_000 });

test("the widget has one line per running or lingering job, and none once all have ended", () => {
  expect(widgetLines([running, lingering, done, failed], 13_000)).toEqual([
    "$ npm run dev · 12s · aaaa0001",
    "$ make watch · 13s · bbbb0002 · lingering",
  ]);
  expect(widgetLines([done, failed], 13_000)).toBeUndefined();
  expect(widgetLines([], 0)).toBeUndefined();
});

test("a time reads in hours and minutes once it is long, never as a raw count of seconds", () => {
  expect(widgetLines([running], 4 * 3_600_000 + 1_000)).toEqual([
    "$ npm run dev · 4h00m · aaaa0001",
  ]);
});

test.each([
  [
    running,
    'aaaa0001 "npm run dev" · running for 12s · /jobs/aaaa0001/out.log',
  ],
  [
    lingering,
    'bbbb0002 "make watch" · running for 13s, lingering · /jobs/bbbb0002/out.log',
  ],
  [
    done,
    'cccc0003 "npm run dev" · exited 0 after 41s · /jobs/cccc0003/out.log',
  ],
  [
    failed,
    'dddd0004 "npm run dev" · exited 2 after 5s · /jobs/dddd0004/out.log',
  ],
  [
    stopped,
    'eeee0005 "npm run dev" · stopped after 7s · /jobs/eeee0005/out.log',
  ],
  [
    lost,
    'ffff0006 "npm run dev" · ended after 9s, exit status lost · /jobs/ffff0006/out.log',
  ],
])("the listing reads a job as one line: %#", (shown, line) => {
  expect(listingLines([shown], 13_000)).toEqual([line]);
});

test("the listing puts running and lingering jobs before ended ones, and says when there are none", () => {
  expect(
    listingLines([done, running, stopped, lingering], 13_000).map((l) =>
      l.slice(0, 8),
    ),
  ).toEqual(["aaaa0001", "bbbb0002", "cccc0003", "eeee0005"]);
  expect(listingLines([], 0)).toEqual(["No background jobs in this session."]);
});

test("a terminal sequence or newline in a command or log path never reaches a line", () => {
  const hostile = job("aaaa0001", {
    command: "echo \u001b]52;c;aGk=\u0007hi\nsecond",
    log: "/jobs/\u001b[31mx/out.log",
  });
  for (const line of [
    ...(widgetLines([hostile], 0) ?? []),
    ...listingLines([hostile], 0),
  ]) {
    expect(line).not.toContain("\n");
    expect(line.includes("\u001b")).toBe(false);
  }
});
