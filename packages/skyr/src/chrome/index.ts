/**
 * The surfaces skyr draws outside the transcript, wired once: the session start and end they
 * share, so a feature module hands them rows (or, for voice, a class for the editor) and never
 * mounts anything itself.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canDraw, tierOf } from "../ui/caps.js";
import { loaderIndicator } from "../ui/spinner.js";
import { type BarHandle, createBar } from "./bar.js";
import { BAR_KEYS } from "./bar-view.js";
import { createEditorHost, type EditorHost } from "./editor-host.js";
import { createFooter } from "./footer.js";
import { trackWorking } from "./working.js";

export interface Chrome {
  readonly bar: BarHandle;
  readonly editor: EditorHost;
}

const ABOUT_TOGGLE = "Open or close skyr's bar of subagents and shells";
const ABOUT_SWITCH = "Switch skyr's bar between its AGENTS and SHELLS tabs";

/** Call before the features register: its `session_start` must run before theirs. */
export function registerChrome(pi: ExtensionAPI): Chrome {
  const bar = createBar();
  const working = trackWorking(pi);
  // The frames Pi's loader holds now; the working line draws only for an indicator it recognises as these
  let ownFrames: readonly string[] = [];
  const editor = createEditorHost({ working, bar, ownFrames: () => ownFrames });
  const footer = createFooter();
  pi.on("session_start", async (_event, ctx) => {
    bar.stop();
    footer.stop();
    if (!canDraw(ctx)) return;
    // Independent effects: a throw while mounting the bar must not leave Pi's spinner or footer default
    try {
      bar.start(ctx.ui);
    } finally {
      try {
        // Pi resets the indicator at every session start; set once, so an extension's or the user's own choice stands
        const indicator = loaderIndicator({
          theme: ctx.ui.theme,
          mode: tierOf(process.env),
        });
        ownFrames = indicator.frames ?? [];
        ctx.ui.setWorkingIndicator(indicator);
      } finally {
        await footer.start(ctx);
      }
    }
  });
  // Its own handler: a throw in one mount cannot cost the other their start
  pi.on("session_start", async (event, ctx) => {
    if (canDraw(ctx)) await editor.mount(ctx, event.reason);
  });
  pi.on("message_end", (_event, ctx) => footer.refreshSoon(ctx));
  // Unlike message_end, these fire after the entries they change are appended
  pi.on("session_info_changed", (_event, ctx) => footer.refresh(ctx));
  pi.on("turn_end", (_event, ctx) => footer.refresh(ctx));
  pi.on("tool_execution_start", (_event, ctx) => footer.refresh(ctx));
  pi.on("agent_settled", (_event, ctx) => footer.settled(ctx));
  pi.on("session_compact", (_event, ctx) => footer.refresh(ctx));
  pi.on("session_tree", (_event, ctx) => footer.refresh(ctx));
  pi.on("model_select", (_event, ctx) => footer.refresh(ctx));
  pi.on("thinking_level_select", (_event, ctx) => footer.refresh(ctx));
  pi.on("session_shutdown", () => {
    editor.stop();
    bar.stop();
    footer.stop();
  });
  // Neither key is bound in Pi or pi-tui by default.
  pi.registerShortcut(BAR_KEYS.toggle, {
    description: ABOUT_TOGGLE,
    handler: async (ctx) => {
      if (!canDraw(ctx)) return;
      const notice = bar.toggle();
      if (notice !== undefined) ctx.ui.notify(notice, "info");
    },
  });
  pi.registerShortcut(BAR_KEYS.switchTab, {
    description: ABOUT_SWITCH,
    handler: async (ctx) => {
      if (!canDraw(ctx)) return;
      const notice = bar.nextTab();
      if (notice !== undefined) ctx.ui.notify(notice, "info");
    },
  });
  return { bar, editor };
}
