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

  onTestFinished(async () => {
    await runtime.dispose();
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get session() {
      return runtime.session;
    },
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
