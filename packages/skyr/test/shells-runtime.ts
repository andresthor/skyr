import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  defineTool,
  type EventBus,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { onTestFinished } from "vitest";
import type { BarHandle, BarSource, BarTab } from "../src/chrome/bar.js";
import { registerSkyr } from "../src/index.js";
import { loadPi } from "../src/pi.js";
import { type ShellsDeps, wireShells } from "../src/shells/index.js";
import { identify } from "../src/shells/job.js";
import { registerWebFetch } from "../src/tools/web-fetch.js";
import { textOf, widgetHost } from "./session.js";

/** A bar that draws nothing, for a test that does not look at it. */
export const NO_BAR: BarHandle = {
  attach: () => () => {},
  open: () => undefined,
  slotTarget: () => undefined,
};

/** A bar that keeps the sources attached to it and the tabs it was opened on. */
export function recordingBar() {
  const attached = new Set<BarSource>();
  const opened: BarTab[] = [];
  const bar: BarHandle = {
    attach(source) {
      attached.add(source);
      return () => void attached.delete(source);
    },
    open: (tab) => {
      opened.push(tab);
      return undefined;
    },
    slotTarget: () => undefined,
  };
  return { bar, attached, opened };
}

/**
 * skyr's shells alone, with their test seams. `web_fetch` is registered because skyr's reload
 * recognises its own `bash` by the file that registered it. `spy` sees every `setActiveTools`
 * the shells make, with the set that was active just before.
 */
export function shellsWith(
  deps: ShellsDeps,
  spy?: (before: string[], requested: string[]) => void,
  bar: BarHandle = NO_BAR,
): ExtensionFactory {
  return async (pi) => {
    registerWebFetch(pi);
    const seen = spy
      ? new Proxy(pi, {
          get: (target, key) =>
            key === "setActiveTools"
              ? (names: string[]) => {
                  spy(target.getActiveTools(), names);
                  target.setActiveTools(names);
                }
              : Reflect.get(target, key),
        })
      : pi;
    wireShells(
      seen,
      await loadPi(),
      (await identify(process.pid))?.token,
      bar,
      deps,
    );
  };
}

export interface ShellRuntime {
  /** The current session; `/new` and `/resume` replace it. */
  session: AgentSession;
  notices: string[];
  requests: TranscriptContext[];
  /** `structuredContent` of each tool result, by tool-call id. */
  structured: Map<string, unknown>;
  /** Each partial result Pi streamed, by tool-call id. */
  updates: Map<string, unknown[]>;
  /** The agent dir the session's settings are read from. */
  agentDir: string;
  /** The text of the next message skyr delivers about a background job. */
  nextDelivery(): Promise<string>;
  /** Ends the session as `/quit` does, awaiting every `session_shutdown` handler. */
  quit(): Promise<void>;
  newSession(): Promise<void>;
  resume(file: string): Promise<void>;
}

/**
 * A session built the way Pi's modes build one, through `createAgentSessionRuntime`, so `/new`
 * and `/resume` make fresh extension instances. It is bound to a UI, because Pi emits
 * `session_start` after a reload only for a bound session; the default mode is `tui`.
 */
export async function shellRuntime(
  o: {
    respond?: FauxResponseFactory;
    /** In load order; skyr is `registerSkyr`, so a test places others before or after it. */
    extensions?: ExtensionFactory[];
    settings?: Record<string, unknown>;
    customTools?: ToolDefinition[];
    /** The bus every session's extensions share, so a test can play an ACP host on it. */
    eventBus?: EventBus;
    mode?: ExtensionContext["mode"];
  } = {},
): Promise<ShellRuntime> {
  const root = mkdtempSync(join(tmpdir(), "skyr-test-shells-"));
  const [cwd, agentDir, sessionDir] = ["cwd", "agent", "sessions"].map((n) => {
    const dir = join(root, n);
    mkdirSync(dir);
    return dir;
  }) as [string, string, string];
  const restoreAgentDir = useAgentDir(agentDir);
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
      ...o.settings,
    }),
  );

  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const requests: TranscriptContext[] = [];
  const respond = o.respond ?? (() => fauxAssistantMessage("done"));
  faux.setResponses(
    // Faux consumes one response per request; more than any test makes
    Array.from({ length: 50 }, () => (context, ...rest) => {
      requests.push(context);
      return respond(context, ...rest);
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });

  const structured = new Map<string, unknown>();
  const updates = new Map<string, unknown[]>();
  const record: ExtensionFactory = (pi) => {
    pi.on("tool_result", (e) => {
      structured.set(e.toolCallId, structuredClone(e.structuredContent));
    });
    pi.on("tool_execution_update", (e) => {
      updates.set(e.toolCallId, [
        ...(updates.get(e.toolCallId) ?? []),
        structuredClone(e.partialResult),
      ]);
    });
  };

  const create: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [...(o.extensions ?? [registerSkyr]), record],
        eventBus: o.eventBus,
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: faux.getModel(),
      customTools: o.customTools,
    });
    return { ...created, services, diagnostics: [] };
  };

  const notices: string[] = [];
  const { setWidget } = widgetHost();
  const ui = {
    setWidget,
    notify: (message: string) => notices.push(message),
  } as unknown as ExtensionUIContext;
  const bind = (session: AgentSession) =>
    session.bindExtensions({ uiContext: ui, mode: o.mode ?? "tui" });

  const runtime = await createAgentSessionRuntime(create, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, sessionDir),
  });
  runtime.setRebindSession(bind);
  await bind(runtime.session);

  let quit: Promise<void> | undefined;
  const dispose = () => {
    quit ??= runtime.dispose();
    return quit;
  };
  // Restored only after the shutdown handlers ran: they find their jobs under the agent dir
  onTestFinished(async () => {
    await dispose();
    restoreAgentDir();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get session() {
      return runtime.session;
    },
    agentDir,
    quit: dispose,
    nextDelivery: () =>
      new Promise((resolve) => {
        const off = runtime.session.subscribe((event) => {
          if (
            event.type === "message_end" &&
            event.message.role === "custom" &&
            event.message.customType === "skyr.shell"
          ) {
            off();
            resolve(textOf(event.message as never));
          }
        });
        onTestFinished(off);
      }),
    notices,
    requests,
    structured,
    updates,
    newSession: async () => void (await runtime.newSession()),
    resume: async (file: string) => void (await runtime.switchSession(file)),
  };
}

/** Points `getAgentDir()` at `dir`; the returned function puts the previous one back. */
export function useAgentDir(dir: string): () => void {
  // test/setup.ts always sets one
  const previous = process.env.PI_CODING_AGENT_DIR as string;
  process.env.PI_CODING_AGENT_DIR = dir;
  return () => {
    process.env.PI_CODING_AGENT_DIR = previous;
  };
}

export const toolNamed = (session: AgentSession, name: string) =>
  session.getAllTools().find((t) => t.name === name);

/** skyr registers `bash` and `bash_stop` together, so the same extension file provides both. */
export function skyrServesBash(session: AgentSession): boolean {
  const bash = toolNamed(session, "bash");
  return (
    bash?.sourceInfo.source !== "builtin" &&
    bash?.sourceInfo.path === toolNamed(session, "bash_stop")?.sourceInfo.path
  );
}

/** A tool that runs `bash` with `args` as a nested call, as a codemode script does; its text is `show(outcome)`. */
export function nestTool(
  args: Record<string, unknown>,
  show: (outcome: unknown) => unknown = (outcome) => outcome,
): ToolDefinition {
  return defineTool({
    name: "nest",
    label: "nest",
    description: "Runs bash as a nested call.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const outcome = await ctx.executeTool("bash", args);
      return {
        content: [{ type: "text", text: JSON.stringify(show(outcome)) }],
        details: undefined,
      };
    },
  }) as unknown as ToolDefinition;
}
