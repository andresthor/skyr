// Several tasks in one call: each runs as its own lane, and the call answers for all of them.
import { readFileSync } from "node:fs";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import {
  agentFile,
  call,
  childIds,
  hold,
  lanes,
  parentSession,
  results,
  router,
  scriptTurns,
  taskOf,
  textOf,
} from "./session.js";

/** Input tokens a call's children spent, each read from its own saved transcript. */
const spentBy = (details: unknown) =>
  (details as { sessionFile: string }[])
    .flatMap((run) => SessionManager.open(run.sessionFile).getEntries())
    .reduce(
      (sum, e) =>
        sum +
        (e.type === "message" && e.message.role === "assistant"
          ? e.message.usage.input
          : 0),
      0,
    );

const plain = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

const nobody = () => {
  throw new Error("a child started");
};

test("a call with one bad task among three runs nothing and names every bad task in one error", async () => {
  const parent = await parentSession({
    respond: router(
      [
        lanes("one", [
          { prompt: "a" },
          { prompt: "b", agent: "nope" },
          { prompt: "c" },
        ]),
        lanes("many", [
          { prompt: "d", cwd: "missing" },
          { prompt: "e" },
          { prompt: "f", description: " " },
        ]),
      ],
      nobody,
    ),
    userAgents: { "broken.md": "---\ntools: Read\n---\nNo description.\n" },
  });

  await parent.session.prompt("go");

  const one = results(parent.session).get("one")!;
  expect(one.isError).toBe(true);
  expect(textOf(one)).toMatch(
    /^subagent: nothing ran; fix these and call again:\n- task 2 \("run nope"\): no agent "nope"; available: none\nAgent files that failed to load: \S*broken\.md: [^\n]*$/,
  );
  const many = results(parent.session).get("many")!;
  expect(many.isError).toBe(true);
  expect(textOf(many).split("\n")).toEqual([
    "subagent: nothing ran; fix these and call again:",
    expect.stringMatching(
      /^- task 1 \("run d"\): cwd "missing" does not resolve \(ENOENT\)/,
    ),
    "- task 3: give a short description: 3-5 words for the user, in description",
  ]);
  expect(parent.requests.filter((r) => taskOf(r) !== "go")).toHaveLength(0);
  expect(parent.widgets).toEqual([]);
});

test("a refused call claims nothing: a later writer in that directory starts at once, and a continue it named can be continued again", async () => {
  const parent = await parentSession({
    respond: scriptTurns(
      (context) => fauxAssistantMessage(`ANSWER ${taskOf(context)}`),
      () => fauxAssistantMessage([call({ prompt: "look" })]),
      (context) =>
        fauxAssistantMessage([
          lanes("refused", [
            { prompt: "w1", tools: ["write"], cwd: "." },
            {
              description: "again",
              continue: childIds(context)[0],
              prompt: "x",
            },
            { prompt: "bad", agent: "nope" },
          ]),
        ]),
      (context) =>
        fauxAssistantMessage([
          lanes("after", [
            { prompt: "w2", tools: ["write"], cwd: "." },
            {
              description: "again",
              continue: childIds(context)[0],
              prompt: "y",
            },
          ]),
        ]),
    ),
  });

  await parent.session.prompt("go");

  const refused = results(parent.session).get("refused")!;
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toMatch(/^subagent: nothing ran; /);
  const after = results(parent.session).get("after")!;
  expect(after.isError).toBe(false);
  expect(textOf(after)).toMatch(/^subagent: 2 tasks · 2 done · /);
  expect(parent.requests.some((r) => taskOf(r) === "w1")).toBe(false);
});

test("a misplaced background is refused, naming the key", async () => {
  const parent = await parentSession({
    respond: router(
      [
        fauxToolCall(
          "subagent",
          { tasks: [{ description: "x", prompt: "bg", background: true }] },
          { id: "bg" },
        ),
      ],
      nobody,
    ),
  });

  await parent.session.prompt("go");

  const result = results(parent.session).get("bg")!;
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("  - tasks.0.background: schema is false");
  expect(parent.requests.filter((r) => taskOf(r) !== "go")).toHaveLength(0);
});

test("agent on the call is refused, naming the key", async () => {
  const parent = await parentSession({
    respond: router(
      [
        fauxToolCall(
          "subagent",
          { agent: "scout", tasks: [{ description: "x", prompt: "a" }] },
          { id: "a" },
        ),
      ],
      nobody,
    ),
    userAgents: { "scout.md": agentFile("Finds things") },
  });

  await parent.session.prompt("go");

  const result = results(parent.session).get("a")!;
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("  - agent: schema is false");
  expect(parent.requests.filter((r) => taskOf(r) !== "go")).toHaveLength(0);
});

test("nine tasks fail Pi's validation before anything starts", async () => {
  const parent = await parentSession({
    respond: router(
      [
        lanes(
          "nine",
          Array.from({ length: 9 }, (_, i) => ({ prompt: `t${i}` })),
        ),
      ],
      nobody,
    ),
  });

  await parent.session.prompt("go");

  const result = results(parent.session).get("nine")!;
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain(
    "  - tasks: must not have more than 8 items",
  );
  expect(parent.widgets).toEqual([]);
});

test("a call is an error only when every task failed, stopped or ended empty", async () => {
  const child: FauxResponseFactory = (context) => {
    const task = taskOf(context);
    if (task.startsWith("boom"))
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "provider exploded",
      });
    if (task.startsWith("empty")) return fauxAssistantMessage("");
    if (task.startsWith("stop"))
      return fauxAssistantMessage("", { stopReason: "aborted" });
    return fauxAssistantMessage("FINE");
  };
  const parent = await parentSession({
    respond: router(
      [
        lanes("mixed", [
          { prompt: "stop 1" },
          { prompt: "ok" },
          { prompt: "boom 1" },
          { prompt: "empty 1" },
        ]),
        lanes("none", [
          { prompt: "boom 2" },
          { prompt: "empty 2" },
          { prompt: "stop 2" },
        ]),
      ],
      child,
    ),
  });

  await parent.session.prompt("go");

  const mixed = results(parent.session).get("mixed")!;
  expect(mixed.isError).toBe(false);
  const text = textOf(mixed);
  expect(text).toMatch(
    /^subagent: 4 tasks · 1 done, 1 empty, 1 failed, 1 stopped · \d+k? tok\n/,
  );
  expect(
    [
      ...text.matchAll(
        /<subagent-answer task="(\d of 4)" [^\n]* status="(\w+)" /g,
      ),
    ].map(([, task, status]) => `${task} ${status}`),
  ).toEqual(["1 of 4 stopped", "2 of 4 done", "3 of 4 failed", "4 of 4 empty"]);
  const none = results(parent.session).get("none")!;
  expect(none.isError).toBe(true);
  expect(textOf(none)).toMatch(
    /^subagent: 3 tasks · 1 empty, 1 failed, 1 stopped · /,
  );
});

test("Esc keeps every finished lane's answer; a running lane reads stopped before it answered, a queued one stopped before it started, having spent nothing", async () => {
  const holds = new Map(["slow", "w1"].map((task) => [task, hold()]));
  const parent = await parentSession({
    respond: router(
      [
        lanes("call", [
          { prompt: "fast" },
          { prompt: "slow" },
          { prompt: "w1", tools: ["write"], cwd: "." },
          { prompt: "w2", tools: ["write"], cwd: "." },
        ]),
      ],
      (context, ...rest) => {
        const task = taskOf(context);
        if (task === "fast") return fauxAssistantMessage("FAST");
        const held = holds.get(task);
        if (!held) throw new Error(`${task} started`);
        return held.step(context, ...rest);
      },
    ),
  });

  const run = parent.session.prompt("go");
  await Promise.all([...holds.values()].map((h) => h.entered));
  // The fast lane has ended once only the other three are listed.
  await vi.waitFor(() => expect(parent.widgets.at(-1)).toHaveLength(3));
  await parent.session.abort();
  await run;

  const result = results(parent.session).get("call")!;
  expect(result.isError).toBe(false);
  const blocks = textOf(result).split("\n\n").slice(1);
  expect(blocks).toEqual([
    expect.stringMatching(/ status="done" [^\n]*>\nFAST\n<\/subagent-answer>$/),
    expect.stringMatching(
      /\nsubagent: "run slow" was stopped by the user before it answered\n/,
    ),
    expect.stringMatching(
      /\nsubagent: "run w1" was stopped by the user before it answered\n/,
    ),
    expect.stringMatching(
      /\nsubagent: "run w2" was stopped by the user before it started\n/,
    ),
  ]);
  expect(result.details).toMatchObject([
    { status: "done" },
    { status: "aborted", error: "stopped by the user" },
    { status: "aborted", error: "stopped by the user" },
    { status: "aborted", turns: 0, tokens: 0 },
  ]);
  expect(result.details).not.toHaveProperty([3, "sessionFile"]);
});

test("Esc reaches every lane of a call at once", async () => {
  const holds = new Map(["a", "b", "c"].map((task) => [task, hold()]));
  const parent = await parentSession({
    respond: router(
      [
        lanes(
          "call",
          [...holds.keys()].map((task) => ({ prompt: task })),
        ),
      ],
      (context, ...rest) => holds.get(taskOf(context))!.step(context, ...rest),
    ),
  });

  const run = parent.session.prompt("go");
  await Promise.all([...holds.values()].map((h) => h.entered));
  await parent.session.abort();
  await run;

  const result = results(parent.session).get("call")!;
  expect(result.isError).toBe(true);
  expect(textOf(result)).toMatch(/^subagent: 3 tasks · 3 stopped · /);
  expect(
    textOf(result).match(/was stopped by the user before it answered/g),
  ).toHaveLength(3);
});

test("each call's result carries only its own lanes, and session totals count every lane of both calls once", async () => {
  const { session } = await parentSession({
    respond: router(
      [lanes("two", [{ prompt: "a" }, { prompt: "b" }]), call({ prompt: "c" })],
      (context) => fauxAssistantMessage(`ANSWER ${taskOf(context)}`),
    ),
  });

  await session.prompt("go");

  const runsOf = (id: string) =>
    results(session).get(id)?.details as { description: string }[];
  expect(runsOf("two").map((r) => r.description)).toEqual(["run a", "run b"]);
  expect(runsOf("c").map((r) => r.description)).toEqual(["run c"]);
  const spent = (id: string) => spentBy(results(session).get(id)?.details);
  expect(spent("two")).toBeGreaterThan(0);
  expect(results(session).get("two")?.usage?.input).toBe(spent("two"));
  const parentInput = session.messages.reduce(
    (sum, m) => sum + (m.role === "assistant" ? m.usage.input : 0),
    0,
  );
  expect(session.getSessionStats().tokens.input).toBe(
    parentInput + spent("two") + spent("c"),
  );
});

test("each lane's details carry its own counters", async () => {
  const { session } = await parentSession({
    respond: router(
      [lanes("call", [{ prompt: "tool" }, { prompt: "plain" }])],
      (context) =>
        taskOf(context) === "tool" &&
        context.messages.at(-1)?.role !== "toolResult"
          ? fauxAssistantMessage([fauxToolCall("ls", { path: "." })])
          : fauxAssistantMessage("ok"),
    ),
  });

  await session.prompt("go");

  expect(results(session).get("call")?.details).toMatchObject([
    { description: "run tool", turns: 2, toolCalls: 1 },
    { description: "run plain", turns: 1, toolCalls: 0 },
  ]);
});

test("each lane's answer is cut at 10 KB and names its own spill file", async () => {
  const long = (task: string) =>
    `${Array.from({ length: 400 }, (_, i) => `${task} ${i} ${"x".repeat(40)}`).join("\n")}\nTAIL-${task}`;
  const { session } = await parentSession({
    respond: router(
      [lanes("call", [{ prompt: "a" }, { prompt: "b" }])],
      (context) => fauxAssistantMessage(long(taskOf(context))),
    ),
  });

  await session.prompt("go");

  const text = textOf(results(session).get("call")!);
  for (const [n, task] of [
    [1, "a"],
    [2, "b"],
  ] as const) {
    const [, body, path] =
      new RegExp(
        `\\n<subagent-answer task="${n} of 2" [^\\n]*>\\n([\\s\\S]*?)\\n</subagent-answer>\\n\\[Truncated: task ${n}'s full answer is in (.+)\\]`,
      ).exec(text) ?? [];
    expect(Buffer.byteLength(body ?? "")).toBeLessThanOrEqual(10_000);
    expect(body).not.toContain(`TAIL-${task}`);
    expect(readFileSync(path!, "utf8")).toBe(long(task));
  }
});

test("a failed task's spend still counts: toward its call's usage, and toward the session when every task failed", async () => {
  const { session } = await parentSession({
    respond: router(
      [
        lanes("mixed", [{ prompt: "tool, then fail" }, { prompt: "ok" }]),
        lanes("failed", [
          { prompt: "fail" },
          { prompt: "tool, then fail too" },
        ]),
      ],
      (context) => {
        const task = taskOf(context);
        if (task === "ok") return fauxAssistantMessage("fine");
        if (
          task.startsWith("tool") &&
          context.messages.at(-1)?.role !== "toolResult"
        )
          return fauxAssistantMessage([fauxToolCall("ls", { path: "." })]);
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "provider exploded",
        });
      },
    ),
  });

  await session.prompt("go");

  const mixed = results(session).get("mixed")!;
  expect(mixed.details).toMatchObject([
    { status: "failed", turns: 2 },
    { status: "done" },
  ]);
  expect(mixed.usage?.input).toBe(spentBy(mixed.details));
  const failed = results(session).get("failed")!;
  expect(failed.isError).toBe(true);
  expect(spentBy(failed.details)).toBeGreaterThan(0);
  const parentInput = session.messages.reduce(
    (sum, m) => sum + (m.role === "assistant" ? m.usage.input : 0),
    0,
  );
  expect(session.getSessionStats().tokens.input).toBe(
    parentInput + spentBy(mixed.details) + spentBy(failed.details),
  );
});

test("a stringified tasks array runs as the array it encodes", async () => {
  const parent = await parentSession({
    respond: router(
      [
        fauxToolCall(
          "subagent",
          {
            tasks: JSON.stringify([
              { description: "a", prompt: "a" },
              { description: "b", prompt: "b" },
            ]),
          },
          { id: "s" },
        ),
      ],
      (context) => fauxAssistantMessage(`ANSWER ${taskOf(context)}`),
    ),
  });

  await parent.session.prompt("go");

  const result = results(parent.session).get("s")!;
  expect(result.isError).toBe(false);
  expect(textOf(result)).toMatch(/^subagent: 2 tasks · 2 done · /);
  expect(
    parent.requests
      .map(taskOf)
      .filter((t) => t !== "go")
      .sort(),
  ).toEqual(["a", "b"]);
});

test("a lone task object runs as one lane", async () => {
  const parent = await parentSession({
    respond: router(
      [
        fauxToolCall(
          "subagent",
          { tasks: { description: "solo", prompt: "solo" } },
          { id: "s" },
        ),
      ],
      () => fauxAssistantMessage("ok"),
    ),
  });

  await parent.session.prompt("go");

  const result = results(parent.session).get("s")!;
  expect(result.isError).toBe(false);
  expect(textOf(result)).toMatch(
    /^subagent: 1 task · done · [^\n]*\n[\s\S]*<subagent-answer task="1 of 1" description="solo" /,
  );
});

test("a lane that still sends task is refused with where the job and the role go, before any child starts", async () => {
  const parent = await parentSession({
    respond: router(
      [
        fauxToolCall(
          "subagent",
          {
            tasks: [
              { description: "a", prompt: "a" },
              { description: "old", prompt: "You are a reviewer.", task: "b" },
            ],
          },
          { id: "lanes" },
        ),
        fauxToolCall(
          "subagent",
          { tasks: { description: "solo", task: "c" } },
          { id: "lone" },
        ),
      ],
      nobody,
    ),
  });

  await parent.session.prompt("go");

  for (const id of ["lanes", "lone"]) {
    const result = results(parent.session).get(id)!;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "subagent: nothing ran; `task` is not a field: put each task's job in `prompt` and any role in `role`, then call again",
    );
  }
  expect(parent.requests.filter((r) => taskOf(r) !== "go")).toHaveLength(0);
});

test("a shimmed call's row renders its lanes from the raw arguments", async () => {
  const scout = { agent: "scout", description: "a", prompt: "a" };
  const tasks = [scout, { description: "b", prompt: "b" }];
  const parent = await parentSession({
    respond: router(
      [
        fauxToolCall(
          "subagent",
          { tasks: JSON.stringify(tasks) },
          { id: "string" },
        ),
        fauxToolCall("subagent", { tasks: scout }, { id: "lone" }),
      ],
      () => fauxAssistantMessage("ok"),
    ),
    userAgents: { "scout.md": agentFile("Finds things") },
  });

  await parent.session.prompt("go");

  // The session keeps the arguments as the model sent them.
  const saved = new Map(
    parent.session.messages.flatMap((m) =>
      m.role === "assistant"
        ? m.content.flatMap((c) =>
            c.type === "toolCall" ? [[c.id, c.arguments] as const] : [],
          )
        : [],
    ),
  );
  expect(typeof saved.get("string")?.tasks).toBe("string");
  const tool = parent.session.extensionRunner.getToolDefinition("subagent");
  const line = (id: string, isPartial: boolean) =>
    tool
      ?.renderCall?.(saved.get(id), plain, { isPartial } as RenderContext)
      .render(200)[0]
      ?.trimEnd();
  expect(line("string", true)).toBe('subagent 2 tasks · scout "a", "b"');
  expect(line("string", false)).toBe("subagent 2 tasks · scout");
  expect(line("lone", false)).toBe('subagent scout "a"');
});

test("an old flat task call is refused, naming its keys", async () => {
  const parent = await parentSession({
    respond: router(
      [
        fauxToolCall(
          "subagent",
          { description: "old", task: "old" },
          { id: "old" },
        ),
      ],
      nobody,
    ),
  });

  await parent.session.prompt("go");

  const result = results(parent.session).get("old")!;
  expect(result.isError).toBe(true);
  expect(textOf(result)).toMatch(
    /^Validation failed for tool "subagent":\n {2}- tasks: must have required properties tasks\n {2}- description: schema is false\n {2}- task: schema is false\n/,
  );
  expect(parent.requests.filter((r) => taskOf(r) !== "go")).toHaveLength(0);
});
