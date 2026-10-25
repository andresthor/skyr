import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createBashToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { registerSkyr } from "../src/index.js";
import { loadPi } from "../src/pi.js";
import { registerShells } from "../src/shells/index.js";
import { bashInEffect, shellRuntime } from "./shells-runtime.js";

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
    "%s mode serves bash from skyr and registers bash_stop inactive",
    async (mode) => {
      const rt = await shellRuntime({ mode });
      expect(skyrServesBash(rt.session)).toBe(true);
      expect(rt.session.getActiveToolNames()).toContain("bash");
      expect(tool(rt.session, "bash_stop")).toBeDefined();
      expect(rt.session.getActiveToolNames()).not.toContain("bash_stop");
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

  test("bash_stop says no jobs exist yet", async () => {
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
    ).rejects.toThrow("bash_stop: no background jobs exist yet.");
  });
});

/** A host that answers what `registerShells` asks, so a case Pi's own tools cannot produce is reachable. */
async function sessionStart(o: {
  tools?: Partial<ToolInfo>[];
  parameters?: string[];
  mode?: ExtensionContext["mode"];
  path?: string;
}) {
  const piModule = await loadPi();
  const handlers: ((event: unknown, ctx: ExtensionContext) => void)[] = [];
  const registered: string[] = [];
  const notices: string[] = [];
  const parameters = Type.Object(
    Object.fromEntries(
      (o.parameters ?? ["command", "timeout"]).map((k) => [k, Type.String()]),
    ),
  );
  const pi = {
    on: (_event: string, fn: (typeof handlers)[number]) => handlers.push(fn),
    getSettings: () => ({}),
    getAllTools: () => o.tools ?? [],
    registerTool: (t: { name: string }) => registered.push(t.name),
  } as unknown as ExtensionAPI;
  registerShells(pi, {
    ...piModule,
    createBashToolDefinition: (cwd: string, opts?: never) => ({
      ...piModule.createBashToolDefinition(cwd, opts),
      parameters,
    }),
  } as unknown as typeof piModule);
  const previous = process.env.PATH;
  if (o.path !== undefined) process.env.PATH = o.path;
  try {
    handlers[0]?.({}, {
      mode: o.mode ?? "tui",
      cwd: process.cwd(),
      ui: { notify: (m: string) => notices.push(m) },
    } as unknown as ExtensionContext);
  } finally {
    process.env.PATH = previous;
  }
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
