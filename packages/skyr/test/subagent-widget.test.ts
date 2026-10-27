// The live widget: a component Pi mounts once per appearance, repainting itself each second.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  call,
  expectInert,
  HOSTILE,
  hold,
  type Parent,
  parentSession,
  router,
  taskOf,
} from "./session.js";

const WIDGET = "skyr.subagents";

/** Fakes the widget's tick from here on; setTimeout stays real, as Pi's own waits need it. */
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

/** Resolves once the parent's model has had `n` requests and the parent is idle again. */
async function parentTurns(parent: Parent, n: number): Promise<void> {
  const seen = () => parent.requests.filter((r) => taskOf(r) === "go").length;
  await new Promise<void>((resolve) => {
    const check = () => {
      if (seen() < n) return;
      stop();
      resolve();
    };
    const stop = parent.session.subscribe(check);
    check();
  });
  await parent.session.waitForIdle();
}

test("the subagent widget is set once per appearance, not once per tick", async () => {
  const held = hold();
  const parent = await parentSession({
    respond: router([call({ prompt: "s" })], held.step),
  });
  fakeTicks();

  const run = parent.session.prompt("go");
  await held.entered;
  const frames = parent.widgets.length;
  vi.advanceTimersByTime(3_000);
  // Each second repaints the mounted widget, so its clock moves without a store change.
  expect(parent.widgets.length).toBe(frames + 3);
  expect(parent.widgets.at(-1)?.[0]).toMatch(/^● running "run s" · /);

  held.release();
  await run;
  expect(parent.widgetSets.filter((key) => key === WIDGET)).toHaveLength(2);
  expect(parent.widgets.at(-1)).toBeUndefined();
});

test("every widget line fits a 20-column pane, wide characters and emoji included", async () => {
  const { parent, run } = await writers(11);

  const lines = parent.mounted(WIDGET)?.render(20) ?? [];
  expect(lines).toHaveLength(10);
  expectInert(lines, 20);

  await parent.session.abort();
  await run;
});

test("ten running children all show, with no count of the rest", async () => {
  const { parent, run } = await writers(10);

  const lines = parent.widgets.at(-1) ?? [];
  expect(lines).toHaveLength(10);
  expect(lines[9]).toMatch(/^○ queued /);

  await parent.session.abort();
  await run;
});

test("more than ten running children show nine and a count of the rest", async () => {
  const { parent, run } = await writers(11);

  const lines = parent.widgets.at(-1) ?? [];
  expect(lines).toHaveLength(10);
  expect(lines[0]).toMatch(/^● running /);
  for (const line of lines.slice(1, 9)) expect(line).toMatch(/^○ queued /);
  expect(lines[9]).toBe("… +2 more · /subagents lists all");
  await parent.session.prompt("/subagents");
  expect(parent.notices.at(-1)?.split("\n")).toHaveLength(11);

  await parent.session.abort();
  await run;
});

test("with a host that never mounts the widget, no repaint tick runs and the widget is set only as it appears and goes", async () => {
  const held = hold();
  const again = hold();
  const turns = [
    fauxAssistantMessage([call({ prompt: "bg", background: true })]),
    fauxAssistantMessage("done"),
    fauxAssistantMessage("noted"),
    fauxAssistantMessage([call({ prompt: "bg2", background: true })]),
    fauxAssistantMessage("done"),
  ];
  const sets: string[] = [];
  const parent = await parentSession({
    respond: (context, ...rest) =>
      taskOf(context) === "go"
        ? (turns.shift() ?? fauxAssistantMessage("noted"))
        : (taskOf(context) === "bg2" ? again : held).step(context, ...rest),
    // A host that takes the factory and never calls it, as RPC mode does.
    ui: {
      setWidget: (key: string) => {
        sets.push(key);
      },
    },
  });
  fakeTicks();
  const intervals = vi.getTimerCount();

  await parent.session.prompt("go");
  await held.entered;
  vi.advanceTimersByTime(1_500);
  // A background call starts no interval of its own, so any new one is a widget tick.
  expect(vi.getTimerCount()).toBe(intervals);
  expect(sets.filter((key) => key === WIDGET)).toHaveLength(1);

  held.release();
  await parentTurns(parent, 3);
  expect(sets.filter((key) => key === WIDGET)).toHaveLength(2);

  // The host never disposed the first widget, so the next appearance must be set again
  await parent.session.prompt("again");
  await again.entered;
  expect(sets.filter((key) => key === WIDGET)).toHaveLength(3);
  again.release();
  await parentTurns(parent, 6);
  expect(sets.filter((key) => key === WIDGET)).toHaveLength(4);
});

test("after the host disposes the widget, the next run shows it again", async () => {
  const holds = new Map(["a", "b"].map((task) => [task, hold()]));
  const parent = await parentSession({
    respond: router(
      [...holds.keys()].map((task) =>
        call({ prompt: task, tools: ["write"], cwd: "." }),
      ),
      (context, ...rest) => {
        const held = holds.get(taskOf(context));
        if (!held) throw new Error(`unexpected task ${taskOf(context)}`);
        return held.step(context, ...rest);
      },
    ),
  });
  fakeTicks();

  const run = parent.session.prompt("go");
  await holds.get("a")?.entered;
  expect(parent.mounted(WIDGET)).toBeDefined();
  // As a reload does: Pi disposes every widget without a set from skyr.
  parent.resetWidgets();
  const frames = parent.widgets.length;
  vi.advanceTimersByTime(2_000);
  expect(parent.widgets).toHaveLength(frames);

  holds.get("a")?.release();
  await holds.get("b")?.entered;
  expect(parent.mounted(WIDGET)).toBeDefined();
  expect(parent.widgets.at(-1)?.[0]).toMatch(/^● running "run b" · /);

  holds.get("b")?.release();
  await run;
  expect(parent.widgets.at(-1)).toBeUndefined();
});
