/** Runs one subagent to completion behind a seam a separate-process runner can also fill. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentSession,
  ExtensionFactory,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { loadPi } from "../pi.js";

type AssistantMessage = Extract<
  AgentSession["messages"][number],
  { role: "assistant" }
>;
export type Usage = AssistantMessage["usage"];
type ThinkingLevel = AgentSession["thinkingLevel"];

/** Everything a child needs, as plain data, so a subprocess runner can take the same spec. */
export interface ChildSpec {
  id: string;
  cwd: string;
  /** `provider/id` or a `pi --model` pattern; a `:level` suffix overrides `thinkingLevel`. */
  model: string;
  thinkingLevel: ThinkingLevel | undefined;
  /** Already validated: Pi silently drops a name it does not know. */
  tools: string[];
  /** Appended to Pi's system prompt when non-empty; Pi keeps its tool list and guidelines. */
  systemPrompt: string;
  task: string;
  /** Whether the child may read the project's `.pi/` settings and prompts. */
  trusted: boolean;
  /** Absent: the child is not saved, as for a parent run under `--no-session`. */
  session?:
    | { dir: string; parent: string }
    /** An earlier run's session file: this run continues it. */
    | { resume: string };
}

/** `usage` is the child's running total, not the turn's own. */
export type ChildEvent =
  | { type: "tool"; name: string }
  | { type: "turn"; usage: Usage };

export interface ChildResult {
  status: "done" | "failed" | "aborted";
  /** Undefined when the child stopped without writing text. */
  text: string | undefined;
  error: string | undefined;
  usage: Usage;
  sessionFile: string | undefined;
}

export interface Runner {
  /**
   * Throws, having spent nothing, when the model does not resolve or the run cannot start
   * (including a signal aborted beforehand). Every later failure is a `status`, with the usage.
   * `onEvent` is called synchronously from inside the child's event dispatch.
   */
  run(
    spec: ChildSpec,
    signal: AbortSignal,
    onEvent: (event: ChildEvent) => void,
  ): Promise<ChildResult>;
}

type Providers = Pick<
  ModelRegistry,
  | "getRegisteredProviderIds"
  | "getRegisteredNativeProvider"
  | "getRegisteredProviderConfig"
>;

/**
 * `providers` are copied into each child's own model runtime, since the parent's is private;
 * `--api-key` keys and virtual models do not carry over. `registerTools` is the child's only
 * extension: Pi's and the user's extensions, skills and prompt templates stay off.
 */
export function inProcessRunner(
  providers: Providers,
  registerTools: ExtensionFactory,
): Runner {
  return {
    async run(spec, signal, onEvent) {
      const pi = await loadPi();
      const agentDir = pi.getAgentDir();

      const modelRuntime = await pi.ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      });
      for (const id of providers.getRegisteredProviderIds()) {
        const native = providers.getRegisteredNativeProvider(id);
        const config = providers.getRegisteredProviderConfig(id);
        if (native) modelRuntime.registerNativeProvider(native);
        else if (config) modelRuntime.registerProvider(id, config);
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
        extensionFactories: [{ name: "skyr", factory: registerTools }],
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
          onEvent(event);
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
      signal.addEventListener("abort", stop, { once: true });
      try {
        signal.throwIfAborted();
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
            (message): message is AssistantMessage =>
              message.role === "assistant",
          )
          .at(-1);
        const result = {
          text: session.getLastAssistantText(),
          usage,
          sessionFile: session.sessionFile,
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
            signal.aborted || stopped === "aborted"
              ? "aborted"
              : stopped === "error"
                ? "failed"
                : "done",
          error: last?.errorMessage,
        };
      } finally {
        signal.removeEventListener("abort", stop);
        unsubscribe();
        session.dispose();
      }
    },
  };
}

function openResumable(pi: Awaited<ReturnType<typeof loadPi>>, file: string) {
  if (!existsSync(file))
    throw new Error(
      `the saved session ${file} is gone; start a fresh subagent instead`,
    );
  if (typeof pi.SessionManager.open !== "function")
    throw new Error(
      "this runtime cannot resume subagent sessions (SessionManager.open is missing); update the host Pi, or start a fresh subagent instead",
    );
  return pi.SessionManager.open(file);
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Fields Pi's session totals count; the optional token splits are left out. */
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
