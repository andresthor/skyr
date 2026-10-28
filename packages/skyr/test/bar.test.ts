// The bar above the editor: a component Pi mounts once per session, empty at rest, repainting
// itself while anything runs so a clock in its pulse moves.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, onTestFinished, test, vi } from "vitest";
import { elapsed } from "../src/tools/render.js";
import {
  call,
  expectInert,
  HOSTILE,
  hold,
  parentSession,
  plainTheme,
  router,
  taskOf,
} from "./session.js";
import { piScreen } from "./ui.js";

const BAR = "skyr.bar";

/** Fakes the bar's tick from here on; setTimeout stays real, as Pi's own waits need it. */
function fakeTicks(): void {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** `count` writers in one directory: the first runs on hold, the rest queue behind it. */
async function writers(count: number) {
  const held = hold();
  const parent = await parentSession({
    mode: "tui",
    respond: router(
      Array.from({ length: count }, (_, i) =>
        call({
          prompt: `w${i}`,
          tools: ["write"],
          cwd: ".",
          description: i === 0 ? HOSTILE : `漢字🙂 writer ${i}`,
        }),
      ),
      held.step,
    ),
  });
  const run = parent.session.prompt("go");
  await held.entered;
  return { parent, run };
}

test("the bar is set once per session, not once per appearance or tick", async () => {
  fakeTicks();
  const held = hold();
  const parent = await parentSession({
    mode: "tui",
    respond: router([call({ prompt: "s" })], held.step),
  });

  const run = parent.session.prompt("go");
  await held.entered;
  const frames = parent.widgets.length;
  vi.advanceTimersByTime(3_000);
  // Each second repaints the mounted bar, so its clock moves without a store change.
  expect(parent.widgets.length).toBe(frames + 3);

  held.release();
  await run;
  expect(parent.widgetSets).toEqual([BAR]);
});

test("a running child shows in the pulse and the pulse goes when it ends, leaving the bar mounted and empty", async () => {
  fakeTicks();
  const held = hold();
  const parent = await parentSession({
    mode: "tui",
    respond: router([call({ prompt: "s" })], held.step),
  });
  expect(parent.widgets.at(-1)).toEqual([]);

  const run = parent.session.prompt("go");
  await held.entered;
  expect(parent.widgets.at(-1)).toEqual([
    expect.stringMatching(/^1 agent • /),
    "",
  ]);

  held.release();
  await run;
  expect(parent.widgets.at(-1)).toEqual([]);
  expect(parent.mounted(BAR)).toBeDefined();
});

test("every bar line fits a 20-column pane, wide characters and emoji included", async () => {
  const { parent, run } = await writers(11);

  const lines = parent.mounted(BAR)?.render(20) ?? [];
  expect(lines).toHaveLength(2);
  expectInert(lines, 20);

  await parent.session.abort();
  await run;
});

test("with a host that never mounts the bar, no tick runs", async () => {
  fakeTicks();
  const held = hold();
  const sets: string[] = [];
  const parent = await parentSession({
    mode: "tui",
    respond: router([call({ prompt: "s" })], held.step),
    // A host that takes the factory and never calls it.
    ui: {
      setWidget: (key: string) => {
        sets.push(key);
      },
    },
  });
  const intervals = vi.getTimerCount();

  const run = parent.session.prompt("go");
  await held.entered;
  vi.advanceTimersByTime(1_500);
  expect(vi.getTimerCount()).toBe(intervals);
  expect(sets).toEqual([BAR]);

  held.release();
  await run;
});

test("after the host disposes the bar, nothing repaints and the next session mounts it again", async () => {
  fakeTicks();
  const held = hold();
  const parent = await parentSession({
    mode: "tui",
    respond: router([call({ prompt: "s" })], held.step),
  });

  const run = parent.session.prompt("go");
  await held.entered;
  expect(parent.mounted(BAR)).toBeDefined();
  // As a reload does: Pi disposes every widget without a set from skyr.
  parent.resetWidgets();
  const frames = parent.widgets.length;
  vi.advanceTimersByTime(2_000);
  expect(parent.widgets).toHaveLength(frames);

  held.release();
  await run;
  expect(parent.widgets).toHaveLength(frames);
  expect(parent.mounted(BAR)).toBeUndefined();

  await parent.session.reload();
  expect(parent.mounted(BAR)).toBeDefined();
});

test("subagents and shells share one bar: a shell under running subagents adds a group, not a widget", async () => {
  const held = hold();
  const parent = await parentSession({
    mode: "tui",
    respond: (context, ...rest) => {
      if (taskOf(context) !== "go") return held.step(context, ...rest);
      return context.messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage("done")
        : fauxAssistantMessage([
            call({ prompt: "s" }),
            fauxToolCall(
              "bash",
              { command: "sleep 60", background: true },
              { id: "sh" },
            ),
          ]);
    },
  });

  const run = parent.session.prompt("go");
  await held.entered;
  await vi.waitFor(() =>
    expect(parent.widgets.at(-1)?.[0]).toMatch(/^1 agent • {3}1 shell • /),
  );
  expect(parent.widgetSets).toEqual([BAR]);

  await parent.session.prompt("/shells stop all");
  held.release();
  await run;
});

test("a reload with a child running leaves one bar, set once by the new session, and no interval", async () => {
  fakeTicks();
  const held = hold();
  const parent = await parentSession({
    mode: "tui",
    respond: router([call({ prompt: "s", background: true })], held.step),
  });
  const intervals = vi.getTimerCount();

  await parent.session.prompt("go");
  await held.entered;
  expect(vi.getTimerCount()).toBe(intervals + 1);

  await parent.session.reload();
  expect(parent.widgetSets).toEqual([BAR, BAR]);
  expect(parent.mounted(BAR)).toBeDefined();
  expect(parent.widgets.at(-1)).toEqual([]);
  await vi.waitFor(() => expect(vi.getTimerCount()).toBe(intervals));
});

test("no interval is left after a session ends with a running row and a running child", async () => {
  fakeTicks();
  const held = hold();
  const parent = await parentSession({
    mode: "tui",
    respond: router([call({ prompt: "s", background: true })], held.step),
  });
  const intervals = vi.getTimerCount();

  await parent.session.prompt("go");
  await held.entered;
  // A tool row of this session, still running when it ends
  elapsed({ state: {}, executionStarted: true, invalidate() {} });
  expect(vi.getTimerCount()).toBe(intervals + 1);

  await parent.session.reload();
  await vi.waitFor(() => expect(vi.getTimerCount()).toBe(intervals));
});

test("the pulse never crashes Pi's renderer at 20, 40 and 86 columns", async () => {
  const { parent, run } = await writers(3);
  const bar = parent.mounted(BAR);
  expect(bar?.render(100)).toHaveLength(2);

  for (const width of [20, 40, 86]) {
    const { firstFrameCrash, crash } = piScreen(bar!, width);
    expect(firstFrameCrash).toBeUndefined();
    expect(crash).toBeUndefined();
  }

  await parent.session.abort();
  await run;
});

/** A parent whose host hands the bar a `tui` and a `theme` of its choosing, and keeps what the bar returns. */
async function brokenHost(tui: object, theme: object) {
  const held = hold();
  let bar: { render(width: number): string[] } | undefined;
  const parent = await parentSession({
    mode: "tui",
    respond: router([call({ prompt: "s" })], held.step),
    ui: {
      setWidget: ((_key: string, factory: (...args: object[]) => never) => {
        bar = factory(tui, theme);
      }) as never,
    },
  });
  const run = parent.session.prompt("go");
  await held.entered;
  return {
    parent,
    bar: () => bar,
    finish: async () => {
      held.release();
      await run;
    },
  };
}

test("a render that throws draws nothing and tells the user once", async () => {
  const theme = {
    get colors(): never {
      throw new Error("theme gone");
    },
  };
  const host = await brokenHost(
    { requestRender() {}, terminal: { rows: 40, columns: 100 } },
    theme,
  );

  const bar = host.bar();
  expect(bar?.render(100)).toEqual([]);
  expect(bar?.render(100)).toEqual([]);
  await vi.waitFor(() => expect(host.parent.notices).toHaveLength(1));
  expect(host.parent.notices[0]).toBe(
    "skyr: the bar stopped drawing after an error (theme gone); /reload brings it back",
  );
  await host.finish();
  expect(host.parent.notices).toHaveLength(1);
});

test("a host whose repaint throws costs the store change nothing", async () => {
  const host = await brokenHost(
    {
      requestRender() {
        throw new Error("tui gone");
      },
      terminal: { rows: 40, columns: 100 },
    },
    {},
  );

  await vi.waitFor(() =>
    expect(host.parent.notices.at(-1)).toContain("(tui gone)"),
  );
  // The child's end is a store change too; it must still complete the call
  await host.finish();
  expect(
    host.parent.notices.filter((n) => n.includes("bar stopped")),
  ).toHaveLength(1);
});

test("a bar that stopped drawing stops its clock, repaints nothing more, and reaches trip from a tick", async () => {
  fakeTicks();
  const baseline = vi.getTimerCount();
  const requestRender = vi.fn();
  const theme = {
    get colors(): never {
      throw new Error("theme gone");
    },
  };
  const host = await brokenHost(
    { requestRender, terminal: { rows: 40, columns: 100 } },
    theme,
  );
  expect(vi.getTimerCount()).toBe(baseline + 1);

  host.bar()?.render(100);
  expect(vi.getTimerCount()).toBe(baseline);
  const repaints = requestRender.mock.calls.length;
  await host.finish();
  expect(requestRender).toHaveBeenCalledTimes(repaints);
});

test("a tick whose repaint throws stops the bar and says so once", async () => {
  fakeTicks();
  const baseline = vi.getTimerCount();
  let failing = false;
  const host = await brokenHost(
    {
      requestRender() {
        if (failing) throw new Error("tui gone");
      },
      terminal: { rows: 40, columns: 100 },
    },
    plainTheme,
  );
  expect(vi.getTimerCount()).toBe(baseline + 1);

  failing = true;
  vi.advanceTimersByTime(1_000);
  await vi.waitFor(() =>
    expect(host.parent.notices).toEqual([
      "skyr: the bar stopped drawing after an error (tui gone); /reload brings it back",
    ]),
  );
  expect(vi.getTimerCount()).toBe(baseline);
  // A running child would draw a pulse; a bar that tripped draws nothing
  expect(host.bar()?.render(100)).toEqual([]);
  await host.finish();
});
