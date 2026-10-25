import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createBashToolDefinition,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, onTestFinished, test } from "vitest";
import { registerSkyr } from "../src/index.js";
import { loadPi } from "../src/pi.js";
import { registerShells, wireShells } from "../src/shells/index.js";
import { groupAlive, readOutcome } from "../src/shells/job.js";
import type { ShellSnapshot } from "../src/shells/store.js";
import { scratchDir, script } from "./session.js";
import { bashInEffect, shellRuntime, shellsWith } from "./shells-runtime.js";

const tool = (session: AgentSession, name: string) =>
  session.getAllTools().find((t) => t.name === name);

/** skyr registers `bash` and `bash_stop` together, so the same extension file provides both. */
function skyrServesBash(session: AgentSession): boolean {
  const bash = bashInEffect(session);
  return (
    bash?.sourceInfo.source !== "builtin" &&
    bash?.sourceInfo.path === tool(session, "bash_stop")?.sourceInfo.path
  );
}

/** Another extension's `bash`, registered while it loads. */
const replacer: ExtensionFactory = (pi) => {
  pi.registerTool({
    ...createBashToolDefinition(process.cwd()),
    description: "replacement bash",
  });
};

const stepAsideNotice = (cause: string) =>
  `skyr: background shells are off because ${cause}; bash is left as it is.`;

describe("registerShells in a session", () => {
  test.each(["print", "json"] as const)(
    "%s mode keeps Pi's bash and registers no bash_stop",
    async (mode) => {
      const rt = await shellRuntime({ mode });
      expect(bashInEffect(rt.session)?.sourceInfo.source).toBe("builtin");
      expect(tool(rt.session, "bash_stop")).toBeUndefined();
      expect(rt.notices).toEqual([]);
    },
  );

  test.each(["tui", "rpc"] as const)(
    "%s mode serves bash from skyr and offers bash_stop beside it",
    async (mode) => {
      const rt = await shellRuntime({ mode });
      expect(skyrServesBash(rt.session)).toBe(true);
      expect(rt.session.getActiveToolNames()).toContain("bash");
      expect(rt.session.getActiveToolNames()).toContain("bash_stop");
      expect(rt.notices).toEqual([]);
    },
  );

  test.each([
    ["before skyr", [replacer, registerSkyr]],
    ["after skyr", [registerSkyr, replacer]],
  ])(
    "a bash another extension registers while loading, loaded %s, stays in effect",
    async (_order, extensions) => {
      const rt = await shellRuntime({ extensions });
      const bash = bashInEffect(rt.session);
      expect(bash?.description).toBe("replacement bash");
      expect(tool(rt.session, "bash_stop")).toBeUndefined();
      expect(rt.notices).toHaveLength(1);
      expect(rt.notices[0]).toContain("another extension provides bash");
    },
  );

  test("a bash from the SDK's customTools stays in effect", async () => {
    const rt = await shellRuntime({
      customTools: [
        {
          ...createBashToolDefinition(process.cwd()),
          description: "sdk bash",
        } as unknown as ToolDefinition,
      ],
    });
    expect(bashInEffect(rt.session)?.description).toBe("sdk bash");
    expect(tool(rt.session, "bash_stop")).toBeUndefined();
    expect(rt.notices[0]).toContain("another extension provides bash");
  });

  test("a reload keeps serving bash without mistaking it for another extension's", async () => {
    const rt = await shellRuntime();
    await rt.session.reload();
    await rt.session.reload();
    expect(skyrServesBash(rt.session)).toBe(true);
    expect(rt.notices).toEqual([]);
  });

  test("/new then /resume serve bash in each session", async () => {
    const rt = await shellRuntime();
    const first = rt.session.sessionFile;
    await rt.newSession();
    expect(skyrServesBash(rt.session)).toBe(true);
    await rt.resume(first as string);
    expect(skyrServesBash(rt.session)).toBe(true);
    expect(tool(rt.session, "bash_stop")).toBeDefined();
    expect(rt.notices).toEqual([]);
  });

  test("a shellPath that is not a POSIX shell steps aside with a notice", async () => {
    const rt = await shellRuntime({
      settings: { shellPath: "/usr/local/bin/fish" },
    });
    expect(bashInEffect(rt.session)?.sourceInfo.source).toBe("builtin");
    expect(tool(rt.session, "bash_stop")).toBeUndefined();
    expect(rt.notices).toEqual([
      stepAsideNotice("shellPath names fish, which is not a POSIX shell"),
    ]);
  });

  test("two reloads never remove a tool from the model's set", async () => {
    const rt = await shellRuntime({
      respond: () => fauxAssistantMessage("ok"),
    });
    await rt.session.prompt("go");
    await rt.session.reload();
    await rt.session.prompt("go");
    await rt.session.reload();
    await rt.session.prompt("go");
    const removed = rt.requests.flatMap((context) =>
      context.messages.flatMap((m) =>
        m.role === "system" ? (m.toolsRemoved ?? []) : [],
      ),
    );
    expect(removed).toEqual([]);
    expect(rt.requests.length).toBe(3);
  });

  test("bash_stop with no jobs says what it was given and that nothing runs", async () => {
    const rt = await shellRuntime();
    const stop = rt.session.getToolDefinition("bash_stop");
    await expect(
      stop?.execute(
        "id",
        { id: "abcd1234" },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow('bash_stop: no job "abcd1234". Running: none.');
  });
});

/** A host that answers what `registerShells` asks, so a case Pi's own tools cannot produce is reachable. */
async function sessionStart(o: {
  tools?: Partial<ToolInfo>[];
  parameters?: string[];
  mode?: ExtensionContext["mode"];
  path?: string;
  /** What `identify(process.pid)` gave; default a token. */
  self?: string | undefined;
  /** A file where the agent dir should be, so nothing can be created under it. */
  agentDirIsFile?: boolean;
}) {
  const piModule = await loadPi();
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const registered: string[] = [];
  const notices: string[] = [];
  const parameters = Type.Object(
    Object.fromEntries(
      (o.parameters ?? ["command", "timeout"]).map((k) => [k, Type.String()]),
    ),
  );
  const agentDir = o.agentDirIsFile
    ? join(scratchDir("agent"), "not-a-dir")
    : scratchDir("agent");
  if (o.agentDirIsFile) writeFileSync(agentDir, "");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  onTestFinished(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const pi = {
    on: (
      event: string,
      fn: typeof handlers extends Map<string, infer F> ? F : never,
    ) => handlers.set(event, fn),
    getSettings: () => ({}),
    getAllTools: () => o.tools ?? [],
    getActiveTools: () => ["bash"],
    setActiveTools: () => {},
    registerTool: (t: { name: string }) => registered.push(t.name),
    registerMessageRenderer: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  registerShells(
    pi,
    {
      ...piModule,
      createBashToolDefinition: (cwd: string, opts?: never) => ({
        ...piModule.createBashToolDefinition(cwd, opts),
        parameters,
      }),
    } as unknown as typeof piModule,
    "self" in o ? o.self : "owner-token",
  );
  const previous = process.env.PATH;
  if (o.path !== undefined) process.env.PATH = o.path;
  const ctx = {
    mode: o.mode ?? "tui",
    cwd: process.cwd(),
    ui: { notify: (m: string) => notices.push(m) },
    sessionManager: { getSessionId: () => "s1" },
    isIdle: () => true,
  } as unknown as ExtensionContext;
  try {
    await handlers.get("session_start")?.({}, ctx);
  } finally {
    process.env.PATH = previous;
  }
  onTestFinished(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
  });
  return { registered, notices };
}

describe("registerShells step-aside", () => {
  test("Pi's bash taking other parameters than command and timeout steps aside with a notice", async () => {
    const host = await sessionStart({
      parameters: ["command", "timeout", "cwd"],
    });
    expect(host.registered).toEqual([]);
    expect(host.notices).toEqual([
      stepAsideNotice(
        "this Pi's bash takes command, timeout, cwd, not command and timeout",
      ),
    ]);
  });

  test("a missing ps steps aside with a notice", async () => {
    const host = await sessionStart({
      path: mkdtempSync(join(tmpdir(), "skyr-test-nops-")),
    });
    expect(host.registered).toEqual([]);
    expect(host.notices).toEqual([stepAsideNotice("ps is not on PATH")]);
  });

  test("a Pi process that ps cannot identify steps aside with a notice", async () => {
    const host = await sessionStart({ self: undefined });
    expect(host.registered).toEqual([]);
    expect(host.notices).toEqual([
      stepAsideNotice("ps cannot identify this Pi process"),
    ]);
  });

  test("a pid-file dir that cannot be created steps aside with a notice", async () => {
    const host = await sessionStart({ agentDirIsFile: true });
    expect(host.registered).toEqual([]);
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0]).toMatch(
      /^skyr: background shells are off because .*\.pending cannot be created \(.*\); bash is left as it is\.$/,
    );
  });

  test("with nothing in the way both tools register and nothing is said", async () => {
    const host = await sessionStart({});
    expect(host.registered).toEqual(["bash", "bash_stop"]);
    expect(host.notices).toEqual([]);
  });
});

// Only the shells' session_start handler waits on Pi; a host that does not await it misses that.
test("registerSkyr registers its other tools before it awaits Pi", () => {
  const names: string[] = [];
  const pending = registerSkyr({
    registerTool: (t: { name: string }) => names.push(t.name),
    registerCommand: () => {},
    registerShortcut: () => {},
    registerMessageRenderer: () => {},
    on: () => {},
  } as unknown as ExtensionAPI);
  expect(names).toContain("web_fetch");
  expect(names).toContain("subagent");
  return pending;
});

// Jobs, through a real session. The limit is 100 ms and every command waits on a gate file.
const gateFile = () => join(scratchDir("gate"), "go");
const slow = (gate: string) =>
  `echo working; until [ -e '${gate}' ] || [ $SECONDS -ge 30 ]; do sleep 0.02; done; echo finished; exit 4`;
const call = (command: string, id: string) =>
  fauxAssistantMessage([fauxToolCall("bash", { command }, { id })]);
const shells = shellsWith({ limitMs: 100, graceMs: 50 });

const resultOf = (session: AgentSession, id: string) => {
  const result = session.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === id,
  );
  if (result?.role !== "toolResult") throw new Error(`no result for ${id}`);
  return {
    isError: result.isError,
    text: result.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
    details: result.details,
    job: (result.details as { job?: ShellSnapshot } | undefined)?.job,
  };
};

/** The shell's group, read from the job record next to the log. */
const pgidOf = (job: ShellSnapshot): number =>
  JSON.parse(readFileSync(join(dirname(job.log), "job.json"), "utf8")).pgid;

describe("a slow bash call in a session", () => {
  test("moves at the limit, keeps running through Esc, and its end reaches the model as a message that starts a turn", async () => {
    const gate = gateFile();
    const command = slow(gate);
    const rt = await shellRuntime({
      extensions: [shells],
      respond: script(call(command, "c1")),
    });
    await rt.session.prompt("go");
    const moved = resultOf(rt.session, "c1");
    const job = moved.job as ShellSnapshot;
    expect(moved.isError).toBe(false);
    expect(job).toMatchObject({ command, status: "running" });
    expect(moved.text).toBe(
      `working\n\nStill running after 0.1 s; moved to the background as job ${job.id} in ${job.cwd}. Full log: ${job.log}. You will be told automatically when it ends: do not sleep, poll or re-read the log to wait. Keep working on anything that does not depend on it; if nothing does, end your turn. Stop it with bash_stop {"id":"${job.id}"}.`,
    );

    await rt.session.abort();
    expect(groupAlive(pgidOf(job))).toBe(true);

    const delivery = rt.nextDelivery();
    writeFileSync(gate, "");
    const text = await delivery;
    expect(text.split("\n")).toEqual([
      expect.stringMatching(
        new RegExp(
          `^\\[background job "echo working; until .*" \\(id ${job.id}\\): exited with code 4 after \\d+s\\]$`,
        ),
      ),
      expect.stringContaining(`$ echo working; until [ -e '${gate}' ]`),
      "working",
      "finished",
      expect.stringMatching(new RegExp(`^Log: ${job.log} \\(\\d+B\\)$`)),
    ]);
    await rt.session.waitForIdle();
    const last = rt.requests.at(-1)?.messages ?? [];
    expect(JSON.stringify(last)).toContain("exited with code 4");
  });

  test("background: true starts a job at once, and its end is told like any other", async () => {
    const gate = gateFile();
    const command = slow(gate);
    const rt = await shellRuntime({
      extensions: [shellsWith({ limitMs: 60_000, graceMs: 50 })],
      respond: script(
        fauxAssistantMessage([
          fauxToolCall("bash", { command, background: true }, { id: "bg" }),
        ]),
      ),
    });
    await rt.session.prompt("go");
    const started = resultOf(rt.session, "bg");
    const job = started.job as ShellSnapshot;
    expect(started.isError).toBe(false);
    expect(
      started.text.endsWith(
        `Started in the background: moved to the background as job ${job.id} in ${job.cwd}. Output goes to ${job.log}; programs may buffer output, so an empty log may only mean nothing was flushed. You will be told automatically when it ends: do not sleep, poll or re-read the log to wait. Stop it with bash_stop {"id":"${job.id}"}.`,
      ),
    ).toBe(true);
    expect(groupAlive(pgidOf(job))).toBe(true);
    const delivery = rt.nextDelivery();
    writeFileSync(gate, "");
    expect(await delivery).toContain(`(id ${job.id}): exited with code 4`);
  });

  test("a nested background call is refused with what to do instead", async () => {
    const nest = defineTool({
      name: "nest",
      label: "nest",
      description: "Runs bash as a nested call.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const outcome = await ctx.executeTool("bash", {
          command: "true",
          background: true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(outcome) }],
          details: {},
        };
      },
    }) as unknown as ToolDefinition;
    const rt = await shellRuntime({
      extensions: [shells],
      customTools: [nest],
      respond: script(
        fauxAssistantMessage([fauxToolCall("nest", {}, { id: "n1" })]),
      ),
    });
    await rt.session.prompt("go");
    expect(resultOf(rt.session, "n1").text).toContain(
      "bash: background is not available inside another tool's call; run the command without background, or call bash directly.",
    );
  });

  test("two calls in one message move as two jobs, each result paired with its own call, and end separately", async () => {
    const [gateA, gateB] = [gateFile(), gateFile()];
    const [a, b] = [slow(gateA), slow(gateB)];
    const rt = await shellRuntime({
      extensions: [shells],
      respond: script(
        fauxAssistantMessage([
          fauxToolCall("bash", { command: a }, { id: "a" }),
          fauxToolCall("bash", { command: b }, { id: "b" }),
        ]),
      ),
    });
    await rt.session.prompt("go");
    const [first, second] = [
      resultOf(rt.session, "a"),
      resultOf(rt.session, "b"),
    ];
    expect(first.job?.command).toBe(a);
    expect(second.job?.command).toBe(b);
    expect(first.job?.id).not.toBe(second.job?.id);

    const deliveredA = rt.nextDelivery();
    writeFileSync(gateA, "");
    const textA = await deliveredA;
    expect(textA).toContain(`(id ${first.job?.id})`);
    expect(textA).toContain(`Still running: ${second.job?.id} `);
    await rt.session.waitForIdle();

    const deliveredB = rt.nextDelivery();
    writeFileSync(gateB, "");
    expect(await deliveredB).toContain(`(id ${second.job?.id})`);
  });

  test("a call that settles in time is Pi's result: no job, no moved text", async () => {
    const rt = await shellRuntime({
      extensions: [shells],
      respond: script(call("echo quick", "c1")),
    });
    await rt.session.prompt("go");
    expect(resultOf(rt.session, "c1")).toMatchObject({
      isError: false,
      text: "quick\n",
      job: undefined,
    });
  });

  test("a job moved before a /reload keeps running through it, and its end is told once, by the reloaded session", async () => {
    const gate = gateFile();
    const rt = await shellRuntime({
      extensions: [shells],
      respond: script(call(slow(gate), "c1")),
    });
    await rt.session.prompt("go");
    const job = resultOf(rt.session, "c1").job as ShellSnapshot;
    await rt.session.reload();
    expect(groupAlive(pgidOf(job))).toBe(true);
    const delivery = rt.nextDelivery();
    writeFileSync(gate, "");
    expect(await delivery).toContain(`(id ${job.id}): exited with code 4`);
    await rt.session.waitForIdle();
    const told = rt.session.messages.filter(
      (m) => m.role === "custom" && m.customType === "skyr.shell",
    );
    expect(told).toHaveLength(1);
  });

  test("a /reload that steps aside stops the jobs it was handed, for the session's end", async () => {
    const gate = gateFile();
    const rt = await shellRuntime({
      extensions: [shells],
      respond: script(call(slow(gate), "c1")),
    });
    await rt.session.prompt("go");
    const job = resultOf(rt.session, "c1").job as ShellSnapshot;
    const pgid = pgidOf(job);
    writeFileSync(
      join(rt.agentDir, "settings.json"),
      JSON.stringify({ shellPath: "/usr/local/bin/fish" }),
    );
    await rt.session.reload();
    expect(rt.notices).toHaveLength(1);
    expect(groupAlive(pgid)).toBe(false);
    expect(await readOutcome(dirname(job.log))).toMatchObject({
      stopReason: "session",
    });
  });

  test("the widget follows a job and /shells lists and stops it, telling the model without starting a turn", async () => {
    const gate = gateFile();
    const rt = await shellRuntime({
      extensions: [shells],
      respond: script(call(slow(gate), "c1")),
    });
    await rt.session.prompt("go");
    const job = resultOf(rt.session, "c1").job as ShellSnapshot;
    expect(rt.widgets.at(-1)).toEqual([
      expect.stringMatching(
        new RegExp(`^\\$ echo working; until .* · \\d+s · ${job.id}$`),
      ),
    ]);

    await rt.session.prompt("/shells");
    expect(rt.notices.at(-1)).toMatch(
      new RegExp(
        `^${job.id} "echo working; until .*" · running for \\d+s · ${job.log}$`,
      ),
    );
    const requests = rt.requests.length;
    const delivery = rt.nextDelivery();
    await rt.session.prompt("/shells stop all");
    expect(rt.notices.at(-1)).toBe(`shells: stopped ${job.id}`);
    expect(await delivery).toContain("stopped by the user after");
    await rt.session.waitForIdle();
    expect(rt.requests.length).toBe(requests);
    expect(rt.widgets.at(-1)).toBeUndefined();
  });

  test("a nested call (a script's, through executeTool) never moves, however long it runs", async () => {
    const nest = defineTool({
      name: "nest",
      label: "nest",
      description: "Runs bash as a nested call.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const outcome = await ctx.executeTool("bash", {
          command: "sleep 0.4; echo nested-done",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(outcome.result) }],
          details: {},
        };
      },
    }) as unknown as ToolDefinition;
    const rt = await shellRuntime({
      extensions: [shells],
      customTools: [nest],
      respond: script(
        fauxAssistantMessage([fauxToolCall("nest", {}, { id: "n1" })]),
      ),
    });
    await rt.session.prompt("go");
    const { text } = resultOf(rt.session, "n1");
    expect(text).toContain("nested-done");
    expect(text).not.toContain("moved to the background");
  });

  test("quit stops a running job, SIGKILLing one that ignores SIGTERM, and records why", async () => {
    const rt = await shellRuntime({
      extensions: [shells],
      respond: script(
        call(
          "trap '' TERM; echo up; while [ $SECONDS -lt 30 ]; do sleep 0.1; done",
          "c1",
        ),
      ),
    });
    await rt.session.prompt("go");
    const job = resultOf(rt.session, "c1").job as ShellSnapshot;
    const pgid = pgidOf(job);
    expect(groupAlive(pgid)).toBe(true);
    await rt.quit();
    expect(await readOutcome(dirname(job.log))).toMatchObject({
      status: "aborted",
      stopReason: "session",
    });
    expect(groupAlive(pgid)).toBe(false);
  });

  test("bash_stop ends a job the model started, and stays usable when a gate refuses bash", async () => {
    const gate = gateFile();
    let id = "";
    let step = 0;
    const respond: FauxResponseFactory = () => {
      step += 1;
      if (step === 1) return call(slow(gate), "c1");
      if (step === 3)
        return fauxAssistantMessage([
          fauxToolCall("bash", { command: "echo planning" }, { id: "blocked" }),
          fauxToolCall("bash_stop", { id }, { id: "stop" }),
        ]);
      return fauxAssistantMessage("ok");
    };
    let planMode = false;
    const rt = await shellRuntime({
      extensions: [
        shells,
        (pi) => {
          pi.on("tool_call", (event) =>
            planMode && event.toolName === "bash"
              ? { block: true, reason: "plan mode" }
              : undefined,
          );
        },
      ],
      respond,
    });
    await rt.session.prompt("go");
    const job = resultOf(rt.session, "c1").job as ShellSnapshot;
    id = job.id;
    planMode = true;
    await rt.session.prompt("now stop it");
    expect(resultOf(rt.session, "blocked").isError).toBe(true);
    const stop = resultOf(rt.session, "stop");
    expect(stop.isError).toBe(false);
    expect(stop.text).toMatch(
      new RegExp(
        `^Stopped job ${id} "echo working; until .*" after \\d+s \\(SIGTERM; exit code 143\\)\\. Last output:\\nworking\\nLog: ${job.log}$`,
      ),
    );
    expect(stop.details).toMatchObject({
      id,
      status: "aborted",
      stopReason: "agent",
    });
    expect(groupAlive(pgidOf(job))).toBe(false);
  });

  test("bash_stop's annotations are ones Pi's own gate predicate does not prompt on", async () => {
    const rt = await shellRuntime({ extensions: [shells] });
    const annotations = rt.session.getToolDefinition("bash_stop")?.annotations;
    expect(annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // The predicate from the extension docs
    const prompts =
      annotations?.destructiveHint === true ||
      (!annotations?.readOnlyHint &&
        ((annotations?.destructiveHint ?? true) ||
          (annotations?.openWorldHint ?? true)));
    expect(prompts).toBe(false);
  });
});

describe("bash_stop's place in the active tools", () => {
  test("it is active after /new and /resume, and after /tree restores a loadout without it", async () => {
    const rt = await shellRuntime({
      extensions: [shells],
      respond: () => fauxAssistantMessage("ok"),
    });
    const first = rt.session.sessionFile as string;
    await rt.session.prompt("one");
    const earlier = rt.session.sessionManager.getLeafId() as string;
    rt.session.setActiveToolsByName(
      rt.session.getActiveToolNames().filter((n) => n !== "bash_stop"),
    );
    await rt.session.prompt("two");
    const later = rt.session.sessionManager.getLeafId() as string;

    await rt.session.navigateTree(earlier, { summarize: false });
    await rt.session.navigateTree(later, { summarize: false });
    expect(rt.session.getActiveToolNames()).toContain("bash_stop");

    await rt.newSession();
    expect(rt.session.getActiveToolNames()).toContain("bash_stop");
    await rt.resume(first);
    expect(rt.session.getActiveToolNames()).toContain("bash_stop");
  });

  test("a session resumed after skyr stepped aside has no bash_stop, active or registered", async () => {
    const rt = await shellRuntime({
      extensions: [shells],
      respond: () => fauxAssistantMessage("ok"),
    });
    await rt.session.prompt("one");
    const file = rt.session.sessionFile as string;
    expect(rt.session.getActiveToolNames()).toContain("bash_stop");

    writeFileSync(
      join(rt.agentDir, "settings.json"),
      JSON.stringify({ shellPath: "/usr/local/bin/fish" }),
    );
    await rt.resume(file);
    expect(bashInEffect(rt.session)?.sourceInfo.source).toBe("builtin");
    expect(rt.session.getActiveToolNames()).not.toContain("bash_stop");
    expect(tool(rt.session, "bash_stop")).toBeUndefined();
    expect(rt.notices).toHaveLength(1);
  });

  test("no setActiveTools call from the shells takes a tool away, across start, reload, /new and /resume", async () => {
    const calls: [before: string[], requested: string[]][] = [];
    const rt = await shellRuntime({
      extensions: [
        shellsWith({ limitMs: 100, graceMs: 50 }, (before, requested) =>
          calls.push([before, requested]),
        ),
      ],
      respond: () => fauxAssistantMessage("ok"),
    });
    const first = rt.session.sessionFile as string;
    await rt.session.prompt("one");
    await rt.session.reload();
    await rt.newSession();
    await rt.resume(first);
    expect(calls.length).toBeGreaterThan(0);
    for (const [before, requested] of calls)
      expect(requested).toEqual(expect.arrayContaining(before));
  });
});

describe("the message a job's end is delivered in", () => {
  test("is drawn one sanitized line per line, with no escape sequence that came from the job's output", async () => {
    const piModule = await loadPi();
    const renderers: Record<string, (...args: never[]) => unknown> = {};
    wireShells(
      {
        on: () => {},
        registerCommand: () => {},
        registerMessageRenderer: (
          type: string,
          fn: (typeof renderers)[string],
        ) => {
          renderers[type] = fn;
        },
      } as unknown as ExtensionAPI,
      piModule,
      "owner-token",
    );
    const render = renderers["skyr.shell"] as unknown as (
      message: unknown,
      options: { expanded: boolean; outputPad: number },
      theme: unknown,
    ) => { render(width: number): string[] };
    const theme = {
      bg: (_color: string, text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    const hostile = [
      '[background job "x" (id ab12cd34): exited with code 0 after 1s]',
      "evil \u001b]52;c;aGVsbG8=\u0007 clipboard \u001b[31mred\u001b[0m \u202eRTL",
    ].join("\n");
    const box = render(
      { content: [{ type: "text", text: hostile }] },
      { expanded: true, outputPad: 1 },
      theme,
    );
    const lines = box.render(80);
    expect(lines.join("\n")).toContain("evil");
    const drawn = lines.join("\n");
    for (const hidden of ["\u001b", "\u0007", "\u202e"])
      expect(drawn.includes(hidden)).toBe(false);
  });
});
