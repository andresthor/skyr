import { expect, test } from "vitest";
import {
  createShellStore,
  duration,
  type ShellSnapshot,
  taskItems,
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

test("the store replaces what it holds on a put and never mutates it, nor the caller's object", () => {
  const store = createShellStore();
  const mine = { ...running };
  store.put(mine);
  const handedOut = store.jobs()[0];
  mine.status = "failed";
  expect(store.jobs()[0]?.status).toBe("running");
  store.put({ ...running, status: "done", exitCode: 0, endedAt: 2_000 });
  expect(handedOut).toEqual(running);
  expect(store.jobs()[0]).toMatchObject({ status: "done", exitCode: 0 });
});

test("jobs() lists jobs in the order they started, not the order they were put", () => {
  const store = createShellStore();
  store.put(job("00000002", { startedAt: 2_000 }));
  store.put(job("00000001", { startedAt: 1_000 }));
  expect(store.jobs().map((j) => j.id)).toEqual(["00000001", "00000002"]);
});

test("the task list holds the active jobs only, as running, with lingering said", () => {
  const items = taskItems([
    running,
    job("00000002", { status: "done", lingering: true }),
    job("00000003", { status: "done" }),
  ]);
  expect(items.map((t) => [t.id, t.status, t.detail])).toEqual([
    ["ab12cd34", "running", undefined],
    ["00000002", "running", "lingering"],
  ]);
  expect(items[0]).toMatchObject({ title: "npm run dev", startedAt: 1_000 });
});

test.each([
  [41_400, "41s"],
  [60_000, "1m00s"],
  [725_000, "12m05s"],
  [14_400_000, "4h00m"],
  [-1_500, "0s"],
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

test("a title is clipped", () => {
  expect(titleOf("x".repeat(200)).length).toBeLessThanOrEqual(61);
});
