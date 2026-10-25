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
import { defineTool, estimateTokens } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";
import {
  ADVISOR_ON,
  advisorCall,
  advisorResults,
  advisorRouter,
  echo,
} from "./advisor.js";
import { parentSession, script, textOf } from "./session.js";

/** Numbered advice, so each reply can be told apart. */
function numbered(): FauxResponseFactory {
  let n = 0;
  return () => fauxAssistantMessage(`ADVICE ${++n}`);
}

const json = (messages: TranscriptContext["messages"]) =>
  JSON.stringify(messages);

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
    skyr: ADVISOR_ON,
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
  const parent = await parentSession({ respond, skyr: ADVISOR_ON });
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
  const parent = await parentSession({ respond, skyr: ADVISOR_ON });
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
    skyr: ADVISOR_ON,
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
  const parent = await parentSession({ respond, skyr: ADVISOR_ON });
  await parent.session.prompt("go");

  expect(advisorResults(parent.session)[0]?.isError).toBe(true);
  const messages = calls[1]!.context.messages;
  expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  expect(textOf(messages[1]!)).toContain(
    "→ advisor({}) #a1\n\n#a1 error:\nadvisor: faux/faux-2 failed: busy.",
  );
});

/** A tool whose every result is `chars` characters long, so a turn's size is known. */
const big = (chars: number) =>
  defineTool({
    name: "big",
    label: "big",
    description: "Returns a lot.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "x".repeat(chars) }],
        details: {},
      };
    },
  });

const bigCall = (id: string) => fauxToolCall("big", {}, { id });
const done = () => fauxAssistantMessage("done");

/** Every `#id` a call line names, and every `#id` a result opens with. */
function ids(text: string) {
  return {
    calls: [...text.matchAll(/→ \w+\(.*\) #(\S+)$/gm)].map((m) => m[1]),
    results: [...text.matchAll(/^#(\S+) (?:ok|error):$/gm)].map((m) => m[1]),
  };
}

/**
 * One part over faux-3's part budget: "go", three big turns, "steer", three more, an extension
 * message, then the advisor call; `then` follows the first review.
 */
async function overBudget(...then: ReturnType<typeof fauxAssistantMessage>[]) {
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([bigCall("b1")]),
      fauxAssistantMessage([bigCall("b2")]),
      fauxAssistantMessage([bigCall("b3")]),
      done(),
      fauxAssistantMessage([bigCall("b4")]),
      fauxAssistantMessage([bigCall("b5")]),
      fauxAssistantMessage([bigCall("b6")]),
      done(),
      fauxAssistantMessage([advisorCall("a1")]),
      ...then,
    ),
    numbered(),
  );
  const parent = await parentSession({
    respond,
    skyr: { advisor: { model: "faux/faux-3" } },
    customTools: [big(15_000)],
  });
  await parent.session.prompt("go");
  await parent.session.prompt("steer");
  await parent.session.sendCustomMessage(
    { customType: "x.note", content: "NOTE", display: true },
    { triggerTurn: true },
  );
  return { parent, calls };
}

test("an over-budget part keeps its first and last user message and its tail, and cuts whole turns only, with a count", async () => {
  const { calls } = await overBudget();

  const text = textOf(calls[0]!.context.messages[1]!);
  expect(text).toContain("<transcript>\nuser:\ngo\n\n[4 turns cut here");
  expect(text).toContain(
    "user:\nsteer\n\n[1 turn cut here to fit the advisor's context window]\n\nagent:\n→ big({}) #b5",
  );
  expect(text).toContain("extension message (x.note):\nNOTE");
  const { calls: called, results } = ids(text);
  expect(called).toEqual(["b5", "b6", "a1"]);
  expect(results).toEqual(["b5", "b6"]);
});

test("the message that called the advisor is never cut, and its reasoning is clipped like a result", async () => {
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([bigCall("b1")]),
      fauxAssistantMessage([
        fauxThinking(
          `${"h".repeat(25_000)}${"m".repeat(20_000)}${"t".repeat(25_000)}`,
        ),
        advisorCall("a1"),
      ]),
    ),
    numbered(),
  );
  const parent = await parentSession({
    respond,
    skyr: { advisor: { model: "faux/faux-3" } },
    customTools: [big(1_000)],
  });
  await parent.session.prompt("go");

  const text = textOf(calls[0]!.context.messages[1]!);
  expect(text).toMatch(
    /^<transcript>\nuser:\ngo\n\n\[1 turn cut here to fit the advisor's context window\]\n\nagent reasoning:\nh{25000}\n\[20000 of 70000 characters cut from the middle of the reasoning\]\nt{25000}\n\nagent:\n→ advisor\(\{\}\) #a1\n<\/transcript>/,
  );
});

test("past the cap, parts are dropped a step at a time, and between steps each request starts with the previous one", async () => {
  const rounds = 14;
  const { respond, calls } = advisorRouter(
    script(
      ...Array.from({ length: rounds }, (_, n) => [
        fauxAssistantMessage([bigCall(`b${n}`)]),
        fauxAssistantMessage([advisorCall(`a${n}`)]),
      ]).flat(),
    ),
    numbered(),
  );
  const parent = await parentSession({
    respond,
    skyr: { advisor: { model: "faux/faux-3" } },
    customTools: [big(18_000)],
  });
  await parent.session.prompt("go");

  expect(calls).toHaveLength(rounds);
  const requests = calls.map((c) => c.context.messages);
  // Call numbers whose request does not start with the one before it.
  const moved = requests.flatMap((messages, n) => {
    const before = requests[n - 1];
    return before && json(messages.slice(0, before.length)) !== json(before)
      ? [n + 1]
      : [];
  });
  const dropping = requests.flatMap((messages, n) =>
    json(messages).includes("were dropped to fit") ? [n + 1] : [],
  );
  // faux-3's 60,000 less the output reserve (16,384) and the margin (4,096), by Pi's estimate.
  for (const messages of requests)
    expect(
      messages.reduce((n, m) => n + Math.ceil(1.25 * estimateTokens(m)), 0),
    ).toBeLessThanOrEqual(39_520);
  // Six parts fit; from the seventh call on, parts go four at a time.
  expect(dropping[0]).toBe(7);
  expect(dropping).toHaveLength(rounds - 6);
  expect(moved).toEqual([7, 11]);
});

test("a closed part is cut the same way on every later call", async () => {
  const { calls } = await overBudget(fauxAssistantMessage([advisorCall("a2")]));

  const first = calls[0]!.context.messages;
  const second = calls[1]!.context.messages;
  expect(textOf(first[1]!)).toContain("turns cut here");
  expect(json(second.slice(0, first.length))).toBe(json(first));
});

test("when the parts exceed the window, the oldest after the first are dropped with their advice, behind a fixed marker", async () => {
  const { respond, calls } = advisorRouter(
    script(
      ...[1, 2, 3, 4].flatMap((n) => [
        fauxAssistantMessage([bigCall(`b${n}`)]),
        fauxAssistantMessage([advisorCall(`a${n}`)]),
      ]),
    ),
    numbered(),
  );
  const parent = await parentSession({
    respond,
    skyr: { advisor: { model: "faux/faux-3" } },
    customTools: [big(36_000)],
  });
  await parent.session.prompt("go");

  const messages = calls[3]!.context.messages;
  const roles = messages.map((m) => m.role);
  expect(roles[0]).toBe("system");
  expect(roles.slice(1)).toEqual(
    roles.slice(1).map((_, i) => (i % 2 === 0 ? "user" : "assistant")),
  );
  expect(roles.at(-1)).toBe("user");
  const all = json(messages);
  expect(all).toContain("#b1 ok");
  expect(all).toContain("ADVICE 1");
  expect(all).not.toContain("#b2 ok");
  expect(all).not.toContain("ADVICE 2");
  expect(all).toContain("#b4 ok");
  expect(textOf(messages[3]!)).toMatch(
    /^\[Earlier parts of the session, and your replies to them, were dropped to fit your context window\.\]\n\n<transcript>\n/,
  );
});

test("a session that cannot fit fails before any request, naming the model's window", async () => {
  const { respond, calls } = advisorRouter(
    script(fauxAssistantMessage([advisorCall("a1")])),
    numbered(),
  );
  const parent = await parentSession({
    respond,
    skyr: { advisor: { model: "faux/faux-4" } },
  });
  await parent.session.prompt("go");

  expect(calls).toHaveLength(0);
  const [result] = advisorResults(parent.session);
  expect(result?.isError).toBe(true);
  expect(textOf(result!)).toMatch(
    /^advisor: the session does not fit faux\/faux-4's context window even after cutting \(about \d+ tokens, 520 available\); continue without the review$/,
  );
});
