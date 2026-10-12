// Background delegates: the call returns at once, the answer arrives as a message.
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import {
  call,
  hold,
  type Parent,
  parentSession,
  results,
  taskOf,
  textOf,
} from "./session.js";

/** The parent's turns: `calls` first, `second` (default "done"), then "noted" for delivered answers. */
function bgRouter(
  calls: ReturnType<typeof call>[],
  child: FauxResponseFactory,
  second?: FauxResponseFactory,
): FauxResponseFactory {
  let turns = 0;
  return (context, ...rest) => {
    if (taskOf(context) !== "go") return child(context, ...rest);
    turns += 1;
    if (turns === 1) return fauxAssistantMessage(calls);
    if (turns === 2)
      return second?.(context, ...rest) ?? fauxAssistantMessage("done");
    return fauxAssistantMessage("noted");
  };
}

const parentTurns = (parent: Parent) =>
  parent.requests.filter((r) => taskOf(r) === "go");

/** The message a delivered answer arrived in: the last message of the parent's third turn. */
async function delivered(parent: Parent) {
  await vi.waitFor(() =>
    expect(parentTurns(parent).length).toBeGreaterThanOrEqual(3),
  );
  await parent.session.waitForIdle();
  return parentTurns(parent)[2]!.messages.at(-1)!;
}

test("a background call returns before the child answers, and the answer arrives as a message that starts a parent turn once the parent is idle", async () => {
  const held = hold();
  const parent = await parentSession({
    respond: bgRouter([call({ task: "bg", background: true })], held.step),
  });

  await parent.session.prompt("go");

  expect(parentTurns(parent)).toHaveLength(2);
  const started = results(parent.session).get("bg");
  expect(started?.isError).toBe(false);
  expect(textOf(started!)).toMatch(
    /^subagent: started "run bg" in the background \(id [0-9a-f]{8}\); its answer arrives as a message/,
  );
  expect(parent.widgets.at(-1)?.[0]).toMatch(/^↗ running "run bg" · 0 turns/);

  held.release();
  const message = await delivered(parent);
  expect(message.role).toBe("user");
  expect(textOf(message)).toMatch(
    /^\[background subagent "run bg" \(id [0-9a-f]{8}\): done, 1 turn, 0 tools, \d+k? tok\]\n\nreleased$/,
  );
  expect(parent.widgets.at(-1)).toBeUndefined();
});

test("an answer that finishes while the parent is streaming is delivered when the parent settles, including after Esc", async () => {
  const parentHold = hold();
  const parent = await parentSession({
    respond: bgRouter(
      [call({ task: "bg", background: true })],
      () => fauxAssistantMessage("BG-DONE"),
      parentHold.step,
    ),
  });

  const run = parent.session.prompt("go");
  await parentHold.entered;
  await vi.waitFor(() => expect(parent.widgets.at(-1)).toBeUndefined());
  expect(parentTurns(parent)).toHaveLength(2);

  await parent.session.abort();
  await run;
  const message = await delivered(parent);
  expect(textOf(message)).toContain("BG-DONE");
});

test("Esc does not stop a background child, and /subagents stop <id> does", async () => {
  const held = hold();
  const parentHold = hold();
  let childAborted = false;
  const parent = await parentSession({
    respond: bgRouter(
      [call({ task: "bg", background: true })],
      (context, options, ...rest) => {
        options?.signal?.addEventListener("abort", () => {
          childAborted = true;
        });
        return held.step(context, options, ...rest);
      },
      parentHold.step,
    ),
  });

  const run = parent.session.prompt("go");
  await Promise.all([held.entered, parentHold.entered]);
  await parent.session.abort();
  await run;

  expect(childAborted).toBe(false);
  const line = parent.widgets.at(-1)?.[0] ?? "";
  expect(line).toMatch(/^↗ running "run bg"/);
  const id = /· ([0-9a-f]{8})$/.exec(line)?.[1];
  expect(id).toBeDefined();

  await parent.session.prompt(`/subagents stop ${id}`);
  expect(childAborted).toBe(true);
  const message = await delivered(parent);
  expect(textOf(message)).toMatch(
    /^\[background subagent "run bg" \(id [0-9a-f]{8}\): aborted, .*\]\n\nsubagent: "run bg" was stopped before it answered$/,
  );
  expect(parent.notices.at(-1)).toBe("subagent: stopping 1 subagent");
  expect(parent.widgets.at(-1)).toBeUndefined();
});

test("session_shutdown aborts background children and clears the widget, and their answers are not delivered to the next session", async () => {
  const held = hold();
  let childAborted = false;
  const parent = await parentSession({
    respond: bgRouter(
      [call({ task: "bg", background: true })],
      (context, options, ...rest) => {
        options?.signal?.addEventListener("abort", () => {
          childAborted = true;
        });
        return held.step(context, options, ...rest);
      },
    ),
  });

  await parent.session.prompt("go");
  await held.entered;
  expect(parent.widgets.at(-1)).toHaveLength(1);
  await parent.session.reload();

  await vi.waitFor(() => expect(childAborted).toBe(true));
  expect(parent.widgets.at(-1)).toBeUndefined();
  await parent.session.waitForIdle();
  expect(parentTurns(parent)).toHaveLength(2);
});

test("the widget lists live children with sanitised text within the width, and clears when none are left", async () => {
  const OSC52 = "\u001b]52;c;cHduZWQ=\u0007";
  const hostile = `${OSC52}evil‮漢字漢字🙂🙂 ${"x".repeat(120)}`;
  const holds = new Map(["bg", "fg"].map((task) => [task, hold()]));
  const parent = await parentSession({
    respond: bgRouter(
      [
        call({ task: "bg", background: true, description: hostile }),
        call({ task: "fg", description: hostile }),
      ],
      (context: TranscriptContext, ...rest) =>
        holds.get(taskOf(context))!.step(context, ...rest),
    ),
  });

  const run = parent.session.prompt("go");
  await Promise.all([...holds.values()].map((h) => h.entered));
  const lines = parent.widgets.at(-1) ?? [];
  expect(lines).toHaveLength(2);
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(100);
    expect(line).not.toContain("\u001b]");
    expect(line).not.toContain("cHduZWQ");
    expect(line).not.toContain("‮");
  }
  expect(lines.map((l) => l.slice(0, 2)).sort()).toEqual(["↗ ", "● "]);

  for (const h of holds.values()) h.release();
  await run;
  await delivered(parent);
  expect(parent.widgets.at(-1)).toBeUndefined();
});

test("a background writer takes the per-cwd slot like a blocking one", async () => {
  const holds = new Map(["bg", "fg"].map((task) => [task, hold()]));
  const parent = await parentSession({
    respond: bgRouter(
      [
        call({ task: "bg", background: true, tools: ["edit"] }),
        call({ task: "fg", tools: ["edit"] }),
      ],
      (context, ...rest) => holds.get(taskOf(context))!.step(context, ...rest),
    ),
  });

  const run = parent.session.prompt("go");
  await holds.get("bg")!.entered;
  await vi.waitFor(() =>
    expect(parent.widgets.at(-1)?.some((l) => l.startsWith("○ queued"))).toBe(
      true,
    ),
  );
  holds.get("bg")!.release();
  await holds.get("fg")!.entered;
  holds.get("fg")!.release();
  await run;

  expect(results(parent.session).get("fg")?.isError).toBe(false);
  const order = parent.requests.map(taskOf).filter((t) => t !== "go");
  expect(order).toEqual(["bg", "fg"]);
  await delivered(parent);
});

test("a queued background writer returns at once as queued and runs when the slot frees", async () => {
  const holds = new Map(["fg", "bg"].map((task) => [task, hold()]));
  const parent = await parentSession({
    respond: bgRouter(
      [
        call({ task: "fg", tools: ["edit"] }),
        call({ task: "bg", background: true, tools: ["edit"] }),
      ],
      (context, ...rest) => holds.get(taskOf(context))!.step(context, ...rest),
    ),
  });
  let ended = false;
  parent.session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolCallId === "bg")
      ended = true;
  });

  const run = parent.session.prompt("go");
  await holds.get("fg")!.entered;
  await vi.waitFor(() => expect(ended).toBe(true));
  expect(parent.widgets.at(-1)?.some((l) => l.startsWith("○ queued"))).toBe(
    true,
  );
  holds.get("fg")!.release();
  await holds.get("bg")!.entered;
  holds.get("bg")!.release();
  await run;
  await delivered(parent);

  expect(textOf(results(parent.session).get("bg")!)).toMatch(
    /^subagent: started "run bg" in the background/,
  );
  expect(parent.widgets.at(-1)).toBeUndefined();
});
