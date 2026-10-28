/**
 * The surfaces skyr draws outside the transcript, wired once: the one `session_start` and
 * `session_shutdown` pair they share, so a feature module hands them rows and never mounts
 * anything itself.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canDraw } from "../ui/caps.js";
import { type BarHandle, createBar } from "./bar.js";

export interface Chrome {
  readonly bar: BarHandle;
}

/** Call before the features register: its `session_start` must run before theirs. */
export function registerChrome(pi: ExtensionAPI): Chrome {
  const bar = createBar();
  pi.on("session_start", (_event, ctx) => {
    bar.stop();
    if (canDraw(ctx)) bar.start(ctx.ui);
  });
  pi.on("session_shutdown", () => bar.stop());
  return { bar };
}
