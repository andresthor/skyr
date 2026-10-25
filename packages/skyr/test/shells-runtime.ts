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
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { onTestFinished } from "vitest";
import { registerSkyr } from "../src/index.js";
import { loadPi } from "../src/pi.js";
import { type ShellsDeps, wireShells } from "../src/shells/index.js";
import { identify } from "../src/shells/job.js";
import { registerWebFetch } from "../src/tools/web-fetch.js";

/**
 * skyr's shells alone, with their test seams. `web_fetch` is registered because skyr's reload
 * recognises its own `bash` by the file that registered it. `spy` sees every `setActiveTools`
 * the shells make, with the set that was active just before.
 */
export function shellsWith(
  deps: ShellsDeps,
  spy?: (before: string[], requested: string[]) => void,
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
      deps,
    );
  };
}

export interface ShellRuntime {
  /** The current session; `/new` and `/resume` replace it. */
  session: AgentSession;
  notices: string[];
  /** Every request the model received. */
  requests: TranscriptContext[];
  /** `structuredContent` of each tool result, by tool-call id. */
  structured: Map<string, unknown>;
  /** Each partial result Pi streamed, by tool-call id. */
  updates: Map<string, unknown[]>;
  /** The agent dir the session's settings are read from. */
  agentDir: string;
  /** Resolves with the text of the next message skyr delivers about a background job. */
  nextDelivery(): Promise<string>;
  /** Ends the session as `/quit` does, awaiting every `session_shutdown` handler. */
  quit(): Promise<void>;
  /** `/new`, bound to a UI as Pi's modes do. */
  newSession(): Promise<void>;
  /** `/resume` of an earlier session file. */
  resume(file: string): Promise<void>;
}

/**
 * A session built the way Pi's modes build one, through `createAgentSessionRuntime`, so `/new`
 * and `/resume` make a fresh set of services and extension instances. It is bound to a UI,
 * because Pi emits `session_start` after a reload only for a bound session; the default
 * mode is `tui`, never the print mode extensions see unbound. Disposed when the test ends.
 */
export async function shellRuntime(
  o: {
    respond?: FauxResponseFactory;
    /** In load order; skyr is `registerSkyr`, so a test places others before or after it. */
    extensions?: ExtensionFactory[];
    /** Written into the agent dir's settings.json. */
    settings?: Record<string, unknown>;
    customTools?: ToolDefinition[];
    mode?: ExtensionContext["mode"];
  } = {},
): Promise<ShellRuntime> {
  const root = mkdtempSync(join(tmpdir(), "skyr-test-shells-"));
  const [cwd, agentDir, sessionDir] = ["cwd", "agent", "sessions"].map((n) => {
    const dir = join(root, n);
    mkdirSync(dir);
    return dir;
  }) as [string, string, string];
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
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
  faux.setResponses(
    Array.from({ length: 50 }, () => (context, ...rest) => {
      requests.push(context);
      return (o.respond ?? (() => fauxAssistantMessage("done")))(
        context,
        ...rest,
      );
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

  const create = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: Parameters<
      typeof createAgentSessionFromServices
    >[0]["sessionStartEvent"];
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
  const ui = {
    setWidget: () => {},
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
  onTestFinished(async () => {
    await dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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
            const { content } = event.message;
            resolve(
              typeof content === "string"
                ? content
                : content
                    .map((c) => (c.type === "text" ? c.text : ""))
                    .join(""),
            );
          }
        });
      }),
    notices,
    requests,
    structured,
    updates,
    async newSession() {
      await runtime.newSession();
    },
    async resume(file: string) {
      await runtime.switchSession(file);
    },
  };
}

/** The `bash` Pi has in effect, with where it came from. */
export function bashInEffect(session: AgentSession) {
  return session.getAllTools().find((t) => t.name === "bash");
}
