/**
 * The subagent runs of one registration: resolving a call, claiming what it holds, running the
 * child, and handing back or delivering its answer. `open` and `close` reset what belongs to one
 * session; the unit itself lives as long as the extension.
 */
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { loadPi } from "../pi.js";
import { clip, errnoOf, quoted, sanitize } from "../tools/render.js";
import { DEFAULT_TOOLS, type loadAgents, parseTools } from "./agents.js";
import { readStoredResult } from "./child/protocol.js";
import { registerChildTools } from "./child/tools.js";
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
} from "./worktree.js";

export const MESSAGE_TYPE = "skyr.subagent";

/** One subagent task; `index.ts` composes it into the tool's parameters. */
export const Task = Type.Object({
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
  continue: Type.Optional(
    Type.String({
      description:
        "ID (8 chars) of a finished subagent, from the `id` on its answer, whose saved session gets another run: same tools, model and directory; give a fresh task only. Omit agent, prompt, tools, model and cwd.",
    }),
  ),
});

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
   * Foreground. Resolves the task, then claims it before the first await; a bad task throws one
   * model-facing error, having claimed nothing. `signal` (Esc) stops the child. Settles once the
   * child has, and never rejects after the claim: a stop or a failure is the outcome's `error`.
   */
  run(
    task: Static<typeof Task>,
    signal: AbortSignal | undefined,
    ctx: CallContext,
  ): Promise<LaneOutcome>;
  /**
   * Background. Resolves and claims as `run` does, then returns the start snapshot. The child
   * ignores Esc and queues its own delivery for the idle parent; nothing after the claim throws.
   */
  start(task: Static<typeof Task>, ctx: CallContext): RunSnapshot;
  /** Sends every pending background answer as one message; `agent_settled`. */
  flush(): void;
  /** `/subagents stop <id|all>`: the notice. */
  stop(target: string): { text: string; level: "info" | "warning" };
  /** Session start: forget the last session, sweep crashed job dirs, deliver what they hold. */
  open(parentFile: string | undefined): Promise<void>;
  /** Session shutdown: stop every child with `reason`; forget records and pending answers. */
  close(reason: string): void;
}

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
  /** The description, sanitized and trimmed; the label's description half. */
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
  // Finished children (this session only), for `continue`; cleared with the store.
  const records = new Map<string, ChildRecord>();
  // Child ids whose continued run is live: set synchronously in claim, so two same-turn
  // continues on one child cannot both resolve (and both append one session file).
  const runningContinues = new Set<string>();
  // Bumped at every session start and shutdown, so a child that outlives its session touches
  // neither the next session nor its own stale context.
  let generation = 0;
  let sessionAbort = new AbortController();
  let canSpawn = spawnCheck();

  function unknownAgent(name: string): Error {
    const { agents: defined, errors } = agents();
    const names = [...defined.keys()].sort().join(", ") || "none";
    const broken =
      errors.length > 0
        ? ` Agent files that failed to load: ${errors.join("; ")}`
        : "";
    return fail(`no agent "${clip(name)}"; available: ${names}.${broken}`);
  }

  /**
   * Resolves a call against its agent file and the defaults, throwing for anything the model
   * must fix. Synchronous, and claims nothing: a throw leaves no trace.
   */
  function resolveCall(
    params: Static<typeof Task>,
    ctx: Pick<ExtensionContext, "cwd" | "model" | "sessionManager">,
  ): Call {
    // Clean where it enters: every label, title, error and answer built from it reads this one.
    const description = sanitize(params.description).trim();
    if (description === "")
      throw fail(
        "give a short description: 3-5 words for the user, in description",
      );
    if (params.continue !== undefined)
      return resolveContinue(params, params.continue.trim(), description);
    const agent =
      params.agent === undefined
        ? undefined
        : agents().agents.get(params.agent);
    if (params.agent !== undefined && !agent) throw unknownAgent(params.agent);
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
      systemPrompt: [agent?.body, params.prompt].filter(Boolean).join("\n\n"),
      description,
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
      params.prompt !== undefined ||
      params.tools !== undefined ||
      params.model !== undefined ||
      params.cwd !== undefined
    )
      throw fail(
        "continue reuses the subagent's tools, model and directory; omit agent, prompt, tools, model and cwd",
      );
    if (prefix === "")
      throw fail(
        "continue: pass the 8-char id of a finished subagent, from the `id` on its answer",
      );
    const matches = [...records.entries()].filter(([id]) =>
      id.startsWith(prefix),
    );
    if (matches.length === 0)
      throw fail(
        [...children.keys()].some((id) => id.startsWith(prefix))
          ? `subagent ...${clip(prefix)} is still running; wait for its answer or stop it`
          : `no subagent matches "${clip(prefix)}"; ids are the 8-char \`id\` on each subagent answer and are valid only in this session - start a fresh subagent instead`,
      );
    if (matches.length > 1)
      throw fail(
        `"${clip(prefix)}" matches more than one finished subagent (${matches.map(([, r]) => labelOf(r)).join(", ")}); give its whole 8-char id or start a fresh subagent`,
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
    return {
      agent: record.agent,
      description,
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
   * Claims a resolved call: the continue guard, the writer slot, the stop handle and the store
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
      ...(call.worktree
        ? {
            worktree: {
              path: call.worktree.path,
              branch: call.worktree.branch,
            },
          }
        : {}),
    };
    const own = new AbortController();
    children.set(call.id, own);
    store.apply(call.id, { type: "start", snapshot });
    return { slot, own, snapshot };
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
    // `delivery` never throws: every field it reads is checked where it enters.
    const text = delivery(pending);
    const details = pending.map((o) => o.run);
    pending = [];
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: [{ type: "text", text }],
        display: true,
        details,
      },
      { triggerTurn: true },
    );
  }

  /**
   * Resolves and claims a call, then starts its child. `settled` never rejects; `signal` is the
   * call's Esc, which a background call does not pass.
   */
  function launch(
    task: Static<typeof Task>,
    ctx: CallContext,
    background: boolean,
    signal?: AbortSignal,
  ): { started: RunSnapshot; settled: Promise<LaneOutcome> } {
    const call = resolveCall(task, ctx);
    // Read before the claim: nothing that can throw sits between it and the release below.
    const parentFile = ctx.sessionManager.getSessionFile();
    // Before the first await: Pi starts a batch's calls in order only up to that point.
    const { slot, own, snapshot } = claim(call, background);
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
          : sessionSignal.reason === "reload"
            ? " because Pi reloaded"
            : " because the session ended";
    const id = call.id;

    // A continue's worktree may hold its earlier run's writes; only a fresh one is known empty.
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
        body,
        notes: [],
        run: { ...last, status, endedAt: Date.now(), ...extra },
      };
    };
    const stoppedBeforeStart = (): LaneOutcome => {
      const why = noAnswer(label, {
        stoppedBy: stoppedBy(),
        before: "started",
      });
      return {
        ...ended("aborted", why.body, { error: why.error }),
        // A stop can land once the fresh worktree exists, and nothing deletes it.
        notes:
          fresh !== undefined && existsSync(fresh.path)
            ? [{ kind: "line", text: worktreeNote(fresh, false) }]
            : [],
      };
    };

    const finish = async (): Promise<LaneOutcome> => {
      try {
        if (slot?.behind) {
          await slot.wait(childSignal);
          if (childSignal.aborted) return stoppedBeforeStart();
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
            task: task.task,
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
        if (result.sessionFile !== undefined && result.sessionFile !== "")
          records.set(id, {
            id,
            agent: call.agent,
            description: call.description,
            model: call.model,
            tools: call.tools,
            cwd: call.cwd,
            key,
            trusted,
            systemPrompt: call.systemPrompt,
            sessionFile: result.sessionFile,
            worktree: call.worktree,
          });
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
                    text: worktreeNote(
                      call.worktree,
                      result.status === "done" || resumed !== undefined,
                    ),
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
        runningContinues.delete(id);
        store.apply(id, { type: "end" });
      }
    };

    return {
      started: snapshot,
      // A throw after the claim is this run's failure, not the call's: Pi keeps a tool's own
      // result after Esc, so a stopped run still hands back its details.
      settled: finish().catch((error: unknown) => {
        if (childSignal.aborted) return stoppedBeforeStart();
        const why = noAnswer(label, {
          cause: errorText(error),
          context: fresh
            ? `created worktree ${fresh.path} on branch ${fresh.branch}; it is empty — `
            : undefined,
        });
        return ended("failed", why.body, { error: why.error });
      }),
    };
  }

  return {
    store,
    async run(task, signal, ctx) {
      return launch(task, ctx, false, signal).settled;
    },
    start(task, ctx) {
      const born = generation;
      const { started, settled } = launch(task, ctx, true);
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
      const recovered = await sweepJobs(parentFile);
      if (recovered.length > 0) {
        pending.push(...recovered);
        flush();
      }
    },
    close(reason) {
      generation += 1;
      // the reason lets a stopped child say whether Pi reloaded or the session ended
      sessionAbort.abort(reason);
      store.clear();
      pending = [];
      records.clear();
      runningContinues.clear();
    },
  };
}
