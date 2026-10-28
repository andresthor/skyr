// Which UI surfaces skyr touches in each run mode.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { call, hold, parentSession, router } from "./session.js";
import { recordingUi } from "./ui.js";

test.each(["print", "json"] as const)(
  "outside tui, skyr calls no UI method but notify (%s)",
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
    expect([...methods].filter((m) => m !== "notify")).toEqual([]);
  },
);

/** A held foreground child, so the subagent surface has something to draw. */
async function withRunningChild(mode: "tui" | "rpc" | "json" | "print") {
  const held = hold();
  const { ui, calls } = recordingUi();
  const parent = await parentSession({
    respond: router([call({ prompt: "s" })], held.step),
    mode,
    ui,
  });
  const run = parent.session.prompt("go");
  await held.entered;
  const widgetKeys = () =>
    calls
      .filter(({ method }) => method === "setWidget")
      .map(({ args }) => args[0]);
  return {
    widgetKeys,
    async finish() {
      held.release();
      await run;
    },
  };
}

test.each(["rpc", "json", "print"] as const)(
  "in %s no widget is set",
  async (mode) => {
    const child = await withRunningChild(mode);
    expect(child.widgetKeys()).toEqual([]);
    await child.finish();
    expect(child.widgetKeys()).toEqual([]);
  },
);

test("in tui the bar is set once, however many children run", async () => {
  const child = await withRunningChild("tui");
  expect(child.widgetKeys()).toEqual(["skyr.bar"]);
  await child.finish();
});

test("a ctx with hasUI true in rpc mode draws nothing", async () => {
  let hasUI: boolean | undefined;
  const held = hold();
  const { ui, calls } = recordingUi();
  const parent = await parentSession({
    respond: router([call({ prompt: "s" })], held.step),
    mode: "rpc",
    ui,
    extensions: [
      (pi) => {
        pi.on("session_start", (_event, ctx) => {
          hasUI = ctx.hasUI;
        });
      },
    ],
  });
  const run = parent.session.prompt("go");
  await held.entered;
  held.release();
  await run;

  expect(hasUI).toBe(true);
  expect(calls.filter(({ method }) => method === "setWidget")).toEqual([]);
});

test("setWorkingIndicator is called once per tui session start, after a reload again, and never outside tui", async () => {
  const setups = async (mode: "tui" | "rpc" | "print") => {
    const { ui, calls } = recordingUi();
    const parent = await parentSession({
      respond: () => fauxAssistantMessage("ok"),
      mode,
      ui,
    });
    const count = () =>
      calls.filter(({ method }) => method === "setWorkingIndicator").length;
    return { parent, count };
  };

  const tui = await setups("tui");
  expect(tui.count()).toBe(1);
  await tui.parent.session.reload();
  expect(tui.count()).toBe(2);

  for (const mode of ["rpc", "print"] as const) {
    const other = await setups(mode);
    await other.parent.session.prompt("go");
    expect(other.count()).toBe(0);
  }
});

test("each run in tui sets the working indicator again, so a theme switch reaches Pi's loader", async () => {
  const { ui, calls } = recordingUi();
  const parent = await parentSession({
    respond: () => fauxAssistantMessage("ok"),
    mode: "tui",
    ui,
  });
  const count = () =>
    calls.filter(({ method }) => method === "setWorkingIndicator").length;
  expect(count()).toBe(1);
  await parent.session.prompt("go");
  expect(count()).toBe(2);
});
