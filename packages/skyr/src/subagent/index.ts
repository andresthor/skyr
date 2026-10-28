/**
 * `subagent`: runs each task of a call in a fresh session, as a named agent from an agent file or
 * as an ad-hoc one, and returns the agents' final answers, at once or later as messages. A child
 * loads no extensions, so it never gets this tool itself.
 */
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { loadPi } from "../pi.js";
import { isRecord, publishTasks } from "../tengi.js";
import {
  firstLine,
  messageLines,
  type Segment,
  seconds,
  styled,
  textMessageRenderer,
  tokens,
  toolRow,
} from "../tools/render.js";
import { liveWidget } from "../tools/widget.js";
import { type AgentDef, loadAgents, READ_FIELDS } from "./agents.js";
import { addUsage } from "./child/protocol.js";
import { resultText, startedText } from "./result.js";
import { createRuns, MESSAGE_TYPE, Task } from "./runs.js";
import { count, isRun, labelOf, type RunSnapshot, taskOf } from "./store.js";
import { laneLine, laneTree, widgetLines } from "./view.js";
import { repoRoot } from "./worktree.js";

const WIDGET_KEY = "skyr.subagents";
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

export function registerSubagent(pi: ExtensionAPI): void {
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
  let stopWidget: (() => void) | undefined;

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
    renderCall(args, theme, context) {
      const tasks = tasksOf(args);
      const [only] = tasks;
      if (tasks.length <= 1)
        return toolRow(theme, [
          ["toolTitle", "subagent", true],
          ["accent", only?.agent ? ` ${only.agent}` : ""],
          ["muted", only?.description ? ` "${only.description}"` : ""],
          ["muted", only?.cwd ? ` in ${only.cwd}` : ""],
        ]);
      // While the call runs, its row is all there is to say what it started; once it ends, the
      // result's lines name every task.
      const named = context.isPartial
        ? tasks.flatMap(({ agent, description }) =>
            description === undefined ? [] : [labelOf({ agent, description })],
          )
        : [...new Set(tasks.flatMap(({ agent }) => agent ?? []))];
      return toolRow(theme, [
        ["toolTitle", "subagent", true],
        ["muted", ` ${count(tasks.length, "task")}`],
        [
          context.isPartial ? "muted" : "accent",
          named.length > 0 ? ` · ${named.join(", ")}` : "",
        ],
      ]);
    },
    renderResult(result, _options, theme, context) {
      // Saved details only: Pi draws a running call from renderCall alone.
      const lanes = lanesOf(result.details);
      if (lanes && lanes.length > 1) return rows(theme, laneTree(lanes));
      const run = lanes?.[0];
      if (!run) {
        // Refused or thrown: Pi draws no content beside a renderer, so the row carries the cause
        // and each problem line, but not the arguments Pi's validator echoes after them.
        const [head = "", ...rest] = messageLines(result);
        const end = rest.findIndex((line) =>
          line.startsWith("Received arguments"),
        );
        const problems = rest
          .slice(0, end < 0 ? undefined : end)
          .filter((line) => line.trimStart().startsWith("- "));
        return rows(theme, [
          [["error", head]],
          ...problems.map((line): Segment[] => [["muted", line.trimStart()]]),
        ]);
      }
      if (context.isError)
        return toolRow(theme, [
          ["error", run.error ?? firstLine(result.content)],
          ...summary(run),
          ...runTime(run),
        ]);
      if (run.background)
        return toolRow(theme, [
          ["accent", "↗ background"],
          ["muted", ` · ${labelOf(run)} · ${run.id.slice(0, 8)}`],
        ]);
      return toolRow(theme, [
        ["success", "✓ done"],
        ...summary(run),
        ["muted", ` · ${tokens(run.tokens)}`],
        ...runTime(run),
      ]);
    },
  });

  const asText = textMessageRenderer(PREVIEW_LINES);
  // Collapsed, a line per run, so a later run's failure is not hidden below an earlier answer.
  pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
    const lanes = lanesOf(message.details);
    if (!lanes) return asText(message, options, theme);
    const box = new Box(options.outputPad, 1, (t) =>
      theme.bg("customMessageBg", t),
    );
    for (const run of lanes)
      box.addChild(new TruncatedText(styled(theme, laneLine(run))));
    if (options.expanded)
      box.addChild(new Text(["", ...messageLines(message)].join("\n"), 0, 0));
    return box;
  });

  pi.registerCommand("subagents", {
    description:
      "List running subagents; `/subagents stop <id|all>` stops them",
    handler: async (args, ctx) => {
      const [verb, target] = args.trim().split(/\s+/);
      if (verb === "stop") {
        const { text, level } = runs.stop(target ?? "");
        ctx.ui.notify(text, level);
        return;
      }
      ctx.ui.notify(
        widgetLines(store.running(), Date.now())?.join("\n") ??
          "subagent: none running",
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

    stopWidget?.();
    stopWidget = undefined;
    if (!ctx.hasUI) return;
    stopWidget = liveWidget(ctx, WIDGET_KEY, {
      subscribe: store.subscribe,
      lines: () => widgetLines(store.running(), Date.now()),
      lists: "/subagents",
    });
  });

  pi.on("session_shutdown", (event) => {
    stopWidget?.();
    stopWidget = undefined;
    runs.close(event.reason);
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

/** One tool row per line. */
function rows(theme: Theme, lines: Segment[][]): Container {
  const box = new Container();
  for (const line of lines) box.addChild(toolRow(theme, line));
  return box;
}
