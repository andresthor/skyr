// The live runs as an ACP host's task list, over Pi's event bus.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { call, hold, parentSession, router } from "./session.js";

/** Answers capability queries as an ACP host would, and records every published task list. */
function taskHost(bus: EventBus, taskLists: boolean) {
  const published: unknown[] = [];
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
  bus.on("tengi:tasks", (payload) => published.push(payload));
  return published;
}

test("a host that forwards task lists sees a running subagent as one task, and an empty list once it ends", async () => {
  const bus = createEventBus();
  const published = taskHost(bus, true);
  const held = hold();
  const { session } = await parentSession({
    respond: router([call({ task: "look" })], held.step),
    eventBus: bus,
  });

  const run = session.prompt("go");
  await held.entered;
  expect(published.at(-1)).toEqual({
    source: "skyr/subagents",
    items: [
      {
        id: expect.any(String),
        title: '"run look"',
        status: "running",
        detail: "0 turns · 0 tools",
        startedAt: expect.any(Number),
      },
    ],
  });

  held.release();
  await run;
  expect(published.at(-1)).toEqual({ source: "skyr/subagents", items: [] });
});

test("nothing is published when the host does not forward task lists, or no host answers", async () => {
  const declining = createEventBus();
  const declined = taskHost(declining, false);
  const silent = createEventBus();
  const unheard: unknown[] = [];
  silent.on("tengi:tasks", (payload) => unheard.push(payload));

  for (const eventBus of [declining, silent]) {
    const { session } = await parentSession({
      respond: router([call({ task: "look" })], () =>
        fauxAssistantMessage("found"),
      ),
      eventBus,
    });
    await session.prompt("go");
  }
  expect(declined).toEqual([]);
  expect(unheard).toEqual([]);
});
