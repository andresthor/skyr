/**
 * The subagent runs of one registration: resolving a call's tasks, claiming what they hold,
 * running each child, and handing back or delivering its answer. `open` and `close` reset what
 * belongs to one session; the unit itself lives as long as the extension.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { errnoOf } from "../errno.js";
import { loadPi } from "../pi.js";
import { clip, quoted, sanitize } from "../ui/text.js";
import { DEFAULT_TOOLS, type loadAgents, parseTools } from "./agents.js";
import { GRACE_MS } from "./child/proc-runner.js";
import { readStoredResult } from "./child/protocol.js";
import { registerChildTools } from "./child/tools.js";
import { type ChildRecord, leaveStopped, takeStopped } from "./handoff.js";
import { answer, delivery, type LaneOutcome, noAnswer } from "./result.js";
import { runnerFor, spawnCheck } from "./runner.js";
import {
  count,
  createRunStore,
  labelOf,
  type RunSnapshot,
  type RunStatus,
  type RunStore,
} from "./store.js";
import {
  addWorktree,
  planWorktree,
  type WorktreePlan,
  worktreeNote,
  worktreeState,
} from "./worktree.js";

export const MESSAGE_TYPE = "skyr.subagent";

/** One subagent task; `index.ts` composes it into the tool's parameters. */
// Closed, as the call is: Pi's validator then names a misplaced or unknown key instead of
// running without it.
export const Task = Type.Object(
  {
    agent: Type.Optional(
      Type.String({
        description:
          "Name of one of the agents listed in this tool's description. Omit for a general-purpose subagent.",
      }),
    ),
    description: Type.String({
      description: "3-5 words for the user, naming this task",
    }),
    prompt: Type.String({
      description:
        "The whole job for this subagent, standalone: paths, context and the answer you want back. A role goes in `role`, never the job itself.",
    }),
    role: Type.Optional(
      Type.String({
        description:
          "Added to the subagent's system prompt, after the agent's own when agent is given. Give it the role in a sentence, how to work, and the shape of the answer you want back; never the job.",
      }),
    ),
    tools: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Tool names this subagent may use; replaces the agent's or the default set. Add edit or write only to change files: such a subagent runs alone in its directory tree.",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Model for this subagent, as `pi --model` takes it (provider/id or a pattern). Defaults to the agent's, else yours.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Existing directory this subagent works in, absolute or relative to yours. Create it first if you need a fresh one.",
      }),
    ),
    continue: Type.Optional(
      Type.String({
        description:
          "ID (8 chars) of a finished or stopped subagent, from the `id` on its answer: its saved session gets another run with the same tools, model and directory. Give description and a fresh prompt only; omit agent, role, tools, model and cwd.",
      }),
    ),
  },
  { additionalProperties: false },
);

type CallContext = Pick<
  ExtensionContext,
  | "cwd"
  | "model"
  | "sessionManager"
  | "modelRegistry"
  | "thinkingLevel"
  | "isProjectTrusted"
  | "isIdle"
>;

/** What `loadAgents` found at the latest session start. */
type Agents = Pick<Awaited<ReturnType<typeof loadAgents>>, "agents" | "errors">;

interface Runs {
  /** Running children, for the widget, ACP and `/subagents`; read-only. */
  readonly store: Pick<RunStore, "running" | "subscribe">;
  /**
   * Foreground. Resolves every task, then claims each in task order, before the first await; any
   * bad task throws one model-facing error naming every bad task, having claimed nothing.
   * `signal` (Esc) stops every child. Settles once every child has, in task order, and never
   * rejects after the claim: a stop or a failure is that outcome's `error`.
   */
  run(
    tasks: readonly Static<typeof Task>[],
    signal: AbortSignal | undefined,
    ctx: CallContext,
  ): Promise<LaneOutcome[]>;
  /**
   * Background. Resolves and claims as `run` does, then returns each task's start snapshot. The
   * children ignore Esc, and each queues its own delivery for the idle parent; nothing after the
   * claim throws.
   */
  start(tasks: readonly Static<typeof Task>[], ctx: CallContext): RunSnapshot[];
  /** Sends every pending background answer as one message; `agent_settled`. */
  flush(): void;
  /** `/subagents stop <id|all>`: the notice. */
  stop(target: string): { text: string; level: "info" | "warning" };
  /**
   * Session start: forget the last session, sweep crashed job dirs, deliver what they hold. A
   * reload of this session file also restores the children it could continue, and delivers the
   * background runs it stopped as a message that starts no turn of its own.
   */
  open(parentFile: string | undefined): Promise<void>;
  /**
   * Session shutdown: stop every child with `reason`; forget records and pending answers. The
   * background runs it stops and the children it could continue are left for the next session on
   * the same file.
   */
  close(reason: string): void;
}

/** One task resolved against its agent file and the defaults; nothing has been spent yet. */
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
  /** The description, sanitized and trimmed; the label's description half. */
  description: string;
  /** The job the child is given, as the model wrote it. */
  task: string;
  /** The child's id, minted at resolve time so a reserved worktree shares it. */
  id: string;
  /** Present: a worktree was reserved for a bare writer; the child runs inside it. */
  worktree?: WorktreePlan;
  /** Why a bare writer fell back to writing in-tree (non-repo, unborn HEAD, no git). */
  worktreeWhy?: string;
  /** Present: this task continues a finished child; the record carries its calling facts. */
  continueOf?: ChildRecord;
}

/** A writer's place in its directory's queue. */
interface Slot {
  chain: Promise<void>;
  label: string;
}

/** A task names an agent that is not loaded; the refusal then lists the agent files that failed. */
class UnknownAgent extends Error {}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** What follows "was stopped" when the session's end, not the user, stopped a child. */
const sessionStop = (reason: unknown) =>
  reason === "reload" ? " because Pi reloaded" : " because the session ended";

/** How long a child the session's end stopped may keep writing: its kill grace, and its exit. */
const STOP_SETTLE_MS = GRACE_MS + 1_000;

/**
 * What a background run reads as when a session's end stopped it and its own call is gone. A
 * worktree that exists is stated: the run may have written there before it stopped.
 */
async function stoppedOutcome(
  run: RunSnapshot,
  reason: string,
  continuable: boolean,
): Promise<LaneOutcome> {
  const { body, error } = noAnswer(labelOf(run), {
    stoppedBy: sessionStop(reason),
    before: run.status === "queued" ? "started" : "answered",
  });
  const plan = run.worktree;
  // A child that was running keeps writing through its kill grace, so no read of its tree is
  // final; one still queued never wrote.
  const settling = run.status !== "queued";
  const state =
    plan === undefined
      ? "absent"
      : settling
        ? existsSync(plan.path)
          ? "writes"
          : "absent"
        : await worktreeState(plan);
  return {
    body,
    notes: [
      ...(plan === undefined || state === "absent"
        ? []
        : [
            {
              kind: "line" as const,
              text: worktreeNote(plan, state === "writes"),
            },
            ...(settling
              ? [
                  {
                    kind: "line" as const,
                    text: `The child may still be writing for about ${Math.ceil(STOP_SETTLE_MS / 1000)}s; check git -C ${plan.path} status --porcelain after that`,
                  },
                ]
              : []),
          ]),
      ...(continuable
        ? [
            {
              kind: "line" as const,
              text: `Its session is saved; a task with continue: ${run.id.slice(0, 8)} resumes it`,
            },
          ]
        : []),
    ],
    run: { ...run, status: "aborted", endedAt: Date.now(), error },
  };
}

/** The directory where one session's child sessions live, next to the parent's .jsonl. */
function childSessionDir(parentFile: string | undefined): string | undefined {
  return parentFile === undefined
    ? undefined
    : join(dirname(parentFile), basename(parentFile, ".jsonl"));
}

/**
 * The session file of a child that has begun, or undefined. The parent learns the name only
 * from a finished run's result; Pi names the file `<timestamp>_<child id>.jsonl` in the dir
 * the child was given.
 */
function savedSessionOf(
  parentFile: string | undefined,
  id: string,
): string | undefined {
  const dir = childSessionDir(parentFile);
  if (dir === undefined) return undefined;
  try {
    const name = readdirSync(dir).find((file) => file.endsWith(`_${id}.jsonl`));
    return name === undefined ? undefined : join(dir, name);
  } catch {
    return undefined;
  }
}

/**
 * A crashed parent's finished children wait in their job dirs. On any session start the
 * valid results are delivered once; dirs older than a day are reaped, and the freshly
 * delivered ones right after their read.
 */
async function sweepJobs(
  parentFile: string | undefined,
): Promise<LaneOutcome[]> {
  const recovered: LaneOutcome[] = [];
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
    const { body, spill, error } = await answer(
      labelOf(stored),
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
    // A recovered bare writer keeps stating its worktree: the writes live on there.
    const worktreeDir = join(base, "worktrees", entry.name.slice(0, 8));
    recovered.push({
      body,
      notes: [
        ...(spill ? [spill] : []),
        ...(existsSync(worktreeDir)
          ? [
              {
                kind: "line" as const,
                text: `Ran in worktree ${worktreeDir} — its writes are uncommitted there; nothing deletes it`,
              },
            ]
          : []),
      ],
      run: {
        id: entry.name,
        ...(stored.agent !== undefined ? { agent: stored.agent } : {}),
        description: stored.description,
        status: stored.status,
        startedAt: 0,
        turns: 0,
        toolCalls: 0,
        tokens: stored.usage.totalTokens,
        recovered: true as const,
        ...(error !== undefined ? { error } : {}),
      },
      usage: stored.usage,
    });
  }
  return recovered;
}

export function createRuns(
  pi: Pick<ExtensionAPI, "getSettings" | "sendMessage">,
  agents: () => Agents,
): Runs {
  const store = createRunStore();
  // One writer per directory: a key's chain resolves once every earlier writer has released.
  // Kept across sessions: an aborted child writes on through its SIGTERM grace.
  const writers = new Map<string, Slot>();
  // Per-child abort, for `/subagents stop`; everything a UI reads stays in the store.
  const children = new Map<string, AbortController>();
  // Finished background answers waiting for the parent to be idle. Never Pi's steer or followUp
  // queues: Esc clears those.
  let pending: LaneOutcome[] = [];
  // Children that can be continued, for `continue`: finished ones, and after a reload those it
  // carried over. Cleared with the store.
  const records = new Map<string, ChildRecord>();
  // The calling facts of each fresh child while it runs, for the record its stop leaves.
  const live = new Map<string, Omit<ChildRecord, "sessionFile">>();
  // Child ids whose continued run is live: set synchronously in claim, so two same-turn
  // continues on one child cannot both resolve (and both append one session file).
  const runningContinues = new Set<string>();
  // Bumped at every session start and shutdown, so a child that outlives its session touches
  // neither the next session nor its own stale context.
  let generation = 0;
  // Written only in `open`.
  let sessionFile: string | undefined;
  let sessionAbort = new AbortController();
  let canSpawn = spawnCheck();

  /**
   * Resolves every task of a call, then refuses the call if any is bad, with one error naming
   * each problem. Synchronous, and claims nothing: a refusal leaves no trace.
   */
  function resolveAll(
    tasks: readonly Static<typeof Task>[],
    ctx: Pick<ExtensionContext, "cwd" | "model" | "sessionManager">,
  ): Call[] {
    const calls: Call[] = [];
    const problems: string[] = [];
    // A continued child's id, by the task that first continues it.
    const continued = new Map<string, number>();
    let agentMissing = false;
    for (const [i, task] of tasks.entries()) {
      // Clean where it enters: every label, title, error and answer built from it reads this one.
      const description = sanitize(task.description).trim();
      const which = `task ${i + 1}${description ? ` ("${clip(description)}")` : ""}`;
      let call: Call;
      try {
        call = resolveCall(task, description, ctx);
      } catch (error: unknown) {
        if (error instanceof UnknownAgent) agentMissing = true;
        problems.push(`- ${which}: ${errorText(error)}`);
        continue;
      }
      const first = call.continueOf && continued.get(call.id);
      if (first !== undefined) {
        problems.push(
          `- ${which}: continues the same subagent as task ${first} (${call.id.slice(0, 8)}); one run per subagent at a time, so merge them into one task`,
        );
        continue;
      }
      if (call.continueOf) continued.set(call.id, i + 1);
      calls.push(call);
    }
    if (problems.length === 0) return calls;
    const { errors } = agents();
    throw new Error(
      [
        "subagent: nothing ran; fix these and call again:",
        ...problems,
        ...(agentMissing && errors.length > 0
          ? [`Agent files that failed to load: ${errors.join("; ")}`]
          : []),
      ].join("\n"),
    );
  }

  /**
   * Resolves one task against its agent file and the defaults, throwing for anything the model
   * must fix. Synchronous, and claims nothing.
   */
  function resolveCall(
    params: Static<typeof Task>,
    description: string,
    ctx: Pick<ExtensionContext, "cwd" | "model" | "sessionManager">,
  ): Call {
    if (description === "")
      throw new Error(
        "give a short description: 3-5 words for the user, in description",
      );
    if (params.continue !== undefined)
      return resolveContinue(params, params.continue.trim(), description);
    const agent =
      params.agent === undefined
        ? undefined
        : agents().agents.get(params.agent);
    if (params.agent !== undefined && !agent)
      throw new UnknownAgent(
        `no agent "${clip(params.agent)}"; available: ${[...agents().agents.keys()].sort().join(", ") || "none"}`,
      );
    const childId = randomUUID();
    const label = labelOf({
      agent: agent?.name,
      description,
    });
    const model =
      params.model ??
      agent?.model ??
      (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
    if (!model)
      throw new Error("no model is selected; select one, or pass model");
    let tools: string[];
    try {
      tools = parseTools(params.tools) ?? agent?.tools ?? DEFAULT_TOOLS;
    } catch (error: unknown) {
      throw new Error(`tools: ${errorText(error)}`, { cause: error });
    }
    // Realpath, as Pi keys its file queue and trust store: two spellings of one dir share a slot.
    let parentKey: string;
    try {
      parentKey = realpathSync(ctx.cwd);
    } catch (error: unknown) {
      throw new Error(
        `the working directory ${ctx.cwd} does not resolve (${errnoOf(error) ?? "fs error"}); tell the user to restart Pi in an existing directory`,
      );
    }
    const message = `pass an existing directory, absolute or relative to ${ctx.cwd}`;
    const cwd = resolve(ctx.cwd, params.cwd ?? ".");
    let key: string;
    try {
      key = realpathSync(cwd);
    } catch (error: unknown) {
      throw new Error(
        `cwd ${quoted(params.cwd ?? ".", 120)} does not resolve (${errnoOf(error) ?? "fs error"}) (looked at ${clip(cwd)}); ${message}`,
      );
    }
    // A broken entry cannot survive a successful realpath, so undefined means the directory
    // disappeared while resolving: same diagnosis as a continue's record losing its cwd.
    const entry = statSync(key, { throwIfNoEntry: false });
    if (entry === undefined)
      throw new Error(
        `cwd ${quoted(params.cwd ?? ".", 120)} no longer exists (looked at ${clip(key)}); ${message}`,
      );
    if (!entry.isDirectory())
      throw new Error(
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
      const planned = planWorktree(cwd, sessionDir, childId, description);
      if ("why" in planned) worktreeWhy = planned.why;
      else worktree = planned;
    }
    return {
      agent: agent?.name,
      label,
      model,
      tools,
      writer,
      systemPrompt: [agent?.body, params.role].filter(Boolean).join("\n\n"),
      description,
      task: params.prompt,
      cwd: worktree !== undefined ? worktree.path : cwd,
      key: worktree !== undefined ? worktree.path : key,
      parentKey,
      id: childId,
      ...(worktree !== undefined ? { worktree } : {}),
      ...(worktreeWhy !== undefined ? { worktreeWhy } : {}),
    };
  }

  /** The `continue` branch of `resolveCall`: refuses a child whose continued run is live. */
  function resolveContinue(
    params: Static<typeof Task>,
    raw: string,
    description: string,
  ): Call {
    const prefix = raw;
    if (
      params.agent !== undefined ||
      params.role !== undefined ||
      params.tools !== undefined ||
      params.model !== undefined ||
      params.cwd !== undefined
    )
      throw new Error(
        "continue reuses the subagent's tools, model and directory; omit agent, role, tools, model and cwd",
      );
    if (prefix === "")
      throw new Error(
        "continue: pass the 8-char id of a finished or stopped subagent, from the `id` on its answer",
      );
    const matches = [...records.entries()].filter(([id]) =>
      id.startsWith(prefix),
    );
    if (matches.length === 0)
      throw new Error(
        [...children.keys()].some((id) => id.startsWith(prefix))
          ? `subagent ...${clip(prefix)} is still running; wait for its answer or stop it`
          : `no subagent matches "${clip(prefix)}"; ids are the 8-char \`id\` on each subagent answer and are valid only in this session - start a fresh subagent instead`,
      );
    if (matches.length > 1)
      throw new Error(
        `"${clip(prefix)}" matches more than one finished or stopped subagent (${matches.map(([, r]) => labelOf(r)).join(", ")}); give its whole 8-char id or start a fresh subagent`,
      );
    const [match] = matches;
    if (!match) throw new Error(`no subagent matches "${clip(prefix)}"`);
    const record = match[1];
    // A second writer on the session file would interleave its entries with the dying child's.
    if (record.settledAt !== undefined && Date.now() < record.settledAt)
      throw new Error(
        `subagent ${record.id.slice(0, 8)} was stopped moments ago and may still be writing its session; call again in ${Math.ceil((record.settledAt - Date.now()) / 1000)}s`,
      );
    const entry = statSync(record.cwd, { throwIfNoEntry: false });
    if (entry === undefined)
      throw new Error(
        `the subagent's working directory ${clip(record.cwd)} no longer exists; start a fresh subagent instead`,
      );
    if (!entry.isDirectory())
      throw new Error(
        `the subagent's working directory ${clip(record.cwd)} is not a directory anymore; start a fresh subagent instead`,
      );
    if (runningContinues.has(record.id))
      throw new Error(
        `subagent ${record.id.slice(0, 8)} already has a run in progress; wait for it to finish`,
      );
    return {
      agent: record.agent,
      description,
      task: params.prompt,
      worktree: record.worktree,
      label: labelOf({ agent: record.agent, description }),
      model: record.model,
      tools: record.tools,
      writer: record.tools.includes("edit") || record.tools.includes("write"),
      systemPrompt: record.systemPrompt,
      cwd: record.cwd,
      key: record.key,
      parentKey: record.key,
      id: record.id,
      continueOf: record,
    };
  }

  /**
   * Claims a resolved task: the continue guard, the writer slot, the stop handle and the store
   * entry. The caller releases each once the run ends.
   */
  function claim(call: Call, background: boolean) {
    if (call.continueOf !== undefined) runningContinues.add(call.id);
    const slot = call.writer ? takeSlot(call.key, call.label) : undefined;
    const snapshot: RunSnapshot = {
      id: call.id,
      agent: call.agent,
      description: call.description,
      status: slot?.behind ? "queued" : "running",
      startedAt: Date.now(),
      turns: 0,
      toolCalls: 0,
      tokens: 0,
      ...(slot?.behind ? { behind: slot.behind } : {}),
      ...(background ? { background: true as const } : {}),
      ...(call.worktree ? { worktree: call.worktree } : {}),
    };
    const own = new AbortController();
    children.set(call.id, own);
    store.apply(call.id, { type: "start", snapshot });
    return { call, slot, own, snapshot };
  }

  /**
   * The next writer slot for `key`, behind every live writer in the same directory, above it or
   * below it. `behind` names the latest of those, if any; `wait` resolves once they have all
   * released or `signal` aborts; `release` frees the slot exactly once, whatever happened, and
   * a slot freed while still queued keeps the directory locked until every writer ahead ends.
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
        // Freed while queued: the next writer now waits for the one this slot waited for.
        if (behind !== undefined && writers.get(key)?.chain === chain)
          writers.set(key, { chain, label: behind });
        void chain.then(() => {
          if (writers.get(key)?.chain === chain) writers.delete(key);
        });
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

  /**
   * One message for everything that finished, so a second send never lands in a steer queue.
   * `triggerTurn` false only delivers it: the model reads it on its next prompt.
   */
  function flush(triggerTurn = true): void {
    if (pending.length === 0) return;
    // `delivery` never throws: every field it reads is checked where it enters.
    const text = delivery(pending);
    const details = pending.map((o) => ({ ...o.run, usage: o.usage }));
    pending = [];
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: [{ type: "text", text }],
        display: true,
        details,
      },
      { triggerTurn },
    );
  }

  /**
   * Resolves and claims every task of a call, then starts each child, in task order. Each
   * `settled` never rejects; `signal` is the call's Esc, which a background call does not pass.
   */
  function launch(
    tasks: readonly Static<typeof Task>[],
    ctx: CallContext,
    background: boolean,
    signal?: AbortSignal,
  ): { started: RunSnapshot; settled: Promise<LaneOutcome> }[] {
    const calls = resolveAll(tasks, ctx);
    // Read before the claims: nothing that can throw sits between them and the releases below.
    const parentFile = ctx.sessionManager.getSessionFile();
    // Every claim before the first await: Pi starts a batch's calls in order only up to that
    // point, so writers queue in call order, then task order.
    const claimed = calls.map((call) => claim(call, background));
    return claimed.map(({ call, slot, own, snapshot }, i) => {
      const lane = { n: i + 1, of: claimed.length };
      let started = snapshot;
      const { label, key } = call;
      // A continued run reuses the child's id (via the record the resolve read).
      const resumed = call.continueOf;
      const sessionSignal = sessionAbort.signal;
      const childSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
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
            : sessionStop(sessionSignal.reason);
      const id = call.id;

      // A continue's worktree may hold its earlier run's writes; only a fresh one can be known empty.
      const fresh = resumed === undefined ? call.worktree : undefined;
      // The store's snapshot while the child is live, else the one this call last started it with
      // (the store is empty once the child has ended, or when a reload cleared it mid-run);
      // either way without the live-only `activity`.
      const ended = (
        status: RunStatus,
        body: string,
        extra: Partial<RunSnapshot> = {},
      ): LaneOutcome => {
        const { activity: _, ...last } = store.get(id) ?? started;
        return {
          lane,
          body,
          notes: [],
          run: { ...last, status, endedAt: Date.now(), ...extra },
        };
      };
      // Set once the runner is called: a stop after it may follow writes.
      let began = false;
      const stoppedWithoutResult = async (): Promise<LaneOutcome> => {
        const why = noAnswer(label, {
          stoppedBy: stoppedBy(),
          before: began ? "answered" : "started",
        });
        // A stop can land once the fresh worktree exists, and nothing deletes it.
        const state = fresh && (await worktreeState(fresh));
        return {
          ...ended("aborted", why.body, { error: why.error }),
          notes:
            fresh && state !== "absent"
              ? [
                  {
                    kind: "line",
                    text: worktreeNote(fresh, state === "writes"),
                  },
                ]
              : [],
        };
      };

      const failed = async (error: unknown): Promise<LaneOutcome> => {
        const state = fresh && (await worktreeState(fresh));
        const why = noAnswer(label, {
          cause: errorText(error),
          context:
            fresh === undefined
              ? undefined
              : state === "absent"
                ? `git could not create worktree ${fresh.path} on branch ${fresh.branch}; `
                : state === "writes"
                  ? `worktree ${fresh.path} on branch ${fresh.branch} may hold uncommitted writes (git -C ${fresh.path} status --porcelain); `
                  : `created worktree ${fresh.path} on branch ${fresh.branch}; it is empty — `,
        });
        return ended("failed", why.body, { error: why.error });
      };

      const finish = async (): Promise<LaneOutcome> => {
        try {
          if (slot?.behind) {
            await slot.wait(childSignal);
            if (childSignal.aborted) return stoppedWithoutResult();
            const { behind: _, ...rest } = started;
            started = { ...rest, status: "running" };
            store.apply(id, { type: "start", snapshot: started });
          }
          if (call.worktree !== undefined && resumed === undefined)
            // A fresh bare writer creates its reserved worktree; a continue of an older
            // worktree child reuses the existing one (re-adding would fail the identity).
            await addWorktree(call.parentKey, call.worktree, childSignal);
          const trusted =
            resumed !== undefined
              ? resumed.trusted
              : await trustFor(key, call.parentKey, ctx.isProjectTrusted());
          const facts: Omit<ChildRecord, "sessionFile"> = {
            id,
            agent: call.agent,
            description: call.description,
            model: call.model,
            tools: call.tools,
            cwd: call.cwd,
            key,
            trusted,
            systemPrompt: call.systemPrompt,
            worktree: call.worktree,
          };
          // A continued child already has its record.
          if (resumed === undefined) live.set(id, facts);
          began = true;
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
              task: call.task,
              trusted,
              description: call.description,
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
          const { body, spill, error } = await answer(label, id, result, {
            stoppedBy: stoppedBy(),
          });
          // A fresh run that did not finish may have written before it stopped, or not at all.
          const mayHoldWrites =
            fresh === undefined ||
            result.status === "done" ||
            (await worktreeState(fresh)) === "writes";
          if (result.sessionFile !== undefined && result.sessionFile !== "")
            records.set(id, { ...facts, sessionFile: result.sessionFile });
          return {
            ...ended(result.status, body, {
              sessionFile: result.sessionFile,
              spillFile: spill?.path,
              ...(error !== undefined ? { error } : {}),
            }),
            notes: [
              ...(spill ? [spill] : []),
              ...(call.worktree
                ? [
                    {
                      kind: "line" as const,
                      text: worktreeNote(call.worktree, mayHoldWrites),
                    },
                  ]
                : call.worktreeWhy !== undefined
                  ? [
                      {
                        kind: "line" as const,
                        text: `${call.worktreeWhy}; writing in-tree: NOT isolated from your uncommitted files.`,
                      },
                    ]
                  : []),
            ],
            usage: result.usage,
          };
        } finally {
          slot?.release();
          children.delete(id);
          live.delete(id);
          runningContinues.delete(id);
          store.apply(id, { type: "end" });
        }
      };

      return {
        started: snapshot,
        // A throw after the claim is this run's failure, not the call's: Pi keeps a tool's own
        // result after Esc, so a stopped run still hands back its details.
        settled: finish().catch((error: unknown) =>
          childSignal.aborted ? stoppedWithoutResult() : failed(error),
        ),
      };
    });
  }

  return {
    store,
    async run(tasks, signal, ctx) {
      return Promise.all(
        launch(tasks, ctx, false, signal).map(({ settled }) => settled),
      );
    },
    start(tasks, ctx) {
      const born = generation;
      return launch(tasks, ctx, true).map(({ started, settled }) => {
        void settled.then((outcome) => {
          if (born !== generation) return;
          pending.push(outcome);
          let idle: boolean;
          try {
            idle = ctx.isIdle();
          } catch {
            // The runner is stale because the host disposed or reloaded the session without
            // events; the instance is gone, so there is nothing to deliver to.
            return;
          }
          if (idle) flush();
        });
        return started;
      });
    },
    flush,
    stop(target) {
      const hits = [...children].filter(
        ([id]) => target === "all" || (target && id.startsWith(target)),
      );
      if (hits.length === 0 || (hits.length > 1 && target !== "all")) {
        const ids = store.running().map((r) => r.id.slice(0, 8));
        return {
          text: `subagent: ${hits.length === 0 ? "nothing matches" : "more than one id matches"} "${target}"; running: ${ids.join(", ") || "none"}`,
          level: "warning",
        };
      }
      for (const [, controller] of hits) controller.abort();
      return {
        text: `subagent: stopping ${count(hits.length, "subagent")}`,
        level: "info",
      };
    },
    async open(parentFile) {
      store.clear();
      sessionAbort = new AbortController();
      canSpawn = spawnCheck();
      generation += 1;
      pending = [];
      records.clear();
      runningContinues.clear();
      sessionFile = parentFile;
      const recovered = await sweepJobs(parentFile);
      const stopped = takeStopped(parentFile);
      for (const record of stopped?.records ?? []) {
        // A record is only as good as the directory and session it names.
        if (
          existsSync(record.sessionFile) &&
          statSync(record.cwd, { throwIfNoEntry: false })?.isDirectory()
        )
          records.set(record.id, record);
      }
      // A SIGTERMed process child can finish its result before the sweep reads it; that answer
      // is the run's, and a notice that it was stopped would contradict it.
      const notices = stopped
        ? await Promise.all(
            stopped.runs
              .filter((run) => !recovered.some((r) => r.run.id === run.id))
              .map((run) =>
                stoppedOutcome(run, stopped.reason, records.has(run.id)),
              ),
          )
        : [];
      pending.push(...recovered, ...notices);
      // A crashed child's answer asks for work; a reload's notice only informs.
      flush(recovered.length > 0);
    },
    close(reason) {
      generation += 1;
      const settledAt = Date.now() + STOP_SETTLE_MS;
      // Before the abort, which can end children synchronously and empty the store.
      leaveStopped(
        sessionFile,
        reason,
        store.running().filter((run) => run.background),
        [
          // A continued run is stopped too, and still writes its record's session.
          ...[...records.values()].map((record) =>
            runningContinues.has(record.id) ? { ...record, settledAt } : record,
          ),
          // A child that had begun saved a session, which the stop leaves resumable.
          ...[...live].flatMap(([id, facts]) => {
            const file = savedSessionOf(sessionFile, id);
            return file === undefined
              ? []
              : [
                  {
                    ...facts,
                    sessionFile: file,
                    settledAt,
                  },
                ];
          }),
        ],
      );
      live.clear();
      // the reason lets a stopped child say whether Pi reloaded or the session ended
      sessionAbort.abort(reason);
      store.clear();
      pending = [];
      records.clear();
      runningContinues.clear();
    },
  };
}
