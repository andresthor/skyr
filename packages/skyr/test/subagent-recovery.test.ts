// A crashed parent's finished children: the collector sweep and the reaper on session_start.
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import { call, type Parent, parentSession, taskOf, textOf } from "./session.js";

const usage = {
  input: 5,
  output: 7,
  cacheRead: 30,
  cacheWrite: 0,
  totalTokens: 42,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The parent's turns: `calls` first, otherwise done; child-like contexts fall through. */
function turnRouter(calls: ReturnType<typeof call>[]): FauxResponseFactory {
  let turns = 0;
  return (context) => {
    if (taskOf(context) !== "go") return fauxAssistantMessage("noted");
    turns += 1;
    return turns === 1
      ? fauxAssistantMessage(calls)
      : fauxAssistantMessage("done");
  };
}

const parentTurns = (parent: Parent) =>
  parent.requests.filter((r) => taskOf(r) === "go");

/** The session dir's job root, exactly where the subprocess runner leaves a child's job. */
const jobsRootOf = (parent: Parent) => {
  const file = parent.session.sessionFile!;
  return join(dirname(file), basename(file, ".jsonl"), "jobs");
};

function plant(jobsRoot: string, id: string, result: string): string {
  const dir = join(jobsRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), result);
  return dir;
}

test("a crashed parent's finished child is delivered once on the next session start, its job dir removed", async () => {
  const parent = await parentSession({
    respond: turnRouter([call({ task: "pick" })]),
  });
  await parent.session.prompt("go");
  expect(parentTurns(parent)).toHaveLength(2);

  const job = plant(
    jobsRootOf(parent),
    "deadbeef01",
    JSON.stringify({
      v: 1,
      status: "done",
      text: "RECOVERED-ANSWER",
      error: undefined,
      usage,
      sessionFile: undefined,
      description: "answers the old call",
    }),
  );

  await parent.session.reload();
  await vi.waitFor(() => expect(parentTurns(parent)).toHaveLength(3));
  await parent.session.waitForIdle();
  const message = parentTurns(parent)[2]!.messages.at(-1)!;
  expect(textOf(message)).toMatch(
    /\[background subagent "answers the old call" \(id deadbeef\): done, /,
  );
  expect(textOf(message)).toContain(", 42 tok]");
  expect(textOf(message)).toContain("RECOVERED-ANSWER");
  expect(existsSync(job)).toBe(false);

  // Delivered once: a further start reads nothing, so no turn beyond the delivery's.
  await parent.session.reload();
  await parent.session.waitForIdle();
  expect(parentTurns(parent)).toHaveLength(3);
});

test("a malformed job is reaped only when it has aged out; a fresh one stays for its live child", async () => {
  const parent = await parentSession({
    respond: turnRouter([call({ task: "pick" })]),
  });
  await parent.session.prompt("go");
  const jobsRoot = jobsRootOf(parent);
  const stale = plant(jobsRoot, "cafef00d01", "{not the protocol");
  const fresh = plant(jobsRoot, "2111accd1", "{not the protocol");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(stale, old, old);

  await parent.session.reload();
  await parent.session.waitForIdle();

  expect(parentTurns(parent)).toHaveLength(2);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});
