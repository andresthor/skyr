// Pi behaviour the advisor design rests on. A failure here after a Pi upgrade means the design
// changes, not the test.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionAPI,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, onTestFinished, test } from "vitest";
import { type Parent, parentSession, toolsSeen } from "./session.js";

const answer = () => fauxAssistantMessage("ok");

type AgentMessage = Parameters<typeof convertToLlm>[0][number];

const usage = (input: number) => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const noop = (name: string) =>
  defineTool({
    name,
    label: name,
    description: `The ${name} tool.`,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: name }], details: {} };
    },
  });

test("the assistant message whose tool is running is in the branch, and no call of its batch has a result yet", async () => {
  let fastDone!: () => void;
  const fastFinished = new Promise<void>((r) => {
    fastDone = r;
  });
  const fast = defineTool({
    name: "fast",
    label: "fast",
    description: "Returns at once.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "fast" }], details: {} };
    },
  });
  let seen: AgentMessage[] = [];
  const reader = defineTool({
    name: "reader",
    label: "reader",
    description: "Reads the branch.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      await fastFinished;
      // A hop past Pi's own continuations, where a result persisted at once would land.
      await new Promise((r) => setImmediate(r));
      seen = ctx.sessionManager.buildSessionProjection().messages;
      return { content: [{ type: "text", text: "read" }], details: {} };
    },
  });
  const { session } = await parentSession({
    respond: (context) =>
      context.messages.at(-1)?.role === "toolResult"
        ? answer()
        : fauxAssistantMessage([
            fauxToolCall("fast", {}, { id: "f" }),
            fauxToolCall("reader", {}, { id: "r" }),
          ]),
    customTools: [fast, reader],
  });
  session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolCallId === "f")
      fastDone();
  });
  await session.prompt("go");

  const last = seen.at(-1);
  expect(last?.role).toBe("assistant");
  expect(
    last?.role === "assistant" &&
      last.content.flatMap((c) => (c.type === "toolCall" ? [c.id] : [])),
  ).toEqual(["f", "r"]);
  // Pi had finished `fast`, yet its result is persisted only once the whole batch ends.
  expect(seen.some((m) => m.role === "toolResult")).toBe(false);
});

test("convertToLlm turns summaries, custom messages and user bash runs into user messages, drops `!!`-excluded bash runs, and keeps the rest in order", () => {
  const assistant = fauxAssistantMessage([
    fauxToolCall("read", { path: "a" }, { id: "c1" }),
  ]);
  const messages: AgentMessage[] = [
    { role: "user", content: "task", timestamp: 1 },
    {
      role: "compactionSummary",
      summary: "COMPACTED",
      tokensBefore: 10,
      timestamp: 2,
    },
    assistant,
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "file" }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "custom",
      customType: "x.note",
      content: "NOTE",
      display: true,
      timestamp: 4,
    },
    {
      role: "bashExecution",
      command: "ls",
      output: "LISTED",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 5,
    },
    {
      role: "bashExecution",
      command: "secret",
      output: "HIDDEN",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 6,
      excludeFromContext: true,
    },
    { role: "branchSummary", summary: "BRANCHED", fromId: "e1", timestamp: 7 },
  ];

  const out = convertToLlm(messages);

  expect(out.map((m) => m.role)).toEqual([
    "user",
    "user",
    "assistant",
    "toolResult",
    "user",
    "user",
    "user",
  ]);
  expect(out[2]).toEqual(assistant);
  const texts = out.map((m) => JSON.stringify(m.content));
  expect(texts[1]).toContain("COMPACTED");
  expect(texts[4]).toContain("NOTE");
  expect(texts[5]).toContain("LISTED");
  expect(texts[6]).toContain("BRANCHED");
  expect(texts.join()).not.toContain("HIDDEN");
});

test("a tool result's usage counts toward the session's token totals, a returned error's too", async () => {
  const billed = (name: string, input: number, isError: boolean) =>
    defineTool({
      name,
      label: name,
      description: "Reports what it spent.",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: "spent" }],
          details: {},
          usage: usage(input),
          isError,
        };
      },
    });
  const { session } = await parentSession({
    respond: (context) =>
      context.messages.at(-1)?.role === "toolResult"
        ? answer()
        : fauxAssistantMessage([
            fauxToolCall("billed", {}),
            fauxToolCall("billed_error", {}),
          ]),
    customTools: [
      billed("billed", 12_345, false),
      billed("billed_error", 100, true),
    ],
  });
  await session.prompt("go");

  expect(
    session.messages.flatMap((m) =>
      m.role === "toolResult" ? [[m.toolName, m.isError]] : [],
    ),
  ).toEqual([
    ["billed", false],
    ["billed_error", true],
  ]);
  const assistantInput = session.messages
    .flatMap((m) => (m.role === "assistant" ? [m.usage.input] : []))
    .reduce((a, b) => a + b, 0);
  expect(session.getSessionStats().tokens.input).toBe(
    assistantInput + 12_345 + 100,
  );
});

test("a thrown tool error is persisted with no usage", async () => {
  const thrower = defineTool({
    name: "thrower",
    label: "thrower",
    description: "Throws.",
    parameters: Type.Object({}),
    async execute() {
      throw Object.assign(new Error("boom"), { usage: usage(9) });
    },
  });
  const { session } = await parentSession({
    respond: (context) =>
      context.messages.at(-1)?.role === "toolResult"
        ? answer()
        : fauxAssistantMessage([fauxToolCall("thrower", {})]),
    customTools: [thrower],
  });
  await session.prompt("go");

  const result = session.messages.find((m) => m.role === "toolResult");
  expect(result?.isError).toBe(true);
  expect(result?.usage).toBeUndefined();
});

test('streamSimple on the model registry resolves with stopReason "error" for an unknown provider, and does not reject', async () => {
  const parent = await parentSession({ respond: answer });
  const registry = new ModelRegistry(parent.session.modelRuntime);
  const model = parent.session.model;
  if (!model) throw new Error("the session has no model");

  const reply = await registry
    .streamSimple(
      { ...model, provider: "nope" },
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    )
    .result();

  expect(reply.stopReason).toBe("error");
  expect(parent.requests).toHaveLength(0);
});

/**
 * A session reopened from a transcript that declares `late_tool`, which the reopening session
 * does not register at start, so Pi holds it pending. `factory` is the reopened session's only
 * extension.
 */
async function reopened(
  factory: (pi: ExtensionAPI) => void,
  respond: Parameters<typeof parentSession>[0]["respond"],
): Promise<{ session: AgentSession; parent: Parent }> {
  const parent = await parentSession({
    respond,
    customTools: [noop("late_tool"), noop("trigger")],
  });
  await parent.session.prompt("first");
  const file = parent.session.sessionFile;
  if (!file) throw new Error("the first session was not persisted");

  const { cwd, agentDir } = parent;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [factory],
  });
  await resourceLoader.reload();
  // No `tools`: only a session on the default tools restores its loadout from the transcript.
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: parent.session.modelRuntime,
    model: parent.session.model,
    settingsManager,
    sessionManager: SessionManager.open(file),
    resourceLoader,
  });
  onTestFinished(() => session.dispose());
  await session.bindExtensions({});
  return { session, parent };
}

// Not activated by registering, so only the pending set can make it active.
const lateTool = () => ({ ...noop("late_tool"), defaultActive: false });

test("a restored tool that is still pending when a run starts is not active in that run", async () => {
  let callTrigger = false;
  let activeInRun: boolean | undefined;
  const { session, parent } = await reopened(
    (pi) => {
      pi.registerTool({
        ...noop("trigger"),
        async execute() {
          pi.registerTool(lateTool());
          activeInRun = pi.getActiveTools().includes("late_tool");
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      });
    },
    (context) =>
      context.messages.at(-1)?.role !== "toolResult" && callTrigger
        ? fauxAssistantMessage([fauxToolCall("trigger", {})])
        : answer(),
  );
  expect(session.getActiveToolNames()).not.toContain("late_tool");
  callTrigger = true;

  await session.prompt("go");

  expect(activeInRun).toBe(false);
  expect(toolsSeen(parent.requests.at(-1)!)).not.toContain("late_tool");
});

test("a restored tool that registers in session_start is active", async () => {
  const { session } = await reopened((pi) => {
    pi.on("session_start", () => pi.registerTool(lateTool()));
  }, answer);

  expect(session.getActiveToolNames()).toContain("late_tool");
});

test("deactivating a tool in session_start drops a restored tool that is still pending", async () => {
  const { session } = await reopened((pi) => {
    pi.registerTool(noop("trigger"));
    pi.on("session_start", () => {
      pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "trigger"));
      pi.registerTool(lateTool());
    });
  }, answer);

  expect(session.getActiveToolNames()).not.toContain("trigger");
  expect(session.getActiveToolNames()).not.toContain("late_tool");
});
