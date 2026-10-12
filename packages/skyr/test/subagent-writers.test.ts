// One writer per directory: a child whose tools include edit or write.
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import type { RunSnapshot } from "../src/subagent/store.js";
import {
  agentFile,
  call,
  hold,
  parentSession,
  results,
  router,
  scratchDir,
  sections,
  taskOf,
  textOf,
} from "./session.js";

/** The latest `details` Pi received for each call, by task. */
function updatesOf(
  session: Awaited<ReturnType<typeof parentSession>>["session"],
) {
  const latest = new Map<string, RunSnapshot>();
  session.subscribe((event) => {
    if (event.type === "tool_execution_update")
      latest.set(event.toolCallId, event.partialResult.details as RunSnapshot);
  });
  return latest;
}

const queued = (latest: Map<string, RunSnapshot>, task: string) => () =>
  expect(latest.get(task)?.status).toBe("queued");

test("writers in one cwd run one at a time in call order, from an agent file's tools or the tools param, and the status counts queued children", async () => {
  const holds = new Map(["w1", "w2", "w3"].map((task) => [task, hold()]));
  const released = new Set<string>();
  const parent = await parentSession({
    respond: router(
      [
        call({ task: "w1", agent: "editor" }),
        call({ task: "w2", tools: ["read", "edit"] }),
        call({ task: "w3", tools: ["write"] }),
      ],
      (context, ...rest) => {
        const task = taskOf(context);
        if (task === "w2" && !released.has("w1"))
          throw new Error("w2 started before w1 released");
        if (task === "w3" && !released.has("w2"))
          throw new Error("w3 started before w2 released");
        return holds.get(task)!.step(context, ...rest);
      },
    ),
    userAgents: { "editor.md": agentFile("Edits", "tools: Read, Edit\n") },
  });
  const latest = updatesOf(parent.session);

  const run = parent.session.prompt("go");
  await holds.get("w1")!.entered;
  await vi.waitFor(queued(latest, "w3"));
  expect(latest.get("w3")?.behind).toBe('"run w2"');
  expect(
    parent.widgets.some(
      (w) =>
        w?.length === 3 && w.filter((l) => l.includes("queued")).length === 2,
    ),
  ).toBe(true);

  released.add("w1");
  holds.get("w1")!.release();
  await holds.get("w2")!.entered;
  released.add("w2");
  holds.get("w2")!.release();
  await holds.get("w3")!.entered;
  holds.get("w3")!.release();
  await run;

  const order = parent.requests.map(taskOf).filter((t) => t.startsWith("w"));
  expect(order).toEqual(["w1", "w2", "w3"]);
  for (const task of holds.keys())
    expect(results(parent.session).get(task)?.isError).toBe(false);
  expect(parent.widgets.at(-1)).toBeUndefined();
});

test("a writer and a reader in the same cwd run concurrently, and bash does not make a writer", async () => {
  const holds = new Map(["w", "r", "b"].map((task) => [task, hold()]));
  const parent = await parentSession({
    respond: router(
      [
        call({ task: "w", tools: ["edit"] }),
        call({ task: "r" }),
        call({ task: "b", tools: ["read", "bash"] }),
      ],
      (context, ...rest) => holds.get(taskOf(context))!.step(context, ...rest),
    ),
  });

  const run = parent.session.prompt("go");
  await Promise.all([...holds.values()].map((h) => h.entered));
  expect(parent.widgets.at(-1)).toHaveLength(3);
  expect(parent.widgets.at(-1)?.some((l) => l.includes("queued"))).toBe(false);
  for (const h of holds.values()) h.release();
  await run;
  for (const task of holds.keys())
    expect(results(parent.session).get(task)?.isError).toBe(false);
});

test("writers in different cwds run concurrently, and a second spelling of the same directory queues", async () => {
  const B = scratchDir("cwd-b");
  const link = join(scratchDir("cwd-link"), "b");
  symlinkSync(B, link);
  const holds = new Map(["wa", "wb", "wb2"].map((task) => [task, hold()]));
  let releasedB = false;
  const seen = new Map<string, Record<string, string | null>>();
  const parent = await parentSession({
    respond: router(
      [
        call({ task: "wa", tools: ["edit"] }),
        call({ task: "wb", tools: ["edit"], cwd: B }),
        call({ task: "wb2", tools: ["edit"], cwd: link }),
      ],
      (context: TranscriptContext, ...rest) => {
        const task = taskOf(context);
        if (task === "wb2" && !releasedB)
          throw new Error("wb2 started before wb released");
        seen.set(task, sections(context));
        return holds.get(task)!.step(context, ...rest);
      },
    ),
  });

  const run = parent.session.prompt("go");
  await Promise.all([holds.get("wa")!.entered, holds.get("wb")!.entered]);
  holds.get("wa")!.release();
  releasedB = true;
  holds.get("wb")!.release();
  await holds.get("wb2")!.entered;
  holds.get("wb2")!.release();
  await run;

  expect(seen.get("wa")?.cwd).toBe(`<cwd>\n${parent.cwd}\n</cwd>`);
  expect(seen.get("wb")?.cwd).toBe(`<cwd>\n${B}\n</cwd>`);
  expect(seen.get("wb2")?.cwd).toBe(`<cwd>\n${link}\n</cwd>`);
  for (const task of holds.keys())
    expect(results(parent.session).get(task)?.isError).toBe(false);
});

test("a writer in a subdirectory queues behind a writer in the directory above it", async () => {
  const holds = new Map(["root", "sub"].map((task) => [task, hold()]));
  let releasedRoot = false;
  const parent = await parentSession({
    respond: router(
      [
        call({ task: "root", tools: ["edit"] }),
        call({ task: "sub", tools: ["edit"], cwd: "sub" }),
      ],
      (context, ...rest) => {
        if (taskOf(context) === "sub" && !releasedRoot)
          throw new Error("sub started before root released");
        return holds.get(taskOf(context))!.step(context, ...rest);
      },
    ),
  });
  mkdirSync(join(parent.cwd, "sub"));

  const run = parent.session.prompt("go");
  await holds.get("root")!.entered;
  await vi.waitFor(() =>
    expect(parent.widgets.at(-1)?.some((l) => l.startsWith("○ queued"))).toBe(
      true,
    ),
  );
  releasedRoot = true;
  holds.get("root")!.release();
  await holds.get("sub")!.entered;
  holds.get("sub")!.release();
  await run;

  for (const task of holds.keys())
    expect(results(parent.session).get(task)?.isError).toBe(false);
});

test("a failed first writer still lets the second start", async () => {
  const h2 = hold();
  const parent = await parentSession({
    respond: router(
      [
        call({ task: "w1", tools: ["edit"] }),
        call({ task: "w2", tools: ["edit"] }),
      ],
      (context, ...rest) =>
        taskOf(context) === "w1"
          ? fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: "provider exploded",
            })
          : h2.step(context, ...rest),
    ),
  });

  const run = parent.session.prompt("go");
  await h2.entered;
  h2.release();
  await run;

  const byTask = results(parent.session);
  expect(byTask.get("w1")?.isError).toBe(true);
  expect(textOf(byTask.get("w1")!)).toBe(
    'subagent: "run w1" failed: provider exploded',
  );
  expect(byTask.get("w2")?.isError).toBe(false);
});

test("a queued writer aborted by Esc sends no request, reports aborted having spent nothing, and the count returns to 0 within a second", async () => {
  const h1 = hold();
  const parent = await parentSession({
    respond: router(
      [
        call({ task: "w1", tools: ["edit"] }),
        call({ task: "w2", tools: ["edit"] }),
      ],
      (context, ...rest) => {
        if (taskOf(context) === "w2") throw new Error("w2 started");
        return h1.step(context, ...rest);
      },
    ),
  });
  const latest = updatesOf(parent.session);

  const run = parent.session.prompt("go");
  await h1.entered;
  await vi.waitFor(queued(latest, "w2"));
  expect(parent.widgets.at(-1)).toHaveLength(2);
  expect(
    parent.widgets.at(-1)?.filter((l) => l.includes("queued")),
  ).toHaveLength(1);

  const started = Date.now();
  await parent.session.abort();
  await run;
  expect(Date.now() - started).toBeLessThan(1000);

  const w2 = results(parent.session).get("w2");
  expect(w2?.isError).toBe(true);
  expect(textOf(w2!)).toBe('subagent: "run w2" was stopped before it started');
  expect(w2?.details).toMatchObject({ status: "aborted", turns: 0, tokens: 0 });
  expect(w2?.details).not.toHaveProperty("sessionFile");
  expect(parent.requests.some((r) => taskOf(r) === "w2")).toBe(false);
  expect(parent.widgets.at(-1)).toBeUndefined();
});

test("session_shutdown aborts queued children", async () => {
  const h1 = hold();
  const parent = await parentSession({
    respond: router(
      [
        call({ task: "w1", tools: ["edit"] }),
        call({ task: "w2", tools: ["edit"] }),
      ],
      (context, ...rest) => {
        if (taskOf(context) === "w2") throw new Error("w2 started");
        return h1.step(context, ...rest);
      },
    ),
  });
  const latest = updatesOf(parent.session);

  const run = parent.session.prompt("go");
  await h1.entered;
  await vi.waitFor(queued(latest, "w2"));
  // The only emitter of session_shutdown reachable from a test.
  await parent.session.reload();
  await run;

  const byTask = results(parent.session);
  expect(byTask.get("w1")?.isError).toBe(true);
  expect(textOf(byTask.get("w2")!)).toBe(
    'subagent: "run w2" was stopped before it started',
  );
  expect(parent.requests.some((r) => taskOf(r) === "w2")).toBe(false);
  expect(parent.widgets.at(-1)).toBeUndefined();
});
