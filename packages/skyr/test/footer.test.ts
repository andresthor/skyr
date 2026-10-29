// The footer skyr puts in Pi's slot: a component mounted once per terminal session whose frames
// are built from facts computed when events fire.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { createFooter } from "../src/chrome/footer.js";
import {
  expectInert,
  HOSTILE,
  hold,
  parentSession,
  plainTheme,
  scratchDir,
} from "./session.js";
import { piScreen, recordingUi } from "./ui.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A tui session whose footer is held as Pi holds it. */
async function tuiSession(
  skyr?: unknown,
  respond: Parameters<typeof parentSession>[0]["respond"] = () =>
    fauxAssistantMessage("ok"),
) {
  const host = recordingUi();
  const parent = await parentSession({
    respond,
    mode: "tui",
    ui: host.ui,
    skyr,
  });
  const lines = (width = 200) => host.footer()?.render(width) ?? [];
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
  expect(lines()[1]).toMatch(/^ ~\/skyr-test-cwd-\S+ \(main\)( ·|$)/);

  const before = renders();
  setBranch("feat-x");
  expect(renders()).toBe(before + 1);
  expect(lines()[1]).toContain("(feat-x)");

  setBranch(null);
  expect(lines()[1]).not.toContain("(");
});

test("a rename shows on the line", async () => {
  const { parent, lines, renders } = await tuiSession();
  expect(lines()[1]).not.toContain("my session");

  const before = renders();
  parent.session.setSessionName("my session");
  expect(lines()[1]).toMatch(/ · my session( ·|$)/);
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
  expect(lines()).toHaveLength(2);

  statuses.set("b", "two\nlines");
  statuses.set("a", "one");
  expect(lines()).toHaveLength(3);
  expect(lines()[2]).toBe(" one two lines");

  statuses.clear();
  expect(lines()).toHaveLength(2);
});

test("a status holding CR, ESC[2J, an OSC 52 sequence, a bidi override, wide characters and colour keeps the colour and loses everything else, and is cut to the pane", async () => {
  const { lines, statuses } = await tuiSession();
  statuses.set("x", `\r\u001b[31m${HOSTILE}\u001b[2J\u001b[0m`);
  for (const width of [20, 40, 86, 200]) {
    const frame = lines(width);
    expectInert(frame, width);
    expect(frame[2]).toContain("\u001b[31m");
    expect(frame[2]).not.toContain("\u001b[2J");
    expect(frame[2]).not.toContain("\r");
  }
});

test("under NO_COLOR a status loses its colour too", async () => {
  vi.stubEnv("NO_COLOR", "1");
  const { lines, statuses } = await tuiSession();
  statuses.set("x", "\u001b[31mred\u001b[0m");
  expect(lines()[2]).toBe(" red");
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
  const { parent, footer, statuses, setBranch, lines } = await tuiSession();
  parent.session.setSessionName(HOSTILE);
  setBranch(HOSTILE);
  statuses.set("x", HOSTILE);
  for (const width of [20, 40, 86]) {
    expectInert(lines(width), width);
    const { firstFrameCrash, crash } = piScreen(footer()!, width);
    expect(firstFrameCrash).toBeUndefined();
    expect(crash).toBeUndefined();
  }
});

test("ui.footer false never calls setFooter", async () => {
  const { sets, notices } = await tuiSession({ ui: { footer: false } });
  expect(sets()).toEqual([]);
  expect(notices()).toEqual([]);
});

test("a ui section with a non-boolean footer or an unknown key is reported once and the footer stays on", async () => {
  const { sets, notices } = await tuiSession({
    ui: { footer: "yes", colour: 1 },
  });
  expect(sets()).toHaveLength(1);
  expect(notices()).toHaveLength(1);
  // The problem strings themselves are pinned in ui-config.test.ts; through the session the
  // notice only has to name the setting and the unknown key it is about
  expect(notices()[0]?.args[0]).toContain("ui.footer");
  expect(notices()[0]?.args[0]).toContain("colour");
  expect(notices()[0]?.args[1]).toBe("warning");
});

test("a ui section that is not an object is reported and the footer stays on", async () => {
  const { sets, notices } = await tuiSession({ ui: [] });
  expect(sets()).toHaveLength(1);
  expect(notices()).toHaveLength(1);
});

test("a malformed skyr.json still gets the footer", async () => {
  const { sets, footer } = await tuiSession("{not json");
  expect(sets()).toHaveLength(1);
  expect(footer()).toBeDefined();
});

/** A context the footer can read, with the reads counted. */
function stubContext(
  ui: ExtensionUIContext,
  fields: Record<string, unknown> = {},
) {
  const reads = { entries: 0, branch: 0, context: 0 };
  const ctx = {
    mode: "tui",
    ui,
    sessionManager: {
      getCwd: () => "/x",
      getSessionName: () => undefined,
      getSessionId: () => "s",
      getLeafId: () => "leaf",
      getEntries: () => {
        reads.entries += 1;
        return [];
      },
      getBranch: () => {
        reads.branch += 1;
        return [];
      },
    },
    getContextUsage: () => {
      reads.context += 1;
      return { tokens: 1000, percent: 1, contextWindow: 100_000 };
    },
    model: { provider: "p", id: "claude-m", reasoning: true },
    thinkingLevel: "high",
    ...fields,
  } as unknown as ExtensionContext;
  return { ctx, reads };
}

test("a start overtaken while the settings are read installs nothing, and the latest start installs once", async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", scratchDir("agent"));
  const host = recordingUi();
  const { ctx } = stubContext(host.ui);
  const footer = createFooter();

  const stopped = footer.start(ctx);
  footer.stop();
  await stopped;
  expect(host.calls.filter(({ method }) => method === "setFooter")).toEqual([]);

  const first = footer.start(ctx);
  const second = footer.start(ctx);
  await Promise.all([first, second]);
  expect(
    host.calls.filter(({ method }) => method === "setFooter"),
  ).toHaveLength(1);
});

/** A usage record that costs `total` and nothing else. */
const usage = (
  total: number,
  tokens: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } = {},
) => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  ...tokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const userMessage = (text: string) => ({
  role: "user" as const,
  content: text,
  timestamp: 0,
});

const assistant = (total: number) => ({
  ...fauxAssistantMessage("answer"),
  usage: usage(total),
});

test("a turn's own messages are in the figures at turn_end", async () => {
  const { parent, lines } = await tuiSession();
  expect(lines()[0]).toContain("0 turns $0.00");
  await parent.session.prompt("go");
  expect(lines()[0]).toContain("1 turns");
});

test("cost sums assistant, tool result, usage, compaction and branch-summary usage over every entry, abandoned branches included", async () => {
  const { parent, lines } = await tuiSession();
  const manager = parent.session.sessionManager;
  const root = manager.appendMessage(userMessage("root"));
  manager.appendMessage(assistant(1));
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "t",
    toolName: "read",
    content: [{ type: "text", text: "x" }],
    isError: false,
    timestamp: 0,
    usage: usage(2),
  });
  manager.appendUsage("cache_warm", "faux", "faux-1", usage(4));
  const kept = manager.appendMessage(userMessage("kept"));
  manager.appendCompaction("summary", kept, 10, undefined, false, usage(8));
  manager.branchWithSummary(root, "abandoned", undefined, false, usage(16));
  await parent.session.prompt("go");
  expect(lines()[0]).toContain("$31.00");
});

test("a delivered background run's usage is in the cost, and a custom message of another shape is ignored", async () => {
  const { parent, lines } = await tuiSession();
  const manager = parent.session.sessionManager;
  manager.appendCustomMessageEntry("runs", "done", true, [
    { id: "a", usage: usage(1.5) },
    { id: "b", usage: usage(-3) },
    { id: "c" },
    "text",
  ]);
  manager.appendCustomMessageEntry("other", "x", true, { usage: usage(100) });
  manager.appendCustomMessageEntry("none", "x", true);
  await parent.session.prompt("go");
  expect(lines()[0]).toContain("$1.50");
});

test("turns count the branch's user messages, not another branch's", async () => {
  const { parent, lines } = await tuiSession();
  const manager = parent.session.sessionManager;
  const first = manager.appendMessage(userMessage("one"));
  manager.appendMessage(userMessage("two"));
  manager.appendMessage(userMessage("three"));
  manager.branch(first);
  await parent.session.prompt("go");
  expect(lines()[0]).toContain("2 turns");
});

test("context reads ? after a compaction", async () => {
  const { parent, lines } = await tuiSession();
  const manager = parent.session.sessionManager;
  const kept = manager.appendMessage(userMessage("kept"));
  manager.appendCompaction("summary", kept, 10);
  parent.session.setSessionName("compacted");
  expect(lines()[0]).toMatch(/^ \? ▫{8} \?\/128k/);
});

test("one turn_end reads the context once", async () => {
  const { parent } = await tuiSession();
  const context = vi.spyOn(parent.session, "getContextUsage");
  await parent.session.prompt("go");
  expect(context).toHaveBeenCalledTimes(1);
});

test("a refresh with nothing changed reads no entries", async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", scratchDir("agent"));
  const host = recordingUi();
  const { ctx, reads } = stubContext(host.ui);
  const footer = createFooter();
  await footer.start(ctx);
  expect(reads).toEqual({ entries: 1, branch: 1, context: 1 });

  footer.refresh(ctx);
  footer.refresh(ctx);
  expect(reads).toEqual({ entries: 1, branch: 1, context: 1 });
});

test("the model and thinking level follow the context, and no level shows for a model that does not reason", async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", scratchDir("agent"));
  const host = recordingUi();
  const footer = createFooter();
  const { ctx } = stubContext(host.ui);
  await footer.start(ctx);
  expect(host.footer()?.render(100)[0]).toContain("claude-m high");

  footer.refresh(stubContext(host.ui, { thinkingLevel: "low" }).ctx);
  expect(host.footer()?.render(100)[0]).toContain("claude-m low");

  footer.refresh(
    stubContext(host.ui, {
      model: { provider: "p", id: "plain", reasoning: false },
    }).ctx,
  );
  const line = host.footer()?.render(100)[0] ?? "";
  expect(line).toContain("plain");
  expect(line).not.toMatch(/plain (low|high)/);
});

test("the model follows model_select", async () => {
  const { parent, lines } = await tuiSession();
  expect(lines()[0]).toContain("faux-1");
  const other = parent.session.modelRuntime
    .getAllModels()
    .find((model) => model.id === "faux-3");
  if (!other) throw new Error("the faux provider lost faux-3");
  await parent.session.setModel(other as never);
  expect(lines()[0]).toContain("faux-3");
  expect(lines()[0]).toContain("/60k");
});

test("the totals sum Pi's four sources over every entry, and a delivered run adds none", async () => {
  const { parent, lines } = await tuiSession();
  const manager = parent.session.sessionManager;
  const root = manager.appendMessage(userMessage("root"));
  manager.appendMessage({ ...assistant(0), usage: usage(0, { input: 1000 }) });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "t",
    toolName: "read",
    content: [{ type: "text", text: "x" }],
    isError: false,
    timestamp: 0,
    usage: usage(0, { output: 2000 }),
  });
  manager.appendUsage(
    "cache_warm",
    "faux",
    "faux-1",
    usage(0, { cacheRead: 4000 }),
  );
  manager.appendCompaction(
    "s",
    root,
    1,
    undefined,
    false,
    usage(0, { cacheWrite: 8000 }),
  );
  manager.branchWithSummary(
    root,
    "abandoned",
    undefined,
    false,
    usage(0, { input: 16_000 }),
  );
  manager.appendCustomMessageEntry("runs", "done", true, [
    { usage: usage(0, { input: 999_000 }) },
  ]);
  parent.session.setSessionName("totals");
  expect(lines()[1]).toContain("↑17k ↓2k R4k W8k");
});

test("CH is the latest assistant's cache read over its prompt tokens and absent without cache use", async () => {
  const { parent, lines } = await tuiSession();
  const manager = parent.session.sessionManager;
  manager.appendMessage(userMessage("a"));
  manager.appendMessage({
    ...assistant(0),
    usage: usage(0, { input: 10, cacheRead: 990 }),
  });
  manager.appendMessage(userMessage("b"));
  manager.appendMessage({
    ...assistant(0),
    usage: usage(0, { input: 50, cacheRead: 30, cacheWrite: 20 }),
  });
  parent.session.setSessionName("x");
  expect(lines()[1]).toContain("CH30%");

  manager.appendMessage({ ...assistant(0), usage: usage(0) });
  parent.session.setSessionName("y");
  expect(lines()[1]).toContain("↑60 R1k W20");
  expect(lines()[1]).not.toContain("CH");
});

/** Fakes the clock the footer reads and ticks on; no session may be running that waits on a timer. */
function fakeClock(at: Date): void {
  vi.useFakeTimers({
    toFake: [
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
      "Date",
    ],
  });
  vi.setSystemTime(at);
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

test("the clock shows HH:MM and repaints once a minute, not once a second", async () => {
  fakeClock(new Date(2026, 9, 28, 22, 5, 0));
  const { lines, renders } = await tuiSession();
  expect(lines()[0]).toMatch(/ 22:05$/);

  const before = renders();
  vi.advanceTimersByTime(59_000);
  expect(renders()).toBe(before);
  vi.advanceTimersByTime(1_000);
  expect(renders()).toBe(before + 1);
  expect(lines()[0]).toMatch(/ 22:06$/);
});

test("no timer is left after a dispose, and three reloads leave one", async () => {
  fakeClock(new Date(2026, 9, 28, 22, 5, 0));
  const { parent, resetFooter } = await tuiSession();
  expect(vi.getTimerCount()).toBe(1);
  resetFooter();
  expect(vi.getTimerCount()).toBe(0);

  for (let i = 0; i < 3; i++) await parent.session.reload();
  expect(vi.getTimerCount()).toBe(1);
});

test("the profile is the agent dir's parent name, and pi for ~/.pi/agent", async () => {
  const { parent, lines } = await tuiSession();
  expect(lines()[0]).toContain(` ${basename(dirname(parent.agentDir))} `);

  for (const [agentDir, profile] of [
    [join(".pi", "agent"), "pi"],
    [join("experimental", "agent"), "experimental"],
  ] as const) {
    vi.stubEnv("PI_CODING_AGENT_DIR", join(scratchDir("home"), agentDir));
    const host = recordingUi();
    const footer = createFooter();
    await footer.start(stubContext(host.ui).ctx);
    expect(host.footer()?.render(200)[0]).toMatch(
      new RegExp(`${profile} \\d\\d:\\d\\d$`),
    );
  }
});

/** A session file under `<agentDir>/sessions` charging `provider` `cost` today. */
function spent(
  agentDir: string,
  name: string,
  provider: string,
  cost: number,
  daysAgo = 0,
) {
  const now = new Date();
  const at = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - daysAgo,
    12,
  );
  mkdirSync(join(agentDir, "sessions", "--x--"), { recursive: true });
  writeFileSync(
    join(agentDir, "sessions", "--x--", `${name}.jsonl`),
    `${JSON.stringify({
      type: "message",
      timestamp: at.toISOString(),
      message: {
        role: "assistant",
        provider,
        usage: { cost: { total: cost } },
      },
    })}\n`,
  );
}

/** Waits for the footer's repaints until `done` holds. */
async function until(
  run: { nextRender(): Promise<void> },
  done: () => boolean,
): Promise<void> {
  while (!done()) await run.nextRender();
}

/** A footer over the agent dir `agentDir`, started on a context whose model belongs to `provider`. */
async function spendFooter(agentDir: string, provider: string) {
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const host = recordingUi();
  const footer = createFooter();
  const model = (name: string) => ({
    provider: name,
    id: "m",
    reasoning: false,
  });
  const ctx = (name: string) =>
    stubContext(host.ui, { model: model(name) }).ctx;
  await footer.start(ctx(provider));
  return {
    ...host,
    footer: host.footer,
    started: footer,
    ctx,
    line2: () => host.footer()?.render(200)[1] ?? "",
  };
}

test("the spend group names the current provider and shows the owner's form: anthropic Σ $4.12·day  $102·mo", async () => {
  const agentDir = scratchDir("agent");
  spent(agentDir, "a", "anthropic", 4.12);
  spent(agentDir, "b", "anthropic", 98, 5);
  const run = await spendFooter(agentDir, "anthropic");
  await until(run, () =>
    run.line2().includes("anthropic Σ $4.12·day  $102·mo"),
  );
});

test("the ascii tier writes sum and -", async () => {
  vi.stubEnv("TERM", "dumb");
  const agentDir = scratchDir("agent");
  spent(agentDir, "a", "anthropic", 4.12);
  const run = await spendFooter(agentDir, "anthropic");
  await until(run, () =>
    run.line2().includes("anthropic sum $4.12-day  $4.12-mo"),
  );
  expect(run.line2()).toMatch(/^[\x20-\x7e]*$/);
});

test("two providers' files give each model its own figures and no total, and a model switch re-picks without a rescan", async () => {
  const agentDir = scratchDir("agent");
  spent(agentDir, "a", "anthropic", 1);
  spent(agentDir, "b", "corti", 20);
  const run = await spendFooter(agentDir, "anthropic");
  await until(run, () => run.line2().includes("anthropic Σ $1.00·day"));
  expect(run.line2()).not.toContain("$21");

  // A rescan would find nothing now
  rmSync(join(agentDir, "sessions"), { recursive: true });
  run.started.refresh(run.ctx("corti"));
  expect(run.line2()).toContain("corti Σ $20.00·day");
  expect(run.line2()).not.toContain("anthropic");
});

test("no spend shows before the first scan ends", async () => {
  const agentDir = scratchDir("agent");
  spent(agentDir, "a", "anthropic", 1);
  const run = await spendFooter(agentDir, "anthropic");
  expect(run.line2()).not.toContain("Σ");
  await until(run, () => run.line2().includes("Σ"));
});

test("roots come from getAgentDir(), never a literal path", async () => {
  const home = scratchDir("home");
  vi.stubEnv("HOME", home);
  spent(join(home, ".pi", "agent"), "elsewhere", "anthropic", 1000);
  const agentDir = scratchDir("agent");
  spent(agentDir, "a", "anthropic", 1);
  const run = await spendFooter(agentDir, "anthropic");
  await until(run, () => run.line2().includes("Σ $1.00·day"));
  expect(run.line2()).not.toContain("$1001");
});

test("a scan runs at start and after agent_settled and on no timer", async () => {
  fakeClock(new Date());
  const agentDir = scratchDir("agent");
  spent(agentDir, "a", "anthropic", 1);
  const run = await spendFooter(agentDir, "anthropic");
  await until(run, () => run.line2().includes("Σ $1.00·day"));

  spent(agentDir, "b", "anthropic", 2);
  // The clock's interval is the only timer, before the time passes and after
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(30 * 60_000);
  expect(vi.getTimerCount()).toBe(1);
  expect(run.line2()).toContain("Σ $1.00·day");

  run.started.settled(run.ctx("anthropic"));
  await until(run, () => run.line2().includes("Σ $3.00·day"));
});

test("a session file spend cannot read is reported once", async () => {
  if (process.getuid?.() === 0) return;
  const agentDir = scratchDir("agent");
  spent(agentDir, "a", "anthropic", 1);
  spent(agentDir, "b", "anthropic", 2);
  chmodSync(join(agentDir, "sessions", "--x--", "b.jsonl"), 0o000);
  const run = await spendFooter(agentDir, "anthropic");
  await until(run, () => run.line2().includes("Σ $1.00·day"));
  const first = run.calls.filter(({ method }) => method === "notify");
  expect(first).toHaveLength(1);
  expect(first[0]?.args[0]).toContain(
    "spend could not read --x--/b.jsonl (EACCES)",
  );

  // The second scan fails the same way and stays quiet
  const second = run.nextRender();
  run.started.settled(run.ctx("anthropic"));
  await second;
  expect(run.calls.filter(({ method }) => method === "notify")).toHaveLength(1);
});

test("an unreadable sessions root is named as the sessions folder, with permissions as the fix", async () => {
  if (process.getuid?.() === 0) return;
  const agentDir = scratchDir("agent");
  spent(agentDir, "a", "anthropic", 1);
  const root = join(agentDir, "sessions");
  const run = await spendFooter(agentDir, "anthropic");
  await until(run, () => run.line2().includes("Σ $1.00·day"));
  chmodSync(root, 0o000);
  try {
    run.started.settled(run.ctx("anthropic"));
    await until(run, () => run.calls.some(({ method }) => method === "notify"));
    const notice = run.calls.find(({ method }) => method === "notify");
    expect(notice?.args[0]).toContain(
      "spend could not read the sessions folder",
    );
    expect(notice?.args[0]).toContain("Check its permissions");
    expect(notice?.args[0]).not.toContain("remove");
    expect(run.line2()).toContain("Σ $1.00·day");
  } finally {
    chmodSync(root, 0o700);
  }
});

test("a message's turn shows when its message ends, not when the turn does", async () => {
  const held = hold();
  const { parent, lines, nextRender } = await tuiSession(undefined, held.step);
  const run = parent.session.prompt("go");
  await held.entered;
  // The model has not answered: only the prompt's message has ended
  while (!lines()[0]?.includes("1 turns")) await nextRender();
  held.release();
  await run;
});
