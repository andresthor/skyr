import { execFileSync } from "node:child_process";
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
  type EventBus,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, onTestFinished } from "vitest";
import { registerSkyr } from "../src/index.js";

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `skyr-test-${name}-`));

export interface Parent {
  session: AgentSession;
  cwd: string;
  agentDir: string;
  /** Every request faux received, from the parent and from any child on its provider. */
  requests: TranscriptContext[];
  /** Every widget skyr set, in order; `undefined` clears it. */
  widgets: (string[] | undefined)[];
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
  /** Agent files in `.claude/agents` at the repo root. */
  claudeAgents?: Record<string, string>;
  /** Start the session with the project untrusted. */
  untrusted?: boolean;
  /** Make the parent's cwd a git repo with one seed commit (for worktree-y tests). */
  git?: boolean;
  /** The run mode extensions see; Pi's default is print. */
  mode?: ExtensionContext["mode"];
  /** UI methods spread over the recording `setWidget` and `notify`. */
  ui?: Partial<ExtensionUIContext>;
  /** Written to `<agentDir>/skyr.json` as JSON; a string is written as it is. */
  skyr?: unknown;
  /** Extensions loaded beside skyr, in this order after it. */
  extensions?: ExtensionFactory[];
  /** The bus every extension shares; a test answers on it as an ACP host would, outside any extension. */
  eventBus?: EventBus;
}): Promise<Parent> {
  const cwd = tmp("cwd");
  if (o.git) seedRepo(cwd);
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

  if (o.skyr !== undefined)
    writeFileSync(
      join(agentDir, "skyr.json"),
      typeof o.skyr === "string" ? o.skyr : JSON.stringify(o.skyr),
    );
  writeAll(join(agentDir, "agents"), o.userAgents);
  writeAll(join(cwd, CONFIG_DIR_NAME, "agents"), o.repoAgents);
  writeAll(join(cwd, ".claude", "agents"), o.claudeAgents);

  // Further models: for an agent file that names one, and for the advisor. faux-2's output cap
  // is below the advisor's own, so a test can tell which one a request used; faux-3 and faux-4
  // have windows small enough to cut a session for.
  const faux = fauxProvider({
    models: [
      { id: "faux-1" },
      { id: "faux-2", maxTokens: 8_000 },
      { id: "faux-3", contextWindow: 60_000 },
      { id: "faux-4", contextWindow: 21_000 },
    ],
  });
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
  // Pi marks a native provider configured only once its async availability check lands.
  await modelRuntime.refresh({ allowNetwork: false });

  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: !o.untrusted,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [registerSkyr, ...(o.extensions ?? [])],
    eventBus: o.eventBus,
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
  const widgets: (string[] | undefined)[] = [];
  const notices: string[] = [];
  // Own keys only: Pi spreads the UI object. Pi itself calls none of the other methods.
  const uiContext = {
    setWidget: (_key: string, content: string[] | undefined) =>
      widgets.push(content),
    notify: (message: string) => notices.push(message),
    ...o.ui,
  } as unknown as ExtensionUIContext;
  await session.bindExtensions({ uiContext, mode: o.mode });

  onTestFinished(() => {
    session.dispose();
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const dir of [cwd, sessionDir, agentDir])
      rmSync(dir, { recursive: true, force: true });
  });
  return { session, cwd, agentDir, requests, widgets, notices };
}

/** A temp directory, removed when the test ends. */
export function scratchDir(name: string): string {
  const dir = tmp(name);
  // A job's continuation may still be writing into it as the test ends
  onTestFinished(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 }),
  );
  return dir;
}

/** Makes `dir` a git repo with one seed commit. */
function seedRepo(dir: string): void {
  execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=skyr-test",
      "-c",
      "user.email=skyr-test@example.com",
      "commit",
      "-m",
      "seed",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

/** A temp git repo with one seed commit, removed when the test ends. */
export function gitRepo(name: string): string {
  const dir = scratchDir(name);
  seedRepo(dir);
  return dir;
}

/** Text a model or repo could plant: an OSC 52 clipboard write, a bidi override, wide and emoji runs. */
export const HOSTILE =
  "\u001b]52;c;cHduZWQ=\u0007evil\u202e漢字漢字🙂🙂 and more words";

/** Rendered `lines` fit `width` and carry nothing the terminal would act on. */
export function expectInert(lines: string[], width: number): void {
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(line).not.toContain("\u001b]");
    expect(line).not.toContain("cHduZWQ");
    expect(line).not.toContain("\u202e");
  }
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
  background?: boolean;
  continue?: string;
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

/** The main model sends `turns` in order, one per request, then answers "done". */
export function script(
  ...turns: ReturnType<typeof fauxAssistantMessage>[]
): FauxResponseFactory {
  let next = 0;
  return () => turns[next++] ?? fauxAssistantMessage("done");
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

/**
 * Answers capability queries as an ACP host would and records every published task list;
 * `taskLists` is whether it forwards them. `until` resolves once the last list of a source
 * satisfies a predicate.
 */
export function taskHost(bus: EventBus, taskLists: boolean) {
  const published: { source: string; items: unknown[] }[] = [];
  let waiting: { done: () => boolean; resolve: () => void }[] = [];
  bus.on("tengi:capabilities?", (q) => {
    if (typeof q === "object" && q !== null && "id" in q)
      bus.emit("tengi:capabilities", {
        id: q.id,
        v: 1,
        forms: false,
        notices: false,
        agentui: { version: 1, tasks: taskLists },
        formRequests: false,
        taskLists,
      });
  });
  bus.on("tengi:tasks", (payload) => {
    published.push(payload as (typeof published)[number]);
    for (const w of waiting) if (w.done()) w.resolve();
    waiting = waiting.filter((w) => !w.done());
  });
  const last = (source: string) =>
    published.filter((p) => p.source === source).at(-1)?.items;
  const until = (source: string, pred: (items: unknown[]) => boolean) =>
    new Promise<void>((resolve) => {
      const done = () => {
        const items = last(source);
        return items !== undefined && pred(items);
      };
      if (done()) resolve();
      else waiting.push({ done, resolve });
    });
  return { published, last, until };
}
