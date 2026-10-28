// The footer skyr puts in Pi's slot: a component mounted once per terminal session whose frames
// are built from facts computed when events fire.
import { tmpdir } from "node:os";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import { expectInert, HOSTILE, parentSession, plainTheme } from "./session.js";
import { piScreen, recordingUi } from "./ui.js";

/** A tui session whose footer is held as Pi holds it. */
async function tuiSession() {
  const host = recordingUi();
  const parent = await parentSession({
    respond: () => fauxAssistantMessage("ok"),
    mode: "tui",
    ui: host.ui,
  });
  const lines = (width = 100) => host.footer()?.render(width) ?? [];
  const sets = () => host.calls.filter(({ method }) => method === "setFooter");
  const notices = () => host.calls.filter(({ method }) => method === "notify");
  return { ...host, parent, lines, sets, notices };
}

test.each(["rpc", "json", "print"] as const)(
  "in %s the footer is never set",
  async (mode) => {
    const { ui, calls } = recordingUi();
    const parent = await parentSession({
      respond: () => fauxAssistantMessage("ok"),
      mode,
      ui,
    });
    await parent.session.prompt("go");
    expect(calls.filter(({ method }) => method === "setFooter")).toEqual([]);
  },
);

test("in tui the footer is set once per session", async () => {
  const { parent, sets, footer } = await tuiSession();
  await parent.session.prompt("go");
  expect(sets()).toHaveLength(1);
  expect(footer()).toBeDefined();

  await parent.session.reload();
  expect(sets()).toHaveLength(2);
});

test("the directory shows under ~ and the branch follows a branch change without a repaint of anything else", async () => {
  vi.stubEnv("HOME", tmpdir());
  const { lines, setBranch, renders } = await tuiSession();
  expect(lines()[0]).toMatch(/^ ~\/skyr-test-cwd-\S+ \(main\)$/);

  const before = renders();
  setBranch("feat-x");
  expect(renders()).toBe(before + 1);
  expect(lines()[0]).toContain("(feat-x)");

  setBranch(null);
  expect(lines()[0]).not.toContain("(");
});

test("a rename shows on the line", async () => {
  const { parent, lines, renders } = await tuiSession();
  expect(lines()[0]).not.toContain("my session");

  const before = renders();
  parent.session.setSessionName("my session");
  expect(lines()[0]).toMatch(/ • my session$/);
  expect(renders()).toBe(before + 1);
});

test("render does no work: 100 renders read neither the name, the directory, the entries nor the context", async () => {
  const { parent, lines } = await tuiSession();
  const manager = parent.session.sessionManager;
  const spies = [
    vi.spyOn(manager, "getSessionName"),
    vi.spyOn(manager, "getCwd"),
    vi.spyOn(manager, "getEntries"),
    vi.spyOn(manager, "getBranch"),
    vi.spyOn(parent.session, "getContextUsage"),
  ];
  for (let i = 0; i < 100; i++) lines(40 + (i % 3));
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

test("a frame is built once until the width, the facts or the theme change", async () => {
  const { lines } = await tuiSession();
  const style = vi.spyOn(plainTheme, "style");
  lines(100);
  const drawn = style.mock.calls.length;
  expect(drawn).toBeGreaterThan(0);

  lines(100);
  expect(style).toHaveBeenCalledTimes(drawn);

  lines(60);
  expect(style.mock.calls.length).toBeGreaterThan(drawn);
});

test("invalidate drops the cached lines so a theme switch repaints", async () => {
  const { lines, footer } = await tuiSession();
  const style = vi.spyOn(plainTheme, "style");
  lines(100);
  const drawn = style.mock.calls.length;
  footer()?.invalidate();
  lines(100);
  expect(style.mock.calls.length).toBe(drawn * 2);
});

test("statuses are one line, sorted by key and absent when empty", async () => {
  const { lines, statuses } = await tuiSession();
  expect(lines()).toHaveLength(1);

  statuses.set("b", "two\nlines");
  statuses.set("a", "one");
  expect(lines()).toHaveLength(2);
  expect(lines()[1]).toBe(" one two lines");

  statuses.clear();
  expect(lines()).toHaveLength(1);
});

test("a status holding CR, ESC[2J, an OSC 52 sequence, a bidi override, wide characters and colour keeps the colour and loses everything else, and is cut to the pane", async () => {
  const { lines, statuses } = await tuiSession();
  statuses.set("x", `\r\u001b[31m${HOSTILE}\u001b[2J\u001b[0m`);
  for (const width of [20, 40, 86, 200]) {
    const frame = lines(width);
    expectInert(frame, width);
    expect(frame[1]).toContain("\u001b[31m");
    expect(frame[1]).not.toContain("\u001b[2J");
    expect(frame[1]).not.toContain("\r");
  }
});

test("under NO_COLOR a status loses its colour too", async () => {
  vi.stubEnv("NO_COLOR", "1");
  const { lines, statuses } = await tuiSession();
  statuses.set("x", "\u001b[31mred\u001b[0m");
  expect(lines()[1]).toBe(" red");
});

test("a footer that throws gives way to Pi's footer, with one notice", async () => {
  const { sets, notices, setBranch, lines } = await tuiSession();
  setBranch(new Error("boom"));
  setBranch(new Error("boom again"));
  await Promise.resolve();

  expect(sets().map(({ args }) => args[0] === undefined)).toEqual([
    false,
    true,
  ]);
  expect(notices()).toHaveLength(1);
  expect(notices()[0]?.args).toEqual([
    expect.stringContaining("the footer stopped drawing after an error (boom)"),
    "warning",
  ]);
  expect(lines()).toEqual([]);
});

test("a footer Pi disposed never restores Pi's footer later", async () => {
  const { footer, resetFooter, sets, notices, statuses } = await tuiSession();
  const old = footer();
  resetFooter();
  vi.spyOn(statuses, Symbol.iterator).mockImplementation(() => {
    throw new Error("late");
  });
  expect(old?.render(100)).toEqual([]);
  await Promise.resolve();

  expect(sets()).toHaveLength(1);
  expect(notices()).toEqual([]);
});

test("three reloads leave one footer and no branch subscriber", async () => {
  const { parent, resetFooter, subscribers, sets } = await tuiSession();
  for (let i = 0; i < 3; i++) {
    resetFooter();
    expect(subscribers()).toBe(0);
    await parent.session.reload();
  }
  expect(subscribers()).toBe(1);
  expect(sets()).toHaveLength(4);
});

test("the footer never crashes Pi's renderer at 20, 40 and 86 columns", async () => {
  const { parent, footer, statuses, setBranch } = await tuiSession();
  parent.session.setSessionName(HOSTILE);
  setBranch(HOSTILE);
  statuses.set("x", HOSTILE);
  for (const width of [20, 40, 86]) {
    const { firstFrameCrash, crash } = piScreen(footer()!, width);
    expect(firstFrameCrash).toBeUndefined();
    expect(crash).toBeUndefined();
  }
});
