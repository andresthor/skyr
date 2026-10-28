/**
 * The surfaces skyr draws outside the transcript, wired once: the one `session_start` and
 * `session_shutdown` pair they share, so a feature module hands them rows and never mounts
 * anything itself, and the events that say what the main agent is doing.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { canDraw, tierOf } from "../ui/caps.js";
import { stopClock } from "../ui/clock.js";
import { loaderIndicator } from "../ui/spinner.js";
import { type BarHandle, createBar } from "./bar.js";
import { createWorking, type Working } from "./working.js";

export interface Chrome {
  readonly bar: BarHandle;
  readonly working: Working;
}

const ABOUT_TOGGLE = "Open or close skyr's bar of subagents and shells";
const ABOUT_SWITCH = "Switch skyr's bar between its AGENTS and SHELLS tabs";

/** Call before the features register: its `session_start` must run before theirs. */
export function registerChrome(pi: ExtensionAPI): Chrome {
  const bar = createBar();
  const working = createWorking();
  // Pi resets the indicator at every session start; each run sets it again so a /theme switch reaches it
  const setIndicator = (ctx: ExtensionContext) =>
    ctx.ui.setWorkingIndicator(
      loaderIndicator({ theme: ctx.ui.theme, mode: tierOf(process.env) }),
    );
  pi.on("session_start", (_event, ctx) => {
    bar.stop();
    working.clear();
    if (!canDraw(ctx)) return;
    // Two independent effects: a throw while mounting the bar must not leave Pi's spinner default
    try {
      bar.start(ctx.ui);
    } finally {
      setIndicator(ctx);
    }
  });
  pi.on("session_shutdown", () => {
    bar.stop();
    working.clear();
    // A running row's tick outlives its session otherwise: nothing else tells it Pi dropped the row
    stopClock();
  });
  pi.on("agent_start", (_event, ctx) => {
    working.agentStart();
    if (canDraw(ctx)) setIndicator(ctx);
  });
  pi.on("agent_end", () => working.clear());
  // A call another tool made is part of that tool's work, not a second action
  pi.on("tool_execution_start", (event) => {
    if (event.parentToolCallId === undefined)
      working.toolStart(event.toolCallId, event.toolName, event.args);
  });
  pi.on("tool_execution_end", (event) => working.toolEnd(event.toolCallId));
  // Neither key is bound in Pi or pi-tui by default.
  pi.registerShortcut("alt+a", {
    description: ABOUT_TOGGLE,
    handler: async (ctx) => {
      if (canDraw(ctx)) bar.toggle();
    },
  });
  pi.registerShortcut("alt+s", {
    description: ABOUT_SWITCH,
    handler: async (ctx) => {
      if (canDraw(ctx)) bar.nextTab();
    },
  });
  return { bar, working };
}
