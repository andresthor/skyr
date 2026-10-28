import { expect, test } from "vitest";
import type { ShellSnapshot } from "../src/shells/store.js";
import { barRow, listingLines } from "../src/shells/view.js";

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
const stopped = job("eeee0005", {
  status: "aborted",
  stopReason: "user",
  endedAt: 7_000,
});
const lost = job("ffff0006", { status: "unknown", endedAt: 9_000 });

test("a running job is a running, background bar row with its title", () => {
  expect(barRow(running)).toEqual({
    id: "aaaa0001",
    mark: "running",
    label: "npm run dev",
    background: true,
    startedAt: 1_000,
  });
});

test("a job that exited non-zero is a failed row with its exit code, and one with no code says failed", () => {
  const failed = job("dddd0004", {
    status: "failed",
    exitCode: 2,
    endedAt: 5_000,
  });
  expect(barRow(failed)).toMatchObject({ mark: "failed", why: "exit 2" });
  expect(barRow({ ...failed, exitCode: undefined }).why).toBe("failed");
  expect(barRow(done).mark).toBe("running");
  expect(barRow(running).why).toBeUndefined();
});

test("a lingering job's row says lingering", () => {
  expect(barRow(lingering)).toMatchObject({
    label: "make watch",
    now: "lingering",
  });
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
    stopped,
    'eeee0005 "npm run dev" · stopped after 7.0s · /jobs/eeee0005/out.log',
  ],
  [
    lost,
    'ffff0006 "npm run dev" · ended after 9.0s, exit status lost · /jobs/ffff0006/out.log',
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

test("a job past a quarter of an hour reads 18m58s, running or ended, never 1138s", () => {
  expect(listingLines([running], 1_139_900)[0]).toContain("running for 18m58s");
  const over = job("cccc0003", {
    status: "done",
    exitCode: 0,
    endedAt: 1_138_000,
  });
  expect(listingLines([over], 2_000_000)[0]).toContain("exited 0 after 18m58s");
});

test("a terminal sequence or newline in a command, id or log path never reaches a line or a bar row", () => {
  const hostile = job("aaaa\u001b]52;c;aGk=\u00070001", {
    command: "echo \u001b]52;c;aGk=\u0007hi\nsecond",
    log: "/jobs/\u001b[31mx/out.log",
  });
  const row = barRow(hostile);
  for (const line of [row.id, row.label, ...listingLines([hostile], 0)]) {
    expect(line).not.toContain("\n");
    expect(line.includes("\u001b")).toBe(false);
  }
});
