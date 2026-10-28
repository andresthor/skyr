// One writer per directory: a child whose tools include edit or write.
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import {
  agentFile,
  call,
  hold,
  lanes,
  listing,
  parentSession,
  results,
  router,
  scratchDir,
  sections,
  taskOf,
  textOf,
} from "./session.js";

/** Passes once the listing shows `task`'s ad-hoc child queued, with what follows. */
const queued =
  (
    parent: Awaited<ReturnType<typeof parentSession>>,
    task: string,
    rest = "",
  ) =>
  async () =>
    expect(
      (await listing(parent)).some((l) =>
        l.startsWith(`○ queued "run ${task}"${rest}`),
      ),
    ).toBe(true);

test("writers in one cwd run one at a time in call order, from an agent file's tools or the tools param, and the status counts queued children", async () => {
  const holds = new Map(["w1", "w2", "w3"].map((task) => [task, hold()]));
  const released = new Set<string>();
  const parent = await parentSession({
    respond: router(
      [
        call({ prompt: "w1", agent: "editor" }),
        call({ prompt: "w2", tools: ["read", "edit"] }),
        call({ prompt: "w3", tools: ["write"] }),
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

  const run = parent.session.prompt("go");
  await holds.get("w1")!.entered;
  await vi.waitFor(queued(parent, "w3", ' · behind "run w2" · '));
  const waiting = await listing(parent);
  expect(waiting).toHaveLength(3);
  expect(waiting.filter((l) => l.includes("queued"))).toHaveLength(2);

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
  expect(await listing(parent)).toEqual([]);
});

test("a writer and a reader in the same cwd run concurrently, and bash does not make a writer", async () => {
  const holds = new Map(["w", "r", "b"].map((task) => [task, hold()]));
  const parent = await parentSession({
    respond: router(
      [
        call({ prompt: "w", tools: ["edit"] }),
        call({ prompt: "r" }),
        call({ prompt: "b", tools: ["read", "bash"] }),
      ],
      (context, ...rest) => holds.get(taskOf(context))!.step(context, ...rest),
    ),
  });

  const run = parent.session.prompt("go");
  await Promise.all([...holds.values()].map((h) => h.entered));
  expect(await listing(parent)).toHaveLength(3);
  expect((await listing(parent)).some((l) => l.includes("queued"))).toBe(false);
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
        call({ prompt: "wa", tools: ["edit"] }),
        call({ prompt: "wb", tools: ["edit"], cwd: B }),
        call({ prompt: "wb2", tools: ["edit"], cwd: link }),
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
        call({ prompt: "root", tools: ["edit"] }),
        call({ prompt: "sub", tools: ["edit"], cwd: "sub" }),
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
  await vi.waitFor(async () =>
    expect((await listing(parent)).some((l) => l.startsWith("○ queued"))).toBe(
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
        call({ prompt: "w1", tools: ["edit"] }),
        call({ prompt: "w2", tools: ["edit"] }),
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
  expect(textOf(byTask.get("w1")!)).toContain(
    'subagent: "run w1" failed: provider exploded',
  );
  expect(textOf(byTask.get("w1")!)).toMatch(/ id="[0-9a-f]{8}">\n/);
  expect(byTask.get("w2")?.isError).toBe(false);
});

test("a queued writer aborted by Esc sends no request, reports aborted having spent nothing, and the count returns to 0 within a second", async () => {
  const h1 = hold();
  const parent = await parentSession({
    respond: router(
      [
        call({ prompt: "w1", tools: ["edit"] }),
        call({ prompt: "w2", tools: ["edit"] }),
      ],
      (context, ...rest) => {
        if (taskOf(context) === "w2") throw new Error("w2 started");
        return h1.step(context, ...rest);
      },
    ),
  });

  const run = parent.session.prompt("go");
  await h1.entered;
  await vi.waitFor(queued(parent, "w2"));
  expect(await listing(parent)).toHaveLength(2);
  expect(
    (await listing(parent)).filter((l) => l.includes("queued")),
  ).toHaveLength(1);

  const started = Date.now();
  await parent.session.abort();
  await run;
  expect(Date.now() - started).toBeLessThan(1000);

  const w2 = results(parent.session).get("w2");
  expect(w2?.isError).toBe(true);
  expect(textOf(w2!)).toContain(
    'subagent: "run w2" was stopped by the user before it started',
  );
  expect(textOf(w2!)).toMatch(/ id="[0-9a-f]{8}">\n/);
  expect(w2?.details).toMatchObject([
    { status: "aborted", turns: 0, tokens: 0 },
  ]);
  expect(w2?.details).not.toHaveProperty([0, "sessionFile"]);
  expect(parent.requests.some((r) => taskOf(r) === "w2")).toBe(false);
  expect(await listing(parent)).toEqual([]);
});

test("a reload aborts queued children, and their result says Pi reloaded", async () => {
  const h1 = hold();
  const parent = await parentSession({
    respond: router(
      [
        call({ prompt: "w1", tools: ["edit"] }),
        call({ prompt: "w2", tools: ["edit"] }),
      ],
      (context, ...rest) => {
        if (taskOf(context) === "w2") throw new Error("w2 started");
        return h1.step(context, ...rest);
      },
    ),
  });

  const run = parent.session.prompt("go");
  await h1.entered;
  await vi.waitFor(queued(parent, "w2"));
  // The only emitter of session_shutdown reachable from a test.
  await parent.session.reload();
  await run;

  const byTask = results(parent.session);
  expect(byTask.get("w1")?.isError).toBe(true);
  expect(textOf(byTask.get("w2")!)).toContain(
    'subagent: "run w2" was stopped because Pi reloaded before it started',
  );
  expect(textOf(byTask.get("w2")!)).toMatch(/ id="[0-9a-f]{8}">\n/);
  expect(parent.requests.some((r) => taskOf(r) === "w2")).toBe(false);
  expect(await listing(parent)).toEqual([]);
});

test("writer lanes in one directory run one at a time: call order, then lane order, across two calls in one message", async () => {
  const order = ["w1", "w2", "w3", "w4"];
  const holds = new Map(order.map((task) => [task, hold()]));
  const released = new Set<string>();
  const writer = (task: string) => ({
    prompt: task,
    tools: ["write"],
    cwd: ".",
  });
  const parent = await parentSession({
    respond: router(
      [
        lanes("A", [writer("w1"), writer("w2")]),
        lanes("B", [writer("w3"), writer("w4")]),
      ],
      (context, ...rest) => {
        const task = taskOf(context);
        const ahead = order.slice(0, order.indexOf(task));
        if (ahead.some((t) => !released.has(t)))
          throw new Error(
            `${task} started before ${ahead.join(", ")} released`,
          );
        return holds.get(task)!.step(context, ...rest);
      },
    ),
  });

  const run = parent.session.prompt("go");
  for (const task of order) {
    await holds.get(task)!.entered;
    released.add(task);
    holds.get(task)!.release();
  }
  await run;

  expect(parent.requests.map(taskOf).filter((t) => t !== "go")).toEqual(order);
  for (const id of ["A", "B"])
    expect(textOf(results(parent.session).get(id)!)).toMatch(
      /^subagent: 2 tasks · 2 done · /,
    );
});

test("two writer lanes of one call in one directory both finish", async () => {
  const parent = await parentSession({
    respond: router(
      [
        lanes("A", [
          { prompt: "w1", tools: ["write"], cwd: "." },
          { prompt: "w2", tools: ["write"], cwd: "." },
        ]),
      ],
      () => fauxAssistantMessage("ok"),
    ),
  });

  await parent.session.prompt("go");

  const result = results(parent.session).get("A")!;
  expect(result.isError).toBe(false);
  expect(textOf(result)).toMatch(/^subagent: 2 tasks · 2 done · /);
});

test("a lane whose model does not resolve releases its writer slot", async () => {
  const parent = await parentSession({
    respond: router(
      [
        lanes("A", [
          { prompt: "w1", tools: ["write"], cwd: ".", model: "nowhere/none" },
          { prompt: "w2", tools: ["write"], cwd: "." },
        ]),
      ],
      (context) => {
        if (taskOf(context) !== "w2") throw new Error("w1 started");
        return fauxAssistantMessage("ok");
      },
    ),
  });

  await parent.session.prompt("go");

  const result = results(parent.session).get("A")!;
  expect(result.isError).toBe(false);
  expect(textOf(result)).toMatch(/^subagent: 2 tasks · 1 done, 1 failed · /);
  expect(result.details).toMatchObject([
    {
      status: "failed",
      error: expect.stringMatching(/^model "nowhere\/none"/),
    },
    { status: "done" },
  ]);
});

/** The parent answers each prompt with its calls, by the prompt's text, and anything else with "done". */
function byPrompt(
  calls: Record<string, ReturnType<typeof call>[]>,
  child: FauxResponseFactory,
): FauxResponseFactory {
  return (context, ...rest) => {
    if (taskOf(context) !== "go") return child(context, ...rest);
    const last = context.messages.at(-1);
    const own = last?.role === "user" ? calls[textOf(last)] : undefined;
    return fauxAssistantMessage(own ?? "done");
  };
}

/** w1 holds until released; any other writer answers at once. */
function heldFirst() {
  const w1 = hold();
  const child: FauxResponseFactory = (context, ...rest) =>
    taskOf(context) === "w1"
      ? w1.step(context, ...rest)
      : fauxAssistantMessage("ok");
  return { w1, child };
}

const writer = (task: string) => ({ prompt: task, tools: ["write"], cwd: "." });

test("a stopped queued writer keeps the directory locked until the writer ahead ends", async () => {
  const { w1, child } = heldFirst();
  const parent = await parentSession({
    respond: byPrompt(
      {
        go: [lanes("bg", [writer("w1"), writer("w2")], { background: true })],
        again: [lanes("again", [writer("w3")], { background: true })],
      },
      child,
    ),
  });

  await parent.session.prompt("go");
  await w1.entered;
  const w2 = /- task 2: "run w2" \(id ([0-9a-f]{8})\)/.exec(
    textOf(results(parent.session).get("bg")!),
  )?.[1];
  // The stopped run's notice is a message, delivered once its worktree question is answered.
  const noticed = new Promise<void>((resolve) => {
    const off = parent.session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "skyr.subagent"
      ) {
        off();
        resolve();
      }
    });
  });
  await parent.session.prompt(`/subagents stop ${w2}`);
  await noticed;
  await vi.waitFor(async () =>
    expect(await listing(parent)).toEqual([expect.stringContaining("run w1")]),
  );
  await parent.session.waitForIdle();

  await parent.session.prompt("again");
  expect(await listing(parent)).toContainEqual(
    expect.stringMatching(/^○ queued "run w3" · behind "run w1" · /),
  );
  expect(parent.requests.some((r) => taskOf(r) === "w3")).toBe(false);

  w1.release();
  await vi.waitFor(async () => expect(await listing(parent)).toEqual([]));
  await parent.session.waitForIdle();
});

test("a foreground writer stopped by Esc while queued keeps the directory locked until the writer ahead ends", async () => {
  const { w1, child } = heldFirst();
  const parent = await parentSession({
    respond: byPrompt(
      {
        go: [call({ ...writer("w1"), background: true }), call(writer("w2"))],
        again: [lanes("again", [writer("w3")], { background: true })],
      },
      child,
    ),
  });

  const run = parent.session.prompt("go");
  await w1.entered;
  await vi.waitFor(queued(parent, "w2"));
  await parent.session.abort();
  await run;

  await parent.session.prompt("again");
  expect(await listing(parent)).toContainEqual(
    expect.stringMatching(/^○ queued "run w3" · behind /),
  );
  expect(parent.requests.some((r) => taskOf(r) === "w3")).toBe(false);

  w1.release();
  await vi.waitFor(async () => expect(await listing(parent)).toEqual([]));
  await parent.session.waitForIdle();
});
