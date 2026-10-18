/** One child run, built and driven from a plain-data ChildSpec. Both runners share this body. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionFactory,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { loadPi } from "../../pi.js";
import { zeroUsage } from "./protocol.js";
import type {
  AssistantMessage,
  ChildEvent,
  ChildResult,
  ChildSpec,
  Usage,
} from "./types.js";

/** Provider sources the parent carries; the child's own file-backed runtime then passes none. */
export type Providers = Pick<
  ModelRegistry,
  | "getRegisteredProviderIds"
  | "getRegisteredNativeProvider"
  | "getRegisteredProviderConfig"
>;

export interface ChildRun {
  /** Absent: the child resolves model/auth from the agent dir's auth.json + models.json alone. */
  providers?: Providers;
  /** The child's only extension: Pi's tools plus skyr's own, never the user's. */
  registerTools: ExtensionFactory;
  signal: AbortSignal;
  onEvent: (event: ChildEvent) => void;
}

const emptyUsage = () => zeroUsage();

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

function openResumable(pi: Awaited<ReturnType<typeof loadPi>>, file: string) {
  if (!existsSync(file))
    throw new Error(
      `the saved session ${file} is gone; start a fresh subagent instead`,
    );
  return pi.SessionManager.open(file);
}

/**
 * Runs one child to completion. Throws, having spent nothing, when the model does not resolve
 * or the run cannot start (including a signal aborted beforehand). Every later failure is a
 * `status` on the result, with the usage. `onEvent` is called synchronously inside the child's
 * event dispatch; a throw there fails the run rather than the child.
 */
export async function runChildSession(
  spec: ChildSpec,
  o: ChildRun,
): Promise<ChildResult> {
  const pi = await loadPi();
  const agentDir = pi.getAgentDir();

  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  if (o.providers) {
    for (const id of o.providers.getRegisteredProviderIds()) {
      const native = o.providers.getRegisteredNativeProvider(id);
      const config = o.providers.getRegisteredProviderConfig(id);
      if (native) modelRuntime.registerNativeProvider(native);
      else if (config) modelRuntime.registerProvider(id, config);
    }
  }
  const picked = pi.resolveCliModel({ cliModel: spec.model, modelRuntime });
  if (!picked.model)
    throw new Error(
      `model "${spec.model}" is not available to a subagent: ${picked.error ?? "no match"}. ` +
        "Pick a model with stored credentials, or set `model:` on the call or in the agent file.",
    );

  // One instance for loader and session, so both see the same project trust.
  const settingsManager = pi.SettingsManager.create(spec.cwd, agentDir, {
    projectTrusted: spec.trusted,
  });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: spec.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [{ name: "skyr", factory: o.registerTools }],
    // The plain `appendSystemPrompt` reads its input as a file when it names one.
    appendSystemPromptOverride: (base) =>
      spec.systemPrompt ? [...base, spec.systemPrompt] : base,
  });
  await resourceLoader.reload();
  const sessionManager = !spec.session
    ? pi.SessionManager.inMemory(spec.cwd, { id: spec.id })
    : "resume" in spec.session
      ? openResumable(pi, spec.session.resume)
      : pi.SessionManager.create(spec.cwd, spec.session.dir, {
          id: spec.id,
          parentSession: spec.session.parent,
        });
  const { session } = await pi.createAgentSession({
    cwd: spec.cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager,
    model: picked.model,
    thinkingLevel: picked.thinkingLevel ?? spec.thinkingLevel,
    tools: spec.tools,
  });

  let usage = emptyUsage();
  let reportError: unknown;
  const stop = () => void session.abort();
  // Pi calls listeners unguarded inside its dispatch; a throw there would break the child.
  const report = (event: ChildEvent) => {
    if (reportError !== undefined) return;
    try {
      o.onEvent(event);
    } catch (error: unknown) {
      reportError = error;
      stop();
    }
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start")
      report({ type: "tool", name: event.toolName });
    else if (
      event.type === "message_end" &&
      event.message.role === "assistant"
    ) {
      usage = addUsage(usage, event.message.usage);
      report({ type: "turn", usage });
    }
  });
  // Listener first: one added after the abort would never fire.
  o.signal.addEventListener("abort", stop, { once: true });
  try {
    o.signal.throwIfAborted();
    try {
      await session.prompt(spec.task);
    } catch (error: unknown) {
      throw new Error(
        `the child could not start: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const last = session.messages
      .filter(
        (message): message is AssistantMessage => message.role === "assistant",
      )
      .at(-1);
    const result: ChildResult = {
      status: "done",
      text: session.getLastAssistantText(),
      error: undefined,
      usage,
      sessionFile: session.sessionFile ?? undefined,
    };
    if (reportError !== undefined)
      return {
        ...result,
        status: "failed",
        error: `progress reporting failed: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
      };
    // Provider failures resolve `prompt()`; only the final assistant message says so. An
    // abort between tool calls can end the run without one, so the signal is checked first.
    const stopped = last?.stopReason;
    return {
      ...result,
      status:
        o.signal.aborted || stopped === "aborted"
          ? "aborted"
          : stopped === "error"
            ? "failed"
            : "done",
      error: last?.errorMessage,
    };
  } finally {
    o.signal.removeEventListener("abort", stop);
    unsubscribe();
    session.dispose();
  }
}
