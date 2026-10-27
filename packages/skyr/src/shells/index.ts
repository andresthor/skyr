/**
 * skyr serves `bash` in place of Pi's, built from Pi's own definition so a call behaves as
 * Pi's does, plus one thing: a call still running at the limit keeps running as a background
 * job, and `bash_stop` ends one.
 *
 * It registers in `session_start`, after every extension has loaded, and only when Pi's own
 * `bash` is the one in effect: Pi lets the first registration of a name win and never lets a
 * tool be taken back out, so the checks come before the first registration.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BashToolDetails,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { PiModule } from "../pi.js";
import { publishTasks, type TaskRef } from "../tengi.js";
import { textMessageRenderer } from "../tools/render.js";
import { Moved, movingOperations } from "./exec.js";
import { identify } from "./job.js";
import {
  createShellSession,
  type ShellSession,
  snapshotOf,
  stopHandedOver,
} from "./session.js";
import { type ShellSnapshot, taskItems } from "./store.js";
import { listingLines, widgetLines } from "./view.js";

const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** web_fetch is registered synchronously in every load, so its path names skyr's own load. */
const ANCHOR_TOOL = "web_fetch";

/** The `~` and `file://` forms Pi accepts for `shellPath`, resolved as Pi does. */
function expandShellPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path.startsWith("file://")) return fileURLToPath(path);
  return path;
}

function onPath(name: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(join(dir, name)));
}

/** Why skyr must leave `bash` to Pi, or undefined when it can serve it. */
function stepAsideCause(
  pi: ExtensionAPI,
  piParameters: string[],
  shellPath: string | undefined,
  self: string | undefined,
): string | undefined {
  const tools = pi.getAllTools();
  const bash = tools.find((t) => t.name === "bash");
  const own = tools.find((t) => t.name === ANCHOR_TOOL)?.sourceInfo.path;
  if (
    bash &&
    bash.sourceInfo.source !== "builtin" &&
    bash.sourceInfo.path !== own
  )
    return `another extension provides bash (${bash.sourceInfo.path})`;
  const expected = ["command", "timeout"];
  if (
    piParameters.length !== expected.length ||
    !expected.every((name) => piParameters.includes(name))
  )
    return `this Pi's bash takes ${piParameters.join(", ")}, not command and timeout`;
  if (shellPath && !POSIX_SHELLS.has(basename(shellPath)))
    return `shellPath names ${basename(shellPath)}, which is not a POSIX shell`;
  if (!onPath("ps")) return "ps is not on PATH";
  if (self === undefined) return "ps cannot identify this Pi process";
  return undefined;
}

const MESSAGE_TYPE = "skyr.shell";
const TASK_SOURCE = "skyr/shells";
const WIDGET_KEY = "skyr.shells";
const WIDGET_WIDTH = 100;
const PREVIEW_LINES = 12;
const DEFAULT_LIMIT_MS = 120_000;
const DEFAULT_GRACE_MS = 5_000;

const BackgroundParam = Type.Optional(
  Type.Boolean({
    description:
      "Run the command as a background job and return at once. Use it for servers, watchers and builds whose result you don't need now. A message tells you when it ends. `timeout`, if set, ends the job after that many seconds.",
  }),
);

const StopParams = Type.Object({
  id: Type.String({ description: "The 8-character job id." }),
});

/** Test seams of `wireShells`; production passes none. */
export interface ShellsDeps {
  /** Milliseconds a call may run in the foreground before it moves. */
  limitMs?: number;
  /** Milliseconds between SIGTERM and SIGKILL when a job is stopped. */
  graceMs?: number;
  identify?: typeof identify;
}

type Route = "plain" | "move" | "start";

/**
 * How a call runs. A nested call (`toolCallId` has a `/`) and a call whose `timeout` ends it
 * within the limit are Pi's own; `background` starts a job at once; every other call moves at
 * the limit, and a longer `timeout` is then the job's deadline. Throws for a nested
 * `background` call, which has no result to carry a job.
 * @internal
 */
export function routeOf(
  call: {
    toolCallId: string;
    timeout: number | undefined;
    background?: boolean | undefined;
  },
  limitMs: number,
): Route {
  if (call.toolCallId.includes("/")) {
    if (call.background)
      throw new Error(
        "bash: background is not available inside another tool's call; run the command without background, or call bash directly.",
      );
    return "plain";
  }
  if (call.background) return "start";
  if (call.timeout !== undefined && call.timeout <= limitMs / 1000)
    return "plain";
  return "move";
}

/**
 * Serves `bash` and `bash_stop` from `session_start`, unless the mode, the host or the
 * settings leave `bash` to Pi. A step-aside warns the user and registers neither tool.
 */
export function registerShells(
  pi: ExtensionAPI,
  piModule: PiModule,
  self: string | undefined,
): void {
  wireShells(pi, piModule, self);
}

/**
 * `registerShells` with its test seams.
 * @internal
 */
export function wireShells(
  pi: ExtensionAPI,
  piModule: PiModule,
  self: string | undefined,
  deps: ShellsDeps = {},
): void {
  const limitMs = deps.limitMs ?? DEFAULT_LIMIT_MS;
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  // Bumped at every session start and shutdown: a call that began in an earlier one never moves.
  let generation = 0;
  let serving = false;

  // Only added to the active set, never removed: Pi drops its pending restored tools when a
  // tool leaves it.
  const activateBashStop = () => {
    const names = pi.getActiveTools();
    if (names.includes("bash") && !names.includes("bash_stop"))
      pi.setActiveTools([...names, "bash_stop"]);
  };

  pi.registerMessageRenderer(MESSAGE_TYPE, textMessageRenderer(PREVIEW_LINES));

  let session: ReturnType<typeof createShellSession> | undefined;
  let stopDrawing: (() => void) | undefined;

  /** Keeps the widget current: on every change, and each second while a job runs. */
  function drawWidget(own: ShellSession, ctx: ExtensionContext): void {
    stopDrawing?.();
    let drawn: string | undefined;
    let tick: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (tick) clearInterval(tick);
      tick = undefined;
      off();
    };
    const draw = () => {
      const lines = widgetLines(own.jobs(), Date.now());
      const key = lines?.join("\n");
      if (key !== drawn) {
        drawn = key;
        // A reload or session replacement between ticks leaves ctx stale; Pi reports a throw
        // from a handler, but a timer callback is not one, so the draw dead-stops instead.
        try {
          ctx.ui.setWidget(
            WIDGET_KEY,
            lines?.map((line) => truncateToWidth(line, WIDGET_WIDTH)),
          );
        } catch {
          stop();
          return;
        }
      }
      // The clock in each line moves only while something is live
      if (lines && !tick) {
        tick = setInterval(draw, 1000);
        tick.unref();
      }
      if (!lines && tick) {
        clearInterval(tick);
        tick = undefined;
      }
    };
    const off = own.subscribe(draw);
    stopDrawing = () => {
      stop();
      try {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        // A stale ctx: its widget went with the session
      }
    };
  }

  pi.registerCommand("shells", {
    description:
      "List this session's background jobs; `/shells stop <id|all>` stops them",
    handler: async (args, ctx) => {
      if (!session) {
        ctx.ui.notify("shells: background shells are off", "warning");
        return;
      }
      const [verb, target] = args.trim().split(/\s+/);
      ctx.ui.notify(
        verb === "stop"
          ? await session.stopByUser(target ?? "")
          : listingLines(session.jobs(), Date.now()).join("\n"),
        "info",
      );
    },
  });

  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    generation += 1;
    const born = generation;
    const root = join(piModule.getAgentDir(), "skyr", "shells");
    // Jobs a /reload handed to this Pi must not outlive the shells that own them
    const releaseHandedOver = async () => {
      // No session serves the list now, so nothing else would clear what the last one showed
      publishTasks(pi.events, TASK_SOURCE, []);
      if (self !== undefined) await stopHandedOver(root, self, graceMs);
    };
    if (
      ctx.mode === "print" ||
      ctx.mode === "json" ||
      process.platform === "win32"
    )
      return releaseHandedOver();

    const settings = pi.getSettings();
    const shellPath = settings.shellPath
      ? expandShellPath(settings.shellPath)
      : undefined;
    const options = { commandPrefix: settings.shellCommandPrefix, shellPath };
    const base = piModule.createBashToolDefinition(ctx.cwd, options);

    let cause = stepAsideCause(
      pi,
      Object.keys(base.parameters.properties),
      shellPath,
      self,
    );
    if (!cause && self !== undefined) {
      // Where a call's shell writes its pid; without it no call could move.
      const pending = join(root, ".pending");
      try {
        mkdirSync(pending, { recursive: true });
      } catch (error: unknown) {
        cause = `${pending} cannot be created (${error instanceof Error ? error.message : String(error)})`;
      }
    }
    // `self` is undefined only with a cause saying so
    if (cause || self === undefined) {
      ctx.ui.notify(
        `skyr: background shells are off because ${cause ?? "ps cannot identify this Pi process"}; bash is left as it is.`,
        "warning",
      );
      return releaseHandedOver();
    }

    const sessionId = ctx.sessionManager.getSessionId();
    const own = createShellSession({
      root,
      owner: self,
      sessionId,
      reload: event.reason === "reload",
      graceMs,
      pi: piModule,
      send: (text, jobs, how) =>
        pi.sendMessage(
          {
            customType: MESSAGE_TYPE,
            content: [{ type: "text", text }],
            display: true,
            details: jobs,
          },
          how,
        ),
      isIdle: () => ctx.isIdle(),
    });
    session = own;
    serving = true;
    const publish = () =>
      publishTasks(pi.events, TASK_SOURCE, taskItems(own.jobs()));
    own.subscribe(publish);
    if (ctx.hasUI) drawWidget(own, ctx);

    pi.registerTool({
      ...base,
      description: `${base.description} A call still running after ${limitMs / 1000} s keeps running as a background job, and you are told when it ends; for anything you expect to run long, set \`background: true\`.`,
      parameters: Type.Object({
        ...base.parameters.properties,
        background: BackgroundParam,
      }),
      // Built per call, from the settings read at session start, so each call is Pi's own code path.
      async execute(id, params, signal, onUpdate, callCtx) {
        const route = routeOf(
          {
            toolCallId: id,
            timeout: params.timeout,
            background: params.background,
          },
          limitMs,
        );
        const operations =
          route !== "plain"
            ? movingOperations({
                ops: piModule.createLocalBashOperations({ shellPath }),
                limitMs,
                root,
                sessionId,
                command: params.command,
                background: route === "start",
                truncateTail: piModule.truncateTail,
                owner: () => (born === generation ? own.owner() : undefined),
                identify: deps.identify ?? identify,
                onMoved: (job) => own.track(job),
                onExited: (job) => own.exited(job),
              })
            : undefined;
        try {
          return await piModule
            .createBashToolDefinition(callCtx.cwd, { ...options, operations })
            .execute(id, params, signal, onUpdate, callCtx);
        } catch (error: unknown) {
          if (!(error instanceof Moved)) throw error;
          const { job, tail, immediate } = error;
          const log = join(job.dir, "out.log");
          const moved = immediate
            ? `Started in the background: moved to the background as job ${job.id} in ${job.cwd}. Output goes to ${log}; programs may buffer output, so an empty log may only mean nothing was flushed. You will be told automatically when it ends: do not sleep, poll or re-read the log to wait. Stop it with bash_stop {"id":"${job.id}"}.`
            : `Still running after ${limitMs / 1000} s; moved to the background as job ${job.id} in ${job.cwd}. Full log: ${log}. You will be told automatically when it ends: do not sleep, poll or re-read the log to wait. Keep working on anything that does not depend on it; if nothing does, end your turn. Stop it with bash_stop {"id":"${job.id}"}.`;
          // No structuredContent although outputSchema is inherited: codemode's calls come through
          // ctx.executeTool with nested ids, which never move, so it never sees this result.
          // Pi's bash details keys are all optional, so this still reads as a bash result's details.
          const details: BashToolDetails & {
            job: ShellSnapshot;
            "tengi:task": TaskRef;
          } = {
            job: snapshotOf(job),
            "tengi:task": { source: TASK_SOURCE, id: job.id },
          };
          return {
            content: [
              {
                type: "text",
                text: tail.trim() ? `${tail.trimEnd()}\n\n${moved}` : moved,
              },
            ],
            details,
          };
        }
      },
    });
    pi.registerTool({
      name: "bash_stop",
      label: "bash_stop",
      description:
        "Stop a background job: SIGTERM to its process group, then SIGKILL after 5 s; returns how it ended. Stopping a job that has already ended is not an error. You never need it to wait, because a job reports its own end.",
      parameters: StopParams,
      // Unannotated, Pi's gates treat a tool as destructive and open-world and may ask each time.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      // Active only alongside `bash`, so a tool set without it gains nothing; activated below.
      defaultActive: false,
      async execute(_id, params: Static<typeof StopParams>) {
        const { text, job } = await own.stopJob(params.id);
        return { content: [{ type: "text", text }], details: job };
      },
    });
    activateBashStop();
    await own.start();
    // A closing session never publishes its stops, so this clears what /new or /resume left listed
    publish();
  });

  // A /compact drops what the model knew of the jobs that still run
  pi.on("session_compact", () => session?.rollCall());

  // /tree restores the active tools from the branch's transcript, which may lack bash_stop.
  pi.on("session_tree", () => {
    if (serving) activateBashStop();
  });

  pi.on("session_shutdown", async (event) => {
    generation += 1;
    serving = false;
    const ending = session;
    session = undefined;
    stopDrawing?.();
    stopDrawing = undefined;
    await ending?.stop({ handOver: event.reason === "reload" });
  });
}
