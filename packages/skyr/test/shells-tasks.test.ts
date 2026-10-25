// The running shells as an ACP host's task list, over Pi's event bus.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { expect, onTestFinished, test } from "vitest";
import { isRecord } from "../src/tengi.js";
import { call, hold, parentSession, router, scratchDir } from "./session.js";

/** Answers capability queries as an ACP host would; resolves `next` waiters per published list. */
function taskHost(bus: EventBus, taskLists: boolean) {
  const published: { source: string; items: unknown[] }[] = [];
  let waiting: { done: () => boolean; resolve: () => void }[] = [];
  bus.on("tengi:capabilities?", (q) => {
    if (typeof q === "object" && q !== null && "id" in q)
      bus.emit("tengi:capabilities", {
        id: q.id,
        v: 1,
        forms: false,
        notices: false,
        agentui: { version: 1, tasks: taskLists },
        formRequests: false,
        taskLists,
      });
  });
  bus.on("tengi:tasks", (payload) => {
    published.push(payload as (typeof published)[number]);
    for (const w of waiting) if (w.done()) w.resolve();
    waiting = waiting.filter((w) => !w.done());
  });
  const last = (source: string) =>
    published.filter((p) => p.source === source).at(-1)?.items;
  /** Resolves once the last list of `source` satisfies `pred`. */
  const until = (source: string, pred: (items: unknown[]) => boolean) =>
    new Promise<void>((resolve) => {
      const done = () => {
        const items = last(source);
        return items !== undefined && pred(items);
      };
      if (done()) resolve();
      else waiting.push({ done, resolve });
    });
  return { published, last, until };
}

/** A gated shell that starts at once and cannot outlive the test. */
function gatedShell() {
  const dir = scratchDir("gate");
  const gate = join(dir, "go");
  onTestFinished(() => writeFileSync(gate, ""));
  // Also ends when the scratch dir is removed, which can come before the loop sees the gate
  const command = `until [ -e '${gate}' ] || [ ! -d '${dir}' ] || [ $SECONDS -ge 30 ]; do sleep 0.02; done`;
  return {
    gate,
    command,
    start: (id = "sh") =>
      fauxToolCall("bash", { command, background: true }, { id }),
  };
}

const session = (bus: EventBus, calls: ReturnType<typeof call>[]) =>
  parentSession({
    mode: "tui",
    eventBus: bus,
    respond: router(calls, () => fauxAssistantMessage("child")),
  });

test("a host that forwards task lists sees a running shell as one task, and an empty list once it ends", async () => {
  const bus = createEventBus();
  const host = taskHost(bus, true);
  const shell = gatedShell();
  const { session: s } = await session(bus, [shell.start()]);
  await s.prompt("go");
  expect(host.last("skyr/shells")).toEqual([
    {
      id: expect.stringMatching(/^[0-9a-f]{8}$/),
      title: expect.stringContaining("until [ -e"),
      status: "running",
      startedAt: expect.any(Number),
    },
  ]);
  const emptied = host.until("skyr/shells", (items) => items.length === 0);
  writeFileSync(shell.gate, "");
  await emptied;
  await s.waitForIdle();
});

test("nothing is published when the host does not forward task lists, or no host answers", async () => {
  const declining = createEventBus();
  const declined = taskHost(declining, false);
  const silent = createEventBus();
  const unheard: unknown[] = [];
  silent.on("tengi:tasks", (payload) => unheard.push(payload));
  for (const bus of [declining, silent]) {
    const shell = gatedShell();
    const { session: s } = await session(bus, [shell.start()]);
    await s.prompt("go");
    writeFileSync(shell.gate, "");
    await s.waitForIdle();
  }
  expect(declined.published).toEqual([]);
  expect(unheard).toEqual([]);
});

test("a reload republishes the jobs the new session was handed", async () => {
  const bus = createEventBus();
  const host = taskHost(bus, true);
  const shell = gatedShell();
  const { session: s } = await session(bus, [shell.start()]);
  await s.prompt("go");
  const [task] = host.last("skyr/shells") ?? [];
  const id = isRecord(task) ? task.id : undefined;
  expect(id).toEqual(expect.any(String));
  const before = host.published.length;
  await s.reload();
  expect(host.published.length).toBeGreaterThan(before);
  expect(host.last("skyr/shells")).toEqual([
    expect.objectContaining({ id, status: "running" }),
  ]);
  writeFileSync(shell.gate, "");
  await host.until("skyr/shells", (items) => items.length === 0);
  await s.waitForIdle();
});

test("shells and subagents publish their own lists, each under its own source", async () => {
  const bus = createEventBus();
  const host = taskHost(bus, true);
  const held = hold();
  const shell = gatedShell();
  const { session: s } = await parentSession({
    mode: "tui",
    eventBus: bus,
    respond: router([shell.start(), call({ task: "look" })], held.step),
  });
  const run = s.prompt("go");
  await held.entered;
  await host.until("skyr/shells", (items) => items.length === 1);
  expect(host.last("skyr/subagents")).toEqual([
    expect.objectContaining({ title: '"run look"' }),
  ]);
  expect(host.last("skyr/shells")).toEqual([
    expect.objectContaining({ title: expect.stringContaining("until [ -e") }),
  ]);
  held.release();
  await run;
  expect(host.last("skyr/subagents")).toEqual([]);
  expect(host.last("skyr/shells")).toHaveLength(1);
  writeFileSync(shell.gate, "");
  await host.until("skyr/shells", (items) => items.length === 0);
  await s.waitForIdle();
});
