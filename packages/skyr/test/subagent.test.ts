import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  SessionManager,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { registerSkyr } from "../src/index.js";
import { hold, parentSession, toolsSeen } from "./session.js";

const plain = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const agentFile = (description: string, fields = "") =>
  `---\ndescription: ${description}\n${fields}---\nYou are a test agent.\n`;

type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

const SCOUT = { "scout.md": agentFile("Finds things") };

function textOf(message: TranscriptContext["messages"][number]): string {
  const { content } = message;
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** The first user message: "go" for the parent, the task for a child. */
const taskOf = (context: TranscriptContext) => {
  const first = context.messages.find((m) => m.role === "user");
  return first ? textOf(first) : "";
};

/** Each call's id is its task, so results can be looked up by task. */
const call = (agent: string, task: string) =>
  fauxToolCall(
    "subagent",
    { agent, description: `run ${agent}`, task },
    { id: task },
  );

/** The parent makes `calls` on its first turn and then answers "done"; children get `child`. */
function router(
  calls: ReturnType<typeof call>[],
  child: FauxResponseFactory,
): FauxResponseFactory {
  return (context, ...rest) => {
    if (taskOf(context) !== "go") return child(context, ...rest);
    return context.messages.at(-1)?.role === "toolResult"
      ? fauxAssistantMessage("done")
      : fauxAssistantMessage(calls);
  };
}

function results(
  session: Awaited<ReturnType<typeof parentSession>>["session"],
) {
  return new Map(
    session.messages.flatMap((m) =>
      m.role === "toolResult" ? [[m.toolCallId, m] as const] : [],
    ),
  );
}

function registered(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  registerSkyr({
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    on: () => {},
  } as unknown as ExtensionAPI);
  const tool = tools.find((t) => t.name === "subagent");
  if (!tool) throw new Error("registerSkyr registered no subagent tool");
  return tool;
}

function resultRow(
  tool: ToolDefinition,
  toolCallId: string,
  result: { content: { type: "text"; text: string }[]; details: unknown },
  isError = false,
  width = 200,
): string[] {
  const context = { toolCallId, isError } as RenderContext;
  return (
    tool
      .renderResult?.(
        result,
        { expanded: false, isPartial: false },
        plain,
        context,
      )
      .render(width) ?? []
  );
}

test("a child never receives the subagent tool, nor any extension installed for the user or the repo", async () => {
  const parent = await parentSession({
    respond: router([call("scout", "look")], () =>
      fauxAssistantMessage("found"),
    ),
    userAgents: SCOUT,
  });
  // The parent loads no extensions either, so any load is a child's.
  for (const dir of [
    join(parent.agentDir, "extensions"),
    join(parent.cwd, CONFIG_DIR_NAME, "extensions"),
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sentinel.js"),
      "export default () => { globalThis.sentinelLoads = (globalThis.sentinelLoads ?? 0) + 1; };",
    );
  }

  await parent.session.prompt("go");

  const child = parent.requests.find((r) => taskOf(r) === "look");
  expect(child).toBeDefined();
  expect(toolsSeen(child!)).not.toContain("subagent");
  expect((globalThis as { sentinelLoads?: number }).sentinelLoads).toBe(
    undefined,
  );
});

test("a child's text and description cannot reach the terminal as escapes, and the row fits 20 columns", () => {
  const OSC52 = "\u001b]52;c;cHduZWQ=\u0007";
  const hostile = `${OSC52}evil‮漢字漢字🙂🙂 and more words`;
  const tool = registered();
  const run = {
    id: "1",
    toolCallId: "t",
    agent: "scout",
    description: hostile,
    status: "running",
    startedAt: Date.now(),
    turns: 1,
    toolCalls: 2,
    tokens: 0,
    activity: hostile,
  };
  const lines = [
    ...(tool
      .renderCall?.(
        { agent: "scout", description: hostile, task: "x" },
        plain,
        {} as RenderContext,
      )
      .render(20) ?? []),
    ...resultRow(tool, "t", { content: [], details: run }, false, 20),
    ...resultRow(
      tool,
      "t",
      {
        content: [{ type: "text", text: `subagent: scout failed: ${hostile}` }],
        details: { ...run, status: "failed", endedAt: Date.now() },
      },
      true,
      20,
    ),
  ];
  expect(lines).toHaveLength(3);
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    expect(line).not.toContain("\u001b]");
    expect(line).not.toContain("cHduZWQ");
    expect(line).not.toContain("‮");
  }
});

test("a child's final text reaches the parent model, and its usage counts toward the parent's session totals", async () => {
  const { session, requests } = await parentSession({
    respond: router([call("scout", "look")], () =>
      fauxAssistantMessage("FINDING-42"),
    ),
    userAgents: SCOUT,
  });

  await session.prompt("go");

  const result = requests.at(-1)?.messages.find((m) => m.role === "toolResult");
  expect(result && textOf(result)).toBe("FINDING-42");
  const childInput = results(session).get("look")?.usage?.input ?? 0;
  expect(childInput).toBeGreaterThan(0);
  const parentInput = session.messages.reduce(
    (sum, m) => sum + (m.role === "assistant" ? m.usage.input : 0),
    0,
  );
  expect(session.getSessionStats().tokens.input).toBe(parentInput + childInput);
});

test("parallel subagent calls in one turn run concurrently, and Esc stops them all within a second", async () => {
  const holds = new Map(["a", "b", "c"].map((task) => [task, hold()]));
  const parent = await parentSession({
    respond: router(
      [...holds.keys()].map((task) => call("scout", task)),
      (context, ...rest) => {
        const held = holds.get(taskOf(context));
        if (!held) throw new Error(`unexpected task ${taskOf(context)}`);
        return held.step(context, ...rest);
      },
    ),
    userAgents: SCOUT,
  });

  const run = parent.session.prompt("go");
  await Promise.all([...holds.values()].map((h) => h.entered));
  expect(parent.status.at(-1)).toBe("3 subagents");

  const started = Date.now();
  await parent.session.abort();
  await run;
  expect(Date.now() - started).toBeLessThan(1000);

  for (const task of holds.keys()) {
    const result = results(parent.session).get(task);
    expect(result?.isError).toBe(true);
    expect(result && textOf(result)).toBe(
      "subagent: scout was stopped before it answered",
    );
  }
  expect(parent.status.at(-1)).toBeUndefined();
});

test("a child gets exactly its agent file's tools or the default set, and the parent's model unless its agent file names one", async () => {
  const seen = new Map<string, { tools: string[]; model: string }>();
  const { session } = await parentSession({
    respond: router(
      [call("reader", "r"), call("scout", "s")],
      (context, _options, _state, model) => {
        seen.set(taskOf(context), {
          tools: toolsSeen(context),
          model: model.id,
        });
        return fauxAssistantMessage("ok");
      },
    ),
    userAgents: {
      ...SCOUT,
      "reader.md": agentFile(
        "Reads",
        "tools: Read, WebSearch\nmodel: faux/faux-2\n",
      ),
    },
  });

  await session.prompt("go");

  expect(seen.get("r")).toEqual({
    tools: ["read", "web_search"],
    model: "faux-2",
  });
  expect(seen.get("s")).toEqual({
    tools: ["bash", "find", "grep", "ls", "read", "web_fetch", "web_search"],
    model: "faux-1",
  });
});

test("agents from the repo and user dirs are listed in the tool description, the repo wins a name clash, and the description stays the same across turns", async () => {
  const { session, requests } = await parentSession({
    respond: router([call("scout", "s")], () => fauxAssistantMessage("ok")),
    userAgents: {
      "scout.md": agentFile("User scout"),
      "helper.md": agentFile("Helps out"),
    },
    repoAgents: { "scout.md": agentFile("Repo scout") },
  });

  await session.prompt("go");

  const parentTurns = requests.filter((r) => taskOf(r) === "go");
  expect(parentTurns).toHaveLength(2);
  // A changed description would be declared again in a later system message.
  const declared = (parentTurns.at(-1)?.messages ?? []).flatMap((m) =>
    m.role === "system"
      ? (m.toolsAdded ?? []).filter((t) => t.name === "subagent")
      : [],
  );
  expect(declared).toHaveLength(1);
  expect(declared[0]?.description).toMatch(
    /\n- helper: Helps out\n- scout: Repo scout$/,
  );
});

test("with no agent files, the model is not offered the subagent tool", async () => {
  const { session, requests } = await parentSession({
    respond: () => fauxAssistantMessage("ok"),
  });
  await session.prompt("go");
  expect(toolsSeen(requests[0]!)).not.toContain("subagent");
});

test("a broken or unknown agent, an unresolvable model, or a child that errors fails the call and tells the model what to try", async () => {
  const parent = await parentSession({
    respond: router(
      [call("broken", "b"), call("faraway", "f"), call("scout", "s")],
      () =>
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "provider exploded",
        }),
    ),
    userAgents: {
      ...SCOUT,
      "broken.md": "---\ntools: Read\n---\nNo description.\n",
      "faraway.md": agentFile("Far away", "model: nowhere/none\n"),
    },
  });

  await parent.session.prompt("go");

  const byTask = results(parent.session);
  for (const result of byTask.values()) expect(result.isError).toBe(true);
  const text = (task: string) => {
    const result = byTask.get(task);
    return result ? textOf(result) : "";
  };
  expect(text("b")).toMatch(
    /^subagent: no agent "broken"; available: faraway, scout\. Agent files that failed to load: .*broken\.md: .*description/,
  );
  expect(text("f")).toMatch(
    /^subagent: faraway: model "nowhere\/none" is not available .* Set `model:` in the agent file/,
  );
  expect(text("s")).toBe("subagent: scout failed: provider exploded");
  expect(parent.notices).toHaveLength(1);
  expect(parent.notices[0]).toMatch(/broken\.md/);
});

test("output past the cap ends with a pointer to a file holding the full answer, and the parent session file doesn't contain the text past the cap", async () => {
  const long = `${Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n")}\nTAIL-MARKER`;
  const { session } = await parentSession({
    respond: router([call("scout", "s")], () => fauxAssistantMessage(long)),
    userAgents: SCOUT,
  });

  await session.prompt("go");

  const result = results(session).get("s");
  const text = result ? textOf(result) : "";
  const path = /\[Truncated: the full answer is in (.+)\]$/.exec(text)?.[1];
  expect(path).toBeDefined();
  expect(readFileSync(path!, "utf8")).toBe(long);
  expect(Buffer.byteLength(text)).toBeLessThan(10_200);
  expect(readFileSync(session.sessionFile!, "utf8")).not.toContain(
    "TAIL-MARKER",
  );
});

test("the row and status count follow the store while a child runs, and a resumed session renders the row from saved details alone", async () => {
  const held = hold();
  const parent = await parentSession({
    respond: router([call("scout", "s")], held.step),
    userAgents: SCOUT,
  });
  const updates: unknown[] = [];
  parent.session.subscribe((event) => {
    if (event.type === "tool_execution_update")
      updates.push(event.partialResult.details);
  });
  const tool = parent.session.getToolDefinition("subagent");
  if (!tool) throw new Error("no subagent tool");

  const run = parent.session.prompt("go");
  await held.entered;
  // Empty details: a running row reads the store.
  expect(resultRow(tool, "s", { content: [], details: {} })[0]).toMatch(
    /^● running · 0 turns · 0 tools · \d+\.\ds/,
  );
  expect(parent.status).toEqual(["1 subagent"]);
  held.release();
  await run;
  expect(parent.status).toEqual(["1 subagent", undefined]);

  const reopened = SessionManager.open(parent.session.sessionFile!);
  const saved = reopened
    .getEntries()
    .flatMap((e) =>
      e.type === "message" && e.message.role === "toolResult"
        ? [e.message]
        : [],
    )[0];
  expect(saved?.details).toMatchObject({
    id: (updates[0] as { id: string }).id,
    status: "done",
  });
  expect(
    resultRow(registered(), "s", {
      content: [],
      details: saved?.details,
    })[0],
  ).toMatch(/^✓ done · 1 turn · 0 tools · \d+k? tok · \d+\.\ds/);
});
