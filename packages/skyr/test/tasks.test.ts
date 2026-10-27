// What shells and subagents publish as an ACP host's task list, over Pi's event bus.
import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createEventBus,
  type EventBus,
} from "@earendil-works/pi-coding-agent";
import { expect, onTestFinished, test } from "vitest";
import {
  agentFile,
  call,
  hold,
  lanes,
  parentSession,
  router,
  taskHost,
  taskOf,
} from "./session.js";
import { gated, gateFile } from "./shells-jobs.js";

/** A background job that holds until the returned gate exists, and is released if the test ends first. */
function gatedShell() {
  const gate = gateFile();
  onTestFinished(() => writeFileSync(gate, ""));
  return {
    gate,
    start: () =>
      fauxToolCall(
        "bash",
        { command: gated(gate), background: true },
        { id: "sh" },
      ),
  };
}

const SHELLS = "skyr/shells";
const SUBAGENTS = "skyr/subagents";

/** Starts one task of a source on `bus`; `finish` ends it. */
type Begin = (
  bus: EventBus,
) => Promise<{ session: AgentSession; finish(): Promise<void> }>;

const shells: Begin = async (bus) => {
  const shell = gatedShell();
  const { session } = await parentSession({
    mode: "tui",
    eventBus: bus,
    respond: router([shell.start()], () => fauxAssistantMessage("child")),
  });
  await session.prompt("go");
  return {
    session,
    // Waits for the job's end message: a test that ends first removes the gate before it is seen
    finish: async () => {
      const told = new Promise<void>((resolve) => {
        const off = session.subscribe((event) => {
          if (
            event.type === "message_end" &&
            event.message.role === "custom" &&
            event.message.customType === "skyr.shell"
          ) {
            off();
            resolve();
          }
        });
      });
      writeFileSync(shell.gate, "");
      await told;
      await session.waitForIdle();
    },
  };
};

const subagents: Begin = async (bus) => {
  const held = hold();
  const { session } = await parentSession({
    mode: "tui",
    eventBus: bus,
    respond: router(
      [call({ agent: "scout", task: "look", description: "look around" })],
      held.step,
    ),
    userAgents: { "scout.md": agentFile("Finds things") },
  });
  const run = session.prompt("go");
  await held.entered;
  return {
    session,
    finish: async () => {
      held.release();
      await run;
    },
  };
};

const sources = [
  [SHELLS, shells, { title: expect.stringContaining("until [ -e") }],
  [
    SUBAGENTS,
    subagents,
    { title: 'scout "look around"', detail: "0 turns · 0 tools" },
  ],
] as const;

test.each(sources)(
  "a host that forwards task lists sees a running %s task, and an empty list once it ends",
  async (source, begin, item) => {
    const bus = createEventBus();
    const host = taskHost(bus, true);
    const { finish } = await begin(bus);
    await host.until(source, (items) => items.length === 1);
    expect(host.last(source)).toEqual([
      {
        id: expect.any(String),
        status: "running",
        startedAt: expect.any(Number),
        ...item,
      },
    ]);
    await finish();
    await host.until(source, (items) => items.length === 0);
  },
);

test.each(sources)(
  "%s publishes nothing when the host does not forward task lists, or no host answers",
  async (_source, begin) => {
    const declining = createEventBus();
    const declined = taskHost(declining, false);
    const silent = createEventBus();
    const unheard: unknown[] = [];
    silent.on("tengi:tasks", (payload) => unheard.push(payload));
    for (const bus of [declining, silent]) await (await begin(bus)).finish();
    expect(declined.published).toEqual([]);
    expect(unheard).toEqual([]);
  },
);

test("a reload republishes the jobs the new session was handed", async () => {
  const bus = createEventBus();
  const host = taskHost(bus, true);
  const { session, finish } = await shells(bus);
  const listed = host.last(SHELLS);
  expect(listed).toHaveLength(1);
  const published = host.published.length;
  await session.reload();
  expect(host.published.length).toBeGreaterThan(published);
  expect(host.last(SHELLS)).toEqual(listed);
  await finish();
  await host.until(SHELLS, (items) => items.length === 0);
});

test("shells and subagents publish their own lists, each under its own source", async () => {
  const bus = createEventBus();
  const host = taskHost(bus, true);
  const held = hold();
  const shell = gatedShell();
  const { session } = await parentSession({
    mode: "tui",
    eventBus: bus,
    respond: router([shell.start(), call({ task: "look" })], held.step),
  });
  const run = session.prompt("go");
  await held.entered;
  await host.until(SHELLS, (items) => items.length === 1);
  expect(host.last(SUBAGENTS)).toHaveLength(1);
  held.release();
  await run;
  await host.until(SUBAGENTS, (items) => items.length === 0);
  expect(host.last(SHELLS)).toHaveLength(1);
  writeFileSync(shell.gate, "");
  await host.until(SHELLS, (items) => items.length === 0);
  await session.waitForIdle();
});

test("a 2-lane call publishes two task items with distinct titles; each leaves as its lane ends", async () => {
  const bus = createEventBus();
  const host = taskHost(bus, true);
  const holds = new Map(["look", "seek"].map((task) => [task, hold()]));
  const { session } = await parentSession({
    mode: "tui",
    eventBus: bus,
    respond: router(
      [
        lanes("call", [
          { agent: "scout", task: "look", description: "look around" },
          { agent: "scout", task: "seek", description: "seek elsewhere" },
        ]),
      ],
      (context, ...rest) => holds.get(taskOf(context))!.step(context, ...rest),
    ),
    userAgents: { "scout.md": agentFile("Finds things") },
  });
  const run = session.prompt("go");
  await host.until(SUBAGENTS, (items) => items.length === 2);
  expect(host.last(SUBAGENTS)).toMatchObject([
    { title: 'scout "look around"' },
    { title: 'scout "seek elsewhere"' },
  ]);

  holds.get("look")!.release();
  await host.until(SUBAGENTS, (items) => items.length === 1);
  expect(host.last(SUBAGENTS)).toMatchObject([
    { title: 'scout "seek elsewhere"' },
  ]);
  holds.get("seek")!.release();
  await run;
  await host.until(SUBAGENTS, (items) => items.length === 0);
});
