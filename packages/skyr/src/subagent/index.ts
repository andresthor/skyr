/**
 * `subagent`: runs each task of a call in a fresh session, as a named agent from an agent file or
 * as an ad-hoc one, and returns the agents' final answers, at once or later as messages. A child
 * loads no extensions, so it never gets this tool itself.
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { BarHandle } from "../chrome/bar.js";
import { failureLine } from "../chrome/bar-view.js";
import { loadPi } from "../pi.js";
import { isRecord, publishTasks } from "../tengi.js";
import {
  messageLines,
  segmentRow,
  textMessageRenderer,
} from "../tools/render.js";
import { canDraw } from "../ui/caps.js";
import type { Fact } from "../ui/record.js";
import {
  type Row,
  reasonOf,
  restOf,
  type Settled,
  type ToolView,
  toolRenderers,
} from "../ui/row.js";
import { sanitize } from "../ui/text.js";
import { type AgentDef, loadAgents, READ_FIELDS } from "./agents.js";
import { addUsage } from "./child/protocol.js";
import { resultText, startedText } from "./result.js";
import { createRuns, MESSAGE_TYPE, Task } from "./runs.js";
import { count, isRun, labelOf, type RunSnapshot, taskOf } from "./store.js";
import {
  barRow,
  headRecord,
  laneLine,
  laneRecord,
  listingLines,
  startedRecord,
} from "./view.js";
import { repoRoot } from "./worktree.js";

const TASK_SOURCE = "skyr/subagents";
const PREVIEW_LINES = 12;

const MAX_TASKS = 8;

const ABOUT =
  "Run tasks in subagents: fresh agents, each with its own context and tools, that return only their final answers. Use them for work that would fill your context, such as searching a codebase, reading many files or researching the web. A subagent sees nothing of this conversation, so each task must stand alone: give paths, context and the answer you want back. Put independent tasks in one call: they run in parallel, cannot see each other's answers, and the call returns when the last one ends unless it runs in the background. Each task is a full agent run with its own token cost, so split work only where the parts are truly independent; work that needs another task's answer goes in a later call.";
const ADHOC =
  "Without `agent` a task's subagent is general-purpose: Pi's own system prompt, the tools read, grep, find, ls, bash, web_search and web_fetch, your model and your working directory. A task's `role`, `tools`, `model` and `cwd` override what its agent file or that default gives. A task whose tools include edit or write runs alone in its directory tree: another writer for the same directory, or one above or below it, waits until the first ends, even within one call. A writer task with NO cwd runs in its own fresh git worktree cut from HEAD instead of waiting; its writes stay uncommitted, and its answer states the worktree path, branch, and how to inspect and merge them. With `background: true` on the call, it returns at once and each task's answer arrives in a message when its task finishes; keep working meanwhile and never poll for them. A task with `continue: <id>` starts a new run on a finished or stopped subagent's saved session, reusing its tools, model and directory: give a fresh prompt only. Ids are the 8-char id shown with each task, and they are valid only while the current session lives. Not in print mode (`pi -p`): the session ends after one turn and the answer would be lost.";

const Params = Type.Object(
  {
    tasks: Type.Array(Task, {
      minItems: 1,
      maxItems: MAX_TASKS,
      description: `One entry per subagent, 1 to ${MAX_TASKS}. They run in parallel and cannot see each other's answers; a foreground call's answers come back in this order.`,
    }),
    background: Type.Optional(
      Type.Boolean({
        description:
          "For every task in this call: return at once; each answer arrives later in a message when its task finishes, and Esc does not stop them. For work you do not need before your next step.",
      }),
    ),
  },
  { additionalProperties: false },
);

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

/**
 * The runs saved in a tool result's or a delivered message's details, which can be `{}` from a
 * call that threw, or from an older shape: undefined unless every run has every field read.
 */
function lanesOf(details: unknown): RunSnapshot[] | undefined {
  if (Array.isArray(details))
    return details.length > 0 && details.every(isRun) ? details : undefined;
  return isRun(details) ? [details] : undefined;
}

/**
 * `tasks` that some models send as a JSON string, parsed; anything else, or a string that is not
 * JSON, as it is. Pi's validator then wraps a lone task object in an array.
 */
function parseTasks(tasks: unknown): unknown {
  if (typeof tasks !== "string") return tasks;
  try {
    const parsed: unknown = JSON.parse(tasks);
    return parsed;
  } catch {
    return tasks;
  }
}

/**
 * The tasks a call's arguments name, for its row: the string fields of each, from a whole,
 * half-streamed or JSON-string `tasks` array, a lone task object, or the one flat task a call
 * made before `tasks` existed.
 */
function tasksOf(
  args: unknown,
): { agent?: string; description?: string; cwd?: string }[] {
  if (typeof args !== "object" || args === null) return [];
  const raw = "tasks" in args ? parseTasks(args.tasks) : args;
  const tasks: unknown[] = Array.isArray(raw) ? raw : [raw];
  return tasks.flatMap((task) => {
    if (typeof task !== "object" || task === null) return [];
    const fields: Record<string, unknown> = { ...task };
    const text = (key: string) =>
      typeof fields[key] === "string" ? { [key]: fields[key] } : {};
    return [{ ...text("agent"), ...text("description"), ...text("cwd") }];
  });
}

/** The names a running multi-lane call shows, all of them, then two and a count, then none. */
function nameLists(names: readonly string[]): string[] {
  const rest = names.length - 2;
  return [
    names.join(" "),
    ...(rest > 0 ? [`${names.slice(0, 2).join(" ")} +${rest}`] : []),
    "",
  ];
}

/** What a call that has not returned says it started, from its arguments as far as they streamed. */
function startingRow(args: Partial<Static<typeof Params>>): Row {
  const tasks = tasksOf(args);
  const background = args.background === true;
  const head = {
    mark: "running",
    verb: "agent",
    background,
    subjectKind: "text",
  } as const;
  // Foreground runs are on the bar; a background call returns before there is anything to point at
  const live: Fact[] = background
    ? []
    : [{ text: "live below", kind: "explain" }];
  if (tasks.length > 1) {
    const names = tasks.flatMap(({ agent, description }) =>
      description === undefined
        ? []
        : [sanitize(labelOf({ agent, description }))],
    );
    return {
      head: {
        ...head,
        subject: nameLists(names),
        facts: [
          { text: count(tasks.length, "lane"), kind: "measure" },
          ...live,
        ],
      },
    };
  }
  const [only] = tasks;
  const label =
    only?.description === undefined
      ? (only?.agent ?? "")
      : labelOf({ agent: only.agent, description: only.description });
  return {
    head: {
      ...head,
      subject: [sanitize(label)],
      facts: [
        ...(only?.cwd
          ? [{ text: `in ${sanitize(only.cwd)}`, kind: "extra" } as const]
          : []),
        ...live,
      ],
    },
  };
}

/** A call refused or thrown before any run: its cause, and the problems the validator listed. */
function refusedRow(settled: Settled): Row {
  const rest = restOf(settled.content);
  // Pi's validator echoes the arguments after the problems
  const end = rest.findIndex((line) => line.startsWith("Received arguments"));
  const problems = rest
    .slice(0, end < 0 ? undefined : end)
    .filter((line) => line.startsWith("- "));
  return {
    head: {
      mark: settled.isError ? "failed" : "done",
      verb: "agent",
      subject: [reasonOf(settled.content, "subagent")],
      subjectKind: "text",
      facts: [],
    },
    rail: { lines: problems, collapsed: 3, ink: "muted" },
  };
}

/** The ledger record of a subagent call, and under it the lane of each run once there are several. */
function callRow({ args, settled }: ToolView<Static<typeof Params>>): Row {
  if (!settled) return startingRow(args);
  const lanes = lanesOf(settled.details);
  const [only] = lanes ?? [];
  if (!lanes || !only) return refusedRow(settled);
  const branchOf = (i: number) => (i === lanes.length - 1 ? "last" : "mid");
  if (lanes.length > 1)
    return lanes.some((run) => run.background)
      ? {
          head: {
            mark: "running",
            verb: "agent",
            background: true,
            subject: [count(lanes.length, "lane")],
            subjectKind: "text",
            facts: [
              { text: "background · answers arrive here", kind: "explain" },
            ],
          },
          children: lanes.map((run, i) => startedRecord(run, branchOf(i))),
        }
      : {
          head: { ...headRecord(lanes), verb: "agent" },
          children: lanes.map((run, i) => laneRecord(run, branchOf(i))),
        };
  if (only.background)
    return {
      head: {
        ...startedRecord(only),
        verb: "agent",
        background: true,
        facts: [{ text: "background · answer arrives here", kind: "explain" }],
      },
    };
  const record = laneRecord(only);
  return {
    head: {
      ...record,
      verb: "agent",
      facts:
        settled.isError && only.error === undefined
          ? [
              { text: reasonOf(settled.content, "subagent"), kind: "explain" },
              ...record.facts,
            ]
          : record.facts,
    },
  };
}

export function registerSubagent(pi: ExtensionAPI, bar: BarHandle): void {
  let loaded: Awaited<ReturnType<typeof loadAgents>> = {
    agents: new Map(),
    errors: [],
    warnings: [],
  };
  let description = describe(loaded.agents);
  const runs = createRuns(pi, () => loaded);
  const { store } = runs;
  store.subscribe(() =>
    publishTasks(pi.events, TASK_SOURCE, store.running().map(taskOf)),
  );
  bar.attach({
    tab: "agents",
    rows: () => store.running().map(barRow),
    subscribe: (changed, failed) => {
      const offs = [
        store.subscribe(changed),
        runs.onFailed((run) => failed(barRow(run))),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: ABOUT,
    promptSnippet:
      "Delegate self-contained tasks to subagents, several in parallel in one call",
    parameters: Params,
    // A new object: Pi passes the call's own arguments, which the session saves as they came.
    prepareArguments: (args) => {
      if (!isRecord(args) || !("tasks" in args))
        return args as Static<typeof Params>;
      const tasks = parseTasks(args.tasks);
      // Pi returns a throw here as the call's result; its own refusal echoes every argument and,
      // beside a role-shaped prompt, never says where the job goes.
      if (
        (Array.isArray(tasks) ? tasks : [tasks]).some(
          (lane) => isRecord(lane) && "task" in lane,
        )
      )
        throw new Error(
          "subagent: nothing ran; `task` is not a field: put each task's job in `prompt` and any role in `role`, then call again",
        );
      // Anything else off the schema goes back for Pi's validator to report.
      return { ...args, tasks } as Static<typeof Params>;
    },
    prepareLoadout: () => ({ descriptions: { subagent: description } }),
    async execute(_toolCallId, { tasks, background }, signal, _onUpdate, ctx) {
      if (!background) {
        const outcomes = await runs.run(tasks, signal, ctx);
        // Every task's spend, failed and stopped ones too, so the session counts all of it.
        const usages = outcomes.flatMap(({ usage }) => usage ?? []);
        return {
          content: [{ type: "text", text: resultText(outcomes) }],
          details: outcomes.map(({ run }) => run),
          usage: usages.length > 0 ? usages.reduce(addUsage) : undefined,
          isError: outcomes.every(({ run }) => run.error !== undefined),
        };
      }
      const started = runs.start(tasks, ctx);
      return {
        content: [{ type: "text", text: startedText(started) }],
        details: started,
      };
    },
    ...toolRenderers<Static<typeof Params>>(callRow),
  });

  const asText = textMessageRenderer(PREVIEW_LINES);
  // Collapsed, a line per run, so a later run's failure is not hidden below an earlier answer.
  pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
    const lanes = lanesOf(message.details);
    if (!lanes) return asText(message, options, theme);
    const box = new Box(options.outputPad, 1, (t) =>
      theme.bg("customMessageBg", t),
    );
    for (const run of lanes) box.addChild(segmentRow(theme, laneLine(run)));
    if (options.expanded)
      box.addChild(new Text(["", ...messageLines(message)].join("\n"), 0, 0));
    return box;
  });

  pi.registerCommand("subagents", {
    description:
      "Open the bar on the running subagents; `/subagents stop <id|slot|all>` stops them",
    handler: async (args, ctx) => {
      const [verb, target] = args.trim().split(/\s+/);
      if (verb === "stop") {
        const slot = bar.slotTarget("agents", target ?? "");
        if (slot && !("id" in slot)) {
          ctx.ui.notify(
            `subagent: ${slot.reason}; running: ${slot.running || "none"}`,
            "warning",
          );
          return;
        }
        const { text, level } = runs.stop(slot?.id ?? target ?? "");
        ctx.ui.notify(text, level);
        return;
      }
      const unlisted = canDraw(ctx) ? bar.open("agents") : [];
      if (unlisted === undefined) return;
      // A pane too small to list the tab gets the listing, which names the ids
      ctx.ui.notify(
        [
          ...(listingLines(store.running(), Date.now()) ?? [
            "subagent: none running",
          ]),
          ...unlisted.map(failureLine),
        ].join("\n"),
        "info",
      );
    },
  });

  pi.on("agent_settled", () => runs.flush());

  pi.on("session_start", async (_event, ctx) => {
    await runs.open(ctx.sessionManager.getSessionFile());
    const { getAgentDir, CONFIG_DIR_NAME } = await loadPi();
    loaded = await loadAgents({
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
    description = describe(loaded.agents);
    if (loaded.errors.length > 0)
      ctx.ui.notify(
        `subagent: agent files that failed to load:\n${loaded.errors.join("\n")}`,
        "warning",
      );
    if (loaded.warnings.length > 0)
      ctx.ui.notify(
        `subagent: agent files with fields skyr ignores (it reads ${READ_FIELDS.join(", ")}):\n${loaded.warnings.join("\n")}`,
        "warning",
      );
  });

  pi.on("session_shutdown", (event) => {
    runs.close(event.reason);
  });
}
