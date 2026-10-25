/**
 * skyr serves `bash` in place of Pi's, built from Pi's own definition so a call behaves as
 * Pi's does, and keeps `bash_stop` ready for the jobs a later change starts.
 *
 * It registers in `session_start`, after every extension has loaded, and only when Pi's own
 * `bash` is the one in effect: Pi lets the first registration of a name win and never lets a
 * tool be taken back out, so the checks come before the first registration.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PiModule } from "../pi.js";

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
  return undefined;
}

function registerBashStop(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bash_stop",
    label: "bash_stop",
    description:
      "Stop a background job: SIGTERM to its process group, then SIGKILL after 5 s; returns how it ended. Stopping a job that has already ended is not an error. You never need it to wait, because a job reports its own end.",
    parameters: Type.Object({
      id: Type.String({ description: "The 8-character job id." }),
    }),
    // Nothing starts jobs yet, so the model is not offered the tool.
    defaultActive: false,
    async execute() {
      throw new Error("bash_stop: no background jobs exist yet.");
    },
  });
}

/**
 * Serves `bash` and `bash_stop` from `session_start`, unless the mode, the host or the
 * settings leave `bash` to Pi. A step-aside warns the user and registers neither tool.
 */
export function registerShells(pi: ExtensionAPI, piModule: PiModule): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (
      ctx.mode === "print" ||
      ctx.mode === "json" ||
      process.platform === "win32"
    )
      return;

    const settings = pi.getSettings();
    const shellPath = settings.shellPath
      ? expandShellPath(settings.shellPath)
      : undefined;
    const options = { commandPrefix: settings.shellCommandPrefix, shellPath };
    const base = piModule.createBashToolDefinition(ctx.cwd, options);

    const cause = stepAsideCause(
      pi,
      Object.keys(base.parameters.properties),
      shellPath,
    );
    if (cause) {
      ctx.ui.notify(
        `skyr: background shells are off because ${cause}; bash is left as it is.`,
        "warning",
      );
      return;
    }

    pi.registerTool({
      ...base,
      // Built per call, from the settings read at session start, so each call is Pi's own code path.
      execute: (id, params, signal, onUpdate, callCtx) =>
        piModule
          .createBashToolDefinition(callCtx.cwd, options)
          .execute(id, params, signal, onUpdate, callCtx),
    });
    registerBashStop(pi);
  });
}
