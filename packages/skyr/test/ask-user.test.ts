/**
 * ask_user through what it registers: a real Pi session where the mode and the turn matter, a
 * direct `execute` where the queue and the signal do. Pi's interactive mode cannot be built in a
 * test, so `dialogs()` stands in for its `custom()`: it mounts the component the factory returns
 * and, on close, writes back the text Pi's restore would.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionToolContext,
  type ExtensionUIContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, Editor } from "@earendil-works/pi-tui";
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

/** ask_user registered on a fake Pi, after a session_start in `mode`. */
function registered(mode: "tui" | "print" = "tui"): AskTool {
  let tool: AskTool | undefined;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  registerAskUser({
    registerTool: (t: AskTool) => {
      tool = t;
    },
    on: (event: string, fn: (event: unknown, ctx: unknown) => void) =>
      handlers.set(event, fn),
  } as unknown as ExtensionAPI);
  handlers.get("session_start")?.({ type: "session_start" }, { mode });
  if (!tool) throw new Error("registerAskUser registered no tool");
  return tool;
}

const ask = (question: Record<string, unknown> = {}) => ({
  questions: [
    {
      question: "Which storage should the cache use?",
      header: "Storage",
      options: [{ label: "SQLite" }, { label: "Postgres" }],
      ...question,
    },
  ],
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
    ),
  });
  const run = session.prompt("go");
  press((await fake.nextOpen()).component, DOWN, ENTER);
  press((await fake.nextOpen()).component, "my own name", ENTER);
  press((await fake.nextOpen()).component, ESC);
  press((await fake.nextOpen()).component, " ", DOWN, DOWN, "SSO", ENTER);
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
  expect(resultRows).toHaveLength(2);
  const lines = [...dialogLines, ...callRow, ...resultRows];
  expect(result.content[0]).toMatchObject({
    text: expect.stringContaining(hostile),
  });
  for (const line of lines) {
    expect(line).not.toContain("\u001b]");
    expect(line).not.toContain(BIDI);
  }
});
