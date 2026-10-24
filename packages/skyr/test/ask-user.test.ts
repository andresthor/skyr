/**
 * ask_user through what it registers: a real Pi session where the mode and the turn matter, a
 * direct `execute` where the queue and the signal do. Pi's interactive mode cannot be built in a
 * test, so `dialogs()` stands in for its `custom()`: it mounts the component the factory returns
 * and, on close, writes back the text Pi's restore would.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import { registerAskUser } from "../src/ask-user/index.js";
import { loadAgents } from "../src/subagent/agents.js";
import { registerChildTools } from "../src/subagent/child/tools.js";
import {
  agentFile,
  call,
  parentSession,
  results,
  router,
  scratchDir,
  taskOf,
  textOf,
  toolsSeen,
} from "./session.js";
import { keybindings } from "./voice.js";

const plain = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

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
const BIDI = String.fromCodePoint(0x202e);
const ZERO_WIDTH = String.fromCodePoint(0x200b);
const FAILED =
  "ask_user: the dialog failed (boom); ask the question in your reply instead";

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
  const opens: ReturnType<typeof deferred<Opened>>[] = [];
  const slot = (i: number) => {
    opens[i] ??= deferred<Opened>();
    return opens[i];
  };
  let opened = 0;
  let waited = 0;
  let mountedNow = 0;
  let failNext: Error | undefined;
  const state = { maxMounted: 0, opened: () => opened };

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
        const component = factory(tui, o.theme ?? plain, keybindings(), done);
        if ("focused" in component) component.focused = true;
        mountedNow++;
        state.maxMounted = Math.max(state.maxMounted, mountedNow);
        slot(opened++).resolve({ component, done, write });
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
    nextOpen: () => slot(waited++).promise,
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
  mode: "tui" | "print" | "rpc" = "tui",
  events: ExtensionAPI["events"] = createEventBus(),
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
  } as unknown as ExtensionAPI);
  handlers.get("session_start")?.({ type: "session_start" }, { mode });
  if (!tool) throw new Error("registerAskUser registered no tool");
  return tool;
}

/**
 * A host on the bus, answering capability queries as tengi does: synchronously, inside the asking
 * emit. `reply` builds the answer from the query's id, so a test can lie about it.
 */
function capabilityHost(
  bus: EventBus,
  reply: (id: unknown) => unknown = (id) => ({
    id,
    v: 1,
    forms: true,
    notices: true,
    agentui: null,
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

test("the TUI parent is offered ask_user and a subagent child is not", async () => {
  const fake = dialogs();
  const childTools: string[][] = [];
  const { session, requests } = await parentSession({
    mode: "tui",
    ui: fake.ui,
    userAgents: { "scout.md": agentFile("Finds things") },
    respond: router([call({ task: "look", agent: "scout" })], (context) => {
      childTools.push(toolsSeen(context));
      return fauxAssistantMessage("ok");
    }),
  });
  await session.prompt("go");
  expect(toolsSeen(requests.find((r) => taskOf(r) === "go")!)).toContain(
    "ask_user",
  );
  expect(childTools).toHaveLength(1);
  expect(childTools[0]).not.toContain("ask_user");

  const names: string[] = [];
  registerChildTools({
    registerTool: (t: { name: string }) => names.push(t.name),
    on: () => {},
  } as unknown as ExtensionAPI);
  expect(names.length).toBeGreaterThan(0);
  expect(names).not.toContain("ask_user");
});

test("an agent file or a subagent call that names ask_user is refused", async () => {
  const user = scratchDir("agents");
  mkdirSync(user, { recursive: true });
  writeFileSync(
    join(user, "asker.md"),
    agentFile("Asks things", "tools: ask_user\n"),
  );
  const { errors } = await loadAgents({ user });
  expect(errors.join("\n")).toContain("unknown tools ask_user");

  const { session } = await parentSession({
    mode: "tui",
    ui: dialogs().ui,
    userAgents: { "scout.md": agentFile("Finds things") },
    respond: router(
      [call({ task: "look", agent: "scout", tools: ["ask_user"] })],
      () => fauxAssistantMessage("ok"),
    ),
  });
  await session.prompt("go");
  expect(textOf(results(session).get("look")!)).toContain(
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
      [
        askCall("free", {
          question: "What should it be called?",
          options: undefined,
        }),
      ],
      [askCall("decline")],
      [
        askCall("multi", {
          question: "Which features should ship?",
          multiSelect: true,
          options: [{ label: "Auth" }, { label: "Billing" }],
        }),
      ],
      [
        fauxToolCall(
          "ask_user",
          {
            questions: [
              STORAGE,
              { question: "What should it be called?", header: "Name" },
            ],
          },
          { id: "two" },
        ),
      ],
    ),
  });
  const run = session.prompt("go");
  press((await fake.nextOpen()).component, DOWN, ENTER);
  press((await fake.nextOpen()).component, "my own name", ENTER);
  press((await fake.nextOpen()).component, ESC);
  press((await fake.nextOpen()).component, " ", DOWN, DOWN, "SSO", ENTER);
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
  expect(textOf(byId.get("multi")!)).toBe(
    "The user answered.\n1. Which features should ship? -> Auth; [own words] SSO",
  );
  expect(textOf(byId.get("two")!)).toBe(
    "The user answered.\n1. Which storage should the cache use? -> SQLite\n2. What should it be called? -> [own words] skyr",
  );
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
  const third = await fake.nextOpen();
  third.done(undefined);
  await three;
  expect(fake.state.maxMounted).toBe(1);

  fake.failNextOpen(new Error("boom"));
  await expect(execute(tool, fake.ui)).rejects.toThrow(new Error(FAILED));
  const after = execute(tool, fake.ui);
  (await fake.nextOpen()).done(undefined);
  await after;

  const throwing = dialogs({
    theme: {
      fg: () => {
        throw new Error("boom");
      },
    } as unknown as Theme,
  });
  const drawn = execute(tool, throwing.ui);
  (await throwing.nextOpen()).component.render(40);
  await expect(drawn).rejects.toThrow(new Error(FAILED));
  const next = execute(tool, throwing.ui);
  (await throwing.nextOpen()).done(undefined);
  await next;
});

test.each([
  "is answered",
  "is declined",
  "fails to open",
  "is aborted",
] as const)(
  "a draft holding a large paste comes back written out in full when the dialog %s, with words that land as the editor returns kept after it",
  async (close) => {
    const pasted = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const fake = dialogs({
      onRefocus: (editor) => editor.insertTextAtCursor(" hello"),
    });
    fake.editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    fake.editor.insertTextAtCursor("\nfix this");
    expect(fake.editor.getText()).toBe("[paste #1 +40 lines]\nfix this");

    const tool = registered();
    const signal = new AbortController();
    if (close === "fails to open") fake.failNextOpen(new Error("boom"));
    const call = execute(tool, fake.ui, ask(), signal.signal).catch(
      (error: unknown) => error,
    );
    if (close !== "fails to open") {
      const { component } = await fake.nextOpen();
      if (close === "is answered") press(component, ENTER);
      else if (close === "is declined") press(component, ESC);
      else signal.abort();
    }
    await call;
    expect(fake.editor.getText()).toBe(`${pasted}\nfix this hello`);
  },
);

test("a draft with no paste comes back as it was", async () => {
  const fake = dialogs();
  fake.editor.insertTextAtCursor("fix this");
  const call = execute(registered(), fake.ui);
  press((await fake.nextOpen()).component, ENTER);
  await call;
  expect(fake.editor.getText()).toBe("fix this");
});

test.each([
  [
    ask({ question: ` ${ZERO_WIDTH} ` }),
    "ask_user: question 1 has no question text; write the full question, ending in ?",
  ],
  [
    ask({ options: [{ label: "SQLite" }, { label: BIDI }] }),
    'ask_user: question 1 ("Which storage should the cache use?") has an option with no visible label; give every option a label',
  ],
  [
    ask({ options: [{ label: "SQLite" }, { label: "sqlite" }] }),
    'ask_user: question 1 ("Which storage should the cache use?") lists "sqlite" twice; labels within a question must differ',
  ],
  [
    ask({ options: [{ label: "SQLite" }, { label: "Other" }] }),
    'ask_user: question 1 ("Which storage should the cache use?") has an option labelled "Other"; the dialog adds that row itself, so drop it',
  ],
  [
    ask({ header: ` ${ZERO_WIDTH}` }),
    'ask_user: question 1 ("Which storage should the cache use?") has no visible header; give a short label of up to 12 columns',
  ],
  [
    {
      questions: [
        STORAGE,
        {
          ...STORAGE,
          question: "which STORAGE should the cache use? ",
        },
      ],
    },
    'ask_user: questions 1 and 2 both ask "which STORAGE should the cache use? "; each question must differ',
  ],
  [
    {
      questions: [
        STORAGE,
        { question: "Where should the cache live?", header: "Storage" },
      ],
    },
    'ask_user: questions 1 and 2 both show the header "Storage"; give each question its own header of up to 12 columns',
  ],
  [
    {
      questions: [
        STORAGE,
        { question: "Where should the cache live?", header: "Storage " },
      ],
    },
    'ask_user: questions 1 and 2 both show the header "Storage"; give each question its own header of up to 12 columns',
  ],
  [
    {
      questions: [
        { ...STORAGE, header: "Storage engine" },
        {
          question: "Where should the cache live?",
          header: "Storage engines",
        },
      ],
    },
    'ask_user: questions 1 and 2 both show the header "Storage eng…"; give each question its own header of up to 12 columns',
  ],
  [
    ask({ multiSelect: true, options: undefined }),
    'ask_user: question 1 ("Which storage should the cache use?") is multiSelect but has no options; give 2-4 options or drop multiSelect',
  ],
  [
    ask({
      options: [
        { label: "SQLite", recommended: true },
        { label: "Postgres", recommended: true },
      ],
    }),
    'ask_user: question 1 ("Which storage should the cache use?") marks 2 options recommended; mark at most one, or set multiSelect',
  ],
])(
  "a question the dialog could not draw is refused before any dialog opens, naming the question: %#",
  async (params, message) => {
    const fake = dialogs();
    await expect(execute(registered(), fake.ui, params)).rejects.toThrow(
      new Error(message),
    );
    expect(fake.custom).not.toHaveBeenCalled();
  },
);

test("escape sequences and bidi overrides in model text never reach a rendered line", async () => {
  const hostile = `\u001b]52;c;aGk=\u0007evil${BIDI}`;
  const params = {
    questions: [
      {
        question: `${hostile}?`,
        header: hostile,
        options: [
          { label: `a${hostile}`, description: hostile },
          { label: "b" },
        ],
      },
    ],
  };
  const tool = registered();
  const fake = dialogs();
  const call = execute(tool, fake.ui, params);
  const opened = await fake.nextOpen();
  const dialogLines = opened.component.render(40);
  press(opened.component, ENTER);
  const result = await call;
  const callRow =
    tool
      .renderCall?.(
        params as never,
        plain,
        {} as Parameters<NonNullable<ToolDefinition["renderCall"]>>[2],
      )
      .render(20) ?? [];
  const resultRows =
    tool
      .renderResult?.(result, { expanded: false, isPartial: false }, plain, {
        isError: false,
        state: {},
      } as Parameters<NonNullable<ToolDefinition["renderResult"]>>[3])
      .render(20) ?? [];
  expect(callRow).toHaveLength(1);
  expect(resultRows).toHaveLength(1);
  const lines = [...dialogLines, ...callRow, ...resultRows];
  expect(result.content[0]).toMatchObject({
    text: expect.stringContaining(hostile),
  });
  for (const line of lines) {
    expect(line).not.toContain("\u001b]");
    expect(line).not.toContain(BIDI);
  }

  // what the user pastes into Other is drawn again on the Submit tab
  const two = execute(tool, fake.ui, {
    questions: [
      STORAGE,
      { question: "What should it be called?", header: "Name" },
    ],
  });
  const review = await fake.nextOpen();
  press(
    review.component,
    DOWN,
    DOWN,
    `\x1b[200~${hostile}\x1b[201~`,
    ENTER,
    "skyr",
    ENTER,
  );
  const submitTab = review.component.render(40);
  expect(submitTab.join("\n")).toContain("evil");
  for (const line of submitTab) {
    expect(line).not.toContain("\u001b]");
    expect(line).not.toContain(BIDI);
  }
  press(review.component, ENTER);
  await two;
});

type ResultContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

/** The result row as drawn, with the padding to the width cut off. */
function resultRows(
  tool: AskTool,
  result: { content: { type: "text"; text: string }[]; details: unknown },
  o: { isError?: boolean; width?: number } = {},
): string[] {
  const context = {
    isError: o.isError ?? false,
    state: {},
    durationMs: 1200,
  } as unknown as ResultContext;
  return (
    tool
      .renderResult?.(
        result as never,
        { expanded: false, isPartial: false },
        plain,
        context,
      )
      .render(o.width ?? 80)
      .map((row) => row.trimEnd()) ?? []
  );
}

test("a persisted answered result draws its rows from details alone, as after a resume, with every answer starting at the same column", async () => {
  const fake = dialogs();
  const { session } = await parentSession({
    mode: "tui",
    ui: fake.ui,
    respond: steps([
      fauxToolCall(
        "ask_user",
        {
          questions: [
            STORAGE,
            { question: "What should it be called?", header: "Name" },
          ],
        },
        { id: "two" },
      ),
    ]),
  });
  const run = session.prompt("go");
  press((await fake.nextOpen()).component, ENTER, "skyr", ENTER, ENTER);
  await run;

  const persisted = results(session).get("two")!;
  expect(persisted.details).toEqual({
    outcome: "answered",
    answers: [
      { header: "Storage", answer: "SQLite" },
      { header: "Name", answer: "[own words] skyr" },
    ],
  });
  const rows = resultRows(registered(), {
    content: [],
    details: persisted.details,
  }).map((r) => stripTerminalSequences(r));
  expect(rows).toEqual(["Storage  SQLite · 1.2s", "Name     [own words] skyr"]);
  const column = (row: string, answer: string) =>
    visibleWidth(row.slice(0, row.indexOf(answer)));
  expect(column(rows[0]!, "SQLite")).toBe(column(rows[1]!, "[own words]"));
});

test("a question left unanswered reaches the model as not answered, with a line against guessing it, and its row says so after a resume", async () => {
  const fake = dialogs();
  const call = execute(registered(), fake.ui, {
    questions: [
      STORAGE,
      { question: "What should it be called?", header: "Name" },
    ],
  });
  press((await fake.nextOpen()).component, "\t", "skyr", ENTER, ENTER);
  const result = await call;

  expect(result.content).toEqual([
    {
      type: "text",
      text: "The user answered.\n1. Which storage should the cache use? -> (not answered)\n2. What should it be called? -> [own words] skyr\nThe user left every question marked (not answered) open. Do not assume answers for them or ask them again; go on with what was answered and say in your reply what stays open.",
    },
  ]);
  expect(result.details).toEqual({
    outcome: "answered",
    answers: [
      { header: "Storage", answer: "" },
      { header: "Name", answer: "[own words] skyr" },
    ],
  });
  const rows = resultRows(registered(), {
    content: [],
    details: result.details,
  }).map((r) => stripTerminalSequences(r));
  expect(rows).toEqual([
    "Storage  not answered · 1.2s",
    "Name     [own words] skyr",
  ]);
});

test("a thrown call draws the red error row with its first line", () => {
  const rows = resultRows(
    registered(),
    {
      content: [{ type: "text", text: `${NO_TERMINAL}\nsecond line` }],
      details: undefined,
    },
    { isError: true, width: 400 },
  );
  expect(rows).toEqual([`${NO_TERMINAL} · 1.2s`]);
});

test("a successful result with no details or another details shape draws a plain row and never throws", () => {
  const tool = registered();
  for (const details of [
    undefined,
    null,
    "answered",
    { outcome: "answered" },
    { outcome: "answered", answers: [{ header: 1, answer: "x" }] },
    { outcome: "answered", answers: [{ header: "h", answer: 2 }] },
    { outcome: "answered", answers: "x" },
    { outcome: "answered", answers: [] },
    { outcome: "cancelled" },
    { outcome: "shrugged" },
  ])
    expect(
      resultRows(tool, {
        content: [{ type: "text", text: "The user answered.\n1. a -> b" }],
        details,
      }),
    ).toEqual(["The user answered. · 1.2s"]);
  expect(
    resultRows(tool, { content: [], details: { outcome: "declined" } }),
  ).toEqual(["declined · 1.2s"]);
});

test("the result row stays within a narrow width and keeps escapes out, whatever the answer holds", () => {
  const hostile = `\u001b]52;c;aGk=\u0007${BIDI}漢字🙂${"wide ".repeat(40)}`;
  const rows = resultRows(
    registered(),
    {
      content: [],
      details: {
        outcome: "answered",
        answers: [
          { header: `漢字${hostile}`, answer: `[own words] ${hostile}` },
          { header: "Name", answer: hostile },
        ],
      },
    },
    { width: 20 },
  );
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(visibleWidth(row)).toBeLessThanOrEqual(20);
    expect(row).not.toContain("\u001b]");
    expect(row).not.toContain(BIDI);
  }
});

test("opening a question rings the terminal bell once", async () => {
  const fake = dialogs();
  const call = execute(registered(), fake.ui);
  const opened = await fake.nextOpen();
  expect(opened.write.mock.calls).toEqual([["\x07"]]);
  press(opened.component, ENTER);
  await call;
  expect(opened.write).toHaveBeenCalledTimes(1);
});

test("in rpc, a host that answers forms and formRequests gets ask_user offered to the model, before and after a reload", async () => {
  const bus = createEventBus();
  capabilityHost(bus);
  const { session, requests } = await parentSession({
    mode: "rpc",
    eventBus: bus,
    respond: () => fauxAssistantMessage("done"),
  });
  await session.prompt("go");
  expect(toolsSeen(requests[0]!)).toContain("ask_user");
  await session.reload();
  await session.prompt("again");
  expect(toolsSeen(requests[1]!)).toContain("ask_user");
});

test.each([
  ["no host", undefined],
  [
    "forms false",
    (id: unknown) => ({ id, v: 1, forms: false, formRequests: true }),
  ],
  ["formRequests absent", (id: unknown) => ({ id, v: 1, forms: true })],
  [
    "another query's id",
    () => ({ id: "other", v: 1, forms: true, formRequests: true }),
  ],
  [
    "a v2 reply",
    (id: unknown) => ({ id, v: 2, forms: true, formRequests: true }),
  ],
  [
    "forms as a string",
    (id: unknown) => ({ id, v: 1, forms: "true", formRequests: true }),
  ],
])(
  "outside the TUI, ask_user stays hidden and a call tells the model to decide when the bus gives %s",
  async (_name, reply) => {
    const bus = createEventBus();
    if (reply) capabilityHost(bus, reply);
    const tool = registered("rpc", bus);
    expect(hidden(tool)).toBe(true);
    await expect(execute(tool, dialogs().ui)).rejects.toThrow(NO_TERMINAL);
  },
);

test("a reply that lands after a microtask is too late: ask_user stays hidden", () => {
  const bus = createEventBus();
  bus.on("tengi:capabilities?", (q) =>
    queueMicrotask(() => {
      if (typeof q === "object" && q !== null && "id" in q)
        bus.emit("tengi:capabilities", {
          id: q.id,
          v: 1,
          forms: true,
          formRequests: true,
        });
    }),
  );
  expect(hidden(registered("rpc", bus))).toBe(true);
});

test("in the TUI, ask_user is offered without asking the bus, whatever a host would say", () => {
  const bus = createEventBus();
  const seen = capabilityHost(bus, (id) => ({
    id,
    v: 1,
    forms: false,
    formRequests: false,
  }));
  expect(hidden(registered("tui", bus))).toBe(false);
  expect(seen.queries).toBe(0);
});

test("a capability query leaves no listener on the bus", () => {
  const bus = createEventBus();
  capabilityHost(bus);
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
  expect(hidden(registered("rpc", counted))).toBe(false);
  expect(live).toBe(0);
});

test("a stale extension API, which throws on subscribe, keeps ask_user hidden and a call tells the model to decide", async () => {
  const stale: ExtensionAPI["events"] = {
    on: () => {
      throw new Error("Extension API is no longer active");
    },
    emit: () => {
      throw new Error("Extension API is no longer active");
    },
  };
  const tool = registered("rpc", stale);
  expect(hidden(tool)).toBe(true);
  await expect(execute(tool, dialogs().ui)).rejects.toThrow(NO_TERMINAL);
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

/**
 * A host that serves form requests: it acks each inside the emit, records it and hands it to
 * `answer`, whose return value, if any, is the reply; a host that answers later keeps the payload.
 */
function formHost(
  bus: EventBus,
  answer: (form: FormPayload) => unknown = () => undefined,
): { forms: FormPayload[]; nextForm: () => Promise<FormPayload> } {
  capabilityHost(bus);
  const forms: FormPayload[] = [];
  const opens: ReturnType<typeof deferred<FormPayload>>[] = [];
  const slot = (i: number) => {
    opens[i] ??= deferred<FormPayload>();
    return opens[i];
  };
  let waited = 0;
  bus.on("tengi:form?", (p) => {
    const form = p as FormPayload;
    form.ack();
    slot(forms.push(form) - 1).resolve(form);
    const reply = answer(form);
    if (reply !== undefined) form.respond(reply);
  });
  /** The next form request, in order of arrival. */
  return { forms, nextForm: () => slot(waited++).promise };
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
  const bus = createEventBus();
  const { forms } = formHost(bus, () => ({ action: "decline" }));
  const result = await execute(registered("rpc", bus), dialogs().ui, {
    questions: FIXTURE.questions,
  });
  expect(said(result)).toBe(DECLINED);
  expect(forms[0]?.message).toBe(FIXTURE.message);
  expect(forms[0]?.requestedSchema).toEqual(FIXTURE.requestedSchema);
});

test("escape sequences and invisible characters in the model's strings never reach the form", async () => {
  const bus = createEventBus();
  const { forms } = formHost(bus, () => ({ action: "decline" }));
  await execute(
    registered("rpc", bus),
    dialogs().ui,
    ask({
      question: "Which\x1b[31m storage\u200b?",
      header: "Sto\x1b]8;;http://x\x07rage",
      options: [
        { label: "SQ\x1b[0mLite", description: "one\u202e file" },
        { label: "Postgres" },
      ],
    }),
  );
  const schema = forms[0]?.requestedSchema as {
    properties: Record<
      string,
      { title: string; description?: string; oneOf?: object[] }
    >;
  };
  expect(schema.properties.question_0).toMatchObject({
    title: "Storage",
    description: "Which storage?",
  });
  expect(schema.properties.question_0?.oneOf?.[0]).toEqual({
    const: "0",
    title: "SQLite",
    description: "one file",
  });
});

test("the request carries the call's id, a fresh request id, the call's signal and the two callbacks", async () => {
  const bus = createEventBus();
  const { forms } = formHost(bus, () => ({ action: "decline" }));
  const tool = registered("rpc", bus);
  const controller = new AbortController();
  await execute(tool, dialogs().ui, ask(), controller.signal);
  await execute(tool, dialogs().ui, ask());
  expect(forms[0]).toMatchObject({ toolCallId: "call" });
  expect(forms[0]?.signal).toBe(controller.signal);
  expect(typeof forms[0]?.id).toBe("string");
  expect(forms[0]?.id).not.toBe(forms[1]?.id);
  expect(forms[1]?.signal).toBeInstanceOf(AbortSignal);
});

test.each([
  ["a pick is its option's label", ask(), { question_0: "1" }, "-> Postgres"],
  [
    "picks come back in option order, own words after them",
    ask({ multiSelect: true }),
    { question_0: ["1", "0"], question_0_custom: "  and\n  more " },
    "-> SQLite; Postgres; [own words] and more",
  ],
  [
    "own words alone are the answer, on one line",
    ask(),
    { question_0_custom: " mine\there " },
    "-> [own words] mine here",
  ],
  [
    "on a single choice with both a pick and own words, the own words win",
    ask(),
    { question_0: "0", question_0_custom: "neither" },
    "-> [own words] neither",
  ],
  [
    "a free-text answer is the user's words",
    { questions: [{ question: "Name?", header: "Name" }] },
    { question_0: "  a  b " },
    "-> [own words] a b",
  ],
  [
    "properties the form never asked for are ignored",
    ask(),
    { question_0: "0", question_7: "x", bogus: 1 },
    "-> SQLite",
  ],
])("%s", async (_name, params, content, expected) => {
  const bus = createEventBus();
  formHost(bus, () => accept(content));
  const result = await execute(registered("rpc", bus), dialogs().ui, params);
  expect(result.content[0]).toMatchObject({ type: "text" });
  expect(said(result)).toContain(expected);
  expect(said(result)).not.toContain(UNANSWERED);
});

test("a question the form left out reaches the model as not answered, with the open-questions line", async () => {
  const bus = createEventBus();
  formHost(bus, () => accept({ question_1: "0" }));
  const result = await execute(registered("rpc", bus), dialogs().ui, {
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
  const bus = createEventBus();
  formHost(bus, () => ({ action: "accept", content }));
  const result = await execute(registered("rpc", bus), dialogs().ui);
  expect(said(result)).toBe(DECLINED);
  expect(result.details).toEqual({ outcome: "declined" });
});

test.each([
  ["a pick that is not a string", ask(), { question_0: ["SENTINEL"] }],
  ["an index that is not canonical", ask(), { question_0: "01" }],
  ["an index past the last option", ask(), { question_0: "7" }],
  [
    "a multi-select pick that is not a list",
    ask({ multiSelect: true }),
    { question_0: "SENTINEL" },
  ],
  [
    "the same pick twice",
    ask({ multiSelect: true }),
    { question_0: ["0", "0"] },
  ],
  ["own words that are not text", ask(), { question_0_custom: ["SENTINEL"] }],
  [
    "a free-text answer that is not text",
    { questions: [{ question: "Name?", header: "Name" }] },
    { question_0: ["SENTINEL"] },
  ],
])(
  "an answer the form could not have produced (%s) is refused without echoing it",
  async (_name, params, content) => {
    const bus = createEventBus();
    formHost(bus, () => accept(content));
    const call = execute(registered("rpc", bus), dialogs().ui, params);
    await expect(call).rejects.toThrow(REFUSED);
    await expect(call).rejects.not.toThrow(/SENTINEL/);
  },
);

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
])(
  "%s reaches the model as its own text",
  async (_name, reply, text, isError) => {
    const bus = createEventBus();
    formHost(bus, () => reply);
    const call = execute(registered("rpc", bus), dialogs().ui);
    if (isError) await expect(call).rejects.toThrow(text);
    else expect(said(await call)).toBe(text);
  },
);

test("a host that refuses the request fails the call with the host's reason, which it tells the model in one line", async () => {
  const bus = createEventBus();
  formHost(bus, () => ({ action: "cancel", error: "no\nlive session" }));
  await expect(execute(registered("rpc", bus), dialogs().ui)).rejects.toThrow(
    "ask_user: the dialog failed (no live session); ask the question in your reply instead",
  );
});

test("a host that advertises form requests but takes none fails the call, so the model asks in its reply instead", async () => {
  const bus = createEventBus();
  capabilityHost(bus);
  await expect(execute(registered("rpc", bus), dialogs().ui)).rejects.toThrow(
    "ask_user: the dialog failed (no host took the form); ask the question in your reply instead",
  );
});

test("a bus that refuses the form request fails the call with the refusal, so the model asks in its reply instead", async () => {
  const bus = createEventBus();
  capabilityHost(bus);
  const refusing: ExtensionAPI["events"] = {
    on: (channel, handler) => bus.on(channel, handler),
    emit: (channel, data) => {
      if (channel === "tengi:form?")
        throw new Error("Extension API is no longer active");
      bus.emit(channel, data);
    },
  };
  await expect(
    execute(registered("rpc", refusing), dialogs().ui),
  ).rejects.toThrow(
    "ask_user: the dialog failed (the bus refused it: Extension API is no longer active); ask the question in your reply instead",
  );
});

test("a cancel the host answers from the signal's own abort listener is the abort, not a closed form", async () => {
  const bus = createEventBus();
  formHost(bus, (form) => {
    form.signal.addEventListener(
      "abort",
      () => form.respond({ action: "cancel" }),
      { once: true },
    );
  });
  const controller = new AbortController();
  const call = execute(
    registered("rpc", bus),
    dialogs().ui,
    ask(),
    controller.signal,
  );
  controller.abort();
  await expect(call).rejects.toThrow(ABORTED);
});

test("an abort while the form is open fails the call at once, aborts the form's signal, and a reply after it changes nothing", async () => {
  const bus = createEventBus();
  const { nextForm } = formHost(bus);
  const controller = new AbortController();
  const call = execute(
    registered("rpc", bus),
    dialogs().ui,
    ask(),
    controller.signal,
  );
  const form = await nextForm();
  controller.abort();
  await expect(call).rejects.toThrow(ABORTED);
  expect(form.signal.aborted).toBe(true);
  form.respond(accept({ question_0: "0" }));
  await expect(call).rejects.toThrow(ABORTED);
});

test("an answer given before a late abort is kept, and a second reply is ignored", async () => {
  const bus = createEventBus();
  const { nextForm } = formHost(bus);
  const controller = new AbortController();
  const call = execute(
    registered("rpc", bus),
    dialogs().ui,
    ask(),
    controller.signal,
  );
  const form = await nextForm();
  form.respond(accept({ question_0: "1" }));
  form.respond({ action: "decline" });
  controller.abort();
  expect(said(await call)).toContain("-> Postgres");
});

test("two calls open one form at a time, in the order they arrived", async () => {
  const bus = createEventBus();
  const { forms, nextForm } = formHost(bus);
  const tool = registered("rpc", bus);
  const first = execute(tool, dialogs().ui, ask());
  const second = execute(tool, dialogs().ui, ask({ header: "Second" }));
  const one = await nextForm();
  // the second emit can only follow the first call's release, so one form is all there is
  expect(forms).toHaveLength(1);
  one.respond(accept({ question_0: "0" }));
  expect(said(await first)).toContain("-> SQLite");
  const two = await nextForm();
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
  const first = results(session).get("a")!;
  expect(first.isError).toBeFalsy();
  expect(textOf(first)).toContain(
    "Which storage should the cache use? -> Postgres",
  );

  await session.reload();
  await session.prompt("again");
  expect(forms).toHaveLength(2);
  expect(textOf(results(session).get("b")!)).toContain("-> Postgres");
});
