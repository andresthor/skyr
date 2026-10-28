/**
 * The surfaces skyr draws outside the transcript, wired once: the one `session_start` and
 * `session_shutdown` pair they share, so a feature module hands them rows and never mounts
 * anything itself.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canDraw } from "../ui/caps.js";
import { stopClock } from "../ui/clock.js";
import { type BarHandle, createBar } from "./bar.js";

export interface Chrome {
  readonly bar: BarHandle;
}

const ABOUT_TOGGLE = "Open or close skyr's bar of subagents and shells";
const ABOUT_SWITCH = "Switch skyr's bar between its AGENTS and SHELLS tabs";

/** Call before the features register: its `session_start` must run before theirs. */
export function registerChrome(pi: ExtensionAPI): Chrome {
  const bar = createBar();
  pi.on("session_start", (_event, ctx) => {
    bar.stop();
    if (canDraw(ctx)) bar.start(ctx.ui);
  });
  pi.on("session_shutdown", () => {
    bar.stop();
    // A running row's tick outlives its session otherwise: nothing else tells it Pi dropped the row
    stopClock();
  });
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
  return { bar };
}
