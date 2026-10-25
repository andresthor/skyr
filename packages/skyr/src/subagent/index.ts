/**
 * `subagent`: runs a task in a fresh session as a named agent from an agent file, or as an ad-hoc
 * one, and returns the agent's final answer, at once or later as a message. A child loads no
 * extensions, so it never gets this tool itself.
 */
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { loadPi } from "../pi.js";
import { publishTasks, type TaskItem } from "../tengi.js";
import {
  clip,
  errnoOf,
  errorRow,
  quoted,
  registerTextMessageRenderer,
  type Segment,
  sanitize,
  seconds,
  tokens,
  toolRow,
} from "../tools/render.js";
import { spill } from "../tools/spill.js";
import {
  type AgentDef,
  DEFAULT_TOOLS,
  loadAgents,
  parseTools,
  READ_FIELDS,
} from "./agents.js";
import { readStoredResult } from "./child/protocol.js";
import { registerChildTools } from "./child/tools.js";
import { type ChildResult, runnerFor, spawnCheck } from "./runner.js";
import { createRunStore, type RunSnapshot, type RunStatus } from "./store.js";
import {
  addWorktree,
  planWorktree,
  repoRoot,
  type WorktreePlan,
  worktreeNote,
} from "./worktree.js";

const MAX_ANSWER_BYTES = 10_000;
const PULSE_MS = 250;
// An unchanged snapshot is resent at this rate so the row's clock moves between store changes.
const PULSE_FLOOR_MS = 1000;
const WIDGET_KEY = "skyr.subagents";
const TASK_SOURCE = "skyr/subagents";
const WIDGET_WIDTH = 100;
const MESSAGE_TYPE = "skyr.subagent";
const PREVIEW_LINES = 12;

const ABOUT =
  "Run a task in a subagent: a fresh agent with its own context and tools that returns only its final answer. Use it for work that would fill your context, such as searching a codebase, reading many files or researching the web. The agent sees nothing of this conversation, so the task must stand alone: give paths, context and the answer you want back. Independent tasks go out as several subagent calls in one turn, and run in parallel.";
const ADHOC =
  "Without `agent` the subagent is general-purpose: Pi's own system prompt, the tools read, grep, find, ls, bash, web_search and web_fetch, your model and your working directory. `prompt`, `tools`, `model` and `cwd` each override what the agent file or that default gives. A subagent whose tools include edit or write runs alone in its directory tree: a second one for the same directory, or one above or below it, waits until the first ends, so issue writes that depend on each other in separate turns. A writer call with NO cwd runs in its own fresh git worktree cut from HEAD instead of queueing; its writes stay uncommitted, and the result states the worktree path, branch, and how to inspect and merge them. With `background: true` the call returns at once and the answer arrives as a message when the subagent finishes; keep working meanwhile and never poll for it. With `continue: <id prefix>` the call starts a new run on a finished subagent's saved session, reusing its tools, model and directory: give a fresh task only. Ids are the `(id ab12cd34)` tag at the end of every subagent result, and they are valid only while the current session lives. Not in print mode (`pi -p`): the session ends after one turn and the answer would be lost.";

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
      "The whole task — the job for this one call, standalone. Role shaping goes in `prompt` (it is appended to the child's system prompt), never the job itself. The agent sees nothing of this conversation: give paths, context and the answer you want back.",
  }),
  prompt: Type.Optional(
    Type.String({
      description:
        "Added to the subagent's system prompt, after the agent's own when agent is given. Give it the role in a sentence, how to work, and the shape of the answer you want back.",
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
  continue: Type.Optional(
    Type.String({
      description:
        "ID prefix (8 chars) of a finished subagent (every subagent result ends with its `(id …)` tag) whose saved session gets another run: same tools, model and directory; give a fresh task only. Omit agent, prompt, tools, model and cwd.",
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
  /** The trimmed description; the label's description half. */
  description: string;
  /** The child's id, minted at resolve time so a reserved worktree shares it. */
  id: string;
  /** Present: a worktree was reserved for a bare writer; the child runs inside it. */
  worktree?: WorktreePlan;
  /** Why a bare writer fell back to writing in-tree (non-repo, unborn HEAD, no git). */
  worktreeWhy?: string;
  /** Present: this call continues a finished child; the record carries its calling facts. */
  continueOf?: ChildRecord;
}

/** A finished child's calling facts, for a second run through its saved session. */
interface ChildRecord {
  id: string;
  agent?: string;
  description: string;
  model: string;
  tools: string[];
  cwd: string;
  key: string;
  trusted: boolean;
  systemPrompt: string;
  sessionFile: string;
  /** A bare writer's worktree: a continued run writes the same tree again. */
  worktree?: WorktreePlan;
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

/** The directory where one session's child sessions live, next to the parent's .jsonl. */
function childSessionDir(parentFile: string | undefined): string | undefined {
  return parentFile === undefined
    ? undefined
    : join(dirname(parentFile), basename(parentFile, ".jsonl"));
}

/** A run's turns, tools and state, or why it waits; empty for a queued run with nobody ahead. */
function progressOf(run: RunSnapshot): string {
  if (run.status === "queued") return run.behind ? `behind ${run.behind}` : "";
  return [
    count(run.turns, "turn"),
    count(run.toolCalls, "tool"),
    run.tool,
    run.worktree && "worktree",
    run.activity === "unknown" && "stalled",
  ]
    .filter(Boolean)
    .join(" · ");
}

function taskOf(run: RunSnapshot): TaskItem {
  const detail = progressOf(run);
  return {
    id: run.id,
    title: labelOf(run),
    status: run.status,
    ...(detail ? { detail } : {}),
    startedAt: run.startedAt,
  };
}

const labelOf = (run: { agent?: string; description: string }) =>
  run.agent ?? `"${clip(run.description)}"`;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

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
  {
    recovered,
    stoppedBy = "",
  }: { recovered?: boolean; stoppedBy?: string } = {},
): Promise<{ text: string; spillFile?: string }> {
  const marker = recovered ? " (recovered after a restart)" : "";
  if (result.status === "aborted")
    return {
      text: `subagent: ${label} was stopped${stoppedBy} before it answered${marker}`,
    };
  if (result.status === "failed")
    return {
      text: `subagent: ${label} failed${marker}: ${result.error ?? "no error message"}`,
    };
  if (!result.text)
    return { text: `subagent: ${label} ended without an answer${marker}` };
  const { truncateHead, DEFAULT_MAX_LINES } = await loadPi();
  const cut = truncateHead(result.text, {
    maxBytes: MAX_ANSWER_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!cut.truncated) return { text: result.text };
  try {
    const spillFile = await spill(id, result.text);
    return {
      text: `${cut.content}\n\n[Truncated: the full answer is in ${spillFile}]`,
      spillFile,
    };
  } catch {
    // ENOSPC or an unwritable temp dir must not cost the model the capped answer it paid for.
    return {
      text: `${cut.content}\n\n[Truncated: the full answer could not be saved to disk; tell the user]`,
    };
  }
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
  store.subscribe(() =>
    publishTasks(pi.events, TASK_SOURCE, store.running().map(taskOf)),
  );
  // One writer per directory: a key's chain resolves once every earlier writer has released.
  const writers = new Map<string, Slot>();
  // Per-child abort, for `/subagents stop`; everything a UI reads stays in the store.
  const children = new Map<string, AbortController>();
  // Finished background answers waiting for the parent to be idle. Never Pi's steer or followUp
  // queues: Esc clears those.
  let pending: Outcome[] = [];
  // Finished children (this session only), for `continue`; cleared with the store.
  const records = new Map<string, ChildRecord>();
  // Child ids whose continued run is live: set synchronously in resolveCall, so two same-turn
  // continues on one child cannot both resolve (and both append one session file).
  const runningContinues = new Set<string>();
  // Bumped at every session start and shutdown, so a child that outlives its session touches
  // neither the next session nor its own stale context.
  let generation = 0;
  let agents = new Map<string, AgentDef>();
  let loadErrors: string[] = [];
  let description = describe(agents);
  let sessionAbort = new AbortController();
  let canSpawn = spawnCheck();
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
    ctx: Pick<ExtensionContext, "cwd" | "model" | "sessionManager">,
  ): Call {
    const agent =
      params.agent === undefined ? undefined : agents.get(params.agent);
    if (params.agent !== undefined && !agent) throw unknownAgent(params.agent);
    if (params.continue !== undefined)
      return resolveContinue(params, params.continue.trim());
    const childId = randomUUID();
    const description = params.description.trim();
    if (description === "")
      throw fail(
        "give a short description: 3-5 words for the user, in description",
      );
    const label = labelOf({
      agent: agent?.name,
      description,
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
    } catch (error: unknown) {
      throw fail(
        `the working directory ${ctx.cwd} does not resolve (${errnoOf(error) ?? "fs error"}); tell the user to restart Pi in an existing directory`,
      );
    }
    const message = `pass an existing directory, absolute or relative to ${ctx.cwd}`;
    const cwd = resolve(ctx.cwd, params.cwd ?? ".");
    let key: string;
    try {
      key = realpathSync(cwd);
    } catch (error: unknown) {
      throw fail(
        `cwd ${quoted(params.cwd ?? ".", 120)} does not resolve (${errnoOf(error) ?? "fs error"}) (looked at ${clip(cwd)}); ${message}`,
      );
    }
    // A broken entry cannot survive a successful realpath, so undefined means the directory
    // disappeared while resolving: same diagnosis as a continue's record losing its cwd.
    const entry = statSync(key, { throwIfNoEntry: false });
    if (entry === undefined)
      throw fail(
        `cwd ${quoted(params.cwd ?? ".", 120)} no longer exists (looked at ${clip(key)}); ${message}`,
      );
    if (!entry.isDirectory())
      throw fail(
        `cwd ${quoted(params.cwd ?? ".", 120)} is not a directory (looked at ${clip(key)}); ${message}`,
      );
    const writer = tools.includes("edit") || tools.includes("write");
    let worktree: WorktreePlan | undefined;
    let worktreeWhy: string | undefined;
    if (writer && params.cwd === undefined) {
      // The worktree's slice of the session dir must keep the canonical spelling (realpath),
      // so a later bare writer naming "the worktree" resolves to the same slot key.
      const parentFile = ctx.sessionManager.getSessionFile();
      const sessionDir =
        parentFile === undefined
          ? undefined
          : join(
              realpathSync(dirname(parentFile)),
              basename(parentFile, ".jsonl"),
            );
      const planned = planWorktree(
        cwd,
        sessionDir,
        childId,
        params.description,
      );
      if ("why" in planned) worktreeWhy = planned.why;
      else worktree = planned;
    }
    return {
      agent: agent?.name,
      label,
      model,
      tools,
      writer,
      systemPrompt: [agent?.body, params.prompt].filter(Boolean).join("\n\n"),
      description,
      cwd: worktree !== undefined ? worktree.path : cwd,
      key: worktree !== undefined ? worktree.path : key,
      parentKey,
      background: params.background === true,
      id: childId,
      ...(worktree !== undefined ? { worktree } : {}),
      ...(worktreeWhy !== undefined ? { worktreeWhy } : {}),
    };
  }

  /** The `continue` branch of `resolveCall`: synchronous, and takes the same-turn guard. */
  function resolveContinue(params: Static<typeof Params>, raw: string): Call {
    const prefix = raw;
    if (
      params.agent !== undefined ||
      params.prompt !== undefined ||
      params.tools !== undefined ||
      params.model !== undefined ||
      params.cwd !== undefined
    )
      throw fail(
        "continue reuses the subagent's tools, model and directory; omit agent, prompt, tools, model and cwd",
      );
    if (prefix === "")
      throw fail("continue: pass a subagent id prefix from one of its results");
    const matches = [...records.entries()].filter(([id]) =>
      id.startsWith(prefix),
    );
    if (matches.length === 0)
      throw fail(
        [...children.keys()].some((id) => id.startsWith(prefix))
          ? `subagent ...${clip(prefix)} is still running; wait for its answer or stop it`
          : `no subagent matches "${clip(prefix)}"; ids are the 8-char prefixes in subagent results and are valid only in this session - start a fresh subagent instead`,
      );
    if (matches.length > 1)
      throw fail(
        `"${clip(prefix)}" matches more than one finished subagent (${matches.map(([, r]) => labelOf(r)).join(", ")}); give a longer prefix or start a fresh subagent`,
      );
    const [match] = matches;
    if (!match) throw fail(`no subagent matches "${clip(prefix)}"`);
    const record = match[1];
    const entry = statSync(record.cwd, { throwIfNoEntry: false });
    if (entry === undefined)
      throw fail(
        `the subagent's working directory ${clip(record.cwd)} no longer exists; start a fresh subagent instead`,
      );
    if (!entry.isDirectory())
      throw fail(
        `the subagent's working directory ${clip(record.cwd)} is not a directory anymore; start a fresh subagent instead`,
      );
    if (runningContinues.has(record.id))
      throw fail(
        `subagent ${record.id.slice(0, 8)} already has a run in progress; wait for it to finish`,
      );
    runningContinues.add(record.id);
    return {
      agent: record.agent,
      description: params.description.trim(),
      worktree: record.worktree,
      label: labelOf({ agent: record.agent, description: params.description }),
      model: record.model,
      tools: record.tools,
      writer: record.tools.includes("edit") || record.tools.includes("write"),
      systemPrompt: record.systemPrompt,
      cwd: record.cwd,
      key: record.key,
      parentKey: record.key,
      background: params.background === true,
      id: record.id,
      continueOf: record,
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
      const progress = progressOf(run);
      const line = `${mark} ${labelOf(run)}${progress ? ` · ${progress}` : ""} · ${Math.round((now - run.startedAt) / 1000)}s · ${run.id.slice(0, 8)}`;
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
      const { label, background, key } = call;
      // A continued run reuses the child's id (via the record the resolve read).
      const resumed = call.continueOf;
      const parentFile = ctx.sessionManager.getSessionFile();
      const own = new AbortController();
      const sessionSignal = sessionAbort.signal;
      // A background child outlives the call, so the call's signal (Esc) is not part of its own.
      const childSignal = AbortSignal.any([
        ...(signal && !background ? [signal] : []),
        sessionSignal,
        own.signal,
      ]);
      // First cause; anything but the session is Esc, `/subagents stop`, or Pi aborting the turn
      // before a session switch.
      const stoppedBy = () =>
        !childSignal.aborted
          ? ""
          : childSignal.reason !== sessionSignal.reason
            ? " by the user"
            : sessionSignal.reason === "reload"
              ? " because Pi reloaded"
              : " because the session ended";
      const born = generation;
      const id = call.id;
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
        ...(call.worktree
          ? {
              worktree: {
                path: call.worktree.path,
                branch: call.worktree.branch,
              },
            }
          : {}),
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

      const failed = (error: unknown, worktree?: WorktreePlan) =>
        fail(
          `${label}: ` +
            (worktree
              ? `created worktree ${worktree.path} on branch ${worktree.branch}; it is empty — `
              : "") +
            errorText(error),
          error,
        );
      // The store's snapshot while the child is live, else the last one this call sent (the store
      // is empty once the child has ended, or when a reload cleared it mid-run); either way
      // without the live-only `activity`.
      const ended = (
        status: RunStatus,
        text: string,
        isError = true,
        extra: Partial<RunSnapshot> = {},
      ): Outcome => {
        const { activity: _, ...last } = store.byToolCall(toolCallId) ?? sent;
        return {
          text,
          isError,
          details: { ...last, status, endedAt: Date.now(), ...extra },
        };
      };
      const stoppedBeforeStart = () =>
        ended(
          "aborted",
          `subagent: ${label} was stopped${stoppedBy()} before it started`,
        );

      const finish = async (): Promise<Outcome> => {
        try {
          if (slot?.behind) {
            await slot.wait(childSignal);
            if (childSignal.aborted) return stoppedBeforeStart();
            const { behind: _, ...rest } = sent;
            sent = { ...rest, status: "running" };
            store.apply(id, { type: "start", snapshot: sent });
            send(sent);
          }
          if (call.worktree !== undefined && resumed === undefined)
            // A fresh bare writer creates its reserved worktree; a continue of an older
            // worktree child reuses the existing one (re-adding would fail the identity).
            await addWorktree(call.parentKey, call.worktree, childSignal);
          const trusted =
            resumed !== undefined
              ? resumed.trusted
              : await trustFor(key, call.parentKey, ctx.isProjectTrusted());
          const result = await runnerFor(
            ctx.modelRegistry,
            registerChildTools,
            canSpawn,
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
              description: params.description,
              agent: call.agent,
              session: resumed
                ? { resume: resumed.sessionFile }
                : parentFile
                  ? {
                      dir: childSessionDir(parentFile) ?? "",
                      parent: parentFile,
                    }
                  : undefined,
            },
            childSignal,
            (event) => store.apply(id, event),
          );
          const { text, spillFile } = await answer(label, id, result, {
            stoppedBy: stoppedBy(),
          });
          const noted = call.worktree
            ? worktreeNote(call.worktree, result.status === "done")
            : call.worktreeWhy === undefined
              ? ""
              : `${call.worktreeWhy}; writing in-tree: NOT isolated from your uncommitted files.\n`;
          if (result.sessionFile !== undefined && result.sessionFile !== "")
            records.set(id, {
              id,
              agent: call.agent,
              description: params.description,
              model: call.model,
              tools: call.tools,
              cwd: call.cwd,
              key,
              trusted,
              systemPrompt: call.systemPrompt,
              sessionFile: result.sessionFile,
            });
          return {
            ...ended(
              result.status,
              noted + text,
              result.status !== "done" || !result.text,
              { sessionFile: result.sessionFile, spillFile },
            ),
            usage: result.usage,
          };
        } finally {
          if (pulse) clearInterval(pulse);
          slot?.release();
          children.delete(id);
          runningContinues.delete(id);
          store.apply(id, { type: "end" });
        }
      };

      if (!background) {
        let outcome: Outcome;
        try {
          outcome = await finish();
        } catch (error: unknown) {
          // Pi's own cancellation (Esc) is Pi's to report.
          if (signal?.aborted) throw error;
          if (!childSignal.aborted) throw failed(error, call.worktree);
          outcome = stoppedBeforeStart();
        }
        // Only a foreground result needs the id tag: a background one's delivered header carries it.
        return {
          content: [
            { type: "text", text: `${outcome.text}\n(id ${id.slice(0, 8)})` },
          ],
          details: outcome.details,
          usage: outcome.usage,
          isError: outcome.isError,
        };
      }
      void finish()
        .catch((error: unknown) =>
          childSignal.aborted
            ? stoppedBeforeStart()
            : ended("failed", failed(error, call.worktree).message),
        )
        .then((outcome) => {
          if (born !== generation) return;
          pending.push(outcome);
          try {
            if (ctx.isIdle()) flush();
          } catch {
            // The only thrower: the runner is stale because the host disposed or reloaded the
            // session without events; the instance is gone, so there is nothing to deliver.
          }
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
          ["muted", run.tool ? ` · ${run.tool}` : ""],
          ...runTime(run),
          ["muted", run.worktree ? " · worktree" : ""],
          ["muted", run.activity === "unknown" ? " · stalled" : ""],
        ]);
      return toolRow(theme, [
        ["success", "✓ done"],
        ...summary(run),
        ["muted", ` · ${tokens(run.tokens)}`],
        ...runTime(run),
      ]);
    },
  });

  registerTextMessageRenderer(pi, MESSAGE_TYPE, PREVIEW_LINES);

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

  /**
   * A crashed parent's finished children wait in their job dirs. On any session start the
   * valid results are delivered once; dirs older than a day are reaped, and the freshly
   * delivered ones right after their read.
   */
  async function sweepJobs(parentFile: string | undefined): Promise<Outcome[]> {
    const recovered: Outcome[] = [];
    const base = childSessionDir(parentFile);
    if (base === undefined) return [];
    const jobsRoot = join(base, "jobs");

    const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const jobDir = join(jobsRoot, entry.name);
      const raw = await readFile(join(jobDir, "result.json"), "utf8").then(
        (body: string) => {
          try {
            return JSON.parse(body) as unknown;
          } catch {
            return undefined;
          }
        },
        () => undefined,
      );
      const stored = raw === undefined ? undefined : readStoredResult(raw);
      if (stored === undefined) {
        // Aged-out leftovers only: a live sibling session's job dirs stay untouched.
        const stamp = await stat(jobDir).catch(() => undefined);
        if (
          stamp !== undefined &&
          Date.now() - stamp.mtimeMs > 24 * 60 * 60 * 1000
        )
          await rm(jobDir, { recursive: true, force: true }).catch(
            () => undefined,
          );
        continue;
      }
      await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
      const { text } = await answer(
        stored.agent ?? `"${clip(stored.description)}"`,
        entry.name,
        {
          status: stored.status,
          text: stored.text,
          error: stored.error,
          usage: stored.usage,
          sessionFile: stored.sessionFile,
        },
        { recovered: true },
      );
      recovered.push({
        text,
        details: {
          id: entry.name,
          toolCallId: `recovered-${entry.name.slice(0, 8)}`,
          ...(stored.agent !== undefined ? { agent: stored.agent } : {}),
          description: stored.description,
          status: stored.status,
          startedAt: 0,
          turns: 0,
          toolCalls: 0,
          tokens: stored.usage.totalTokens,
          recovered: true as const,
        },
        isError: stored.status !== "done",
      });
      // A recovered bare writer keeps stating its worktree: the writes live on there.
      const worktreeDir = join(base, "worktrees", entry.name.slice(0, 8));
      if (existsSync(worktreeDir)) {
        const outcome = recovered[recovered.length - 1];
        if (outcome === undefined) continue;
        outcome.text =
          `Ran in worktree ${worktreeDir} — its writes are uncommitted there; nothing deletes it\n` +
          outcome.text;
      }
    }
    return recovered;
  }

  pi.on("session_start", async (_event, ctx) => {
    store.clear();
    sessionAbort = new AbortController();
    canSpawn = spawnCheck();
    generation += 1;
    pending = [];
    records.clear();
    runningContinues.clear();
    const recovered = await sweepJobs(ctx.sessionManager.getSessionFile());
    if (recovered.length > 0) {
      pending.push(...recovered);
      flush();
    }
    const { getAgentDir, CONFIG_DIR_NAME } = await loadPi();
    const loaded = await loadAgents({
      user: join(getAgentDir(), "agents"),
      // Pi reads a project's .pi/ resources only once the user trusts the project.
      // Claude Code's dir sits at the repo root and loses to Pi's own.
      project: ctx.isProjectTrusted()
        ? [
            join(repoRoot(ctx.cwd), ".claude", "agents"),
            join(ctx.cwd, CONFIG_DIR_NAME, "agents"),
          ]
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
    if (loaded.warnings.length > 0)
      ctx.ui.notify(
        `subagent: agent files with fields skyr ignores (it reads ${READ_FIELDS.join(", ")}):\n${loaded.warnings.join("\n")}`,
        "warning",
      );

    unsubscribe?.();
    unsubscribe = undefined;
    stopTick();
    if (!ctx.hasUI) return;
    const draw = () => {
      const lines = widgetLines();
      // A reload or session replacement between ticks leaves ctx stale; pi reports a throw
      // from a handler, but a timer callback is not one, so the draw dead-stops instead.
      try {
        ctx.ui.setWidget(WIDGET_KEY, lines);
      } catch {
        stopTick();
        return;
      }
      // The clock in each line moves only while something is live.
      if (lines && !widgetTick) widgetTick = setInterval(draw, 1000);
      if (!lines) stopTick();
    };
    unsubscribe = store.subscribe(draw);
  });

  pi.on("session_shutdown", (event, ctx) => {
    generation += 1;
    // the reason lets a stopped child say whether Pi reloaded or the session ended
    sessionAbort.abort(event.reason);
    unsubscribe?.();
    unsubscribe = undefined;
    stopTick();
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    store.clear();
    pending = [];
    records.clear();
    runningContinues.clear();
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
