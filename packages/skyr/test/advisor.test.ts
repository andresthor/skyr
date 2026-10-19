/**
 * The advisor tool, driven through a real session: when it is offered, what the advisor model
 * receives, what the agent gets back, and the row.
 */
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  defineTool,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { parseAdvisorSection } from "../src/advisor/config.js";
import {
  advisorRouter,
  call,
  hold,
  parentSession,
  router,
  taskOf,
  textOf,
  toolsSeen,
} from "./session.js";

const ON = { advisor: { model: "faux/faux-2" } };
const OSC52 = "\u001b]52;c;cHduZWQ=\u0007";

const plain = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

const answer = () => fauxAssistantMessage("done");
const advise =
  (text = "Check the tests first.") =>
  () =>
    fauxAssistantMessage(text);

/** The main model sends `turns` in order, one per request, then answers "done". */
function script(
  ...turns: ReturnType<typeof fauxAssistantMessage>[]
): FauxResponseFactory {
  let next = 0;
  return () => turns[next++] ?? answer();
}

const advisorCall = (id = "adv") => fauxToolCall("advisor", {}, { id });

/** The text of a request's user messages, which hold the transcript. */
function transcript(context: TranscriptContext): string {
  return context.messages
    .filter((m) => m.role === "user")
    .map(textOf)
    .join("\n");
}

function advisorResults(session: AgentSession) {
  return session.messages.flatMap((m) =>
    m.role === "toolResult" && m.toolName === "advisor" ? [m] : [],
  );
}

const echo = defineTool({
  name: "echo",
  label: "echo",
  description: "Echoes.",
  parameters: Type.Object({ x: Type.Optional(Type.Number()) }),
  async execute() {
    return { content: [{ type: "text", text: "echoed" }], details: {} };
  },
});

// Activation and config

test("with no advisor section the tool is not declared and the system prompt never mentions it", async () => {
  const parent = await parentSession({ respond: answer });
  await parent.session.prompt("go");

  expect(toolsSeen(parent.requests[0]!)).not.toContain("advisor");
  const tool = parent.session.getToolDefinition("advisor");
  expect(tool).toBeDefined();
  for (const text of [tool?.promptSnippet, ...(tool?.promptGuidelines ?? [])])
    expect(parent.session.systemPrompt).not.toContain(text);
  expect(parent.notices).toEqual([]);
});

test("with a known model configured, the first request declares advisor with its snippet and guidelines", async () => {
  const parent = await parentSession({ respond: answer, skyr: ON });
  await parent.session.prompt("go");

  expect(toolsSeen(parent.requests[0]!)).toContain("advisor");
  const prompt = parent.session.systemPrompt;
  expect(prompt).toContain(
    "advisor: Get a stronger model's review of the work so far",
  );
  const guidelines =
    parent.session.getToolDefinition("advisor")?.promptGuidelines ?? [];
  expect(guidelines.length).toBeGreaterThan(0);
  for (const guideline of guidelines) {
    expect(guideline).toMatch(/\badvisor\b/);
    expect(prompt).toContain(`- ${guideline}`);
  }
  expect(parent.notices).toEqual([]);
});

test("a configured model that Pi does not know leaves advisor undeclared and is reported once, by name", async () => {
  const parent = await parentSession({
    respond: answer,
    skyr: { advisor: { model: "faux/nope" } },
  });
  await parent.session.prompt("go");
  await parent.session.prompt("again");

  expect(toolsSeen(parent.requests[1]!)).not.toContain("advisor");
  expect(parent.notices).toEqual([
    'skyr.json: advisor.model "faux/nope" is not a known model; advisor off',
  ]);
});

test("a model with no credentials leaves advisor undeclared and is reported once per session, at the first prompt", async () => {
  const parent = await parentSession({
    respond: answer,
    skyr: { advisor: { model: "nokey/m" } },
  });
  // Known only from now on; the key's variable is unset, so Pi has no credentials for it.
  parent.session.modelRuntime.registerProvider("nokey", {
    baseUrl: "http://localhost:9",
    api: "openai-completions",
    apiKey: "$SKYR_TEST_NO_SUCH_KEY",
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1000,
      },
    ],
  });
  await parent.session.reload();
  const credentials = () =>
    parent.notices.filter((n) => n.includes("has no credentials"));
  expect(credentials()).toEqual([]);

  await parent.session.prompt("go");
  await parent.session.prompt("again");
  expect(credentials()).toEqual([
    'skyr.json: advisor.model "nokey/m" has no credentials; advisor off until it has',
  ]);
  expect(toolsSeen(parent.requests.at(-1)!)).not.toContain("advisor");

  await parent.session.reload();
  await parent.session.prompt("once more");
  expect(credentials()).toHaveLength(2);
});

test("a broken skyr.json is reported once, not once per module", async () => {
  const parent = await parentSession({ respond: answer, skyr: '{"advisor":' });
  await parent.session.prompt("go");

  expect(parent.notices.filter((n) => n.includes("skyr.json"))).toHaveLength(1);
  expect(toolsSeen(parent.requests[0]!)).not.toContain("advisor");
});

test("a malformed advisor section turns the advisor off and names the field and the expected form", () => {
  const malformed =
    'skyr.json: advisor.model must be a string like "provider/model-id"; advisor off';
  const notObject =
    'skyr.json: advisor must be an object like {"model": "provider/model-id"}; advisor off';
  const cases: [unknown, ReturnType<typeof parseAdvisorSection>][] = [
    [undefined, { model: undefined, problems: [] }],
    [{}, { model: undefined, problems: [] }],
    ["faux/faux-2", { model: undefined, problems: [notObject] }],
    [["faux/faux-2"], { model: undefined, problems: [notObject] }],
    [null, { model: undefined, problems: [notObject] }],
    [{ model: 7 }, { model: undefined, problems: [malformed] }],
    [{ model: "faux-2" }, { model: undefined, problems: [malformed] }],
    [{ model: "/faux-2" }, { model: undefined, problems: [malformed] }],
    [{ model: "faux/" }, { model: undefined, problems: [malformed] }],
    [
      { model: "openrouter/anthropic/x" },
      { model: { provider: "openrouter", id: "anthropic/x" }, problems: [] },
    ],
    [
      { model: "faux/faux-2", reasoning: "high" },
      {
        model: { provider: "faux", id: "faux-2" },
        problems: [
          'skyr.json: advisor."reasoning" is not a setting; ignored (settings: model)',
        ],
      },
    ],
  ];
  for (const [raw, expected] of cases)
    expect(parseAdvisorSection(raw), JSON.stringify(raw)).toEqual(expected);
});

test("advisor activated by anything but the config is withdrawn before the next run", async () => {
  const parent = await parentSession({ respond: answer });
  parent.session.setActiveToolsByName([
    ...parent.session.getActiveToolNames(),
    "advisor",
  ]);
  expect(parent.session.getActiveToolNames()).toContain("advisor");

  await parent.session.prompt("go");

  expect(toolsSeen(parent.requests[0]!)).not.toContain("advisor");
});

test("advisor cannot be called from another tool", async () => {
  let refused: boolean | undefined;
  const caller = defineTool({
    name: "caller",
    label: "caller",
    description: "Calls advisor.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      refused = (await ctx.executeTool("advisor", {})).isError;
      return { content: [{ type: "text", text: "called" }], details: {} };
    },
  });
  const { respond, calls } = advisorRouter(
    script(fauxAssistantMessage([fauxToolCall("caller", {})])),
    advise(),
  );
  const parent = await parentSession({
    respond,
    skyr: ON,
    customTools: [caller],
  });
  await parent.session.prompt("go");

  expect(toolsSeen(parent.requests[0]!)).toContain("advisor");
  expect(refused).toBe(true);
  expect(calls).toHaveLength(0);
});

test("a subagent child is never offered advisor, even while the parent has it", async () => {
  const { respond } = advisorRouter(
    router([call({ task: "look" })], () => fauxAssistantMessage("found")),
    advise(),
  );
  const parent = await parentSession({ respond, skyr: ON });
  await parent.session.prompt("go");

  const child = parent.requests.find((r) => taskOf(r) === "look");
  expect(child).toBeDefined();
  expect(toolsSeen(parent.requests[0]!)).toContain("advisor");
  expect(toolsSeen(child!)).not.toContain("advisor");
});

// The request

test("the advisor request is its own prompt plus a text transcript: no tool declarations, tool blocks or toolChoice", async () => {
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([fauxToolCall("echo", {}, { id: "e1" })]),
      fauxAssistantMessage([advisorCall()]),
    ),
    advise(),
  );
  const parent = await parentSession({
    respond,
    skyr: ON,
    customTools: [echo],
  });
  await parent.session.prompt("go");

  expect(calls).toHaveLength(1);
  const { context, options } = calls[0]!;
  // pi-ai's openai-completions request sends `tools: []` for a history with tool blocks and no
  // declared tools, and Corti rejects that, so the request must carry neither.
  expect(toolsSeen(context)).toEqual([]);
  for (const message of context.messages) {
    expect(message.role).not.toBe("toolResult");
    if (message.role === "assistant")
      expect(message.content.some((c) => c.type === "toolCall")).toBe(false);
  }
  expect(options?.toolChoice).toBeUndefined();
  const system = context.messages[0];
  expect(system?.role).toBe("system");
  expect(textOf(system!)).toContain(
    `<agent_instructions>\n${parent.session.systemPrompt}\n</agent_instructions>`,
  );
  expect(context.messages.slice(1).map((m) => m.role)).toEqual(["user"]);
});

test("each call shows its arguments and id, and each result its id, ok or error, and its text", async () => {
  const fails = defineTool({
    name: "fails",
    label: "fails",
    description: "Fails.",
    parameters: Type.Object({}),
    async execute() {
      throw new Error("no such file");
    },
  });
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([
        fauxToolCall("echo", { x: 1 }, { id: "e1" }),
        fauxToolCall("fails", {}, { id: "f1" }),
      ]),
      fauxAssistantMessage([advisorCall()]),
    ),
    advise(),
  );
  const parent = await parentSession({
    respond,
    skyr: ON,
    customTools: [echo, fails],
  });
  await parent.session.prompt("go");

  const text = transcript(calls[0]!.context);
  expect(text).toContain("<transcript>\nuser:\ngo\n\n");
  expect(text).toContain('agent:\n→ echo({"x":1}) #e1\n→ fails({}) #f1');
  expect(text).toContain("#e1 ok:\nechoed");
  expect(text).toContain("#f1 error:\nno such file");
  expect(text).toContain("agent:\n→ advisor({}) #adv\n</transcript>");
});

test("a call that had not finished beside advisor shows with no result, and the instruction says what that means", async () => {
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([
        fauxToolCall("echo", {}, { id: "e1" }),
        advisorCall(),
      ]),
    ),
    advise(),
  );
  const parent = await parentSession({
    respond,
    skyr: ON,
    customTools: [echo],
  });
  await parent.session.prompt("go");

  const text = transcript(calls[0]!.context);
  expect(text).toContain("→ echo({}) #e1\n→ advisor({}) #adv");
  expect(text).not.toContain("#e1 ok");
  expect(text).toContain(
    "A call with no result after it had not finished when you were consulted.",
  );
});

test("only the latest readable reasoning is sent: earlier and redacted thinking are not", async () => {
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([
        fauxThinking("EARLIER THOUGHT"),
        fauxToolCall("echo", {}),
      ]),
      fauxAssistantMessage([
        { ...fauxThinking("REDACTED THOUGHT"), redacted: true },
        fauxThinking("LATEST THOUGHT"),
        fauxThinking("  "),
        advisorCall(),
      ]),
    ),
    advise(),
  );
  const parent = await parentSession({
    respond,
    skyr: ON,
    customTools: [echo],
  });
  await parent.session.prompt("go");

  const text = transcript(calls[0]!.context);
  expect(text).toContain(
    "agent reasoning:\nLATEST THOUGHT\n\nagent:\n→ advisor({}) #adv",
  );
  expect(text).not.toContain("EARLIER THOUGHT");
  expect(text).not.toContain("REDACTED THOUGHT");
});

test("a result over 50,000 characters keeps its head and tail and says how much was cut", async () => {
  // The emoji straddles the head's cut, so a naive slice would leave half of it.
  const head = `${"a".repeat(24_999)}😀`;
  const body = `${head}${"m".repeat(10_000)}${"z".repeat(25_000)}`;
  const big = defineTool({
    name: "big",
    label: "big",
    description: "Returns a lot.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: body }], details: {} };
    },
  });
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([fauxToolCall("big", {}, { id: "b1" })]),
      fauxAssistantMessage([advisorCall()]),
    ),
    advise(),
  );
  const parent = await parentSession({
    respond,
    skyr: ON,
    customTools: [big],
  });
  await parent.session.prompt("go");

  const text = transcript(calls[0]!.context);
  expect(text).toContain(
    `#b1 ok:\n${"a".repeat(24_999)}\n[10002 of 60001 characters cut from the middle of the result]\n${"z".repeat(25_000)}`,
  );
  expect(text).not.toContain("m".repeat(2));
  expect(text).not.toMatch(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
  );
});

test("a call's arguments over 50,000 characters keep their head and tail around a line saying how much was cut", async () => {
  const content = "a".repeat(30_000) + "z".repeat(30_000);
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([fauxToolCall("echo", { content }, { id: "w1" })]),
      fauxAssistantMessage([advisorCall()]),
    ),
    advise(),
  );
  const parent = await parentSession({
    respond,
    skyr: ON,
    customTools: [echo],
  });
  await parent.session.prompt("go");

  const text = transcript(calls[0]!.context);
  const args = JSON.stringify({ content });
  expect(text).toContain(
    `→ echo(${args.slice(0, 25_000)}\n[${args.length - 50_000} of ${args.length} characters cut from the middle of the arguments]\n${args.slice(-25_000)}) #w1\n`,
  );
});

test("images are sent where they occur, the last 4, and earlier ones as placeholders", async () => {
  const image = (n: number) => ({
    type: "image" as const,
    data: Buffer.from(`image ${n}`).toString("base64"),
    mimeType: "image/png",
  });
  const shots = defineTool({
    name: "shots",
    label: "shots",
    description: "Returns images.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          { type: "text", text: "six shots" },
          ...[1, 2, 3, 4, 5, 6].map(image),
        ],
        details: {},
      };
    },
  });
  const { respond, calls } = advisorRouter(
    script(
      fauxAssistantMessage([fauxToolCall("shots", {}, { id: "s1" })]),
      fauxAssistantMessage([advisorCall()]),
    ),
    advise(),
  );
  const parent = await parentSession({
    respond,
    skyr: ON,
    customTools: [shots],
  });
  await parent.session.prompt("go");

  const user = calls[0]!.context.messages.find((m) => m.role === "user");
  const content = user?.role === "user" ? user.content : [];
  if (typeof content === "string") throw new Error("expected blocks");
  expect(content.map((c) => c.type)).toEqual([
    "text",
    "image",
    "image",
    "image",
    "image",
    "text",
  ]);
  expect(content.flatMap((c) => (c.type === "image" ? [c.data] : []))).toEqual(
    [3, 4, 5, 6].map((n) => image(n).data),
  );
  const first = content[0];
  expect(first?.type === "text" && first.text).toMatch(
    /#s1 ok:\nsix shots(\[image not sent: only the last 4 images are sent\]){2}$/,
  );
});

test("the request goes to the configured model with high reasoning, the model's own output cap, the call's abort signal and a session id of its own", async () => {
  const { respond, calls } = advisorRouter(
    script(fauxAssistantMessage([advisorCall()])),
    advise(),
  );
  const parent = await parentSession({ respond, skyr: ON });
  await parent.session.prompt("go");

  expect(calls).toHaveLength(1);
  const { options } = calls[0]!;
  expect(options?.reasoning).toBe("high");
  expect(options?.maxTokens).toBe(8000);
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(options?.sessionId).toBe(`${parent.session.sessionId}:advisor`);
});

// The result

test("the advice reaches the agent verbatim, with the review's usage on the result", async () => {
  const advice = "Check the tests first.\n\n- then commit";
  const { respond } = advisorRouter(
    script(fauxAssistantMessage([advisorCall()])),
    advise(advice),
  );
  const parent = await parentSession({ respond, skyr: ON });
  await parent.session.prompt("go");

  const [result] = advisorResults(parent.session);
  expect(result?.isError).toBe(false);
  expect(result?.content).toEqual([{ type: "text", text: advice }]);
  expect(result?.usage?.input).toBeGreaterThan(0);
  expect(result?.details).toEqual({
    model: "faux/faux-2",
    tokens: result?.usage?.totalTokens,
  });
  const next = parent.requests.at(-1)!.messages.at(-1);
  expect(next?.role === "toolResult" && textOf(next)).toBe(advice);
});

test("invisible and control characters in the advice never reach the agent", async () => {
  const { respond } = advisorRouter(
    script(fauxAssistantMessage([advisorCall()])),
    advise(`keep ${OSC52}going‮​\r\nnow\tplease`),
  );
  const parent = await parentSession({ respond, skyr: ON });
  await parent.session.prompt("go");

  const text = textOf(advisorResults(parent.session)[0]!);
  expect(text).toBe("keep ]52;c;cHduZWQ=going\nnow\tplease");
});

test("advice cut at the output limit says so on its last line", async () => {
  const { respond } = advisorRouter(
    script(fauxAssistantMessage([advisorCall()])),
    () => fauxAssistantMessage("Check the", { stopReason: "length" }),
  );
  const parent = await parentSession({ respond, skyr: ON });
  await parent.session.prompt("go");

  const [result] = advisorResults(parent.session);
  expect(result?.isError).toBe(false);
  expect(textOf(result!)).toBe(
    "Check the\n\n[advice cut off at the output limit]",
  );
});

test("a review that produced no advice is a tool error naming the cause, with its usage, and is not retried", async () => {
  const cases: [ReturnType<typeof fauxAssistantMessage>, string][] = [
    [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "rate \u001b[31mlimited\u001b[0m",
      }),
      "advisor: faux/faux-2 failed: rate limited. No review was received; continue on your own judgement and tell the user the advisor was unavailable",
    ],
    [
      fauxAssistantMessage(""),
      "advisor: faux/faux-2 returned no advice (stop reason: stop); continue without the review",
    ],
    [
      fauxAssistantMessage([fauxThinking("so much to weigh")], {
        stopReason: "length",
      }),
      "advisor: faux/faux-2 used its whole output limit on reasoning and wrote no advice; continue without the review",
    ],
  ];
  for (const [reply, expected] of cases) {
    const { respond, calls } = advisorRouter(
      script(fauxAssistantMessage([advisorCall()])),
      () => reply,
    );
    const parent = await parentSession({ respond, skyr: ON });
    await parent.session.prompt("go");

    const [result] = advisorResults(parent.session);
    expect(result?.isError, expected).toBe(true);
    expect(textOf(result!)).toBe(expected);
    expect(result?.usage).toBeDefined();
    expect(calls).toHaveLength(1);
  }
});

test("Esc during a review ends the call as a tool error that keeps its usage", async () => {
  const held = hold();
  const { respond } = advisorRouter(
    script(fauxAssistantMessage([advisorCall()])),
    held.step,
  );
  const parent = await parentSession({ respond, skyr: ON });
  const run = parent.session.prompt("go");
  await held.entered;
  await parent.session.abort();
  await run;

  const [result] = advisorResults(parent.session);
  expect(result?.isError).toBe(true);
  expect(textOf(result!)).toBe(
    "advisor: the review was interrupted before it finished, so there is no advice; do not call advisor again unless the user asks",
  );
  expect(result?.usage).toBeDefined();
});

// The row

test("the advisor row fits a narrow terminal and lets no terminal sequence through, collapsed or expanded", async () => {
  const parent = await parentSession({ respond: answer, skyr: ON });
  const tool = parent.session.getToolDefinition("advisor");
  const result = {
    content: [
      {
        type: "text" as const,
        text: `read ${OSC52}the\ttests 漢字漢字漢字漢字漢字漢字\nthen 🎉🎉🎉🎉🎉🎉🎉🎉🎉 commit`,
      },
    ],
    details: { model: "faux/faux-2", tokens: 12_345 },
  };
  const render = (expanded: boolean, width: number) => {
    const context = {
      toolCallId: "adv",
      isError: false,
      state: {},
      durationMs: 1500,
      expanded,
    } as RenderContext;
    return (
      tool
        ?.renderResult?.(result, { expanded, isPartial: false }, plain, context)
        .render(width) ?? []
    );
  };
  expect(render(false, 80)).toEqual([
    expect.stringMatching(/^✓ advice · faux\/faux-2 · 12k tok · 1\.5s\s*$/),
  ]);
  for (const expanded of [false, true]) {
    const lines = render(expanded, 16);
    expect(lines[0]).toMatch(/^✓ advice/);
    expect(lines.length > 1).toBe(expanded);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(16);
      // A cut row ends on a style reset; no other control character may remain.
      expect(line.replaceAll("\u001b[0m", "")).not.toMatch(/\p{Cc}/u);
    }
  }
});

test("a successful result whose details the row does not recognise draws a muted row, not an error", async () => {
  const parent = await parentSession({ respond: answer, skyr: ON });
  const tool = parent.session.getToolDefinition("advisor");
  const tagged = {
    fg: (color: string, text: string) => `<${color}>${text}`,
    bold: (text: string) => text,
  } as unknown as Theme;
  const context = {
    toolCallId: "adv",
    isError: false,
    state: {},
    durationMs: 1500,
    expanded: false,
  } as RenderContext;
  for (const details of [undefined, {}, { model: "faux/faux-2" }]) {
    const lines =
      tool
        ?.renderResult?.(
          { content: [{ type: "text", text: "advice\nmore" }], details },
          { expanded: false, isPartial: false },
          tagged,
          context,
        )
        .render(80) ?? [];
    expect(lines, JSON.stringify(details)).toEqual([
      expect.stringMatching(/^<muted>advice<muted> · 1\.5s\s*$/),
    ]);
  }
});
