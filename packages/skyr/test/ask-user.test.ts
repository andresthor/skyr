/**
 * ask_user through what it registers: a real Pi session where the mode and the turn matter, a
 * direct `execute` where the queue and the signal do. Pi's interactive mode cannot be built in a
 * test, so `dialogs()` stands in for its `custom()`: it mounts the component the factory returns
 * and, on close, writes back the text Pi's restore would.
 */
import { readFileSync } from "node:fs";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createEventBus,
  defineTool,
  type EventBus,
  type ExtensionAPI,
  type ExtensionToolContext,
  type ExtensionUIContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { expect, onTestFinished, test, vi } from "vitest";
import { registerAskUser } from "../src/ask-user/index.js";
import {
  agentFile,
  call,
  expectInert,
  HOSTILE,
  parentSession,
  results,
  router,
  taskOf,
  textOf,
  toolsSeen,
} from "./session.js";
import { piTheme, toolRowHost } from "./ui.js";
import { keybindings, styledRuns } from "./voice.js";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

const NO_TERMINAL =
  "ask_user: this run has no interactive terminal, so nobody can answer. Choose the most reasonable option yourself, say which you assumed, and continue.";
const ABORTED =
  "ask_user: aborted before the user answered; ask again if you still need the answer";
const DECLINED =
  "The user declined to answer. Do not guess their answers or act as if they chose; end your turn and wait for their next message.";
const UNANSWERED =
  "The user left every question marked (not answered) open. Do not assume answers for them or ask them again; go on with what was answered and say in your reply what stays open.";
const CLOSED =
  "ask_user: the client closed the dialog without an answer. Do not guess the answer; end your turn and wait for the user's next message.";
// Right-to-left override: reverses how the text after it is drawn
const BIDI = "\u202e";
const ZERO_WIDTH = "\u200b";
const failedWith = (why: string) =>
  `ask_user: the dialog failed (${why}); ask the question in your reply instead`;

interface Opened {
  component: Component;
  done(result: unknown): void;
  write: ReturnType<typeof vi.fn>;
}

type Factory = (
  tui: unknown,
  theme: Theme,
  keys: ReturnType<typeof keybindings>,
  done: (result: unknown) => void,
) => Component;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Things that arrive in order; `next` waits for the n-th, whether or not it has come yet. */
function arrivals<T>() {
  const slots: ReturnType<typeof deferred<T>>[] = [];
  let arrived = 0;
  let waited = 0;
  const slot = (i: number) => {
    slots[i] ??= deferred<T>();
    return slots[i];
  };
  return {
    arrive: (value: T) => slot(arrived++).resolve(value),
    count: () => arrived,
    next: () => slot(waited++).promise,
  };
}

/**
 * The editor UI ask_user reads and writes, over a real pi-tui editor, with `custom()` doing what
 * Pi's does: it saves `getText()` on open and, on close, restores it with `setText` and refocuses
 * the editor. `onRefocus` stands in for whatever lands as the editor comes back (voice's held words).
 */
function dialogs(
  o: { theme?: Theme; onRefocus?: (editor: Editor) => void } = {},
) {
  const editor = new Editor(
    { terminal: { rows: 40 }, requestRender: () => {} } as never,
    { borderColor: (s: string) => s, selectList: {} } as never,
  );
  const opens = arrivals<Opened>();
  let mountedNow = 0;
  let failNext: Error | undefined;
  const state = { maxMounted: 0, opened: opens.count };

  const custom = vi.fn(
    (factory: Factory) =>
      new Promise((resolve, reject) => {
        const saved = editor.getText();
        const restore = () => {
          editor.setText(saved);
          o.onRefocus?.(editor);
        };
        if (failNext) {
          const error = failNext;
          failNext = undefined;
          restore();
          return reject(error);
        }
        let closed = false;
        const done = (result: unknown) => {
          if (closed) return;
          closed = true;
          mountedNow--;
          restore();
          resolve(result);
        };
        const write = vi.fn();
        const tui = { terminal: { rows: 40, write }, requestRender() {} };
        const component = factory(
          tui,
          o.theme ?? piTheme(),
          keybindings(),
          done,
        );
        if ("focused" in component) component.focused = true;
        mountedNow++;
        state.maxMounted = Math.max(state.maxMounted, mountedNow);
        opens.arrive({ component, done, write });
      }),
  );
  const ui = {
    getEditorText: () => editor.getExpandedText(),
    setEditorText: (t: string) => editor.setText(t),
    custom,
  };
  return {
    // The fake's custom is not generic; Pi's types only see it through this one cast.
    ui: ui as unknown as Partial<ExtensionUIContext> &
      Pick<ExtensionUIContext, "getEditorText" | "setEditorText">,
    editor,
    custom,
    state,
    /** The next dialog to open, in order of opening. */
    nextOpen: opens.next,
    /** Makes the next `custom()` fail the way Pi's does when the factory rejects. */
    failNextOpen: (error: Error) => {
      failNext = error;
    },
  };
}

function press(component: Component, ...keys: string[]): void {
  for (const key of keys) component.handleInput?.(key);
}

type AskTool = ToolDefinition & {
  execute: NonNullable<ToolDefinition["execute"]>;
};

/** ask_user registered on a fake Pi, after a session_start in `mode`; `events` is the bus it asks on. */
function registered(
  mode: "tui" | "print" | "rpc" | null = "tui",
  events: ExtensionAPI["events"] = createEventBus(),
  thinking: () => ReturnType<ExtensionAPI["getThinkingLevel"]> = () => "high",
): AskTool {
  let tool: AskTool | undefined;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  registerAskUser({
    registerTool: (t: AskTool) => {
      tool = t;
    },
    on: (event: string, fn: (event: unknown, ctx: unknown) => void) =>
      handlers.set(event, fn),
    events,
    getThinkingLevel: thinking,
  } as unknown as ExtensionAPI);
  // null: Pi builds the first loadout before session_start has run
  if (mode)
    handlers.get("session_start")?.({ type: "session_start" }, { mode });
  if (!tool) throw new Error("registerAskUser registered no tool");
  return tool;
}

/** A host answering capability queries as tengi does, inside the asking emit; `reply` can lie. */
function capabilityHost(
  bus: EventBus,
  reply: (id: unknown) => unknown = (id) => ({
    id,
    v: 1,
    forms: true,
    formRequests: true,
  }),
): { queries: number } {
  const state = { queries: 0 };
  bus.on("tengi:capabilities?", (q) => {
    state.queries++;
    if (typeof q === "object" && q !== null && "id" in q)
      bus.emit("tengi:capabilities", reply(q.id));
  });
  return state;
}

const hidden = (tool: AskTool) =>
  tool
    .prepareLoadout?.({} as never)
    ?.hiddenDeclarations?.includes("ask_user") === true;

const STORAGE = {
  question: "Which storage should the cache use?",
  header: "Storage",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
};

const NAME = { question: "What should it be called?", header: "Name" };
const TWO = { questions: [STORAGE, NAME] };

const ask = (question: Record<string, unknown> = {}) => ({
  questions: [{ ...STORAGE, ...question }],
});

function execute(
  tool: AskTool,
  ui: ReturnType<typeof dialogs>["ui"],
  params: unknown = ask(),
  signal?: AbortSignal,
) {
  const ctx = { ui } as unknown as ExtensionToolContext;
  return tool.execute("call", params as never, signal, undefined, ctx);
}

/** The parent makes each step's calls in turn, one assistant message per step, then says done. */
function steps(
  ...calls: ReturnType<typeof fauxToolCall>[][]
): FauxResponseFactory {
  return (context: TranscriptContext) => {
    const done = context.messages.filter((m) => m.role === "assistant").length;
    const next = calls[done];
    return next ? fauxAssistantMessage(next) : fauxAssistantMessage("done");
  };
}

const askCall = (id: string, question: Record<string, unknown> = {}) =>
  fauxToolCall("ask_user", ask(question), { id });

test("outside the TUI, even in rpc where a UI exists, ask_user is hidden from the model and a call that arrives anyway opens nothing and tells the model to decide", async () => {
  const fake = dialogs();
  const { session, requests } = await parentSession({
    mode: "rpc",
    ui: fake.ui,
    respond: steps([askCall("a")]),
  });
  await session.prompt("go");
  expect(toolsSeen(requests[0]!)).not.toContain("ask_user");
  const result = results(session).get("a")!;
  expect(result.isError).toBe(true);
  expect(textOf(result)).toBe(NO_TERMINAL);
  expect(fake.custom).not.toHaveBeenCalled();
});

test("the TUI parent is offered ask_user; a subagent child is not, and a subagent call naming it is refused", async () => {
  const childTools: string[][] = [];
  const { session, requests } = await parentSession({
    mode: "tui",
    ui: dialogs().ui,
    userAgents: { "scout.md": agentFile("Finds things") },
    respond: router(
      [
        call({ prompt: "look", agent: "scout" }),
        call({ prompt: "ask", agent: "scout", tools: ["ask_user"] }),
      ],
      (context) => {
        childTools.push(toolsSeen(context));
        return fauxAssistantMessage("ok");
      },
    ),
  });
  await session.prompt("go");
  expect(toolsSeen(requests.find((r) => taskOf(r) === "go")!)).toContain(
    "ask_user",
  );
  expect(childTools).toHaveLength(1);
  expect(childTools[0]).not.toContain("ask_user");
  expect(textOf(results(session).get("ask")!)).toContain(
    "unknown tools ask_user",
  );
});

test("the model reads the user's answer: an option's label, their own words marked [own words], and a decline as a non-error result telling it to stop and wait", async () => {
  const fake = dialogs();
  const { session } = await parentSession({
    mode: "tui",
    ui: fake.ui,
    respond: steps(
      [askCall("pick")],
      [askCall("free", { ...NAME, options: undefined })],
      [askCall("decline")],
      [fauxToolCall("ask_user", TWO, { id: "two" })],
    ),
  });
  const run = session.prompt("go");
  press((await fake.nextOpen()).component, DOWN, ENTER);
  press((await fake.nextOpen()).component, "my own name", ENTER);
  press((await fake.nextOpen()).component, ESC);
  press((await fake.nextOpen()).component, ENTER, "skyr", ENTER, ENTER);
  await run;

  const byId = results(session);
  expect(textOf(byId.get("pick")!)).toBe(
    "The user answered.\n1. Which storage should the cache use? -> Postgres",
  );
  expect(textOf(byId.get("free")!)).toBe(
    "The user answered.\n1. What should it be called? -> [own words] my own name",
  );
  expect(textOf(byId.get("decline")!)).toBe(DECLINED);
  expect(byId.get("decline")!.isError).toBe(false);
  const two = byId.get("two")!;
  expect(textOf(two)).toBe(
    "The user answered.\n1. Which storage should the cache use? -> SQLite\n2. What should it be called? -> [own words] skyr",
  );
  expect(two.details).toEqual({
    outcome: "answered",
    answers: [
      { header: "Storage", answer: "SQLite" },
      { header: "Name", answer: "[own words] skyr" },
    ],
  });
});

test("an abort while the dialog is open closes it and fails the call; an already-aborted call opens nothing; no abort listener outlives the call", async () => {
  const fake = dialogs();
  const { session } = await parentSession({
    mode: "tui",
    ui: fake.ui,
    respond: steps([askCall("a")]),
  });
  const run = session.prompt("go");
  await fake.nextOpen();
  await session.abort();
  await run;
  const result = results(session).get("a")!;
  expect(result.isError).toBe(true);
  expect(textOf(result)).toBe(ABORTED);

  const tool = registered();
  const direct = dialogs();
  const aborted = new AbortController();
  aborted.abort();
  await expect(execute(tool, direct.ui, ask(), aborted.signal)).rejects.toThrow(
    ABORTED,
  );
  expect(direct.custom).not.toHaveBeenCalled();

  const live = new AbortController();
  const added = vi.spyOn(live.signal, "addEventListener");
  const removed = vi.spyOn(live.signal, "removeEventListener");
  const call = execute(tool, direct.ui, ask(), live.signal);
  await direct.nextOpen();
  live.abort();
  await expect(call).rejects.toThrow(ABORTED);
  expect(added.mock.calls.length).toBeGreaterThan(0);
  for (const [, listener] of added.mock.calls)
    expect(removed.mock.calls.map(([, l]) => l)).toContain(listener);
});

test("two ask_user calls in one message open one dialog at a time, while a sibling tool in the same message runs without waiting", async () => {
  const fake = dialogs();
  const siblingRan = deferred<void>();
  const sibling = defineTool({
    name: "sibling",
    label: "sibling",
    description: "Runs beside the questions.",
    parameters: Type.Object({}),
    async execute() {
      siblingRan.resolve();
      return { content: [{ type: "text", text: "sibling done" }], details: {} };
    },
  });
  const { session } = await parentSession({
    mode: "tui",
    ui: fake.ui,
    customTools: [sibling],
    respond: steps([
      askCall("first"),
      fauxToolCall("sibling", {}, { id: "s" }),
      askCall("second"),
    ]),
  });
  const run = session.prompt("go");
  const first = await fake.nextOpen();
  await siblingRan.promise;
  expect(fake.state.opened()).toBe(1);
  press(first.component, ENTER);
  press((await fake.nextOpen()).component, DOWN, ENTER);
  await run;

  expect(fake.state.maxMounted).toBe(1);
  const byId = results(session);
  expect(textOf(byId.get("first")!)).toContain("-> SQLite");
  expect(textOf(byId.get("second")!)).toContain("-> Postgres");
  expect(textOf(byId.get("s")!)).toBe("sibling done");
});

test("the queue never wedges or overlaps: a waiter aborted behind an open dialog settles at once without letting the next one open early, and a dialog that fails frees the queue with the failure text", async () => {
  const tool = registered();
  const fake = dialogs();
  const second = new AbortController();
  const one = execute(tool, fake.ui);
  const first = await fake.nextOpen();
  const two = execute(tool, fake.ui, ask(), second.signal);
  const three = execute(tool, fake.ui);
  second.abort();
  await expect(two).rejects.toThrow(ABORTED);
  expect(fake.state.opened()).toBe(1);
  first.done(undefined);
  await one;
  (await fake.nextOpen()).done(undefined);
  await three;
  expect(fake.state.maxMounted).toBe(1);

  fake.failNextOpen(new Error("boom"));
  await expect(execute(tool, fake.ui)).rejects.toThrow(
    new Error(failedWith("boom")),
  );
  const after = execute(tool, fake.ui);
  (await fake.nextOpen()).done(undefined);
  await after;

  const throwing = dialogs({
    theme: Object.assign(piTheme(), {
      style: () => {
        throw new Error("boom");
      },
    }),
  });
  const drawn = execute(tool, throwing.ui);
  (await throwing.nextOpen()).component.render(40);
  await expect(drawn).rejects.toThrow(new Error(failedWith("boom")));
  const next = execute(tool, throwing.ui);
  (await throwing.nextOpen()).done(undefined);
  await next;
});

test.each(["is answered", "fails to open"] as const)(
  "a draft holding a large paste comes back written out in full when the dialog %s, with words that land as the editor returns kept after it",
  async (close) => {
    const pasted = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const fake = dialogs({
      onRefocus: (editor) => editor.insertTextAtCursor(" hello"),
    });
    fake.editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    fake.editor.insertTextAtCursor("\nfix this");
    expect(fake.editor.getText()).toBe("[paste #1 +40 lines]\nfix this");

    if (close === "fails to open") fake.failNextOpen(new Error("boom"));
    const call = execute(registered(), fake.ui).catch(
      (error: unknown) => error,
    );
    if (close === "is answered")
      press((await fake.nextOpen()).component, ENTER);
    await call;
    expect(fake.editor.getText()).toBe(`${pasted}\nfix this hello`);
  },
);

const labelled = (...labels: string[]) =>
  ask({ options: labels.map((label) => ({ label })) });
const second = (question: Record<string, unknown>) => ({
  questions: [STORAGE, question],
});

test.each([
  [ask({ question: ` ${ZERO_WIDTH} ` }), /no question text/],
  [labelled("SQLite", BIDI), /no visible label/],
  [labelled("SQLite", "sqlite"), /"sqlite" twice/],
  [labelled("SQLite", "Other"), /labelled "Other"/],
  [ask({ header: ` ${ZERO_WIDTH}` }), /no visible header/],
  [
    second({ ...STORAGE, question: "which STORAGE should the cache use? " }),
    /both ask/,
  ],
  [second({ ...NAME, header: "Storage" }), /both show the header "Storage"/],
  [
    {
      questions: [
        { ...STORAGE, header: "Storage engine" },
        { ...NAME, header: "Storage engines" },
      ],
    },
    /both show the header "Storage eng…"/,
  ],
  [ask({ multiSelect: true, options: undefined }), /multiSelect but has no/],
  [
    ask({
      options: ["A", "B"].map((label) => ({ label, recommended: true })),
    }),
    /marks 2 options recommended/,
  ],
])("an undrawable question is refused: %#", async (params, message) => {
  const fake = dialogs();
  await expect(execute(registered(), fake.ui, params)).rejects.toThrow(message);
  expect(fake.custom).not.toHaveBeenCalled();
});

/** The row Pi draws for the tool, as plain lines without the blank one it leads with. */
const shownRow = (host: ReturnType<typeof toolRowHost>, width = 80) =>
  host
    .lines(width)
    .slice(1)
    .map((line) => stripTerminalSequences(line).trimEnd());

/** The row while the call's arguments stream in, so `args` may be partial. */
const callRows = (tool: AskTool, args: unknown, width?: number) =>
  shownRow(toolRowHost(tool, args), width);

/** The row once the result is in, as Pi draws it (and redraws it from a saved session). */
function resultRows(
  tool: AskTool,
  result: Awaited<ReturnType<AskTool["execute"]>>,
  o: { isError?: boolean; width?: number; args?: unknown } = {},
): string[] {
  const host = toolRowHost(tool, o.args ?? TWO);
  host.update({
    content: result.content,
    details: result.details,
    isError: o.isError ?? false,
    durationMs: 1200,
  });
  return shownRow(host, o.width);
}

test("escape sequences, bidi overrides and wide text from the model or the user never reach a rendered line, at any width; the dialog rings the bell once on open", async () => {
  const tool = registered();
  const fake = dialogs();
  const params = ask({
    question: `${HOSTILE}?`,
    header: HOSTILE,
    options: [{ label: `a${HOSTILE}`, description: HOSTILE }, { label: "b" }],
  });
  const call = execute(tool, fake.ui, params);
  const opened = await fake.nextOpen();
  const dialogLines = opened.component.render(40);
  press(opened.component, ENTER);
  const result = await call;

  expectInert(dialogLines, 40);
  expect(opened.write.mock.calls).toEqual([["\x07"]]);
  const callRow = callRows(tool, params, 20);
  const resultRow = resultRows(tool, result, { width: 20, args: params });
  expect([callRow.length, resultRow.length]).toEqual([1, 1]);
  expectInert([...callRow, ...resultRow], 20);

  // what the user pastes into Other is drawn again on the Submit tab
  const two = execute(tool, fake.ui, TWO);
  const review = await fake.nextOpen();
  press(
    review.component,
    DOWN,
    DOWN,
    `\x1b[200~${HOSTILE}\x1b[201~`,
    ENTER,
    "skyr",
    ENTER,
  );
  const submitTab = review.component.render(40);
  expect(submitTab.join("\n")).toContain("evil");
  expectInert(submitTab, 40);
  press(review.component, ENTER);
  await two;
});

test("the call row survives arguments that are still streaming in", () => {
  const tool = registered();
  for (const args of [
    {},
    { questions: "Sto" },
    { questions: [null, {}, { header: 3 }] },
  ])
    expect(callRows(tool, args)).toEqual([" • ask"]);
  expect(callRows(tool, { questions: [{ header: "Storage" }, {}] })).toEqual([
    expect.stringMatching(/^ • ask +Storage$/),
  ]);
});

test("a header cut for the transcript ends in the terminal's ellipsis, and the twin-header refusal names it with … whatever the terminal", async () => {
  const tool = registered();
  const long = { questions: [{ header: "Storage engine" }] };
  vi.stubEnv("TERM", "xterm-256color");
  expect(callRows(tool, long)).toEqual([
    expect.stringMatching(/^ • ask +Storage eng…$/),
  ]);
  vi.stubEnv("TERM", "dumb");
  expect(callRows(tool, long)).toEqual([
    expect.stringMatching(/^ \* ask +Storage e\.\.\.$/),
  ]);
  const twins = {
    questions: [
      { ...STORAGE, header: "Storage engine" },
      { ...NAME, header: "Storage engines" },
    ],
  };
  await expect(execute(tool, dialogs().ui, twins)).rejects.toThrow(
    /both show the header "Storage eng…"/,
  );
  vi.unstubAllEnvs();
});

test("a question left unanswered reaches the model as not answered, with a line against guessing it, and its row says so after a resume", async () => {
  const fake = dialogs();
  const call = execute(registered(), fake.ui, TWO);
  press((await fake.nextOpen()).component, "\t", "skyr", ENTER, ENTER);
  const result = await call;

  expect(result.content).toEqual([
    {
      type: "text",
      text: `The user answered.\n1. Which storage should the cache use? -> (not answered)\n2. What should it be called? -> [own words] skyr\n${UNANSWERED}`,
    },
  ]);
  expect(result.details).toEqual({
    outcome: "answered",
    answers: [
      { header: "Storage", answer: "" },
      { header: "Name", answer: "[own words] skyr" },
    ],
  });
  expect(
    resultRows(registered(), { content: [], details: result.details }),
  ).toEqual([
    expect.stringMatching(
      /^ ! ask +Storage → not answered · Name → \[own words\] skyr +1 of 2 answered$/,
    ),
  ]);
});

test("answers read as one receipt with each header cut to 12 columns, and a finished row is one line", async () => {
  const tool = registered();
  const details = {
    outcome: "answered",
    answers: [
      { header: "Colour", answer: "green" },
      { header: "A header far too long", answer: "salt; pepper" },
    ],
  };
  const rows = resultRows(tool, { content: [], details } as never, {
    width: 120,
  });
  expect(rows).toEqual([
    expect.stringMatching(
      /^ ✓ ask +Colour → green · A header fa… → salt; pepper +2 answered · 1\.2s$/,
    ),
  ]);
});

test("the count and the time drop before the receipt is cut, as the pane narrows", () => {
  const tool = registered();
  const details = {
    outcome: "answered",
    answers: [
      { header: "Colour", answer: "green" },
      { header: "Extras", answer: "salt; pepper" },
    ],
  };
  const at = (width: number) =>
    resultRows(tool, { content: [], details } as never, { width })[0] ?? "";
  expect(at(100)).toContain("2 answered");
  expect(at(56)).not.toContain("2 answered");
  expect(at(56)).toContain("Colour → green · Extras → salt; pepper");
  expect(at(30)).toContain("…");
});

test("declined is a stopped record, not a failure", () => {
  const rows = resultRows(
    registered(),
    { content: [], details: { outcome: "declined" } } as never,
    { width: 120 },
  );
  expect(rows).toEqual([
    expect.stringMatching(
      /^ ■ ask +Storage · Name +declined · the model was told to stop and wait · 1\.2s$/,
    ),
  ]);
});

test("a thrown call draws the failure with its reason and the rest on a rail; a successful result with no details or another shape draws a plain record and never throws", () => {
  const tool = registered();
  const failed = resultRows(
    tool,
    {
      content: [{ type: "text", text: `${NO_TERMINAL}\nsecond line` }],
      details: { outcome: "declined" },
    },
    { isError: true, width: 400 },
  );
  expect(failed[0]).toMatch(/^ × ask +Storage · Name +this run has no/);
  expect(failed[0]).toMatch(/and continue\. · 1\.2s$/);
  expect(failed.slice(1)).toEqual(["   │ second line"]);
  for (const details of [
    undefined,
    "answered",
    { outcome: "answered" },
    { outcome: "answered", answers: "x" },
    { outcome: "answered", answers: [] },
    { outcome: "answered", answers: [{ header: 1, answer: "x" }] },
    { outcome: "answered", answers: [{ header: "h", answer: 2 }] },
    { outcome: "shrugged", answers: [{ header: "h", answer: "x" }] },
  ])
    expect(
      resultRows(tool, {
        content: [{ type: "text", text: "The user answered.\n1. a -> b" }],
        details,
      }),
    ).toEqual([
      expect.stringMatching(
        /^ ✓ ask +Storage · Name +The user answered\. · 1\.2s$/,
      ),
    ]);
});

/** A tool on a bus whose host answers capability queries with `reply`, after a session_start in `mode`. */
const onHost =
  (reply?: Parameters<typeof capabilityHost>[1], mode: "rpc" | null = "rpc") =>
  () => {
    const bus = createEventBus();
    capabilityHost(bus, reply);
    return registered(mode, bus);
  };
const lacking = (caps: object, id?: unknown) => (asked: unknown) => ({
  id: id ?? asked,
  v: 1,
  forms: true,
  formRequests: true,
  ...caps,
});

/** An extension API whose bus fails the way a stale one does. */
const stale: ExtensionAPI["events"] = {
  on: () => {
    throw new Error("Extension API is no longer active");
  },
  emit: () => {
    throw new Error("Extension API is no longer active");
  },
};

test.each([
  ["forms false", onHost(lacking({ forms: false }))],
  ["formRequests absent", onHost(lacking({ formRequests: undefined }))],
  ["another query's id", onHost(lacking({}, "other"))],
  ["a v2 reply", onHost(lacking({ v: 2 }))],
  ["forms as a string", onHost(lacking({ forms: "true" }))],
  [
    "a reply that lands after a microtask, too late",
    () => {
      const bus = createEventBus();
      bus.on("tengi:capabilities?", (q) =>
        queueMicrotask(() =>
          bus.emit("tengi:capabilities", lacking({})((q as { id: string }).id)),
        ),
      );
      return registered("rpc", bus);
    },
  ],
  ["a stale extension API", () => registered("rpc", stale)],
  ["a capable host but no session_start yet", onHost(undefined, null)],
])(
  "outside the TUI ask_user is hidden when the bus gives %s",
  async (_name, build) => {
    const tool = build();
    expect(hidden(tool)).toBe(true);
    await expect(execute(tool, dialogs().ui)).rejects.toThrow(NO_TERMINAL);
  },
);

test("a capability query leaves no listener on the bus; in the TUI none is made", () => {
  const bus = createEventBus();
  const host = capabilityHost(bus);
  let live = 0;
  const counted: ExtensionAPI["events"] = {
    on: (channel, handler) => {
      live++;
      const off = bus.on(channel, handler);
      return () => {
        live--;
        off();
      };
    },
    emit: (channel, data) => bus.emit(channel, data),
  };
  expect(hidden(registered("tui", counted))).toBe(false);
  expect(host.queries).toBe(0);
  expect(hidden(registered("rpc", counted))).toBe(false);
  expect(host.queries).toBe(1);
  expect(live).toBe(0);
});

interface FormPayload {
  id: string;
  toolCallId: string;
  message: string;
  requestedSchema: object;
  signal: AbortSignal;
  ack(): void;
  respond(reply: unknown): void;
}

/** A host that acks each form request inside the emit and replies with `answer`'s value, if any. */
function formHost(
  bus: EventBus,
  answer: (form: FormPayload) => unknown = () => undefined,
): { forms: FormPayload[]; nextForm: () => Promise<FormPayload> } {
  capabilityHost(bus);
  const forms: FormPayload[] = [];
  const arrived = arrivals<FormPayload>();
  bus.on("tengi:form?", (p) => {
    const form = p as FormPayload;
    form.ack();
    forms.push(form);
    arrived.arrive(form);
    const reply = answer(form);
    if (reply !== undefined) form.respond(reply);
  });
  /** The next form request, in order of arrival. */
  return { forms, nextForm: arrived.next };
}

/** ask_user on an rpc host serving forms; `run` calls it with a dialog UI nobody uses. */
function rpc(answer?: Parameters<typeof formHost>[1]) {
  const bus = createEventBus();
  const host = formHost(bus, answer);
  const tool = registered("rpc", bus);
  return {
    ...host,
    tool,
    run: (params: unknown = ask(), signal?: AbortSignal) =>
      execute(tool, dialogs().ui, params, signal),
  };
}

const accept = (content: unknown) => ({ action: "accept", content });
const said = (result: Awaited<ReturnType<AskTool["execute"]>>) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/ask-user-form.json", import.meta.url),
    "utf8",
  ),
) as { questions: unknown[]; message: string; requestedSchema: object };
const REFUSED =
  /^ask_user: the client's answer was refused \(.*\); ask the question in your reply instead$/;

test("four questions of every kind become the one form the fixture states, which tengi copies", async () => {
  const host = rpc(() => ({ action: "decline" }));
  const result = await host.run({ questions: FIXTURE.questions });
  expect(said(result)).toBe(DECLINED);
  expect(host.forms[0]?.message).toBe(FIXTURE.message);
  expect(host.forms[0]?.requestedSchema).toEqual(FIXTURE.requestedSchema);
});

test("escape sequences and invisible characters in the model's strings never reach the form", async () => {
  const host = rpc(() => ({ action: "decline" }));
  await host.run(
    ask({
      question: "Which\x1b[31m storage\u200b?",
      header: "Sto\x1b]8;;http://x\x07rage",
      options: [
        { label: "SQ\x1b[0mLite", description: "one\u202e file" },
        { label: "Postgres" },
      ],
    }),
  );
  expect(host.forms[0]?.requestedSchema).toMatchObject({
    properties: {
      question_0: {
        title: "Storage",
        description: "Which storage?",
        oneOf: expect.arrayContaining([
          { const: "0", title: "SQLite", description: "one file" },
        ]),
      },
    },
  });
});

test("the request carries the call's id, a fresh request id and the call's signal", async () => {
  const host = rpc(() => ({ action: "decline" }));
  const controller = new AbortController();
  await host.run(ask(), controller.signal);
  await host.run();
  const [first, second] = host.forms;
  expect(first).toMatchObject({ toolCallId: "call" });
  expect(first?.signal).toBe(controller.signal);
  expect(first?.id).not.toBe(second?.id);
});

const MULTI = ask({ multiSelect: true });
const FREE = { questions: [NAME] };

test.each([
  ["a pick is its label", ask(), { question_0: "1" }, "-> Postgres"],
  [
    "picks in option order, own words after",
    MULTI,
    { question_0: ["1", "0"], question_0_custom: "  and\n  more " },
    "-> SQLite; Postgres; [own words] and more",
  ],
  [
    "own words alone, on one line",
    ask(),
    { question_0_custom: " mine\there " },
    "-> [own words] mine here",
  ],
  [
    "a pick and own words: the own words win",
    ask(),
    { question_0: "0", question_0_custom: "neither" },
    "-> [own words] neither",
  ],
  ["a free-text answer", FREE, { question_0: "  a  b " }, "-> [own words] a b"],
  [
    "properties never asked for are ignored",
    ask(),
    { question_0: "0", question_7: "x", bogus: 1 },
    "-> SQLite",
  ],
])("%s", async (_name, params, content, expected) => {
  const result = await rpc(() => accept(content)).run(params);
  expect(said(result)).toContain(expected);
  expect(said(result)).not.toContain(UNANSWERED);
});

test("a question the form left out reaches the model as not answered, with the open-questions line", async () => {
  const result = await rpc(() => accept({ question_1: "0" })).run({
    questions: [
      STORAGE,
      { ...STORAGE, question: "And the backup?", header: "Backup" },
    ],
  });
  const text = said(result);
  expect(text).toContain("-> (not answered)");
  expect(text).toContain("And the backup? -> SQLite");
  expect(text).toContain(UNANSWERED);
  expect(result.details).toEqual({
    outcome: "answered",
    answers: [
      { header: "Storage", answer: "" },
      { header: "Backup", answer: "SQLite" },
    ],
  });
});

test.each([
  ["every question omitted", {}],
  ["only blank own words", { question_0_custom: "   " }],
  ["content that is not an object", "yes"],
  ["no content at all", undefined],
  ["an empty pick for an untouched field", { question_0: "" }],
])("an accepted form with %s is a decline", async (_name, content) => {
  const result = await rpc(() => accept(content)).run();
  expect(said(result)).toBe(DECLINED);
  expect(result.details).toEqual({ outcome: "declined" });
});

test.each([
  ["a pick that is not a string", ask(), { question_0: ["SENTINEL"] }],
  ["an index that is not canonical", ask(), { question_0: "01" }],
  ["an index past the last option", ask(), { question_0: "7" }],
  ["a multi pick that is not a list", MULTI, { question_0: "SENTINEL" }],
  ["the same pick twice", MULTI, { question_0: ["0", "0"] }],
  ["own words that are not text", ask(), { question_0_custom: ["SENTINEL"] }],
  ["a free-text answer that is not text", FREE, { question_0: ["SENTINEL"] }],
])("refuses %s without echoing it", async (_name, params, content) => {
  const call = rpc(() => accept(content)).run(params);
  await expect(call).rejects.toThrow(REFUSED);
  await expect(call).rejects.not.toThrow(/SENTINEL/);
});

test.each([
  ["a decline", { action: "decline" }, DECLINED, false],
  [
    "a cancel while the host is cancelling the turn",
    { action: "cancel", cancelling: true },
    ABORTED,
    true,
  ],
  ["a dismissed form", { action: "cancel" }, CLOSED, true],
  ["an action the contract does not know", { action: "later" }, CLOSED, true],
  [
    "a host's refusal, with its reason on one line",
    { action: "cancel", error: "no\nlive session" },
    failedWith("no live session"),
    true,
  ],
])("%s reaches the model as text", async (_name, reply, text, isError) => {
  const call = rpc(() => reply).run();
  if (isError) await expect(call).rejects.toThrow(text);
  else expect(said(await call)).toBe(text);
});

test.each([
  [
    "a host that advertises form requests but takes none",
    (bus: EventBus) => bus,
    "no host took the form",
  ],
  [
    "a bus that refuses the request",
    (bus: EventBus): ExtensionAPI["events"] => ({
      on: (channel, handler) => bus.on(channel, handler),
      emit: (channel, data) => {
        if (channel === "tengi:form?") return stale.emit(channel, data);
        bus.emit(channel, data);
      },
    }),
    "the bus refused it: Extension API is no longer active",
  ],
])("%s fails the call", async (_name, wrap, why) => {
  const bus = createEventBus();
  capabilityHost(bus);
  await expect(
    execute(registered("rpc", wrap(bus)), dialogs().ui),
  ).rejects.toThrow(failedWith(why));
});

test("a cancel the host answers from the signal's own abort listener is the abort, not a closed form", async () => {
  const host = rpc((form) => {
    form.signal.addEventListener(
      "abort",
      () => form.respond({ action: "cancel" }),
      { once: true },
    );
  });
  const controller = new AbortController();
  const call = host.run(ask(), controller.signal);
  controller.abort();
  await expect(call).rejects.toThrow(ABORTED);
});

test("an abort while the form is open fails the call at once, aborts the form's signal, and a reply after it changes nothing", async () => {
  const host = rpc();
  const controller = new AbortController();
  const call = host.run(ask(), controller.signal);
  const form = await host.nextForm();
  controller.abort();
  await expect(call).rejects.toThrow(ABORTED);
  expect(form.signal.aborted).toBe(true);
  form.respond(accept({ question_0: "0" }));
  await expect(call).rejects.toThrow(ABORTED);
});

test("an answer given before a late abort is kept, and a second reply is ignored", async () => {
  const host = rpc();
  const controller = new AbortController();
  const call = host.run(ask(), controller.signal);
  const form = await host.nextForm();
  form.respond(accept({ question_0: "1" }));
  form.respond({ action: "decline" });
  controller.abort();
  expect(said(await call)).toContain("-> Postgres");
});

test("two calls open one form at a time, in the order they arrived", async () => {
  const host = rpc();
  const first = host.run();
  const second = host.run(ask({ header: "Second" }));
  const one = await host.nextForm();
  // the second emit can only follow the first call's release, so one form is all there is
  expect(host.forms).toHaveLength(1);
  one.respond(accept({ question_0: "0" }));
  expect(said(await first)).toContain("-> SQLite");
  const two = await host.nextForm();
  expect(two.requestedSchema).toMatchObject({
    properties: { question_0: { title: "Second" } },
  });
  two.respond({ action: "decline" });
  expect(said(await second)).toBe(DECLINED);
});

test("in rpc, the model's ask_user call reaches the host as one form, and the answer comes back as the terminal's would; a reload changes nothing", async () => {
  const bus = createEventBus();
  const { forms } = formHost(bus, () => accept({ question_0: "1" }));
  const { session, requests } = await parentSession({
    mode: "rpc",
    eventBus: bus,
    // one ask per prompt: "a" on the first, "b" on the second, then done
    respond: (context) => {
      if (context.messages.at(-1)?.role === "toolResult")
        return fauxAssistantMessage("done");
      const prompts = context.messages.filter((m) => m.role === "user").length;
      return fauxAssistantMessage([askCall(prompts === 1 ? "a" : "b")]);
    },
  });
  await session.prompt("go");
  expect(toolsSeen(requests[0]!)).toContain("ask_user");
  expect(forms).toHaveLength(1);
  expect(forms[0]?.toolCallId).toBe("a");
  expect(textOf(results(session).get("a")!)).toContain("-> Postgres");

  await session.reload();
  await session.prompt("again");
  expect(toolsSeen(requests.at(-1)!)).toContain("ask_user");
  expect(forms).toHaveLength(2);
  expect(textOf(results(session).get("b")!)).toContain("-> Postgres");
});

/** The terminal tier the next dialog opens in; the stubs are undone when the test ends. */
function inTier(tier: "color" | "mono" | "ascii") {
  vi.stubEnv("TERM", tier === "ascii" ? "dumb" : "xterm-256color");
  vi.stubEnv("NO_COLOR", tier === "mono" ? "1" : "");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
}

/** The first row of the dialog `tool` opens at `width`: its top rule. */
async function topRule(
  tool: AskTool,
  fake: ReturnType<typeof dialogs>,
  width = 40,
) {
  const call = execute(tool, fake.ui);
  const opened = await fake.nextOpen();
  const rule = opened.component.render(width)[0] ?? "";
  opened.done(undefined);
  await call;
  return rule;
}

test("the rules are drawn in the thinking colour of the session's level when the dialog opens", async () => {
  inTier("color");
  let level: ReturnType<ExtensionAPI["getThinkingLevel"]> = "high";
  const tool = registered("tui", createEventBus(), () => level);
  const fake = dialogs();
  const colourOf = async () => styledRuns(await topRule(tool, fake))[0]?.fg;
  const expected = (name: string) =>
    styledRuns(piTheme().getThinkingBorderColor(name as never)("-"))[0]?.fg;

  expect(await colourOf()).toEqual(expected("high"));
  level = "low";
  expect(await colourOf()).toEqual(expected("low"));
  expect(expected("low")).not.toEqual(expected("high"));
});

test("a mono or ascii terminal gets plain rules", async () => {
  const tool = registered();
  const fake = dialogs();
  inTier("mono");
  const mono = await topRule(tool, fake);
  expect(stripTerminalSequences(mono)).toBe("─".repeat(40));
  expect(styledRuns(mono)[0]?.fg).toBeUndefined();
  inTier("ascii");
  expect(await topRule(tool, fake)).toBe("-".repeat(40));
});

test("the form path never reads the thinking level or the theme", async () => {
  const bus = createEventBus();
  formHost(bus, () => accept({ question_0: "1" }));
  const tool = registered("rpc", bus, () => {
    throw new Error("the form path asked for the thinking level");
  });
  const fake = dialogs();
  expect(said(await execute(tool, fake.ui))).toContain("-> Postgres");
  expect(fake.custom).not.toHaveBeenCalled();
});

test("a thinking level that cannot be read fails the call with the dialog's failure text", async () => {
  const tool = registered("tui", createEventBus(), () => {
    throw new Error("not initialized");
  });
  await expect(execute(tool, dialogs().ui)).rejects.toThrow(
    new Error(failedWith("not initialized")),
  );
});
