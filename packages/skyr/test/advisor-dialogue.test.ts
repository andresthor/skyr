/**
 * The advisor's dialogue across calls: each answered call closes a part and its advice becomes
 * the advisor's own turn, so call N's request starts with call N-1's, byte for byte, which is
 * what lets a provider's prompt cache serve it. Driven through the tool, since Pi's persistence
 * order is part of what is proved.
 */
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { type AgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { advisorRouter, parentSession, textOf } from "./session.js";

const ON = { advisor: { model: "faux/faux-2" } };

/** The main model sends `turns` in order, one per request, then answers "done". */
function script(
  ...turns: ReturnType<typeof fauxAssistantMessage>[]
): FauxResponseFactory {
  let next = 0;
  return () => turns[next++] ?? fauxAssistantMessage("done");
}

/** Numbered advice, so each reply can be told apart. */
function numbered(): FauxResponseFactory {
  let n = 0;
  return () => fauxAssistantMessage(`ADVICE ${++n}`);
}

const advisorCall = (id: string) => fauxToolCall("advisor", {}, { id });

const echo = defineTool({
  name: "echo",
  label: "echo",
  description: "Echoes.",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "echoed" }], details: {} };
  },
});

const json = (messages: TranscriptContext["messages"]) =>
  JSON.stringify(messages);

function advisorResults(session: AgentSession) {
  return session.messages.flatMap((m) =>
    m.role === "toolResult" && m.toolName === "advisor" ? [m] : [],
  );
}

test("every earlier part renders byte-identically on the next call, reasoning and instruction included", async () => {
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([fauxThinking("WHY A1"), advisorCall("a1")]),
      fauxAssistantMessage([fauxToolCall("echo", {}, { id: "e1" })]),
      fauxAssistantMessage([advisorCall("a2")]),
    ),
    numbered(),
  );
  const parent = await parentSession({
    respond,
    skyr: ON,
    customTools: [echo],
  });
  await parent.session.prompt("go");

  expect(calls).toHaveLength(2);
  const first = calls[0]!.context.messages;
  const second = calls[1]!.context.messages;
  expect(second.map((m) => m.role)).toEqual([
    "system",
    "user",
    "assistant",
    "user",
  ]);
  expect(textOf(first[1]!)).toContain("agent reasoning:\nWHY A1");
  expect(json(second.slice(0, first.length))).toBe(json(first));
  expect(advisorResults(parent.session)[1]?.usage?.cacheRead).toBeGreaterThan(
    0,
  );
});

test("earlier advice appears once, as the advisor's own turn", async () => {
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([advisorCall("a1")]),
      fauxAssistantMessage([advisorCall("a2")]),
    ),
    numbered(),
  );
  const parent = await parentSession({ respond, skyr: ON });
  await parent.session.prompt("go");

  const messages = calls[1]!.context.messages;
  const turn = messages[2];
  expect(turn?.role).toBe("assistant");
  expect(turn && textOf(turn)).toBe("ADVICE 1");
  expect(json(messages).split("ADVICE 1")).toHaveLength(2);
  expect(textOf(messages[3]!)).toContain("→ advisor({}) #a2");
  expect(textOf(messages[3]!)).not.toContain("#a1");
});

test("two advisor calls in one message give one advice turn, in call order", async () => {
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([advisorCall("a1"), advisorCall("a2")]),
      fauxAssistantMessage([advisorCall("a3")]),
    ),
    numbered(),
  );
  const parent = await parentSession({ respond, skyr: ON });
  await parent.session.prompt("go");

  const [a1, a2] = advisorResults(parent.session);
  const messages = calls[2]!.context.messages;
  expect(messages.map((m) => m.role)).toEqual([
    "system",
    "user",
    "assistant",
    "user",
  ]);
  expect(textOf(messages[2]!)).toBe(`${textOf(a1!)}\n\n${textOf(a2!)}`);
});

test("a sibling's later result opens the next part and leaves the earlier part unchanged", async () => {
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([
        fauxToolCall("echo", {}, { id: "e1" }),
        advisorCall("a1"),
      ]),
      fauxAssistantMessage([advisorCall("a2")]),
    ),
    numbered(),
  );
  const parent = await parentSession({
    respond,
    skyr: ON,
    customTools: [echo],
  });
  await parent.session.prompt("go");

  const first = calls[0]!.context.messages;
  const second = calls[1]!.context.messages;
  expect(json(second.slice(0, first.length))).toBe(json(first));
  expect(textOf(first[1]!)).not.toContain("#e1 ok");
  expect(textOf(second[3]!)).toMatch(/^<transcript>\n#e1 ok:\nechoed\n\n/);
});

test("a failed advisor call does not end a part; it reads as an ordinary call", async () => {
  let n = 0;
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([advisorCall("a1")]),
      fauxAssistantMessage([advisorCall("a2")]),
    ),
    () =>
      ++n === 1
        ? fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "busy",
          })
        : fauxAssistantMessage("ADVICE"),
  );
  const parent = await parentSession({ respond, skyr: ON });
  await parent.session.prompt("go");

  expect(advisorResults(parent.session)[0]?.isError).toBe(true);
  const messages = calls[1]!.context.messages;
  expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  expect(textOf(messages[1]!)).toContain(
    "→ advisor({}) #a1\n\n#a1 error:\nadvisor: faux/faux-2 failed: busy.",
  );
});
