// Which UI surfaces skyr touches in each run mode.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { call, parentSession, router } from "./session.js";
import { recordingUi } from "./ui.js";

test.each(["print", "json"] as const)(
  "outside tui, skyr calls no UI setter but notify and setWidget (%s)",
  async (mode) => {
    const { ui, calls } = recordingUi();
    const parent = await parentSession({
      respond: router([call({ prompt: "s" })], () =>
        fauxAssistantMessage("ok"),
      ),
      mode,
      ui,
    });
    await parent.session.prompt("go");
    await parent.session.prompt("/subagents");

    const methods = new Set(calls.map(({ method }) => method));
    expect(
      [...methods].filter((m) => m !== "notify" && m !== "setWidget"),
    ).toEqual([]);
  },
);
