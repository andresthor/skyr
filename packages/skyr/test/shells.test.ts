import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createBashToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, onTestFinished, test } from "vitest";
import { registerSkyr } from "../src/index.js";
import { loadPi } from "../src/pi.js";
import { registerShells, wireShells } from "../src/shells/index.js";
import { groupAlive, readOutcome } from "../src/shells/job.js";
import type { ShellSnapshot } from "../src/shells/store.js";
import { expectInert, HOSTILE, scratchDir, script } from "./session.js";
import { gated, gateFile } from "./shells-jobs.js";
import {
  nestTool,
  shellRuntime,
  shellsWith,
  skyrServesBash,
  toolNamed,
  useAgentDir,
} from "./shells-runtime.js";

const replacement = {
  ...createBashToolDefinition(process.cwd()),
  description: "replacement bash",
};
const replacer: ExtensionFactory = (pi) => pi.registerTool(replacement);
/** An extension API of only `parts`; whatever else is asked for is a no-op. */
const fakePi = (parts: Record<string, unknown>) =>
  new Proxy(parts, {
    get: (target, key: string) => target[key] ?? (() => {}),
  }) as unknown as ExtensionAPI;
const FISH = { shellPath: "/usr/local/bin/fish" };

describe("registerShells in a session", () => {
  test.each([
    ["print", false],
    ["json", false],
    ["tui", true],
    ["rpc", true],
  ] as const)("%s mode serves bash from skyr: %s", async (mode, serves) => {
    const rt = await shellRuntime({ mode });
    expect(skyrServesBash(rt.session)).toBe(serves);
    expect(toolNamed(rt.session, "bash_stop") !== undefined).toBe(serves);
    expect(rt.notices).toEqual([]);
  });

  test.each([
    ["loaded before skyr", { extensions: [replacer, registerSkyr] }],
    ["loaded after skyr", { extensions: [registerSkyr, replacer] }],
    [
      "from the SDK's customTools",
      { customTools: [replacement as unknown as ToolDefinition] },
    ],
  ])(
    "a bash another extension provides, %s, stays in effect",
    async (_how, o) => {
      const rt = await shellRuntime(o);
      expect(toolNamed(rt.session, "bash")?.description).toBe(
        "replacement bash",
      );
      expect(toolNamed(rt.session, "bash_stop")).toBeUndefined();
      expect(rt.notices).toHaveLength(1);
      expect(rt.notices[0]).toContain("another extension provides bash");
    },
  );

  test("a reload, /new and /resume each keep serving bash without mistaking it for another extension's", async () => {
    const rt = await shellRuntime();
    const first = rt.session.sessionFile as string;
    await rt.session.reload();
    await rt.session.reload();
    expect(skyrServesBash(rt.session)).toBe(true);
    await rt.newSession();
    expect(skyrServesBash(rt.session)).toBe(true);
    await rt.resume(first);
    expect(skyrServesBash(rt.session)).toBe(true);
    expect(rt.notices).toEqual([]);
  });
});

/** A host that answers what `registerShells` asks, so a case Pi's own tools cannot produce is reachable. */
async function sessionStart(
  o: {
    parameters?: string[];
    noPs?: boolean;
    /** What `identify(process.pid)` gave; default a token. */
    self?: string | undefined;
    /** A file where the agent dir should be, so nothing can be created under it. */
    agentDirIsFile?: boolean;
    settings?: Record<string, unknown>;
    platform?: NodeJS.Platform;
  } = {},
) {
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
  onTestFinished(useAgentDir(agentDir));
  const pi = fakePi({
    on: (
      event: string,
      fn: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => handlers.set(event, fn),
    getSettings: () => o.settings ?? {},
    getAllTools: () => [],
    getActiveTools: () => ["bash"],
    registerTool: (t: { name: string }) => registered.push(t.name),
  });
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
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    ui: { notify: (m: string) => notices.push(m) },
    sessionManager: { getSessionId: () => "s1" },
    isIdle: () => true,
  } as unknown as ExtensionContext;
  const [path, platform] = [process.env.PATH, process.platform];
  if (o.noPs) process.env.PATH = scratchDir("nops");
  if (o.platform)
    Object.defineProperty(process, "platform", { value: o.platform });
  try {
    await handlers.get("session_start")?.({}, ctx);
  } finally {
    process.env.PATH = path;
    Object.defineProperty(process, "platform", { value: platform });
  }
  onTestFinished(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
  });
  return { registered, notices };
}

describe("registerShells step-aside", () => {
  test.each([
    [
      "a shellPath that is not a POSIX shell",
      { settings: FISH },
      "shellPath names fish, which is not a POSIX shell",
    ],
    [
      "Pi's bash taking other parameters",
      { parameters: ["command", "timeout", "cwd"] },
      "this Pi's bash takes command, timeout, cwd, not command and timeout",
    ],
    ["a missing ps", { noPs: true }, "ps is not on PATH"],
    [
      "a Pi process ps cannot identify",
      { self: undefined },
      "ps cannot identify this Pi process",
    ],
    [
      "a pid-file dir that cannot be created",
      { agentDirIsFile: true },
      ".pending cannot be created",
    ],
  ])("%s registers nothing and says why", async (_why, o, cause) => {
    const host = await sessionStart(o);
    expect(host.registered).toEqual([]);
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0]).toMatch(
      /^skyr: background shells are off because .+; bash is left as it is\.$/,
    );
    expect(host.notices[0]).toContain(cause);
  });

  test.each([
    ["with nothing in the way, both tools register", {}, ["bash", "bash_stop"]],
    ["on win32, nothing registers", { platform: "win32" }, []],
  ] as const)("%s, and nothing is said", async (_case, o, tools) => {
    const host = await sessionStart(o);
    expect(host.registered).toEqual(tools);
    expect(host.notices).toEqual([]);
  });
});

// Only the shells' session_start handler waits on Pi; a host that does not await it misses that.
test("registerSkyr registers its other tools before it awaits Pi", () => {
  const names: string[] = [];
  const pending = registerSkyr(
    fakePi({ registerTool: (t: { name: string }) => names.push(t.name) }),
  );
  expect(names).toEqual(expect.arrayContaining(["web_fetch", "subagent"]));
  return pending;
});

// Jobs, through a real session. The limit is 100 ms and every command waits on a gate file.
const slow = (gate: string) =>
  `echo working; ${gated(gate)}; echo finished; exit 4`;
const call = (command: string, id: string, more = {}) =>
  fauxAssistantMessage([fauxToolCall("bash", { command, ...more }, { id })]);
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

/** A session whose first prompt runs `slow` past the limit, so it comes back as a moved job. */
async function runningJob() {
  const gate = gateFile();
  const command = slow(gate);
  const rt = await shellRuntime({
    extensions: [shells],
    respond: script(call(command, "c1")),
  });
  await rt.session.prompt("go");
  const moved = resultOf(rt.session, "c1");
  return { rt, gate, command, moved, job: moved.job as ShellSnapshot };
}

describe("a slow bash call in a session", () => {
  test("moves at the limit, keeps running through Esc, and its end reaches the model as a message that starts a turn", async () => {
    const { rt, gate, command, moved, job } = await runningJob();
    expect(moved.isError).toBe(false);
    expect(job).toMatchObject({ command, status: "running" });
    expect(moved.text).toBe(
      `working\n\nStill running after 0.1 s; moved to the background as job ${job.id} in ${job.cwd}. Full log: ${job.log}. You will be told automatically when it ends: do not sleep, poll or re-read the log to wait. Keep working on anything that does not depend on it; if nothing does, end your turn. Stop it with bash_stop {"id":"${job.id}"}.`,
    );

    await rt.session.abort();
    expect(groupAlive(pgidOf(job))).toBe(true);

    const delivery = rt.nextDelivery();
    writeFileSync(gate, "");
    expect(await delivery).toContain("exited with code 4");
    await rt.session.waitForIdle();
    expect(JSON.stringify(rt.requests.at(-1)?.messages)).toContain(
      "exited with code 4",
    );
  });

  test("background: true starts a job at once, and its end is told like any other", async () => {
    const gate = gateFile();
    const rt = await shellRuntime({
      extensions: [shellsWith({ limitMs: 60_000, graceMs: 50 })],
      respond: script(call(slow(gate), "bg", { background: true })),
    });
    await rt.session.prompt("go");
    const started = resultOf(rt.session, "bg");
    const job = started.job as ShellSnapshot;
    expect(started.isError).toBe(false);
    expect(started.text).toContain(
      `moved to the background as job ${job.id} in ${job.cwd}`,
    );
    expect(started.text).toContain(
      "You will be told automatically when it ends: do not sleep, poll or re-read the log to wait.",
    );
    expect(groupAlive(pgidOf(job))).toBe(true);
    const delivery = rt.nextDelivery();
    writeFileSync(gate, "");
    expect(await delivery).toContain(`(id ${job.id}): exited with code 4`);
  });

  test.each([
    [
      "a background call is refused with what to do instead",
      { command: "true", background: true },
      "background is not available inside another tool's call",
    ],
    [
      "a call outlasting the limit never moves",
      { command: "sleep 0.25; echo nested-done" },
      "nested-done",
    ],
  ])("a nested call: %s", async (_case, args, expected) => {
    const rt = await shellRuntime({
      extensions: [shells],
      customTools: [nestTool(args)],
      respond: script(
        fauxAssistantMessage([fauxToolCall("nest", {}, { id: "n1" })]),
      ),
    });
    await rt.session.prompt("go");
    const { text } = resultOf(rt.session, "n1");
    expect(text).toContain(expected);
    expect(text).not.toContain("moved to the background as job");
  });

  test("two calls in one message move as two jobs, each result paired with its own call, and end separately", async () => {
    const gates = [gateFile(), gateFile()];
    const commands = gates.map(slow);
    const rt = await shellRuntime({
      extensions: [shells],
      respond: script(
        fauxAssistantMessage(
          commands.map((command, i) =>
            fauxToolCall("bash", { command }, { id: `call${i}` }),
          ),
        ),
      ),
    });
    await rt.session.prompt("go");
    const jobs = commands.map((command, i) => {
      const { job } = resultOf(rt.session, `call${i}`);
      expect(job?.command).toBe(command);
      return job as ShellSnapshot;
    });
    expect(jobs[0]?.id).not.toBe(jobs[1]?.id);

    for (const [i, gate] of gates.entries()) {
      const delivered = rt.nextDelivery();
      writeFileSync(gate, "");
      expect(await delivered).toContain(`(id ${jobs[i]?.id})`);
      await rt.session.waitForIdle();
    }
  });

  test("a job moved before a /reload keeps running through it, and its end is told once, by the reloaded session", async () => {
    const { rt, gate, job } = await runningJob();
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
    const { rt, job } = await runningJob();
    const pgid = pgidOf(job);
    writeFileSync(join(rt.agentDir, "settings.json"), JSON.stringify(FISH));
    await rt.session.reload();
    expect(rt.notices).toHaveLength(1);
    expect(groupAlive(pgid)).toBe(false);
    expect(await readOutcome(dirname(job.log))).toMatchObject({
      stopReason: "session",
    });
  });

  test("the widget follows a job and /shells lists and stops it, telling the model without starting a turn", async () => {
    const { rt, job } = await runningJob();
    expect(rt.widgets.at(-1)?.join("\n")).toContain(job.id);

    await rt.session.prompt("/shells");
    expect(rt.notices.at(-1)).toContain(job.id);
    expect(rt.notices.at(-1)).toContain(job.log);
    const requests = rt.requests.length;
    const delivery = rt.nextDelivery();
    await rt.session.prompt("/shells stop all");
    expect(rt.notices.at(-1)).toBe(`shells: stopped ${job.id}`);
    expect(await delivery).toContain("stopped by the user after");
    await rt.session.waitForIdle();
    expect(rt.requests.length).toBe(requests);
    expect(rt.widgets.at(-1)).toBeUndefined();
  });

  test("quit stops a running job and records why", async () => {
    const { rt, job } = await runningJob();
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
    let reply = call(slow(gateFile()), "c1");
    const rt = await shellRuntime({
      extensions: [
        shells,
        (pi) => {
          pi.on("tool_call", (e) =>
            e.toolCallId === "blocked"
              ? { block: true, reason: "plan mode" }
              : undefined,
          );
        },
      ],
      respond: () => {
        const next = reply;
        reply = fauxAssistantMessage("ok");
        return next;
      },
    });
    await rt.session.prompt("go");
    const job = resultOf(rt.session, "c1").job as ShellSnapshot;
    const { id } = job;
    reply = fauxAssistantMessage([
      fauxToolCall("bash", { command: "echo planning" }, { id: "blocked" }),
      fauxToolCall("bash_stop", { id }, { id: "stop" }),
    ]);
    await rt.session.prompt("now stop it");
    expect(resultOf(rt.session, "blocked").isError).toBe(true);
    const stop = resultOf(rt.session, "stop");
    expect(stop.isError).toBe(false);
    expect(stop.details).toMatchObject({
      id,
      status: "aborted",
      stopReason: "agent",
    });
    expect(groupAlive(pgidOf(job))).toBe(false);

    // Pi's own gate predicate, from the extension docs: it must not prompt on bash_stop
    const annotations = rt.session.getToolDefinition("bash_stop")?.annotations;
    expect(
      annotations?.destructiveHint === true ||
        (!annotations?.readOnlyHint &&
          ((annotations?.destructiveHint ?? true) ||
            (annotations?.openWorldHint ?? true))),
    ).toBe(false);
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

    writeFileSync(join(rt.agentDir, "settings.json"), JSON.stringify(FISH));
    await rt.resume(file);
    expect(skyrServesBash(rt.session)).toBe(false);
    expect(rt.session.getActiveToolNames()).not.toContain("bash_stop");
    expect(toolNamed(rt.session, "bash_stop")).toBeUndefined();
    expect(rt.notices).toHaveLength(1);
  });

  test("no tool is taken away from the model across start, reload, /new and /resume", async () => {
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
    await rt.session.prompt("two");
    await rt.session.reload();
    await rt.newSession();
    await rt.resume(first);
    await rt.session.prompt("three");
    expect(calls.length).toBeGreaterThan(0);
    for (const [before, requested] of calls)
      expect(requested).toEqual(expect.arrayContaining(before));
    const removed = rt.requests.flatMap((context) =>
      context.messages.flatMap((m) =>
        m.role === "system" ? (m.toolsRemoved ?? []) : [],
      ),
    );
    expect(removed).toEqual([]);
  });
});

test("the message a job's end is delivered in is drawn with no escape sequence from the job's output", async () => {
  let draw!: (
    message: unknown,
    options: object,
    theme: object,
  ) => { render(width: number): string[] };
  wireShells(
    fakePi({
      registerMessageRenderer: (type: string, fn: typeof draw) => {
        if (type === "skyr.shell") draw = fn;
      },
    }),
    await loadPi(),
    "owner-token",
  );
  const plain = (_color: string, text: string) => text;
  const text = `[background job "x" (id ab12cd34): exited with code 0 after 1s]\n${HOSTILE}`;
  const lines = draw(
    { content: [{ type: "text", text }] },
    { expanded: true, outputPad: 1 },
    { bg: plain, fg: plain },
  ).render(80);
  expect(lines.join("\n")).toContain("evil");
  expect(lines.join("\n")).not.toContain("\u001b");
  expectInert(lines, 80);
});
