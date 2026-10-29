// The bar above the editor: a component Pi mounts once per session, empty at rest, repainting
// itself while anything runs so a clock in its pulse moves.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import { expect, onTestFinished, test, vi } from "vitest";
import { type BarRow, createBar } from "../src/chrome/bar.js";
import {
  call,
  expectInert,
  HOSTILE,
  hold,
  listing,
  type Parent,
  parentSession,
  plainTheme,
  router,
  scriptTurns,
  taskOf,
  widgetHost,
} from "./session.js";
import { piScreen } from "./ui.js";
import { keybindings } from "./voice.js";

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

  // The bash call moved its job onto the bar within the call that has now ended, so a frame
  // holding both groups was pushed before its end fired.
  const bashEnded = new Promise<void>((resolve) => {
    const stop = parent.session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "bash") {
        stop();
        resolve();
      }
    });
  });
  const run = parent.session.prompt("go");
  await held.entered;
  await bashEnded;
  expect(parent.widgets.at(-1)?.[0]).toMatch(/^1 agent • {3}1 shell • /);
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
  // Reload awaits the old session's shutdown, which stopped the clock before this point.
  expect(vi.getTimerCount()).toBe(intervals);
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
  // The failed render's report is queued as a microtask: one flush delivers the notice.
  await Promise.resolve();
  expect(host.parent.notices).toHaveLength(1);
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

  // The child's start already tripped the bar: the throwing repaint is in the notices.
  expect(host.parent.notices.at(-1)).toContain("(tui gone)");
  // The child's end is a store change too; it must still complete the call
  await host.finish();
  expect(
    host.parent.notices.filter((n) => n.includes("bar stopped")),
  ).toHaveLength(1);
});

/** Presses `key` as Pi does: the shortcut an extension registered, run with a context of `mode`. */
function press(
  parent: Parent,
  key: KeyId,
  mode: "tui" | "rpc" | "print" = "tui",
): void {
  const runner = parent.session.extensionRunner;
  const shortcut = runner
    .getShortcuts(keybindings().getEffectiveConfig())
    .get(key);
  if (!shortcut) throw new Error(`nothing is registered on ${key}`);
  void shortcut.handler({ ...runner.createContext(), mode });
}

/**
 * The ascii tier shows which tab is open as `[AGENTS n]` or `[SHELLS n]`, so a test can read it
 * without colour.
 */
function asciiBar(parent: Parent) {
  vi.stubEnv("TERM", "dumb");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  return () => {
    const lines = parent.mounted(BAR)?.render(100) ?? [];
    return {
      lines,
      open: /\[(AGENTS|SHELLS)/.test(lines[0] ?? ""),
      tab: /\[(AGENTS|SHELLS) \d+\]/.exec(lines[0] ?? "")?.[1],
    };
  };
}

test("alt+a opens the bar on AGENTS and closes it; alt+s opens it on the other tab", async () => {
  const held = hold();
  const parent = await parentSession({
    mode: "tui",
    respond: router([call({ prompt: "s" })], held.step),
  });
  const bar = asciiBar(parent);
  const run = parent.session.prompt("go");
  await held.entered;
  expect(bar().open).toBe(false);

  press(parent, "alt+a");
  expect(bar().tab).toBe("AGENTS");
  expect(bar().lines[1]).toContain('"run s"');
  press(parent, "alt+a");
  expect(bar().open).toBe(false);

  press(parent, "alt+s");
  expect(bar().tab).toBe("SHELLS");
  expect(bar().lines[1]).toContain("nothing running");
  press(parent, "alt+s");
  expect(bar().tab).toBe("AGENTS");

  held.release();
  await run;
});

test("two alt+a in one tick end closed", async () => {
  const parent = await parentSession({
    mode: "tui",
    respond: router([call({ prompt: "s" })], hold().step),
  });
  const bar = asciiBar(parent);

  press(parent, "alt+a");
  press(parent, "alt+a");
  expect(bar().open).toBe(false);
});

test("the shortcuts claim keys Pi leaves unbound", async () => {
  const parent = await parentSession({
    mode: "tui",
    respond: router([], hold().step),
  });
  const runner = parent.session.extensionRunner;
  const shortcuts = runner.getShortcuts(keybindings().getEffectiveConfig());

  expect([...shortcuts.keys()].sort()).toEqual(["alt+a", "alt+s"]);
  expect(runner.getShortcutDiagnostics()).toEqual([]);
});

test("outside tui the shortcuts do nothing", async () => {
  const parent = await parentSession({
    mode: "tui",
    respond: router([], hold().step),
  });
  const bar = asciiBar(parent);

  for (const mode of ["rpc", "print"] as const) {
    press(parent, "alt+a", mode);
    press(parent, "alt+s", mode);
  }
  expect(bar().open).toBe(false);
});

const explodingChild = () =>
  fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "provider exploded",
  });

/**
 * Resolves once the parent's settled run is handed its next turn: the turn a delivered failure
 * starts. Everything its failure changed on the bar — the frames and the unseen lead — is in
 * place by then.
 */
function delivered(parent: Parent): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const stop = parent.session.subscribe((event) => {
      if (event.type === "agent_settled") settled = true;
      else if (settled && event.type === "turn_start") {
        stop();
        resolve();
      }
    });
  });
}

test("opening a tab marks its failures seen: the pulse stops leading with them once the bar closes", async () => {
  const parent = await parentSession({
    mode: "tui",
    respond: scriptTurns(explodingChild, () =>
      fauxAssistantMessage([call({ prompt: "boom", background: true })]),
    ),
  });

  const failureTurn = delivered(parent);
  await parent.session.prompt("go");
  await failureTurn;
  await parent.session.waitForIdle();
  expect(parent.widgets.at(-1)?.[0]).toMatch(/^× "run boom" · .*unseen/);

  press(parent, "alt+a");
  const open = parent.mounted(BAR)?.render(100) ?? [];
  expect(open[0]).toMatch(/AGENTS 1/);
  expect(open[1]).toMatch(/× 1 {2}"run boom" +.*provider exploded/);
  press(parent, "alt+a");
  expect(parent.mounted(BAR)?.render(100)).toEqual([]);
});

test("/subagents opens the AGENTS tab in tui and lists running subagents elsewhere", async () => {
  const held = hold();
  const tui = await parentSession({
    mode: "tui",
    respond: router([call({ prompt: "s" })], held.step),
  });
  const bar = asciiBar(tui);
  const run = tui.session.prompt("go");
  await held.entered;

  press(tui, "alt+s");
  expect(bar().tab).toBe("SHELLS");
  await tui.session.prompt("/subagents");
  expect(bar().tab).toBe("AGENTS");
  expect(tui.notices).toEqual([]);
  held.release();
  await run;

  const other = hold();
  const print = await parentSession({
    mode: "print",
    respond: router([call({ prompt: "s" })], other.step),
  });
  const printRun = print.session.prompt("go");
  await other.entered;
  expect(await listing(print)).toEqual([
    expect.stringMatching(/^\* running "run s"/),
  ]);
  other.release();
  await printRun;
});

test("/shells opens the SHELLS tab in tui", async () => {
  const parent = await parentSession({
    mode: "tui",
    respond: scriptTurns(hold().step, () =>
      fauxAssistantMessage([
        fauxToolCall(
          "bash",
          { command: "sleep 60", background: true },
          { id: "sh" },
        ),
      ]),
    ),
  });
  const bar = asciiBar(parent);

  await parent.session.prompt("go");
  expect(bar().open).toBe(false);
  await parent.session.prompt("/shells");
  expect(bar().tab).toBe("SHELLS");
  expect(bar().lines[1]).toMatch(/\* \$1 sleep 60 &/);
  expect(parent.notices).toEqual([]);

  await parent.session.prompt("/shells stop all");
});

test("a session start resets open, tab and the failures it was holding", async () => {
  const parent = await parentSession({
    mode: "tui",
    respond: scriptTurns(explodingChild, () =>
      fauxAssistantMessage([call({ prompt: "boom", background: true })]),
    ),
  });
  const bar = asciiBar(parent);
  const failureTurn = delivered(parent);
  await parent.session.prompt("go");
  await failureTurn;
  await parent.session.waitForIdle();
  expect(parent.widgets.at(-1)?.[0]).toMatch(/^x "run boom"/);
  press(parent, "alt+s");
  expect(bar().tab).toBe("SHELLS");

  await parent.session.reload();
  // The failure it had not been shown would lead the new session's pulse
  expect(bar().lines).toEqual([]);
  press(parent, "alt+a");
  expect(bar().tab).toBe("AGENTS");
});

test("/subagents stop takes the slot number the bar shows, never an id prefix", async () => {
  const held = hold();
  const parent = await parentSession({
    mode: "tui",
    respond: router([call({ prompt: "s" })], held.step),
  });
  const run = parent.session.prompt("go");
  await held.entered;

  // Digits are hex too: slot 2 must not stop an id that begins with 2
  await parent.session.prompt("/subagents stop 2");
  expect(parent.notices.at(-1)).toMatch(
    /^subagent: nothing is in slot 2; running: 1 "run s"$/,
  );
  await parent.session.prompt("/subagents stop 1");
  expect(parent.notices.at(-1)).toMatch(
    /^subagent: stopping "run s" \(id [0-9a-f]{8}\)$/,
  );
  await run;
});

test("/shells stop takes the $slot number the bar shows", async () => {
  const parent = await parentSession({
    mode: "tui",
    respond: scriptTurns(hold().step, () =>
      fauxAssistantMessage([
        fauxToolCall(
          "bash",
          { command: "sleep 60", background: true },
          { id: "sh" },
        ),
      ]),
    ),
  });
  await parent.session.prompt("go");

  await parent.session.prompt("/shells stop $2");
  expect(parent.notices.at(-1)).toBe(
    "shells: nothing is in slot $2; running: $1 sleep 60",
  );
  await parent.session.prompt("/shells stop 2");
  expect(parent.notices.at(-1)).toBe(
    "shells: nothing is in slot $2; running: $1 sleep 60",
  );
  await parent.session.prompt("/shells stop $1");
  expect(parent.notices.at(-1)).toMatch(
    /^shells: stopped [0-9a-f]{8} "sleep 60"$/,
  );
});

test("on a pane too small to list the tab, /subagents lists the children with their ids", async () => {
  const host = await brokenHost(
    { requestRender() {}, terminal: { rows: 11, columns: 100 } },
    plainTheme,
  );

  await host.parent.session.prompt("/subagents");
  expect(host.parent.notices.at(-1)).toMatch(
    /^• running "run s" .* [0-9a-f]{8}$/,
  );
  await host.finish();
});

test("a failure that lands while its tab is open is already seen", async () => {
  const gate = hold();
  const parent = await parentSession({
    mode: "tui",
    respond: scriptTurns(
      async (...args) => {
        await gate.step(...args);
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "provider exploded",
        });
      },
      () => fauxAssistantMessage([call({ prompt: "boom", background: true })]),
    ),
  });
  const failureTurn = delivered(parent);
  await parent.session.prompt("go");
  await gate.entered;
  press(parent, "alt+a");

  gate.release();
  await failureTurn;
  await parent.session.waitForIdle();
  expect(parent.mounted(BAR)?.render(100)[1]).toMatch(/provider exploded/);
  press(parent, "alt+a");
  expect(parent.mounted(BAR)?.render(100)).toEqual([]);
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
  // The tick's report is queued as a microtask after the throw.
  await Promise.resolve();
  expect(host.parent.notices).toEqual([
    "skyr: the bar stopped drawing after an error (tui gone); /reload brings it back",
  ]);
  expect(vi.getTimerCount()).toBe(baseline);
  // A running child would draw a pulse; a bar that tripped draws nothing
  expect(host.bar()?.render(100)).toEqual([]);
  await host.finish();
});

test("after the bar stopped drawing, /subagents still lists", async () => {
  const theme = {
    get colors(): never {
      throw new Error("theme gone");
    },
  };
  const host = await brokenHost(
    { requestRender() {}, terminal: { rows: 40, columns: 100 } },
    theme,
  );
  host.bar()?.render(100);

  await host.parent.session.prompt("/subagents");
  expect(host.parent.notices).toContainEqual(
    expect.stringMatching(/^• running "run s"/),
  );
  await host.finish();
});

test("after the bar stopped drawing, a slot still names its row, including rows that arrive later", () => {
  const bar = createBar();
  let live: BarRow[] = [];
  let changed = () => {};
  bar.attach({
    tab: "agents",
    rows: () => live,
    subscribe(onChange) {
      changed = onChange;
      return () => {};
    },
  });
  bar.start({
    notify: () => {},
    setWidget: ((_key: string, factory: (...args: object[]) => never) => {
      factory(
        {
          requestRender() {
            throw new Error("tui gone");
          },
          terminal: { rows: 40, columns: 100 },
        },
        plainTheme,
      );
    }) as never,
  });

  live = [rowOf("a1")];
  changed();
  live = [rowOf("a1"), rowOf("a2")];
  changed();

  expect(bar.slotTarget("agents", "1")).toEqual({ id: "a1" });
  expect(bar.slotTarget("agents", "2")).toEqual({ id: "a2" });
});

/** A parent whose bar is mounted on a terminal of `rows` rows, with a child that fails in the background. */
async function failingOn(
  rows: number,
  extra: ReturnType<typeof fauxToolCall>[] = [],
) {
  let bar: { render(width: number): string[] } | undefined;
  const parent = await parentSession({
    mode: "tui",
    respond: scriptTurns(explodingChild, () =>
      fauxAssistantMessage([
        call({ prompt: "boom", background: true }),
        ...extra,
      ]),
    ),
    ui: {
      setWidget: ((_key: string, factory: (...args: object[]) => never) => {
        bar = factory(
          { requestRender() {}, terminal: { rows, columns: 100 } },
          plainTheme,
        );
      }) as never,
    },
  });
  const failureTurn = delivered(parent);
  await parent.session.prompt("go");
  await failureTurn;
  await parent.session.waitForIdle();
  expect(bar?.render(100)[0]).toMatch(/^ ?× "run boom"/);
  return { parent, bar: () => bar?.render(100) ?? [] };
}

test("on a pane too small for the tab, /subagents lists the failure instead of losing it", async () => {
  const { parent, bar } = await failingOn(11);

  expect(bar()[0]).toMatch(/unseen/);
  expect(bar()[0]).not.toContain("nothing running");

  await parent.session.prompt("/subagents");
  expect(parent.notices.at(-1)).toMatch(
    /× "run boom" · .*provider exploded.* · [0-9a-f]{8}$/,
  );
  // Listed once, so it no longer leads
  expect(bar()).toEqual([]);
});

test("on a pane too small for the tab, alt+a and alt+s list the tab in a notice instead of doing nothing", async () => {
  const { parent, bar } = await failingOn(11);

  press(parent, "alt+a");
  expect(parent.notices.at(-1)).toMatch(
    /× "run boom" & · .*provider exploded.* · [0-9a-f]{8}$/,
  );
  // Listed once, so no tab opened and nothing leads
  expect(bar()).toEqual([]);

  press(parent, "alt+s");
  expect(parent.notices.at(-1)).toMatch(/^shells: none running$/);
});

test("on a pane too small for the tab, /shells lists the jobs", async () => {
  const { parent, bar } = await failingOn(11, [
    fauxToolCall(
      "bash",
      { command: "sleep 60", background: true },
      { id: "sh" },
    ),
  ]);

  await parent.session.prompt("/shells");
  expect(parent.notices.at(-1)).toMatch(/"sleep 60" · running for/);
  expect(bar()[0]).not.toMatch(/AGENTS|SHELLS/);
  await parent.session.prompt("/shells stop all");
});

test("the window start is remembered: moving inside the window does not scroll it, and moving past an edge scrolls just enough", () => {
  const { bar, set, host } = standalone(24);
  set(
    "agents",
    Array.from({ length: 10 }, (_, i) => rowOf(`a${i}`)),
  );
  bar.nextTab();
  bar.nextTab();
  const labels = () =>
    (host.mounted(BAR)?.render(100) ?? [])
      .map((l) => /a\d/.exec(l)?.[0])
      .filter(Boolean);

  for (let i = 0; i < 7; i++) bar.move(1);
  expect(labels()[0]).toBe("a0");
  bar.move(1);
  expect(labels()[0]).toBe("a1");
  bar.move(-1);
  bar.move(-1);
  expect(labels()[0]).toBe("a1");
  for (let i = 0; i < 5; i++) bar.move(-1);
  expect(labels()[0]).toBe("a0");
});

/** A bar driven without Pi: sources the test edits, mounted on a fake terminal, drawn in ascii so a highlight reads as `>`. */
function standalone(terminalRows = 40) {
  vi.stubEnv("TERM", "dumb");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const bar = createBar();
  const host = widgetHost();
  const sources = {
    agents: {
      rows: [] as BarRow[],
      changed: () => {},
      failed: (_: BarRow) => {},
    },
    shells: {
      rows: [] as BarRow[],
      changed: () => {},
      failed: (_: BarRow) => {},
    },
  };
  for (const tab of ["agents", "shells"] as const) {
    const state = sources[tab];
    bar.attach({
      tab,
      rows: () => state.rows,
      subscribe(changed, failed) {
        state.changed = changed;
        state.failed = failed;
        return () => {};
      },
    });
  }
  const start = () =>
    bar.start({
      notify: () => {},
      setWidget: (key, content) =>
        host.setWidget(
          key,
          typeof content === "function"
            ? (_tui, theme) =>
                content(
                  {
                    requestRender: () => {},
                    terminal: { rows: terminalRows, columns: 100 },
                  } as never,
                  theme as never,
                )
            : content,
        ),
    });
  start();
  const set = (tab: "agents" | "shells", rows: BarRow[]) => {
    sources[tab].rows = rows;
    sources[tab].changed();
  };
  /** The labels of the highlighted rows, as the mounted bar draws them. */
  const highlighted = () =>
    (host.mounted(BAR)?.render(100) ?? [])
      .filter((line) => line.startsWith(">"))
      .map((line) => /"?([a-z]\d)"?/.exec(line)?.[1]);
  return { bar, set, sources, highlighted, start, host };
}

const rowOf = (id: string, extra: Partial<BarRow> = {}): BarRow => ({
  id,
  mark: "running",
  label: id,
  background: false,
  startedAt: 0,
  ...extra,
});

test("↓ from no focus focuses the first row and ↑ the last, and both clamp at the ends", () => {
  const { bar, set, highlighted } = standalone();
  set("agents", [rowOf("a1"), rowOf("a2"), rowOf("a3")]);
  bar.nextTab();
  bar.nextTab();
  expect(highlighted()).toEqual([]);
  bar.move(1);
  expect(highlighted()).toEqual(["a1"]);
  bar.move(-1);
  expect(highlighted()).toEqual(["a1"]);
  bar.move(1);
  bar.move(1);
  bar.move(1);
  expect(highlighted()).toEqual(["a3"]);
  bar.close();
  bar.nextTab();
  bar.nextTab();
  bar.move(-1);
  expect(highlighted()).toEqual(["a3"]);
});

test("failed rows come first and can be focused", () => {
  const { bar, set, sources, highlighted } = standalone();
  set("agents", [rowOf("a1")]);
  sources.agents.failed(rowOf("f1", { mark: "failed", why: "exit 1" }));
  bar.nextTab();
  bar.nextTab();
  bar.move(1);
  expect(highlighted()).toEqual(["f1"]);
  bar.move(1);
  expect(highlighted()).toEqual(["a1"]);
});

test("the focus follows its row when an earlier row ends, and falls to the row now in its place when its own row ends", () => {
  const { bar, set, highlighted } = standalone();
  set("agents", [rowOf("a1"), rowOf("a2"), rowOf("a3")]);
  bar.nextTab();
  bar.nextTab();
  bar.move(1);
  bar.move(1);
  expect(highlighted()).toEqual(["a2"]);
  set("agents", [rowOf("a2"), rowOf("a3")]);
  expect(highlighted()).toEqual(["a2"]);
  set("agents", [rowOf("a3")]);
  expect(highlighted()).toEqual(["a3"]);
  // the last row ending hands the focus to the one before it
  set("agents", [rowOf("a3"), rowOf("a4"), rowOf("a5")]);
  bar.move(1);
  bar.move(1);
  expect(highlighted()).toEqual(["a5"]);
  set("agents", [rowOf("a3"), rowOf("a4")]);
  expect(highlighted()).toEqual(["a4"]);
  set("agents", []);
  expect(highlighted()).toEqual([]);
});

test("each tab keeps its own focus, and closing or a new session forgets both", () => {
  const { bar, set, highlighted, start } = standalone();
  set("agents", [rowOf("a1"), rowOf("a2")]);
  set("shells", [rowOf("s1"), rowOf("s2")]);
  bar.nextTab();
  bar.nextTab();
  bar.move(1);
  bar.move(1);
  bar.nextTab();
  bar.move(-1);
  expect(highlighted()).toEqual(["s2"]);
  bar.nextTab();
  expect(highlighted()).toEqual(["a2"]);

  bar.close();
  bar.nextTab();
  expect(highlighted()).toEqual([]);
  bar.nextTab();
  expect(highlighted()).toEqual([]);

  bar.move(1);
  bar.stop();
  start();
  bar.nextTab();
  expect(highlighted()).toEqual([]);
});

test("move does nothing while the bar is closed or the terminal is too small to list the tab", () => {
  const closed = standalone();
  closed.set("agents", [rowOf("a1")]);
  expect(closed.bar.listing()).toBe(false);
  closed.bar.move(1);
  closed.bar.nextTab();
  closed.bar.nextTab();
  expect(closed.bar.listing()).toBe(true);
  expect(closed.highlighted()).toEqual([]);

  const small = standalone(11);
  small.set("agents", [rowOf("a1")]);
  small.bar.nextTab();
  small.bar.nextTab();
  expect(small.bar.listing()).toBe(false);
  small.bar.move(1);
  expect(small.highlighted()).toEqual([]);
});

test("move reports no change on an empty tab and on the only row once it is focused, so the key stays the editor's", () => {
  const { bar, set } = standalone();
  bar.nextTab();
  bar.nextTab();
  expect(bar.move(1)).toBe(false);
  set("agents", [rowOf("a1")]);
  expect(bar.move(1)).toBe(true);
  expect(bar.move(1)).toBe(false);
  expect(bar.move(-1)).toBe(false);
});
