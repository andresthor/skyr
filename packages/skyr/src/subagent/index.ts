/**
 * `subagent`: runs a task in a fresh session as a named agent from an agent file, or as an ad-hoc
 * one, and returns the agent's final answer. A child loads no extensions, so it never gets this
 * tool itself.
 */
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errorRow, type Segment, seconds, toolRow } from "../tools/render.js";
import { spill } from "../tools/spill.js";
import { registerWebFetch } from "../tools/web-fetch.js";
import { registerWebSearch } from "../tools/web-search.js";
import { type AgentDef, loadAgents, parseTools } from "./agents.js";
import { type ChildResult, inProcessRunner } from "./runner.js";
import { createRunStore, type RunSnapshot } from "./store.js";

// No edit or write by default: an agent file or the `tools` param names them, and such a child is
// a writer, one per directory.
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
const ADHOC =
  "Without `agent` the subagent is general-purpose: Pi's own system prompt, the tools read, grep, find, ls, bash, web_search and web_fetch, your model and your working directory. `prompt`, `tools`, `model` and `cwd` each override what the agent file or that default gives. A subagent whose tools include edit or write runs alone in its directory: a second one for the same directory waits until the first ends, so issue writes that depend on each other in separate turns.";

const Params = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Name of one of the agents listed in this tool's description. Omit for a general-purpose subagent.",
    }),
  ),
  description: Type.String({ description: "3-5 words for the user" }),
  task: Type.String({
    description:
      "The whole task. The agent sees nothing of this conversation: give paths, context and the answer you want back.",
  }),
  prompt: Type.Optional(
    Type.String({
      description:
        "Added to the subagent's system prompt, after the agent's own prompt when agent is given: its role, rules and how to answer.",
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Tool names the subagent may use; replaces the agent's or the default set. Add edit or write only to change files: such a subagent runs alone in its directory.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Model for the subagent, as `pi --model` takes it (provider/id or a pattern). Defaults to the agent's, else yours.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Existing directory the subagent works in, absolute or relative to yours. Create it first if you need a fresh one.",
    }),
  ),
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
  const list =
    lines.length > 0 ? `Agents:\n${lines.join("\n")}` : "Agents: none defined.";
  return `${ABOUT}\n\n${ADHOC}\n\n${list}`;
}

async function answer(
  label: string,
  id: string,
  result: ChildResult,
): Promise<{ text: string; spillFile?: string }> {
  if (result.status === "aborted")
    return { text: `subagent: ${label} was stopped before it answered` };
  if (result.status === "failed")
    return {
      text: `subagent: ${label} failed: ${result.error ?? "no error message"}`,
    };
  if (!result.text)
    return { text: `subagent: ${label} ended without an answer` };
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
  // One writer per directory: a key's chain resolves once every earlier writer has released.
  const writers = new Map<string, { chain: Promise<void>; label: string }>();
  let agents = new Map<string, AgentDef>();
  let loadErrors: string[] = [];
  let description = describe(agents);
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

  /** Pi's own trust order for a directory, with the parent's verdict where Pi would ask. */
  async function trustFor(
    key: string,
    parentKey: string,
    parentTrusted: boolean,
  ): Promise<boolean> {
    if (key === parentKey) return parentTrusted;
    // Imported here, not at the top: a static value import would make loading skyr evaluate
    // pi-coding-agent, which reads environment variables at module scope.
    const {
      getAgentDir,
      hasTrustRequiringProjectResources,
      ProjectTrustStore,
    } = await import("@earendil-works/pi-coding-agent");
    if (!hasTrustRequiringProjectResources(key)) return true;
    const recorded = new ProjectTrustStore(getAgentDir()).get(key);
    if (recorded !== null) return recorded;
    const fallback = pi.getSettings().defaultProjectTrust;
    if (fallback === "always") return true;
    if (fallback === "never") return false;
    return parentTrusted;
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: ABOUT,
    promptSnippet: "Delegate a self-contained task to a subagent",
    parameters: Params,
    prepareLoadout: () => ({ descriptions: { subagent: description } }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const agent =
        params.agent === undefined ? undefined : agents.get(params.agent);
      if (params.agent !== undefined && !agent)
        throw unknownAgent(params.agent);
      const label = agent ? agent.name : `"${params.description}"`;
      const model =
        params.model ??
        agent?.model ??
        (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
      if (!model)
        throw new Error(
          `subagent: ${label}: no model is selected; select one, or pass model`,
        );
      let tools: string[];
      try {
        tools = parseTools(params.tools) ?? agent?.tools ?? DEFAULT_TOOLS;
      } catch (error: unknown) {
        throw new Error(
          `subagent: tools: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const writer = tools.includes("edit") || tools.includes("write");
      const systemPrompt = [agent?.body, params.prompt]
        .filter(Boolean)
        .join("\n\n");
      const cwd = resolve(ctx.cwd, params.cwd ?? ".");
      // Realpath, as Pi keys its file queue and trust store: two spellings of one dir share a slot.
      let key: string;
      try {
        key = realpathSync(cwd);
        if (!statSync(key).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new Error(
          `subagent: cwd ${JSON.stringify(params.cwd ?? ".")} is not a directory (looked at ${cwd}); pass an existing directory, absolute or relative to ${ctx.cwd}`,
        );
      }
      const parentKey = realpathSync(ctx.cwd);
      const parentFile = ctx.sessionManager.getSessionFile();
      const childSignal = AbortSignal.any(
        signal ? [signal, sessionAbort.signal] : [sessionAbort.signal],
      );

      const id = randomUUID();
      let sent: RunSnapshot = {
        id,
        toolCallId,
        agent: agent?.name,
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
      // Before the first await: Pi starts a batch's calls in order only up to that point.
      let release = () => {};
      let ahead: { chain: Promise<void>; label: string } | undefined;
      if (writer) {
        ahead = writers.get(key);
        let grant!: () => void;
        const mine = new Promise<void>((r) => {
          grant = r;
        });
        const chain = (ahead?.chain ?? Promise.resolve()).then(() => mine);
        writers.set(key, { chain, label });
        release = () => {
          grant();
          if (writers.get(key)?.chain === chain) writers.delete(key);
        };
        if (ahead) sent = { ...sent, status: "queued", behind: ahead.label };
      }
      store.apply(id, { type: "start", snapshot: sent });
      // Pi renders a row's result only once one exists, so the first update cannot wait.
      send(sent);
      const pulse = setInterval(() => {
        const run = store.byToolCall(toolCallId);
        if (run && (run !== sent || Date.now() - sentAt >= PULSE_FLOOR_MS))
          send(run);
      }, PULSE_MS);

      try {
        if (ahead) {
          await Promise.race([
            ahead.chain,
            new Promise<void>((r) =>
              childSignal.addEventListener("abort", () => r(), { once: true }),
            ),
          ]);
          if (childSignal.aborted) {
            const details: RunSnapshot = {
              ...(store.byToolCall(toolCallId) ?? sent),
              status: "aborted",
              endedAt: Date.now(),
            };
            return {
              content: [
                {
                  type: "text",
                  text: `subagent: ${label} was stopped before it started`,
                },
              ],
              details,
              isError: true,
            };
          }
          const { behind: _, ...rest } = sent;
          sent = { ...rest, status: "running" };
          store.apply(id, { type: "start", snapshot: sent });
          send(sent);
        }
        const trusted = await trustFor(key, parentKey, ctx.isProjectTrusted());
        let result: ChildResult;
        try {
          result = await inProcessRunner(
            ctx.modelRegistry,
            registerChildTools,
          ).run(
            {
              id,
              cwd,
              model,
              thinkingLevel: ctx.thinkingLevel,
              tools,
              systemPrompt,
              task: params.task,
              trusted,
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
            `subagent: ${label}: ${message.replace(/^subagent: /, "")}`,
            { cause: error },
          );
        }
        const { text, spillFile } = await answer(label, id, result);
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
        release();
        store.apply(id, { type: "end" });
      }
    },
    renderCall(args, theme) {
      return toolRow(theme, [
        ["toolTitle", "subagent", true],
        ["accent", args.agent ? ` ${args.agent}` : ""],
        ["muted", args.description ? ` "${args.description}"` : ""],
        ["muted", args.cwd ? ` in ${args.cwd}` : ""],
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
      if (run.status === "queued")
        return toolRow(theme, [
          ["warning", "● queued"],
          ["muted", run.behind ? ` · behind ${run.behind}` : ""],
          ...runTime(run),
        ]);
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
      const runs = store.running();
      const queued = runs.filter((r) => r.status === "queued").length;
      const text =
        runs.length === 0
          ? undefined
          : `${count(runs.length, "subagent")}${queued ? `, ${queued} queued` : ""}`;
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
