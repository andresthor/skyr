import { expect, test } from "vitest";
import {
  active,
  createShellStore,
  duration,
  type ShellSnapshot,
  titleOf,
} from "../src/shells/store.js";

const running: ShellSnapshot = {
  id: "ab12cd34",
  command: "npm run dev",
  cwd: "/repo",
  log: "/jobs/ab12cd34/out.log",
  startedAt: 1_000,
  status: "running",
};

const job = (id: string, fields: Partial<ShellSnapshot>): ShellSnapshot => ({
  ...running,
  id,
  ...fields,
});

test("a snapshot or list handed out by jobs() is unchanged by a later put for the same id", () => {
  const store = createShellStore();
  store.put(running);
  const before = store.jobs();
  const first = before[0];
  store.put({ ...running, status: "done", exitCode: 0, endedAt: 2_000 });
  expect(before).toHaveLength(1);
  expect(first).toEqual(running);
  expect(store.jobs()[0]).toMatchObject({ status: "done", exitCode: 0 });
});

test("a snapshot held by the store does not change when the caller mutates the one it put", () => {
  const store = createShellStore();
  const mine = { ...running };
  store.put(mine);
  mine.status = "failed";
  expect(store.jobs()[0]?.status).toBe("running");
});

test("jobs() lists jobs in the order they started, not the order they were put", () => {
  const store = createShellStore();
  store.put(job("00000002", { startedAt: 2_000 }));
  store.put(job("00000001", { startedAt: 1_000 }));
  expect(store.jobs().map((j) => j.id)).toEqual(["00000001", "00000002"]);
});

test("a job is active while it runs or lingers, and not once it has ended", () => {
  expect(active(running)).toBe(true);
  expect(active({ ...running, status: "done", lingering: true })).toBe(true);
  expect(active({ ...running, status: "done" })).toBe(false);
  expect(active({ ...running, status: "aborted" })).toBe(false);
});

test.each([
  [0, "0s"],
  [41_400, "41s"],
  [60_000, "1m00s"],
  [725_000, "12m05s"],
  [14_400_000, "4h00m"],
  [-5, "0s"],
])("a span of %i ms reads %s", (ms, text) => {
  expect(duration(ms)).toBe(text);
});

test.each([
  ["npm test", "npm test"],
  ["cd /repo && npm test", "npm test"],
  ['cd "my repo" && cd sub && make -j4', "make -j4"],
  ["\n\n  sleep 5  \nsecond line", "sleep 5"],
  ["cd /repo &&", "cd /repo &&"],
])("the title of %j is %j", (command, title) => {
  expect(titleOf(command)).toBe(title);
});

test("a title is one clipped line with no terminal sequence in it", () => {
  const title = titleOf(`echo \u001b]52;c;aGk=\u0007${"x".repeat(200)}`);
  expect(title).not.toContain("\u001b");
  expect(title).not.toContain("\n");
  expect(title.length).toBeLessThanOrEqual(61);
});
