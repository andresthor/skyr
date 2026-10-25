// Counts loads for tengi-smoke: one line per load in $PROBE_OUT, which is how a reload shows,
// since nothing on the wire does. Loaded by tengi with `--extension`.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  const out = process.env.PROBE_OUT;
  if (out === undefined) throw new Error("reload-probe: PROBE_OUT is not set");
  appendFileSync(out, "loaded\n");
  pi.registerCommand("probe-reload", {
    description: "probe: ExtensionCommandContext.reload",
    handler: async (_args, ctx) => ctx.reload(),
  });
}
