import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type MessageRenderer,
  ProjectTrustStore,
  SessionManager,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { registerSkyr } from "../src/index.js";
import {
  agentFile,
  call,
  hold,
  parentSession,
  results,
  router,
  scratchDir,
  sections,
  taskOf,
  textOf,
  toolsSeen,
} from "./session.js";

const plain = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

const SCOUT = { "scout.md": agentFile("Finds things") };

/** A child that records what it was given and answers "ok". */
function recorder() {
  const seen = new Map<
    string,
    { tools: string[]; model: string; sections: Record<string, string | null> }
  >();
  const child = (
    context: TranscriptContext,
    _options: unknown,
    _state: unknown,
    model: { id: string },
  ) => {
    seen.set(taskOf(context), {
      tools: toolsSeen(context),
      model: model.id,
      sections: sections(context),
    });
    return fauxAssistantMessage("ok");
  };
  return { seen, child };
}

/** A fresh registration with an empty store: the tool and the delivered-answer renderer. */
function registered(): ToolDefinition & { message: MessageRenderer } {
  const tools: ToolDefinition[] = [];
  const renderers = new Map<string, MessageRenderer>();
  registerSkyr({
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCommand: () => {},
    registerMessageRenderer: (type: string, renderer: MessageRenderer) =>
      renderers.set(type, renderer),
    on: () => {},
  } as unknown as ExtensionAPI);
  const tool = tools.find((t) => t.name === "subagent");
  const message = renderers.get("skyr.subagent");
  if (!tool || !message)
    throw new Error("registerSkyr registered no subagent tool or renderer");
  return { ...tool, message };
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
    respond: router([call({ agent: "scout", task: "look" })], () =>
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

test("a child's text and description cannot reach the terminal as escapes, the row fits 20 columns, and an ad-hoc row never says undefined", () => {
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
  const callRow = (args: Record<string, string>, width: number) =>
    tool.renderCall?.(args, plain, {} as RenderContext).render(width) ?? [];
  const lines = [
    ...callRow({ agent: "scout", description: hostile, task: "x" }, 20),
    ...callRow({ description: hostile, task: "x", cwd: hostile }, 20),
    ...resultRow(tool, "t", { content: [], details: run }, false, 20),
    ...resultRow(
      tool,
      "t",
      {
        content: [],
        details: {
          ...run,
          agent: undefined,
          status: "queued",
          behind: hostile,
        },
      },
      false,
      20,
    ),
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
  expect(lines).toHaveLength(5);
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    expect(line).not.toContain("\u001b]");
    expect(line).not.toContain("cHduZWQ");
    expect(line).not.toContain("‮");
    expect(line).not.toContain("undefined");
  }
  expect(
    callRow(
      { description: "fix it", task: "x", cwd: "../wt" },
      200,
    )[0]?.trimEnd(),
  ).toBe('subagent "fix it" in ../wt');
  expect(
    resultRow(tool, "t", {
      content: [],
      details: { ...run, status: "queued", behind: '"fix it"' },
    })[0],
  ).toMatch(/^● queued · behind "fix it" · \d+\.\ds +$/);
});

test("a background row renders from saved details alone, and a delivered answer's text cannot reach the terminal as escapes and is previewed in full only when expanded", () => {
  const OSC52 = "\u001b]52;c;cHduZWQ=\u0007";
  const hostile = `${OSC52}evil‮漢字漢字🙂🙂 and more words`;
  const tool = registered();
  const row = resultRow(tool, "t", {
    content: [],
    details: {
      id: "abcdef0123",
      toolCallId: "t",
      agent: "scout",
      description: "x",
      status: "running",
      startedAt: 0,
      turns: 0,
      toolCalls: 0,
      tokens: 0,
      background: true,
    },
  })[0];
  expect(row?.trimEnd()).toBe("↗ background · scout · abcdef01");

  const text = Array.from({ length: 20 }, (_, i) => `${hostile} ${i}`).join(
    "\n",
  );
  const render = (expanded: boolean) =>
    tool
      .message(
        {
          role: "custom",
          customType: "skyr.subagent",
          content: [{ type: "text", text }],
          display: true,
          timestamp: 0,
        },
        { expanded, outputPad: 0 },
        plain,
      )
      ?.render(40) ?? [];
  const collapsed = render(false);
  expect(collapsed.length).toBeGreaterThan(0);
  for (const line of collapsed) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    expect(line).not.toContain("\u001b]");
    expect(line).not.toContain("cHduZWQ");
    expect(line).not.toContain("‮");
  }
  expect(collapsed.join("\n")).toContain("… 8 more lines");
  expect(render(true).join("\n")).not.toContain("more lines");
});

test("a child's final text reaches the parent model, and its usage counts toward the parent's session totals", async () => {
  const { session, requests } = await parentSession({
    respond: router([call({ agent: "scout", task: "look" })], () =>
      fauxAssistantMessage("FINDING-42"),
    ),
    userAgents: SCOUT,
  });

  await session.prompt("go");

  const result = requests.at(-1)?.messages.find((m) => m.role === "toolResult");
  expect(result && textOf(result)).toMatch(/^FINDING-42\n\(id [0-9a-f]{8}\)$/);
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
      [...holds.keys()].map((task) => call({ agent: "scout", task })),
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
  expect(parent.widgets.at(-1)).toHaveLength(3);

  const started = Date.now();
  await parent.session.abort();
  await run;
  expect(Date.now() - started).toBeLessThan(1000);

  for (const task of holds.keys()) {
    const result = results(parent.session).get(task);
    expect(result?.isError).toBe(true);
    expect(result && textOf(result)).toMatch(
      /^subagent: scout was stopped before it answered\n\(id [0-9a-f]{8}\)$/,
    );
  }
  expect(parent.widgets.at(-1)).toBeUndefined();
});

test("a child gets exactly its agent file's tools or the default set, and the parent's model unless its agent file names one", async () => {
  const { seen, child } = recorder();
  const { session } = await parentSession({
    respond: router(
      [
        call({ agent: "reader", task: "r" }),
        call({ agent: "scout", task: "s" }),
      ],
      child,
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

  expect(seen.get("r")).toMatchObject({
    tools: ["read", "web_search"],
    model: "faux-2",
  });
  expect(seen.get("s")).toMatchObject({
    tools: ["bash", "find", "grep", "ls", "read", "web_fetch", "web_search"],
    model: "faux-1",
  });
});

test("with only description and task, the child gets the default read set, the parent's model and cwd, and Pi's own prompt with nothing appended", async () => {
  const { seen, child } = recorder();
  const parent = await parentSession({
    respond: router([call({ task: "plain" })], child),
  });

  await parent.session.prompt("go");

  const got = seen.get("plain");
  expect(got).toMatchObject({
    tools: ["bash", "find", "grep", "ls", "read", "web_fetch", "web_search"],
    model: "faux-1",
  });
  expect(got?.sections.preamble).toBeDefined();
  expect(got?.sections.addendum).toBeUndefined();
  expect(got?.sections.cwd).toBe(`<cwd>\n${parent.cwd}\n</cwd>`);
  expect(results(parent.session).get("plain")?.isError).toBe(false);
});

test("prompt is appended to the child's system prompt, and with agent as well the agent body comes first", async () => {
  const { seen, child } = recorder();
  const { session } = await parentSession({
    respond: router(
      [
        call({ task: "p", prompt: "PROMPT-ONLY" }),
        call({ task: "ap", agent: "scout", prompt: "PROMPT-AFTER" }),
      ],
      child,
    ),
    userAgents: SCOUT,
  });

  await session.prompt("go");

  expect(seen.get("p")?.sections.addendum).toBe(
    "<addendum>\nPROMPT-ONLY\n</addendum>",
  );
  expect(seen.get("ap")?.sections.addendum).toMatch(
    /^<addendum>\nYou are a test agent\.\n\nPROMPT-AFTER\n<\/addendum>$/,
  );
});

test("tools on a call is validated like an agent file's, maps Claude Code names, overrides the agent file's list, and an unknown name fails before any child starts", async () => {
  const { seen, child } = recorder();
  const parent = await parentSession({
    respond: router(
      [
        call({ task: "t1", tools: ["Read", "Edit"] }),
        call({ task: "t2", agent: "reader", tools: ["grep"] }),
        call({ task: "t3", tools: ["read", "TodoWrite"] }),
      ],
      (context, ...rest) => {
        if (taskOf(context) === "t3") throw new Error("t3 started");
        return child(context, ...rest);
      },
    ),
    userAgents: { "reader.md": agentFile("Reads", "tools: Read, WebSearch\n") },
  });

  await parent.session.prompt("go");

  expect(seen.get("t1")?.tools).toEqual(["edit", "read"]);
  expect(seen.get("t2")?.tools).toEqual(["grep"]);
  const t3 = results(parent.session).get("t3");
  expect(t3?.isError).toBe(true);
  expect(t3 && textOf(t3)).toMatch(
    /^subagent: tools: unknown tools TodoWrite; valid tools are read, grep, find, ls, bash, edit, write, web_search, web_fetch/,
  );
  expect(parent.requests.some((r) => taskOf(r) === "t3")).toBe(false);
  expect(parent.widgets.some((w) => w?.length === 3)).toBe(false);
});

test("model on a call overrides the agent file's and the parent's, and an unknown model fails before any child starts", async () => {
  const { seen, child } = recorder();
  const parent = await parentSession({
    respond: router(
      [
        call({ task: "m1", model: "faux/faux-2" }),
        call({ task: "m2", agent: "reader", model: "faux/faux-1" }),
        call({ task: "m3", model: "nowhere/none" }),
      ],
      (context, ...rest) => {
        if (taskOf(context) === "m3") throw new Error("m3 started");
        return child(context, ...rest);
      },
    ),
    userAgents: { "reader.md": agentFile("Reads", "model: faux/faux-2\n") },
  });

  await parent.session.prompt("go");

  expect(seen.get("m1")?.model).toBe("faux-2");
  expect(seen.get("m2")?.model).toBe("faux-1");
  const m3 = results(parent.session).get("m3");
  expect(m3?.isError).toBe(true);
  expect(m3 && textOf(m3)).toMatch(
    /^subagent: "run m3": model "nowhere\/none" is not available/,
  );
  expect(parent.requests.some((r) => taskOf(r) === "m3")).toBe(false);
});

test("cwd runs the child there, absolute or relative to the parent's cwd, and its session still saves beside the parent's", async () => {
  const B = scratchDir("cwd-b");
  writeFileSync(join(B, "IN-B.txt"), "");
  const { seen, child } = recorder();
  let listing = "";
  const parent = await parentSession({
    respond: router(
      [
        call({ task: "abs", cwd: B, tools: ["ls"] }),
        call({ task: "rel", cwd: "sub" }),
      ],
      (context, ...rest) => {
        if (taskOf(context) !== "abs") return child(context, ...rest);
        const last = context.messages.at(-1);
        if (last?.role === "toolResult") {
          listing = textOf(last);
          return child(context, ...rest);
        }
        return fauxAssistantMessage([fauxToolCall("ls", { path: "." })]);
      },
    ),
  });
  writeFileSync(join(parent.cwd, "IN-A.txt"), "");
  mkdirSync(join(parent.cwd, "sub"));

  await parent.session.prompt("go");

  expect(listing).toContain("IN-B.txt");
  expect(listing).not.toContain("IN-A.txt");
  expect(seen.get("abs")?.sections.cwd).toBe(`<cwd>\n${B}\n</cwd>`);
  expect(seen.get("rel")?.sections.cwd).toBe(
    `<cwd>\n${join(parent.cwd, "sub")}\n</cwd>`,
  );
  const parentFile = parent.session.sessionFile!;
  const details = results(parent.session).get("abs")?.details as {
    sessionFile?: string;
  };
  expect(
    details.sessionFile?.startsWith(
      join(dirname(parentFile), basename(parentFile, ".jsonl")),
    ),
  ).toBe(true);
  expect(results(parent.session).get("rel")?.isError).toBe(false);
});

test("a missing cwd, or a file as cwd, fails before any child starts and names the path", async () => {
  const parent = await parentSession({
    respond: router(
      [call({ task: "m", cwd: "nope" }), call({ task: "f", cwd: "a-file" })],
      () => {
        throw new Error("a child started");
      },
    ),
  });
  writeFileSync(join(parent.cwd, "a-file"), "");

  await parent.session.prompt("go");

  const byTask = results(parent.session);
  const missing = byTask.get("m");
  const file = byTask.get("f");
  expect(missing?.isError).toBe(true);
  expect(file?.isError).toBe(true);
  // Each diagnosis reads true: a missing path is missing, a file is a file — named, with the path.
  expect(textOf(missing!)).toContain(join(parent.cwd, "nope"));
  expect(textOf(missing!)).toContain("does not resolve (ENOENT)");
  expect(textOf(missing!)).toContain("pass an existing directory");
  expect(textOf(file!)).toContain(join(parent.cwd, "a-file"));
  expect(textOf(file!)).toContain("is not a directory");
  expect(textOf(file!)).toContain("looked at");
  expect(parent.requests.filter((r) => taskOf(r) !== "go")).toHaveLength(0);
  expect(parent.widgets).toEqual([]);
});

test("a foreign cwd takes its trust from Pi's trust store, then the parent's verdict, and agent files still come from the parent's cwd", async () => {
  const B = scratchDir("cwd-b");
  const C = scratchDir("cwd-c");
  for (const [dir, tag] of [
    [B, "FROM-B"],
    [C, "FROM-C"],
  ] as const) {
    mkdirSync(join(dir, CONFIG_DIR_NAME, "agents"), { recursive: true });
    writeFileSync(join(dir, CONFIG_DIR_NAME, "APPEND_SYSTEM.md"), tag);
    writeFileSync(
      join(dir, CONFIG_DIR_NAME, "agents", "local.md"),
      agentFile("Only here"),
    );
  }
  const { seen, child } = recorder();
  const parent = await parentSession({
    respond: router(
      [
        call({ task: "tb", cwd: B }),
        call({ task: "tc", cwd: C }),
        call({ task: "ta", cwd: B, agent: "local" }),
      ],
      child,
    ),
  });
  new ProjectTrustStore(parent.agentDir).set(B, false);

  await parent.session.prompt("go");

  expect(seen.get("tb")?.sections.addendum).toBeUndefined();
  expect(seen.get("tc")?.sections.addendum).toContain("FROM-C");
  const ta = results(parent.session).get("ta");
  expect(ta && textOf(ta)).toMatch(/^subagent: no agent "local"/);
});

test("agents from the repo and user dirs are listed in the tool description, the repo wins a name clash, and the description stays the same across turns", async () => {
  const { session, requests } = await parentSession({
    respond: router([call({ agent: "scout", task: "s" })], () =>
      fauxAssistantMessage("ok"),
    ),
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

test("with no agent files the tool is still offered, says what an ad-hoc call is, and a call with only description and task runs", async () => {
  const { session, requests } = await parentSession({
    respond: router([call({ task: "x" })], () => fauxAssistantMessage("ok")),
  });

  await session.prompt("go");

  const declared = requests[0]!.messages.flatMap((m) =>
    m.role === "system"
      ? (m.toolsAdded ?? []).filter((t) => t.name === "subagent")
      : [],
  );
  expect(declared).toHaveLength(1);
  expect(declared[0]?.description).toMatch(
    /Without `agent`.*\n\nAgents: none defined\.$/s,
  );
  expect(declared[0]?.description).not.toContain("undefined");
  expect(results(session).get("x")?.isError).toBe(false);
});

test("a broken or unknown agent, an unresolvable model, or a child that errors fails the call and tells the model what to try", async () => {
  const parent = await parentSession({
    respond: router(
      [
        call({ agent: "broken", task: "b" }),
        call({ agent: "faraway", task: "f" }),
        call({ agent: "scout", task: "s" }),
      ],
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
    /^subagent: faraway: model "nowhere\/none" is not available .* set `model:` on the call or in the agent file/,
  );
  expect(text("s")).toMatch(
    /^subagent: scout failed: provider exploded\n\(id [0-9a-f]{8}\)$/,
  );
  expect(parent.notices).toHaveLength(1);
  expect(parent.notices[0]).toMatch(/broken\.md/);
});

test("output past the cap ends with a pointer to a file holding the full answer, and the parent session file doesn't contain the text past the cap", async () => {
  const long = `${Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n")}\nTAIL-MARKER`;
  const { session } = await parentSession({
    respond: router([call({ agent: "scout", task: "s" })], () =>
      fauxAssistantMessage(long),
    ),
    userAgents: SCOUT,
  });

  await session.prompt("go");

  const result = results(session).get("s");
  const text = result ? textOf(result) : "";
  const path =
    /\[Truncated: the full answer is in (.+)\]\n\(id [0-9a-f]{8}\)$/.exec(
      text,
    )?.[1];
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
    respond: router([call({ agent: "scout", task: "s" })], held.step),
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
  expect(parent.widgets.at(-1)).toHaveLength(1);
  held.release();
  await run;
  expect(parent.widgets.at(-1)).toBeUndefined();

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
