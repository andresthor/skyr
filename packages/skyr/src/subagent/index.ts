/**
 * `subagent`: runs a task in a fresh session as a named agent from an agent file, or as an ad-hoc
 * one, and returns the agent's final answer, at once or later as a message. A child loads no
 * extensions, so it never gets this tool itself.
 */
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { loadPi } from "../pi.js";
import {
  clip,
  errorRow,
  type Segment,
  sanitize,
  seconds,
  toolRow,
} from "../tools/render.js";
import { spill } from "../tools/spill.js";
import { registerWebFetch } from "../tools/web-fetch.js";
import { registerWebSearch } from "../tools/web-search.js";
import {
  type AgentDef,
  DEFAULT_TOOLS,
  loadAgents,
  parseTools,
} from "./agents.js";
import { type ChildResult, inProcessRunner } from "./runner.js";
import { createRunStore, type RunSnapshot, type RunStatus } from "./store.js";

const MAX_ANSWER_BYTES = 10_000;
const PULSE_MS = 250;
// An unchanged snapshot is resent at this rate so the row's clock moves between store changes.
const PULSE_FLOOR_MS = 1000;
const WIDGET_KEY = "skyr.subagents";
const WIDGET_WIDTH = 100;
const MESSAGE_TYPE = "skyr.subagent";
const PREVIEW_LINES = 12;

const ABOUT =
  "Run a task in a subagent: a fresh agent with its own context and tools that returns only its final answer. Use it for work that would fill your context, such as searching a codebase, reading many files or researching the web. The agent sees nothing of this conversation, so the task must stand alone: give paths, context and the answer you want back. Independent tasks go out as several subagent calls in one turn, and run in parallel.";
const ADHOC =
  "Without `agent` the subagent is general-purpose: Pi's own system prompt, the tools read, grep, find, ls, bash, web_search and web_fetch, your model and your working directory. `prompt`, `tools`, `model` and `cwd` each override what the agent file or that default gives. A subagent whose tools include edit or write runs alone in its directory tree: a second one for the same directory, or one above or below it, waits until the first ends, so issue writes that depend on each other in separate turns. With `background: true` the call returns at once and the answer arrives as a message when the subagent finishes; keep working meanwhile and never poll for it. Not in print mode (`pi -p`): the session ends after one turn and the answer would be lost.";

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
        "Tool names the subagent may use; replaces the agent's or the default set. Add edit or write only to change files: such a subagent runs alone in its directory tree.",
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
  background: Type.Optional(
    Type.Boolean({
      description:
        "Return at once; the answer arrives later as a message, and Esc does not stop it. For work you do not need before your next step.",
    }),
  ),
});

/** A call resolved against its agent file and the defaults; nothing has been spent yet. */
interface Call {
  agent?: string;
  label: string;
  model: string;
  tools: string[];
  writer: boolean;
  systemPrompt: string;
  cwd: string;
  /** Realpath of `cwd`: the writer-slot and trust key. */
  key: string;
  parentKey: string;
  background: boolean;
}

/** A writer's place in its directory's queue. */
interface Slot {
  chain: Promise<void>;
  label: string;
}

/** What a finished child hands back, for a tool result or a delivered message. */
interface Outcome {
  text: string;
  details: RunSnapshot;
  usage?: ChildResult["usage"];
  isError: boolean;
}

/** Every error the model reads starts the same way and says what to try next. */
const fail = (detail: string, cause?: unknown) =>
  new Error(`subagent: ${detail}`, cause === undefined ? undefined : { cause });

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const labelOf = (run: { agent?: string; description: string }) =>
  run.agent ?? `"${clip(run.description)}"`;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const tokens = (n: number) =>
  n < 1000 ? `${n} tok` : `${Math.round(n / 1000)}k tok`;

function registerChildTools(pi: ExtensionAPI): void {
  registerWebSearch(pi);
  registerWebFetch(pi);
}

/** Sorted, so the description stays byte-identical and the prompt cache holds. */
function describe(agents: Map<string, AgentDef>): string {
  const lines = [...agents.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([name, agent]) => `- ${name}: ${agent.description.replace(/\s+/g, " ")}`,
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
  const { truncateHead, DEFAULT_MAX_LINES } = await loadPi();
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

/** The model's one-line header for a delivered answer, then the answer. */
function delivery(outcome: Outcome): string {
  const run = outcome.details;
  return `[background subagent ${labelOf(run)} (id ${run.id.slice(0, 8)}): ${run.status}, ${count(run.turns, "turn")}, ${count(run.toolCalls, "tool")}, ${tokens(run.tokens)}]\n\n${outcome.text}`;
}

export function registerSubagent(pi: ExtensionAPI): void {
  const store = createRunStore();
  // One writer per directory: a key's chain resolves once every earlier writer has released.
  const writers = new Map<string, Slot>();
  // Per-child abort, for `/subagents stop`; everything a UI reads stays in the store.
  const children = new Map<string, AbortController>();
  // Finished background answers waiting for the parent to be idle. Never Pi's steer or followUp
  // queues: Esc clears those.
  let pending: Outcome[] = [];
  // Bumped at every session start and shutdown, so a child that outlives its session touches
  // neither the next session nor its own stale context.
  let generation = 0;
  let agents = new Map<string, AgentDef>();
  let loadErrors: string[] = [];
  let description = describe(agents);
  let sessionAbort = new AbortController();
  let unsubscribe: (() => void) | undefined;
  let widgetTick: ReturnType<typeof setInterval> | undefined;

  function unknownAgent(name: string): Error {
    const names = [...agents.keys()].sort().join(", ") || "none";
    const broken =
      loadErrors.length > 0
        ? ` Agent files that failed to load: ${loadErrors.join("; ")}`
        : "";
    return fail(`no agent "${clip(name)}"; available: ${names}.${broken}`);
  }

  /**
   * Resolves a call against its agent file and the defaults, throwing for anything the model
   * must fix. Synchronous, so nothing is spent and no await precedes the writer slot.
   */
  function resolveCall(
    params: Static<typeof Params>,
    ctx: Pick<ExtensionContext, "cwd" | "model">,
  ): Call {
    const agent =
      params.agent === undefined ? undefined : agents.get(params.agent);
    if (params.agent !== undefined && !agent) throw unknownAgent(params.agent);
    const label = labelOf({
      agent: agent?.name,
      description: params.description,
    });
    const model =
      params.model ??
      agent?.model ??
      (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
    if (!model)
      throw fail(`${label}: no model is selected; select one, or pass model`);
    let tools: string[];
    try {
      tools = parseTools(params.tools) ?? agent?.tools ?? DEFAULT_TOOLS;
    } catch (error: unknown) {
      throw fail(`tools: ${errorText(error)}`, error);
    }
    // Realpath, as Pi keys its file queue and trust store: two spellings of one dir share a slot.
    let parentKey: string;
    try {
      parentKey = realpathSync(ctx.cwd);
    } catch {
      throw fail(
        `the working directory ${ctx.cwd} no longer exists; tell the user to restart Pi in an existing directory`,
      );
    }
    const cwd = resolve(ctx.cwd, params.cwd ?? ".");
    let key: string;
    try {
      key = realpathSync(cwd);
      if (!statSync(key).isDirectory()) throw new Error("not a directory");
    } catch {
      throw fail(
        `cwd ${JSON.stringify(clip(params.cwd ?? "."))} is not a directory (looked at ${clip(cwd)}); pass an existing directory, absolute or relative to ${ctx.cwd}`,
      );
    }
    return {
      agent: agent?.name,
      label,
      model,
      tools,
      writer: tools.includes("edit") || tools.includes("write"),
      systemPrompt: [agent?.body, params.prompt].filter(Boolean).join("\n\n"),
      cwd,
      key,
      parentKey,
      background: params.background === true,
    };
  }

  /**
   * The next writer slot for `key`, behind every live writer in the same directory, above it or
   * below it. `behind` names the latest of those, if any; `wait` resolves once they have all
   * released or `signal` aborts; `release` frees the slot exactly once, whatever happened.
   */
  function takeSlot(
    key: string,
    label: string,
  ): {
    behind?: string;
    wait(signal: AbortSignal): Promise<void>;
    release(): void;
  } {
    // With a trailing separator, so `/a/b` is related to `/a` and `/a/b/c` but not to `/a/bc`.
    const related = [...writers].filter(
      ([other]) =>
        other === key ||
        key.startsWith(other + sep) ||
        other.startsWith(key + sep),
    );
    const behind = related.at(-1)?.[1].label;
    const aheadDone = Promise.all(related.map(([, slot]) => slot.chain)).then(
      () => undefined,
    );
    let grant!: () => void;
    const mine = new Promise<void>((r) => {
      grant = r;
    });
    const chain = aheadDone.then(() => mine);
    writers.set(key, { chain, label });
    return {
      behind,
      wait: (signal) =>
        behind === undefined
          ? Promise.resolve()
          : Promise.race([
              aheadDone,
              new Promise<void>((r) =>
                signal.addEventListener("abort", () => r(), { once: true }),
              ),
            ]),
      release: () => {
        grant();
        if (writers.get(key)?.chain === chain) writers.delete(key);
      },
    };
  }

  /** Pi's own trust order for a directory, with the parent's verdict where Pi would ask. */
  async function trustFor(
    key: string,
    parentKey: string,
    parentTrusted: boolean,
  ): Promise<boolean> {
    if (key === parentKey) return parentTrusted;
    const {
      getAgentDir,
      hasTrustRequiringProjectResources,
      ProjectTrustStore,
    } = await loadPi();
    if (!hasTrustRequiringProjectResources(key)) return true;
    const recorded = new ProjectTrustStore(getAgentDir()).get(key);
    if (recorded !== null) return recorded;
    const fallback = pi.getSettings().defaultProjectTrust;
    if (fallback === "always") return true;
    if (fallback === "never") return false;
    return parentTrusted;
  }

  /** One message for everything that finished, so a second send never lands in a steer queue. */
  function flush(): void {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: [
          { type: "text", text: batch.map(delivery).join("\n\n---\n\n") },
        ],
        display: true,
        details: batch.map((o) => o.details),
      },
      { triggerTurn: true },
    );
  }

  function widgetLines(): string[] | undefined {
    const runs = store.running();
    if (runs.length === 0) return undefined;
    const now = Date.now();
    return runs.map((run) => {
      const mark =
        run.status === "queued"
          ? "○ queued"
          : run.background
            ? "↗ running"
            : "● running";
      const progress =
        run.status === "queued"
          ? run.behind
            ? ` · behind ${run.behind}`
            : ""
          : ` · ${count(run.turns, "turn")} · ${count(run.toolCalls, "tool")}${run.activity ? ` · ${run.activity}` : ""}`;
      const line = `${mark} ${labelOf(run)}${progress} · ${Math.round((now - run.startedAt) / 1000)}s · ${run.id.slice(0, 8)}`;
      return truncateToWidth(sanitize(line), WIDGET_WIDTH);
    });
  }

  function stopTick(): void {
    if (widgetTick) clearInterval(widgetTick);
    widgetTick = undefined;
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: ABOUT,
    promptSnippet: "Delegate a self-contained task to a subagent",
    parameters: Params,
    prepareLoadout: () => ({ descriptions: { subagent: description } }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const call = resolveCall(params, ctx);
      const { label, key, background } = call;
      const parentFile = ctx.sessionManager.getSessionFile();
      const own = new AbortController();
      // A background child outlives the call, so the call's signal (Esc) is not part of its own.
      const childSignal = AbortSignal.any([
        ...(signal && !background ? [signal] : []),
        sessionAbort.signal,
        own.signal,
      ]);
      const born = generation;
      const id = randomUUID();
      // Before the first await: Pi starts a batch's calls in order only up to that point.
      const slot = call.writer ? takeSlot(key, label) : undefined;
      let sent: RunSnapshot = {
        id,
        toolCallId,
        agent: call.agent,
        description: params.description,
        status: slot?.behind ? "queued" : "running",
        startedAt: Date.now(),
        turns: 0,
        toolCalls: 0,
        tokens: 0,
        ...(slot?.behind ? { behind: slot.behind } : {}),
        ...(background ? { background: true as const } : {}),
      };
      let sentAt = 0;
      const send = (run: RunSnapshot) => {
        sent = run;
        sentAt = Date.now();
        onUpdate?.({ content: [], details: run });
      };
      children.set(id, own);
      store.apply(id, { type: "start", snapshot: sent });
      // Pi renders a row's result only once one exists, so the first update cannot wait.
      send(sent);
      // A background row is static once the call returns; the widget shows its progress.
      const pulse = background
        ? undefined
        : setInterval(() => {
            const run = store.byToolCall(toolCallId);
            if (run && (run !== sent || Date.now() - sentAt >= PULSE_FLOOR_MS))
              send(run);
          }, PULSE_MS);

      const stoppedBeforeStart = `subagent: ${label} was stopped before it started`;
      const failed = (error: unknown) =>
        fail(`${label}: ${errorText(error)}`, error);
      // From the store while the child is live, else the last snapshot this call sent: the
      // store is empty once the child has ended, or when a reload cleared it mid-run.
      const ended = (
        status: RunStatus,
        text: string,
        isError = true,
        extra: Partial<RunSnapshot> = {},
      ): Outcome => ({
        text,
        isError,
        details: {
          ...(store.byToolCall(toolCallId) ?? sent),
          status,
          endedAt: Date.now(),
          ...extra,
        },
      });

      const finish = async (): Promise<Outcome> => {
        try {
          if (slot?.behind) {
            await slot.wait(childSignal);
            if (childSignal.aborted)
              return ended("aborted", stoppedBeforeStart);
            const { behind: _, ...rest } = sent;
            sent = { ...rest, status: "running" };
            store.apply(id, { type: "start", snapshot: sent });
            send(sent);
          }
          const trusted = await trustFor(
            key,
            call.parentKey,
            ctx.isProjectTrusted(),
          );
          const result = await inProcessRunner(
            ctx.modelRegistry,
            registerChildTools,
          ).run(
            {
              id,
              cwd: call.cwd,
              model: call.model,
              thinkingLevel: ctx.thinkingLevel,
              tools: call.tools,
              systemPrompt: call.systemPrompt,
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
          const { text, spillFile } = await answer(label, id, result);
          return {
            ...ended(
              result.status,
              text,
              result.status !== "done" || !result.text,
              { sessionFile: result.sessionFile, spillFile },
            ),
            usage: result.usage,
          };
        } finally {
          if (pulse) clearInterval(pulse);
          slot?.release();
          children.delete(id);
          store.apply(id, { type: "end" });
        }
      };

      if (!background) {
        let outcome: Outcome;
        try {
          outcome = await finish();
        } catch (error: unknown) {
          // Cancelled before the child started: let Pi see its own cancellation.
          if (childSignal.aborted) throw error;
          throw failed(error);
        }
        return {
          content: [{ type: "text", text: outcome.text }],
          details: outcome.details,
          usage: outcome.usage,
          isError: outcome.isError,
        };
      }
      void finish()
        .catch((error: unknown) =>
          childSignal.aborted
            ? ended("aborted", stoppedBeforeStart)
            : ended("failed", failed(error).message),
        )
        .then((outcome) => {
          if (born !== generation) return;
          pending.push(outcome);
          if (ctx.isIdle()) flush();
        });
      return {
        content: [
          {
            type: "text",
            text: `subagent: started ${label} in the background (id ${id.slice(0, 8)}); its answer arrives as a message when it finishes`,
          },
        ],
        details: sent,
      };
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
      if (run.background)
        return toolRow(theme, [
          ["accent", "↗ background"],
          ["muted", ` · ${labelOf(run)} · ${run.id.slice(0, 8)}`],
        ]);
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

  pi.registerMessageRenderer<RunSnapshot[]>(
    MESSAGE_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((c) => (c.type === "text" ? c.text : ""))
              .join("");
      const lines = text.split("\n").map(sanitize);
      const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES);
      const hidden = lines.length - shown.length;
      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(
        new Text(
          [
            ...shown,
            ...(hidden > 0
              ? [theme.fg("muted", `… ${hidden} more lines`)]
              : []),
          ].join("\n"),
          0,
          0,
        ),
      );
      return box;
    },
  );

  pi.registerCommand("subagents", {
    description:
      "List running subagents; `/subagents stop <id|all>` stops them",
    handler: async (args, ctx) => {
      const [verb, target] = args.trim().split(/\s+/);
      if (verb === "stop") {
        const hits = [...children].filter(
          ([id]) => target === "all" || (target && id.startsWith(target)),
        );
        if (hits.length === 0 || (hits.length > 1 && target !== "all")) {
          const ids = store.running().map((r) => r.id.slice(0, 8));
          ctx.ui.notify(
            `subagent: ${hits.length === 0 ? "nothing matches" : "more than one id matches"} "${target ?? ""}"; running: ${ids.join(", ") || "none"}`,
            "warning",
          );
          return;
        }
        for (const [, controller] of hits) controller.abort();
        ctx.ui.notify(
          `subagent: stopping ${count(hits.length, "subagent")}`,
          "info",
        );
        return;
      }
      ctx.ui.notify(
        widgetLines()?.join("\n") ?? "subagent: none running",
        "info",
      );
    },
  });

  pi.on("agent_settled", () => flush());

  pi.on("session_start", async (_event, ctx) => {
    store.clear();
    sessionAbort = new AbortController();
    generation += 1;
    pending = [];
    const { getAgentDir, CONFIG_DIR_NAME } = await loadPi();
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
    if (loadErrors.length > 0)
      ctx.ui.notify(
        `subagent: agent files that failed to load:\n${loadErrors.join("\n")}`,
        "warning",
      );

    unsubscribe?.();
    unsubscribe = undefined;
    stopTick();
    if (!ctx.hasUI) return;
    const draw = () => {
      const lines = widgetLines();
      ctx.ui.setWidget(WIDGET_KEY, lines);
      // The clock in each line moves only while something is live.
      if (lines && !widgetTick) widgetTick = setInterval(draw, 1000);
      if (!lines) stopTick();
    };
    unsubscribe = store.subscribe(draw);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    generation += 1;
    sessionAbort.abort();
    unsubscribe?.();
    unsubscribe = undefined;
    stopTick();
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    store.clear();
    pending = [];
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
