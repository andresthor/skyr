import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  CONFIG_DIR_NAME,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { onTestFinished } from "vitest";
import { registerSkyr } from "../src/index.js";

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `skyr-test-${name}-`));

export interface Parent {
  session: AgentSession;
  cwd: string;
  agentDir: string;
  /** Every request faux received, from the parent and from any child on its provider. */
  requests: TranscriptContext[];
  /** Every footer status skyr set, in order; `undefined` clears it. */
  status: (string | undefined)[];
  notices: string[];
}

/**
 * A parent session on a faux model with skyr loaded and nothing ambient; disposed when the
 * test ends. `PI_CODING_AGENT_DIR` points at this test's agent dir until then, so a child
 * built from `getAgentDir()` reads the same settings and extensions dir.
 */
export async function parentSession(o: {
  /** Answers every request; faux consumes steps in arrival order, so route by content. */
  respond: FauxResponseFactory;
  customTools?: ToolDefinition[];
  /** Agent files by file name, written to the user's and the repo's agents dirs. */
  userAgents?: Record<string, string>;
  repoAgents?: Record<string, string>;
}): Promise<Parent> {
  const cwd = tmp("cwd");
  const sessionDir = tmp("sessions");
  const agentDir = tmp("agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Retries would replay a step meant for the next request; compaction adds unscripted ones.
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );

  writeAll(join(agentDir, "agents"), o.userAgents);
  writeAll(join(cwd, CONFIG_DIR_NAME, "agents"), o.repoAgents);

  // A second model, for an agent file that names one.
  const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
  const requests: TranscriptContext[] = [];
  faux.setResponses(
    Array.from({ length: 200 }, () => (context, ...rest) => {
      requests.push(context);
      return o.respond(context, ...rest);
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

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
    extensionFactories: [registerSkyr],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    settingsManager,
    sessionManager: SessionManager.create(cwd, sessionDir),
    resourceLoader,
    customTools: o.customTools,
  });
  const status: (string | undefined)[] = [];
  const notices: string[] = [];
  // Own keys only: Pi spreads the UI object. Pi itself calls none of the other methods.
  const uiContext = {
    setStatus: (_key: string, text: string | undefined) => status.push(text),
    notify: (message: string) => notices.push(message),
  } as unknown as ExtensionUIContext;
  await session.bindExtensions({ uiContext });

  onTestFinished(() => {
    session.dispose();
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const dir of [cwd, sessionDir, agentDir])
      rmSync(dir, { recursive: true, force: true });
  });
  return { session, cwd, agentDir, requests, status, notices };
}

/** A temp directory, removed when the test ends. */
export function scratchDir(name: string): string {
  const dir = tmp(name);
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const agentFile = (description: string, fields = "") =>
  `---\ndescription: ${description}\n${fields}---\nYou are a test agent.\n`;

export function textOf(message: TranscriptContext["messages"][number]): string {
  const { content } = message;
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** The first user message: "go" for the parent, the task for a child. */
export const taskOf = (context: TranscriptContext) => {
  const first = context.messages.find((m) => m.role === "user");
  return first ? textOf(first) : "";
};

/** The system prompt sections a child was given, by name; `{}` when there are none. */
export function sections(
  context: TranscriptContext,
): Record<string, string | null> {
  const first = context.messages[0];
  return first?.role === "system" ? (first.sections ?? {}) : {};
}

/** A `subagent` call whose id is its task, so results can be looked up by task. */
export function call(params: {
  task: string;
  agent?: string;
  description?: string;
  prompt?: string;
  tools?: string[];
  model?: string;
  cwd?: string;
}) {
  const args = Object.fromEntries(
    Object.entries({
      description: `run ${params.agent ?? params.task}`,
      ...params,
    }).filter(([, value]) => value !== undefined),
  );
  return fauxToolCall("subagent", args, { id: params.task });
}

/** The parent makes `calls` on its first turn and then answers "done"; children get `child`. */
export function router(
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

/** The parent's tool results by tool-call id, which `call` sets to the task. */
export function results(session: AgentSession) {
  return new Map(
    session.messages.flatMap((m) =>
      m.role === "toolResult" ? [[m.toolCallId, m] as const] : [],
    ),
  );
}

function writeAll(dir: string, files: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
}

/** A faux step that answers only after `release()`, or as aborted once its request is. */
export function hold(): {
  step: FauxResponseFactory;
  entered: Promise<void>;
  release(): void;
} {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const released = new Promise<void>((r) => {
    release = r;
  });
  const step: FauxResponseFactory = async (_context, options) => {
    enter();
    const signal = options?.signal;
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
      void released.then(resolve);
    });
    return signal?.aborted
      ? fauxAssistantMessage("", { stopReason: "aborted" })
      : fauxAssistantMessage("released");
  };
  return { step, entered, release };
}

/** The tools the model was offered: Pi declares them in system messages, not `context.tools`. */
export function toolsSeen(context: TranscriptContext): string[] {
  const tools = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const t of message.toolsRemoved ?? []) tools.delete(t.name);
    for (const t of message.toolsAdded ?? []) tools.add(t.name);
  }
  return [...tools].sort();
}
