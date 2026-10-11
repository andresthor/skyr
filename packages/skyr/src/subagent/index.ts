/**
 * `subagent`: runs a task in a fresh session as an agent defined in an agent file, and returns
 * the agent's final answer. A child loads no extensions, so it never gets this tool itself.
 */
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errorRow, type Segment, seconds, toolRow } from "../tools/render.js";
import { spill } from "../tools/spill.js";
import { registerWebFetch } from "../tools/web-fetch.js";
import { registerWebSearch } from "../tools/web-search.js";
import { type AgentDef, loadAgents } from "./agents.js";
import { type ChildResult, inProcessRunner } from "./runner.js";
import { createRunStore, type RunSnapshot } from "./store.js";

// No edit or write by default; an agent file that wants them names them.
const DEFAULT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "web_search",
  "web_fetch",
];
const MAX_ANSWER_BYTES = 10_000;
const PULSE_MS = 250;
const PULSE_FLOOR_MS = 1000;
const STATUS_KEY = "skyr.subagents";

const ABOUT =
  "Run a task in a subagent: a fresh agent with its own context and tools that returns only its final answer. Use it for work that would fill your context, such as searching a codebase, reading many files or researching the web. The agent sees nothing of this conversation, so the task must stand alone: give paths, context and the answer you want back. Independent tasks go out as several subagent calls in one turn, and run in parallel.";

const Params = Type.Object({
  agent: Type.String({ description: "Name of one of the agents listed above" }),
  description: Type.String({ description: "3-5 words for the user" }),
  task: Type.String({
    description:
      "The whole task. The agent sees nothing of this conversation: give paths, context and the answer you want back.",
  }),
});

function registerChildTools(pi: ExtensionAPI): void {
  registerWebSearch(pi);
  registerWebFetch(pi);
}

/** Sorted, so the description stays byte-identical and the prompt cache holds. */
function describe(agents: Map<string, AgentDef>): string {
  const lines = [...agents.keys()]
    .sort()
    .map(
      (name) =>
        `- ${name}: ${agents.get(name)?.description.replace(/\s+/g, " ")}`,
    );
  return `${ABOUT}\n\nAgents:\n${lines.join("\n")}`;
}

async function answer(
  agent: string,
  id: string,
  result: ChildResult,
): Promise<{ text: string; spillFile?: string }> {
  if (result.status === "aborted")
    return { text: `subagent: ${agent} was stopped before it answered` };
  if (result.status === "failed")
    return {
      text: `subagent: ${agent} failed: ${result.error ?? "no error message"}`,
    };
  if (!result.text)
    return { text: `subagent: ${agent} ended without an answer` };
  // Imported here, not at the top: a static value import would make loading skyr evaluate
  // pi-coding-agent, which reads environment variables at module scope.
  const { truncateHead, DEFAULT_MAX_LINES } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const cut = truncateHead(result.text, {
    maxBytes: MAX_ANSWER_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!cut.truncated) return { text: result.text };
  const spillFile = await spill(id, result.text);
  return {
    text: `${cut.content}\n\n[Truncated: the full answer is in ${spillFile}]`,
    spillFile,
  };
}

/** Saved details can be `{}` from a call that threw, or from an older shape. */
function isRun(details: unknown): details is RunSnapshot {
  return (
    typeof details === "object" &&
    details !== null &&
    "status" in details &&
    typeof details.status === "string" &&
    "startedAt" in details &&
    typeof details.startedAt === "number" &&
    "turns" in details &&
    typeof details.turns === "number" &&
    "toolCalls" in details &&
    typeof details.toolCalls === "number" &&
    "tokens" in details &&
    typeof details.tokens === "number"
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const tokens = (n: number) =>
  n < 1000 ? `${n} tok` : `${Math.round(n / 1000)}k tok`;

export function registerSubagent(pi: ExtensionAPI): void {
  const store = createRunStore();
  let agents = new Map<string, AgentDef>();
  let loadErrors: string[] = [];
  let description = ABOUT;
  let sessionAbort = new AbortController();
  let unsubscribe: (() => void) | undefined;

  function unknownAgent(name: string): Error {
    const names = [...agents.keys()].sort().join(", ") || "none";
    const broken =
      loadErrors.length > 0
        ? ` Agent files that failed to load: ${loadErrors.map((e) => e.replace(/^subagent: /, "")).join("; ")}`
        : "";
    return new Error(
      `subagent: no agent "${name}"; available: ${names}.${broken}`,
    );
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: ABOUT,
    promptSnippet: "Delegate a self-contained task to a named subagent",
    parameters: Params,
    // Hidden rather than declared with nothing to offer: every declared tool costs context.
    prepareLoadout: () =>
      agents.size === 0
        ? { hiddenDeclarations: ["subagent"] }
        : { descriptions: { subagent: description } },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const agent = agents.get(params.agent);
      if (!agent) throw unknownAgent(params.agent);
      const model =
        agent.model ?? (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
      if (!model)
        throw new Error(
          `subagent: ${agent.name}: no model is selected; select one, or set model: in ${agent.source}`,
        );
      const parentFile = ctx.sessionManager.getSessionFile();
      const childSignal = AbortSignal.any(
        signal ? [signal, sessionAbort.signal] : [sessionAbort.signal],
      );

      const id = randomUUID();
      let sent: RunSnapshot = {
        id,
        toolCallId,
        agent: agent.name,
        description: params.description,
        status: "running",
        startedAt: Date.now(),
        turns: 0,
        toolCalls: 0,
        tokens: 0,
      };
      let sentAt = 0;
      const send = (run: RunSnapshot) => {
        sent = run;
        sentAt = Date.now();
        onUpdate?.({ content: [], details: run });
      };
      store.apply(id, { type: "start", snapshot: sent });
      // Pi renders a row's result only once one exists, so the first update cannot wait.
      send(sent);
      const pulse = setInterval(() => {
        const run = store.byToolCall(toolCallId);
        if (run && (run !== sent || Date.now() - sentAt >= PULSE_FLOOR_MS))
          send(run);
      }, PULSE_MS);

      try {
        let result: ChildResult;
        try {
          result = await inProcessRunner(
            ctx.modelRegistry,
            registerChildTools,
          ).run(
            {
              id,
              cwd: ctx.cwd,
              model,
              thinkingLevel: ctx.thinkingLevel,
              tools: agent.tools ?? DEFAULT_TOOLS,
              systemPrompt: agent.body,
              task: params.task,
              trusted: ctx.isProjectTrusted(),
              session: parentFile
                ? {
                    dir: join(
                      dirname(parentFile),
                      basename(parentFile, ".jsonl"),
                    ),
                    parent: parentFile,
                  }
                : undefined,
            },
            childSignal,
            (event) => store.apply(id, event),
          );
        } catch (error: unknown) {
          // Cancelled before the child started: let Pi see its own cancellation.
          if (childSignal.aborted) throw error;
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `subagent: ${agent.name}: ${message.replace(/^subagent: /, "")}`,
            { cause: error },
          );
        }
        const { text, spillFile } = await answer(agent.name, id, result);
        // The store is empty here when a reload or shutdown cleared it mid-run.
        const details: RunSnapshot = {
          ...(store.byToolCall(toolCallId) ?? sent),
          status: result.status,
          endedAt: Date.now(),
          sessionFile: result.sessionFile,
          spillFile,
        };
        return {
          content: [{ type: "text", text }],
          details,
          usage: result.usage,
          isError: result.status !== "done" || !result.text,
        };
      } finally {
        clearInterval(pulse);
        store.apply(id, { type: "end" });
      }
    },
    renderCall(args, theme) {
      return toolRow(theme, [
        ["toolTitle", "subagent ", true],
        ["accent", args.agent ?? ""],
        ["muted", args.description ? ` "${args.description}"` : ""],
      ]);
    },
    renderResult(result, _options, theme, context) {
      // The store while the child runs; once it ends, and after a resume, the saved details.
      const live = store.byToolCall(context.toolCallId);
      const run = live ?? (isRun(result.details) ? result.details : undefined);
      if (!run || context.isError)
        return errorRow(
          theme,
          result.content,
          run ? [...summary(run), ...runTime(run)] : [],
        );
      if (run.status === "running")
        return toolRow(theme, [
          ["accent", "● running"],
          ...summary(run),
          ["muted", run.activity ? ` · ${run.activity}` : ""],
          ...runTime(run),
        ]);
      return toolRow(theme, [
        ["success", "✓ done"],
        ...summary(run),
        ["muted", ` · ${tokens(run.tokens)}`],
        ...runTime(run),
      ]);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    store.clear();
    sessionAbort = new AbortController();
    // Imported here, not at the top: a static value import would make loading skyr evaluate
    // pi-coding-agent, which reads environment variables at module scope.
    const { getAgentDir, CONFIG_DIR_NAME } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const loaded = await loadAgents({
      user: join(getAgentDir(), "agents"),
      // Pi reads a project's .pi/ resources only once the user trusts the project.
      project: ctx.isProjectTrusted()
        ? join(ctx.cwd, CONFIG_DIR_NAME, "agents")
        : undefined,
    });
    agents = loaded.agents;
    loadErrors = loaded.errors;
    description = describe(agents);
    if (loadErrors.length > 0) ctx.ui.notify(loadErrors.join("\n"), "warning");

    unsubscribe?.();
    unsubscribe = undefined;
    if (!ctx.hasUI) return;
    let shown: string | undefined;
    unsubscribe = store.subscribe(() => {
      const n = store.running().length;
      const text = n === 0 ? undefined : count(n, "subagent");
      // RPC mode writes a line per call, so only changes go out.
      if (text === shown) return;
      shown = text;
      ctx.ui.setStatus(STATUS_KEY, text);
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionAbort.abort();
    unsubscribe?.();
    unsubscribe = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    store.clear();
  });
}

function summary(run: RunSnapshot): Segment[] {
  return [
    [
      "muted",
      ` · ${count(run.turns, "turn")} · ${count(run.toolCalls, "tool")}`,
    ],
  ];
}

// From the snapshot, not the web rows' row-state clock: a resumed row has only its details.
function runTime(run: RunSnapshot): Segment[] {
  return seconds((run.endedAt ?? Date.now()) - run.startedAt);
}
