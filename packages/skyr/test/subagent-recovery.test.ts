// A crashed parent's finished children: the collector sweep and the reaper on session_start.
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { call, type Parent, parentSession, taskOf, textOf } from "./session.js";
import { messageHost } from "./ui.js";

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
    respond: turnRouter([call({ prompt: "pick" })]),
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
    /^Background subagent answers\. .*\n\n<subagent-answer recovered="after a restart" description="answers the old call" status="done" tokens="42 tok" id="deadbeef">\nRECOVERED-ANSWER\n<\/subagent-answer>$/,
  );
  expect(existsSync(job)).toBe(false);

  // Delivered once: a further start reads nothing, so no turn beyond the delivery's.
  await parent.session.reload();
  await parent.session.waitForIdle();
  expect(parentTurns(parent)).toHaveLength(3);
});

/** Plants one finished job, reloads, and returns the text of the message that delivered it. */
async function recover(parent: Parent, fields: object): Promise<string> {
  plant(
    jobsRootOf(parent),
    "deadbeef01",
    JSON.stringify({
      v: 1,
      status: "done",
      text: "RECOVERED-ANSWER",
      usage,
      description: "answers the old call",
      ...fields,
    }),
  );
  await parent.session.reload();
  await vi.waitFor(() => expect(parentTurns(parent)).toHaveLength(3));
  await parent.session.waitForIdle();
  return textOf(parentTurns(parent)[2]!.messages.at(-1)!);
}

test("a recovered job whose agent is not a string is still delivered", async () => {
  const parent = await parentSession({
    respond: turnRouter([call({ prompt: "pick" })]),
  });
  await parent.session.prompt("go");

  expect(await recover(parent, { agent: 42 })).toMatch(
    /\n<subagent-answer recovered="after a restart" description="answers the old call" [^\n]*>\nRECOVERED-ANSWER\n/,
  );
});

test("a recovered worktree child's answer is followed by its worktree", async () => {
  const parent = await parentSession({
    respond: turnRouter([call({ prompt: "pick" })]),
  });
  await parent.session.prompt("go");
  const worktree = join(dirname(jobsRootOf(parent)), "worktrees", "deadbeef");
  mkdirSync(worktree, { recursive: true });

  expect(await recover(parent, {})).toMatch(
    new RegExp(
      `\\nRECOVERED-ANSWER\\n</subagent-answer>\\nRan in worktree ${worktree} — its writes are uncommitted there; nothing deletes it$`,
    ),
  );
});

test("a recovered run's delivered line says it was recovered, with no time, and names a failure's cause", async () => {
  const parent = await parentSession({
    respond: turnRouter([call({ prompt: "pick" })]),
  });
  await parent.session.prompt("go");
  const stored = { v: 1, usage, sessionFile: undefined };
  plant(
    jobsRootOf(parent),
    "deadbeef01",
    JSON.stringify({
      ...stored,
      status: "done",
      text: "RECOVERED-ANSWER",
      agent: "scout",
      description: "answers the old call",
    }),
  );
  plant(
    jobsRootOf(parent),
    "cafebabe01",
    JSON.stringify({
      ...stored,
      status: "failed",
      error: "disk full",
      description: "fails the old call",
    }),
  );

  await parent.session.reload();
  await vi.waitFor(() => expect(parentTurns(parent)).toHaveLength(3));
  await parent.session.waitForIdle();
  const message = parent.session.messages.find(
    (m) => m.role === "custom" && m.customType === "skyr.subagent",
  );
  if (message?.role !== "custom") throw new Error("nothing was delivered");
  const renderer =
    parent.session.extensionRunner.getMessageRenderer("skyr.subagent");
  if (!renderer) throw new Error("no renderer for delivered answers");
  const lines = messageHost(renderer, message, { outputPad: 0 })
    .lines(200)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .filter((line) => line.startsWith("✓") || line.startsWith("×"));
  // The sweep delivers runs in directory order
  expect(lines.sort()).toEqual([
    expect.stringMatching(
      /^× agent & +"fails the old call" +← delivered · disk full · recovered after a restart · 42 tok +cafebabe$/,
    ),
    expect.stringMatching(
      /^✓ agent & +scout "answers the old call" +← delivered · recovered after a restart · 42 tok +deadbeef$/,
    ),
  ]);
  // The sweep knows the run's usage from its stored result; the delivery must carry it too.
  const runs = message.details as Array<{ usage: typeof usage }>;
  expect(runs.map((r) => r.usage)).toEqual([usage, usage]);
});

test("a malformed job is reaped only when it has aged out; a fresh one stays for its live child", async () => {
  const parent = await parentSession({
    respond: turnRouter([call({ prompt: "pick" })]),
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
