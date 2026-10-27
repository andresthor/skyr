/**
 * `subagent`: runs a task in a fresh session as a named agent from an agent file, or as an ad-hoc
 * one, and returns the agent's final answer, at once or later as a message. A child loads no
 * extensions, so it never gets this tool itself.
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Text,
  TruncatedText,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadPi } from "../pi.js";
import { publishTasks } from "../tengi.js";
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
import { type AgentDef, loadAgents, READ_FIELDS } from "./agents.js";
import { resultText, startedText } from "./result.js";
import { createRuns, MESSAGE_TYPE, Task } from "./runs.js";
import {
  count,
  labelOf,
  RUN_STATUSES,
  type RunSnapshot,
  taskOf,
} from "./store.js";
import { laneLine, widgetLines } from "./view.js";
import { repoRoot } from "./worktree.js";

const WIDGET_KEY = "skyr.subagents";
const TASK_SOURCE = "skyr/subagents";
const MAX_WIDGET_LINES = 10;
const PREVIEW_LINES = 12;

const ABOUT =
  "Run a task in a subagent: a fresh agent with its own context and tools that returns only its final answer. Use it for work that would fill your context, such as searching a codebase, reading many files or researching the web. The agent sees nothing of this conversation, so the task must stand alone: give paths, context and the answer you want back. Independent tasks go out as several subagent calls in one turn, and run in parallel.";
const ADHOC =
  "Without `agent` the subagent is general-purpose: Pi's own system prompt, the tools read, grep, find, ls, bash, web_search and web_fetch, your model and your working directory. `prompt`, `tools`, `model` and `cwd` each override what the agent file or that default gives. A subagent whose tools include edit or write runs alone in its directory tree: a second one for the same directory, or one above or below it, waits until the first ends, so issue writes that depend on each other in separate turns. A writer call with NO cwd runs in its own fresh git worktree cut from HEAD instead of queueing; its writes stay uncommitted, and the result states the worktree path, branch, and how to inspect and merge them. With `background: true` the call returns at once and the answer arrives as a message when the subagent finishes; keep working meanwhile and never poll for it. With `continue: <id>` the call starts a new run on a finished subagent's saved session, reusing its tools, model and directory: give a fresh task only. Ids are the 8-char id shown with each subagent's answer and in a background start, and they are valid only while the current session lives. Not in print mode (`pi -p`): the session ends after one turn and the answer would be lost.";

// `continue` stays after `background`, so the schema the model reads keeps its order.
const { continue: continueOf, ...rest } = Task.properties;
const Params = Type.Object({
  ...rest,
  background: Type.Optional(
    Type.Boolean({
      description:
        "Return at once; the answer arrives later as a message, and Esc does not stop it. For work you do not need before your next step.",
    }),
  ),
  continue: continueOf,
});

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

function isRun(details: unknown): details is RunSnapshot {
  if (typeof details !== "object" || details === null) return false;
  const run: Record<string, unknown> = { ...details };
  return (
    typeof run.id === "string" &&
    typeof run.description === "string" &&
    (run.agent === undefined || typeof run.agent === "string") &&
    (run.error === undefined || typeof run.error === "string") &&
    RUN_STATUSES.some((status) => status === run.status) &&
    [run.startedAt, run.turns, run.toolCalls, run.tokens].every(Number.isFinite)
  );
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
  let unsubscribe: (() => void) | undefined;

  function widgetRows(width: number): string[] {
    const lines = widgetLines(store.running(), Date.now()) ?? [];
    // Past the cap, the last row counts what it leaves out.
    const rows =
      lines.length > MAX_WIDGET_LINES
        ? [
            ...lines.slice(0, MAX_WIDGET_LINES - 1),
            `… +${lines.length - MAX_WIDGET_LINES + 1} more · /subagents lists all`,
          ]
        : lines;
    // Pi stops the TUI on a row wider than the pane; the pad matches Pi's own string widgets.
    return rows.map((row) => ` ${truncateToWidth(row, width - 2)}`);
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: ABOUT,
    promptSnippet: "Delegate a self-contained task to a subagent",
    parameters: Params,
    prepareLoadout: () => ({ descriptions: { subagent: description } }),
    async execute(
      _toolCallId,
      { background, ...task },
      signal,
      _onUpdate,
      ctx,
    ) {
      if (!background) {
        const outcome = await runs.run(task, signal, ctx);
        return {
          content: [{ type: "text", text: resultText(outcome) }],
          details: outcome.run,
          usage: outcome.usage,
          isError: outcome.isError,
        };
      }
      const started = runs.start(task, ctx);
      return {
        content: [{ type: "text", text: startedText(started) }],
        details: started,
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
      // Saved details only: Pi draws a running call from renderCall alone.
      const lanes = lanesOf(result.details);
      const run = lanes?.length === 1 ? lanes[0] : undefined;
      if (!run || context.isError)
        return toolRow(theme, [
          ["error", run?.error ?? firstLine(result.content)],
          ...(run ? [...summary(run), ...runTime(run)] : []),
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

    unsubscribe?.();
    unsubscribe = undefined;
    if (!ctx.hasUI) return;
    // Set only as the widget appears and goes: Pi re-inserts a key on every set, which would
    // swap it with other widgets. A host that never mounts it (tengi, RPC) ticks nothing.
    let shown = false;
    let repaint: (() => void) | undefined;
    const widget = (tui: { requestRender(): void }) => {
      repaint = () => tui.requestRender();
      // The clock in each line moves between store changes.
      const tick = setInterval(repaint, 1000);
      tick.unref();
      return {
        render: widgetRows,
        invalidate() {},
        dispose() {
          clearInterval(tick);
          repaint = undefined;
          shown = false;
        },
      };
    };
    const off = store.subscribe(() => {
      // A reload or session replacement leaves ctx stale; Pi reports a throw from a handler,
      // but a child's progress arrives outside any, so the widget dead-stops instead.
      try {
        const live = store.running().length > 0;
        if (live && !shown) {
          ctx.ui.setWidget(WIDGET_KEY, widget);
          shown = true;
        } else if (!live && shown) {
          shown = false;
          ctx.ui.setWidget(WIDGET_KEY, undefined);
        } else repaint?.();
      } catch {
        off();
      }
    });
    unsubscribe = off;
  });

  pi.on("session_shutdown", (event, ctx) => {
    unsubscribe?.();
    unsubscribe = undefined;
    runs.close(event.reason);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
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
