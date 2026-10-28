import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, onTestFinished, test, vi } from "vitest";
import { isShellSnapshot, type ShellSnapshot } from "../src/shells/store.js";
import { barRow, listingLines, shellRow } from "../src/shells/view.js";
import { drawRecord } from "../src/ui/record.js";
import { testTheme } from "./voice.js";

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

/** The record as drawn wide, split where it is spaced out into columns. */
const cells = (row: ReturnType<typeof shellRow>) =>
  stripTerminalSequences(
    drawRecord({ theme: testTheme(), mode: "color" }, row.head, 200, 0),
  )
    .trim()
    .split(/ {2,}/);

const message = (job: ShellSnapshot) =>
  cells(shellRow(job, { verb: "bash", expanded: false }));

test("a job that exited 0 is a done, background record with delivery, exit, time and id", () => {
  expect(message({ ...done, startedAt: 1_000, endedAt: 41_000 })).toEqual([
    "✓ bash &",
    "npm run dev",
    "← delivered · exit 0 · 40s",
    "cccc0003",
  ]);
});

test("a job that exited non-zero is failed with its exit code explained, and a lost status is a warning", () => {
  expect(
    message(job("dddd0004", { status: "failed", exitCode: 2, endedAt: 5_000 })),
  ).toEqual([
    "× bash &",
    "npm run dev",
    "← delivered · exit 2 · 5.0s",
    "dddd0004",
  ]);
  expect(message(lost)).toEqual([
    "! bash &",
    "npm run dev",
    "← delivered · exit status lost · 9.0s",
    "ffff0006",
  ]);
});

test("a stopped job says who stopped it", () => {
  const reason = (stopReason: ShellSnapshot["stopReason"]) =>
    message({ ...stopped, stopReason })[2];
  expect(reason("user")).toContain("stopped by you");
  expect(reason("agent")).toContain("stopped by the agent");
  expect(reason("session")).toContain("stopped by the session ending");
  expect(reason("pi")).toContain("stopped by Pi ending");
  expect(message(stopped)[0]).toBe("■ bash &");
});

test("a lingering job and a job still running when the model forgot are their own states", () => {
  expect(message(lingering)).toEqual([
    "! bash &",
    "make watch",
    "← delivered · lingering · exit 0",
    "bbbb0002",
  ]);
  expect(message(running)).toEqual([
    "• bash &",
    "npm run dev",
    "still running",
    "aaaa0001",
  ]);
});

test("a stop of an ended job puts no middle dot in the ASCII tier", () => {
  vi.stubEnv("TERM", "dumb");
  const row = shellRow(
    { ...done, startedAt: 1_000, endedAt: 41_000 },
    { verb: "stop", expanded: false },
  );
  const drawn = stripTerminalSequences(
    drawRecord({ theme: testTheme(), mode: "ascii" }, row.head, 200, 0),
  );
  vi.unstubAllEnvs();
  expect(drawn).toContain("already ended - exit 0 - 40s");
  expect(drawn).not.toContain("\u00b7");
});

test("a stop is a stop record, and one of a job that had already ended says so", () => {
  const stop = (j: ShellSnapshot) =>
    cells(shellRow(j, { verb: "stop", expanded: false }));
  expect(
    stop({ ...stopped, stopReason: "agent", startedAt: 0, endedAt: 300 }),
  ).toEqual(["■ stop", "npm run dev", "stopped · 0.3s", "eeee0005"]);
  expect(stop({ ...done, startedAt: 1_000, endedAt: 41_000 })).toEqual([
    "✓ stop",
    "npm run dev",
    "already ended · exit 0 · 40s",
    "cccc0003",
  ]);
});

test("expanded, a record names the job's log and its first line does not change", () => {
  const collapsed = shellRow(done, { verb: "bash", expanded: false });
  const expanded = shellRow(done, { verb: "bash", expanded: true });
  expect(expanded.head).toEqual(collapsed.head);
  expect(collapsed.rail).toBeUndefined();
  expect(expanded.rail?.lines).toEqual(["log /jobs/cccc0003/out.log"]);
});

test("no shell record draws a slot number", () => {
  for (const j of [running, lingering, done, stopped, lost])
    for (const verb of ["bash", "stop"] as const)
      expect(
        cells(shellRow(j, { verb, expanded: true })).join(" "),
      ).not.toMatch(/\$\d/);
});

test("a hostile title and log are inert", () => {
  const hostile = job("abcd1234", {
    command: "echo \u001b]52;c;aGk=\u0007\u202e hi",
    log: "/jobs/\u001b[2J/out.log",
    status: "done",
    exitCode: 0,
    endedAt: 1,
  });
  const row = shellRow(hostile, { verb: "bash", expanded: true });
  expect(row.head.subject.join("")).not.toMatch(/\p{Cc}|\u202e|52;c/u);
  expect(row.rail?.lines.join("")).not.toContain("\u001b");
});

test("only a snapshot with every field a record reads is one", () => {
  expect(isShellSnapshot(done)).toBe(true);
  for (const bad of [
    undefined,
    null,
    "x",
    {},
    { ...done, status: "weird" },
    { ...done, startedAt: "0" },
    { ...done, id: 1 },
    { ...done, exitCode: "0" },
    { ...done, stopReason: "weird" },
  ])
    expect(isShellSnapshot(bad)).toBe(false);
});

test("under TERM=dumb the listing separates its facts with the tier's separator and draws no non-ASCII", () => {
  vi.stubEnv("TERM", "dumb");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const [line] = listingLines([running], 13_000);
  expect(line).toBe(
    'aaaa0001 "npm run dev" - running for 12s - /jobs/aaaa0001/out.log',
  );
  expect(line).toMatch(/^[\x20-\x7e]*$/);
});
