// Pi behaviour the ui layout rests on. A failure here after a Pi upgrade means the design
// changes, not the test.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initTheme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  rgbColor,
  stripTerminalSequences,
  styleText,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, onTestFinished, test, vi } from "vitest";
// biome-ignore lint/style/noRestrictedImports: the interactive mode resolves a row's renderers through this but Pi does not export it from its root
import { withBuiltInRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import { scratchDir } from "./session.js";
import {
  BUILTIN_TOOLS,
  type BuiltinTool,
  builtinHost,
  htmlRender,
  messageHost,
  piExport,
  piRenderers,
  piScreen,
  piTheme,
  realIndicator,
  realTool,
  resolveChain,
  scrollScreen,
  toolRowHost,
} from "./ui.js";

test("Pi measures a tab as three columns", () => {
  expect(visibleWidth("\t")).toBe(3);
  expect(visibleWidth("a\tb")).toBe(5);
});

test("a bare ✔ is one column and ✔ with VS16 is two", () => {
  const check = String.fromCodePoint(0x2714);
  expect(visibleWidth(check)).toBe(1);
  expect(visibleWidth(`${check}${String.fromCodePoint(0xfe0f)}`)).toBe(2);
});

test("Pi's truncateToWidth puts a reset before its ellipsis, which ends a surrounding background", () => {
  const styled = styleText(
    "hello world",
    { bg: rgbColor(40, 40, 60) },
    "truecolor",
  );
  expect(truncateToWidth(styled, 6, "…")).toContain("\u001b[0m…");
});

test("Pi's regular renderer throws on an over-wide line from the second frame, and the first frame does not", () => {
  const overWide = { invalidate() {}, render: () => ["x".repeat(30)] };
  const screen = piScreen(overWide, 10);
  expect(screen.firstFrameCrash).toBeUndefined();
  expect(screen.crash?.message).toMatch(/exceeds terminal width/);
});

const KINDS = ["working", "retry", "compaction", "branchSummary"] as const;

test("a status indicator's border text is its spinner, a space, then its message, for all four kinds and for frames that carry colour", () => {
  const coloured = {
    frames: ["a", "b"].map((frame) =>
      styleText(frame, { fg: rgbColor(184, 248, 24) }, "truecolor"),
    ),
  };
  for (const kind of KINDS)
    for (const indicator of [undefined, coloured]) {
      const made = realIndicator(kind, "Doing a thing", { indicator });
      const border = made.renderInBorder(200);
      expect(border.startsWith(`${made.renderSpinnerInBorder(200)} `)).toBe(
        true,
      );
      expect(stripTerminalSequences(border).endsWith(" Doing a thing")).toBe(
        true,
      );
    }
});

test("an indicator given frames draws them verbatim, and one built without options ticks every 80 ms", () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const wrap = (text: string) => `<${text}>`;
  const given = realIndicator("working", "Working", {
    indicator: { frames: ["a", "b"], intervalMs: 200 },
    color: wrap,
  });
  expect(given.renderSpinnerInBorder(20)).toBe("a");
  vi.advanceTimersByTime(200);
  expect(given.renderSpinnerInBorder(20)).toBe("b");

  const requestRender = vi.fn();
  realIndicator("working", "Working", { requestRender });
  const built = requestRender.mock.calls.length;
  vi.advanceTimersByTime(79);
  expect(requestRender).toHaveBeenCalledTimes(built);
  vi.advanceTimersByTime(1);
  expect(requestRender).toHaveBeenCalledTimes(built + 1);
});

test("setting an indicator's frames restarts it at frame 0", () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const made = realIndicator("working", "Working", {
    indicator: { frames: ["a", "b", "c"], intervalMs: 100 },
  });
  vi.advanceTimersByTime(200);
  expect(made.renderSpinnerInBorder(20)).toBe("c");
  made.setIndicator({ frames: ["x", "y"], intervalMs: 100 });
  expect(made.renderSpinnerInBorder(20)).toBe("x");
});

test("an indicator with one frame starts no timer", () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  realIndicator("working", "Working", { indicator: { frames: ["*"] } });
  expect(vi.getTimerCount()).toBe(0);
});

const lineOf = (text: () => string): Component => ({
  invalidate() {},
  render: () => [text()],
});

/** A self-framed definition whose renderers record the context Pi hands them. */
function probeDefinition(
  call: (context: Record<string, unknown>) => Component,
  result: (context: Record<string, unknown>) => Component = () =>
    lineOf(() => "RESULT"),
) {
  const seen: { call: Record<string, unknown>[]; result: unknown[] } = {
    call: [],
    result: [],
  };
  const definition: ToolRenderers = {
    renderShell: "self",
    renderCall: (_args, _theme, context) => {
      seen.call.push(context as never);
      return call(context as never);
    },
    renderResult: (res, options, _theme, context) => {
      seen.result.push({ res, options, context });
      return result(context as never);
    },
  };
  return { definition, seen };
}

test("a \"self\" tool row is a blank line, then the call component's lines, then the result component's", () => {
  const { definition } = probeDefinition(() => lineOf(() => "CALL"));
  const host = toolRowHost(definition, {});
  expect(host.lines(40)).toEqual(["", "CALL"]);
  host.update({ content: [] });
  expect(host.lines(40)).toEqual(["", "CALL", "RESULT"]);
});

test("components a renderer returns are drawn after both renderers ran, so a call component sees what renderResult stored in context.state in the same update", () => {
  const { definition } = probeDefinition(
    (context) =>
      lineOf(() => String((context.state as { stored?: string }).stored)),
    (context) => {
      (context.state as { stored?: string }).stored = "settled";
      return { invalidate() {}, render: () => [] };
    },
  );
  const host = toolRowHost(definition, {});
  expect(host.lines(40)).toEqual(["", "undefined"]);
  host.update({ content: [] });
  expect(host.lines(40)).toEqual(["", "settled"]);
});

test("a result with no details and no duration reaches the renderers when a stream aborts", () => {
  const { definition, seen } = probeDefinition(() => lineOf(() => "CALL"));
  const host = toolRowHost(definition, {});
  host.update({ content: [{ type: "text", text: "aborted" }], isError: true });
  const last = seen.result.at(-1) as {
    res: { details: unknown };
    context: { isError: boolean; durationMs: number | undefined };
  };
  expect(last.res.details).toBeUndefined();
  expect(last.context).toMatchObject({ isError: true, durationMs: undefined });
});

test("durationMs reaches the renderers only on the final result", () => {
  const { definition, seen } = probeDefinition(() => lineOf(() => "CALL"));
  const host = toolRowHost(definition, {});
  host.update({ content: [], durationMs: 900 }, true);
  const partial = seen.result.at(-1) as { context: { durationMs?: number } };
  expect(partial.context.durationMs).toBeUndefined();
  host.update({ content: [], durationMs: 900 });
  const final = seen.result.at(-1) as { context: { durationMs?: number } };
  expect(final.context.durationMs).toBe(900);
});

test("HTML export draws the call with isPartial true and no duration, then the result on its own, with state shared", () => {
  const { definition, seen } = probeDefinition(
    (context) =>
      lineOf(() => String((context.state as { stored?: string }).stored)),
    (context) => {
      (context.state as { stored?: string }).stored = "settled";
      return lineOf(() => "RESULT");
    },
  );
  const exported = htmlRender(definition, {}, { content: [] });
  expect(seen.call[0]).toMatchObject({
    isPartial: true,
    durationMs: undefined,
    executionStarted: true,
    argsComplete: true,
  });
  // The call was drawn before the result existed
  expect(stripTerminalSequences(exported.call ?? "")).toContain("undefined");
  expect(exported.result?.expanded).toContain("RESULT");
  const result = seen.result[0] as { context: { state: object } };
  expect(result.context.state).toBe(seen.call[0]?.state);
});

test("Pi's regular renderer clears the scrollback when a line above the viewport changes, and not when a line inside it does", () => {
  const CLEAR_SCROLLBACK = "\u001b[3J";
  const screen = scrollScreen(10);
  const tall = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  screen.show(tall);
  expect(screen.show(tall.map((l, i) => (i === 0 ? "changed" : l)))).toContain(
    CLEAR_SCROLLBACK,
  );
  const settled = tall.map((l, i) => (i === 0 ? "changed" : l));
  const inside = settled.map((l, i) => (i === 29 ? "tail" : l));
  const written = screen.show(inside);
  expect(written).toContain("tail");
  expect(written).not.toContain(CLEAR_SCROLLBACK);
});

test("a renderer that throws is replaced by Pi's plain text, and a component whose render throws is not caught", () => {
  const thrower = probeDefinition(() => {
    throw new Error("renderer");
  });
  expect(
    stripTerminalSequences(
      toolRowHost(thrower.definition, {}).lines(40).join("\n"),
    ),
  ).toContain("probe");
  const late = probeDefinition(() => ({
    invalidate() {},
    render() {
      throw new Error("component");
    },
  }));
  const host = toolRowHost(late.definition, {});
  expect(() => host.lines(40)).toThrow("component");
});

const MESSAGE = {
  customType: "probe",
  content: [{ type: "text", text: "the **model's** text" }],
};

test("a message renderer that returns undefined or throws is replaced by Pi's purple box with the model's text", () => {
  const dropped = messageHost(() => undefined, MESSAGE);
  const thrown = messageHost(() => {
    throw new Error("renderer");
  }, MESSAGE);
  for (const host of [dropped, thrown]) {
    const text = host.lines(60).map(stripTerminalSequences).join("\n");
    expect(text).toContain("[probe]");
    expect(text).toContain("the model's text");
  }
});

test("a message component is rebuilt on expand and on invalidate", () => {
  const renderer = vi.fn((_message: unknown, options: { expanded: boolean }) =>
    lineOf(() => (options.expanded ? "EXPANDED" : "COLLAPSED")),
  );
  const host = messageHost(renderer as never, MESSAGE);
  expect(renderer).toHaveBeenCalledTimes(1);
  host.expand(true);
  expect(renderer).toHaveBeenCalledTimes(2);
  expect(host.lines(40)).toContain("EXPANDED");
  host.expand(true);
  expect(renderer).toHaveBeenCalledTimes(2);
  host.invalidate();
  expect(renderer).toHaveBeenCalledTimes(3);
});

test("a Spacer(1) precedes the renderer's component", () => {
  const host = messageHost(() => lineOf(() => "RECORD"), MESSAGE);
  expect(host.lines(40)).toEqual(["", "RECORD"]);
});

const spyingResolver =
  (asked: string[]) =>
  (name: string, next: () => ToolRenderers | undefined) => {
    asked.push(name);
    return next();
  };

test("a resolver that calls next() twice runs the resolvers after it twice", () => {
  const asked: string[] = [];
  const base = vi.fn(() => undefined);
  resolveChain(
    [
      (_name, next) => {
        next();
        return next();
      },
      spyingResolver(asked),
    ],
    "grep",
    base,
  );
  expect(asked).toEqual(["grep", "grep"]);
  expect(base).toHaveBeenCalledTimes(2);
});

test("Pi's real chain runs the resolvers after a resolver that calls next() twice, once per next()", async () => {
  const askedOf = async (doubleNext: boolean) => {
    const asked: string[] = [];
    await piExport(
      (pi) => {
        pi.registerToolRenderer((_name, next) => {
          if (doubleNext) next();
          return next();
        });
        pi.registerToolRenderer(spyingResolver(asked));
      },
      [{ name: "grep", args: { pattern: "x" }, result: { content: [] } }],
    );
    return asked;
  };
  const once = await askedOf(false);
  // Without this the doubling below could pass vacuously, the chain asking nobody
  expect(once.length).toBeGreaterThan(0);
  const twice = await askedOf(true);
  expect(twice).toEqual(once.flatMap((name) => [name, name]));
});

test("the interactive base is Pi's own renderers for a tool with no registered definition, and an export's base is undefined for it", async () => {
  for (const name of BUILTIN_TOOLS) {
    const base = withBuiltInRenderers(name, undefined);
    expect(typeof base?.renderCall).toBe("function");
    expect(typeof base?.renderResult).toBe("function");
  }
  expect(withBuiltInRenderers("not-a-tool", undefined)).toBeUndefined();
  const asked: string[] = [];
  const html = await piExport(
    (pi) => pi.registerToolRenderer(spyingResolver(asked)),
    [{ name: "grep", args: { pattern: "x" }, result: { content: [] } }],
  );
  expect(html.length).toBeGreaterThan(0);
  // The session has grep registered; an unregistered name has nothing to resolve to
  const unknown: string[] = [];
  const bases: unknown[] = [];
  await piExport(
    (pi) =>
      pi.registerToolRenderer((name, next) => {
        unknown.push(name);
        bases.push(next());
        return undefined;
      }),
    [{ name: "ghost_tool", args: {}, result: { content: [] } }],
  );
  expect(unknown).toContain("ghost_tool");
  expect(bases).toEqual(expect.arrayContaining([undefined]));
});

test("Pi hands a renderer the component it returned last, and hands undefined after a throw", () => {
  let calls = 0;
  const { definition, seen } = probeDefinition(
    () => {
      calls++;
      if (calls === 4) throw new Error("once");
      return lineOf(() => "CALL");
    },
    () => lineOf(() => "RESULT"),
  );
  const host = toolRowHost(definition, {});
  host.update({ content: [] });
  const first = seen.call.at(-1)?.lastComponent;
  expect(first).toBeDefined();
  host.invalidate();
  const second = seen.call.at(-1);
  expect(second?.lastComponent).toBeDefined();
  // The fourth call throws; the one after it starts from nothing
  host.invalidate();
  host.invalidate();
  expect(seen.call.at(-1)?.lastComponent).toBeUndefined();
  const results = seen.result as { context: { lastComponent: unknown } }[];
  expect(results.at(0)?.context.lastComponent).toBeUndefined();
  expect(results.at(-1)?.context.lastComponent).toBeDefined();
});

const STUB_ARGS: Record<BuiltinTool, unknown> = {
  read: { path: "a.ts" },
  write: { path: "a.ts", content: "x" },
  bash: { command: "true" },
  grep: { pattern: "x" },
  find: { pattern: "*" },
  ls: {},
  edit: { path: "a.ts", edits: [] },
};

test("every built-in renderer other than edit's throws when handed a component that is not its own", async () => {
  const foreign = lineOf(() => "skyr");
  const context = (extra: object) => ({
    args: {},
    toolCallId: "c",
    invalidate() {},
    lastComponent: foreign,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 1,
    ...extra,
  });
  initTheme("dark");
  const theme = piTheme();
  for (const name of BUILTIN_TOOLS) {
    if (name === "edit") continue;
    const renderers = await piRenderers(name);
    const args = STUB_ARGS[name];
    expect(() =>
      renderers.renderCall?.(args as never, theme, context({ args }) as never),
    ).toThrow();
    expect(() =>
      renderers.renderResult?.(
        { content: [{ type: "text", text: "x" }], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        context({ args }) as never,
      ),
    ).toThrow();
  }
});

test("bash's renderResult starts an interval while partial and not when final", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const host = await builtinHost("bash", { command: "sleep 9" });
  host.start();
  host.update({ content: [{ type: "text", text: "a" }] }, true);
  expect(vi.getTimerCount()).toBe(1);
  host.update({ content: [{ type: "text", text: "a" }] });
  expect(vi.getTimerCount()).toBe(0);
});

test("Pi's renderers keep startedAt, endedAt, interval and callComponent in context.state and read nothing else from it", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const keys = new Set<string>();
  const read = new Set<string>();
  const state = new Proxy(
    {},
    {
      get(target, key) {
        read.add(String(key));
        return Reflect.get(target, key);
      },
      set(target, key, value) {
        keys.add(String(key));
        return Reflect.set(target, key, value);
      },
    },
  );
  initTheme("dark");
  const theme = piTheme();
  for (const name of BUILTIN_TOOLS) {
    const renderers = await piRenderers(name);
    const args = STUB_ARGS[name];
    const context = (isPartial: boolean) =>
      ({
        args,
        toolCallId: "c",
        invalidate() {},
        lastComponent: undefined,
        state,
        cwd: process.cwd(),
        executionStarted: true,
        argsComplete: false,
        isPartial,
        expanded: false,
        showImages: false,
        isError: false,
        durationMs: undefined,
        outputPad: 1,
      }) as never;
    renderers.renderCall?.(args as never, theme, context(true));
    renderers.renderResult?.(
      { content: [{ type: "text", text: "x" }], details: undefined },
      { expanded: false, isPartial: true },
      theme,
      context(true),
    );
    renderers.renderResult?.(
      { content: [{ type: "text", text: "x" }], details: undefined },
      { expanded: false, isPartial: false },
      theme,
      context(false),
    );
  }
  const allowed = new Set([
    "startedAt",
    "endedAt",
    "interval",
    "callComponent",
  ]);
  expect([...keys].filter((k) => !allowed.has(k))).toEqual([]);
  expect([...read].filter((k) => !allowed.has(k))).toEqual([]);
});

test("Pi's edit renderer fills state.callComponent.preview.diff after argsComplete, then calls invalidate", async () => {
  const cwd = scratchDir("edit-preview");
  writeFileSync(join(cwd, "a.ts"), "one\ntwo\nthree\n");
  initTheme("dark");
  const theme = piTheme();
  const renderers = await piRenderers("edit", cwd);
  const state: { callComponent?: { preview?: { diff?: string } } } = {};
  const invalidate = vi.fn();
  const args = {
    path: "a.ts",
    edits: [{ oldText: "two", newText: "2" }],
  };
  const context = (argsComplete: boolean) =>
    ({
      args,
      toolCallId: "c",
      invalidate,
      lastComponent: undefined,
      state,
      cwd,
      executionStarted: false,
      argsComplete,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
      durationMs: undefined,
      outputPad: 1,
    }) as never;
  renderers.renderCall?.(args as never, theme, context(false));
  expect(state.callComponent?.preview).toBeUndefined();
  renderers.renderCall?.(args as never, theme, context(true));
  await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
  expect(state.callComponent?.preview?.diff).toMatch(/-2 two/);
});

const SAVED = {
  read: { name: "read", args: { path: "a.ts" } },
  bash: { name: "bash", args: { command: "true" } },
  edit: { name: "edit", args: { path: "a.ts", edits: [] } },
  write: { name: "write", args: { path: "a.ts", content: "x" } },
  grep: { name: "grep", args: { pattern: "x" } },
  find: { name: "find", args: { pattern: "*" } },
  ls: { name: "ls", args: {} },
} as const;

const savedAll = (text = "x") =>
  BUILTIN_TOOLS.map((tool) => ({
    ...SAVED[tool],
    result: { content: [{ type: "text", text }] },
  }));

test("an export asks the resolver for grep and find only: bash, read, write, edit and ls never reach it", async () => {
  const asked: string[] = [];
  await piExport(
    (pi) => pi.registerToolRenderer(spyingResolver(asked)),
    savedAll(),
  );
  expect([...new Set(asked)].sort()).toEqual(["find", "grep"]);
});

test("an export draws grep's call with isPartial true before any result exists", async () => {
  const seen: { isPartial: boolean; sawResult: boolean }[] = [];
  let resultSeen = false;
  await piExport(
    (pi) =>
      pi.registerToolRenderer((name, next) => {
        const base = next();
        if (name !== "grep" || !base) return base;
        return {
          ...base,
          renderCall: (args, theme, context) => {
            seen.push({ isPartial: context.isPartial, sawResult: resultSeen });
            return base.renderCall?.(args, theme, context) as Component;
          },
          renderResult: (...a) => {
            resultSeen = true;
            return base.renderResult?.(...a) as Component;
          },
        };
      }),
    savedAll(),
  );
  expect(seen).toEqual([{ isPartial: true, sawResult: false }]);
});

const text = (result: { content: { text?: string }[] }) =>
  result.content.map((c) => c.text ?? "").join("\n");

function tree(name: string) {
  const cwd = scratchDir(name);
  mkdirSync(join(cwd, "src"));
  writeFileSync(
    join(cwd, "src/a.ts"),
    "const a = 1;\nconst needle = 2;\nconst b = 3;\n",
  );
  writeFileSync(join(cwd, "src/b.ts"), "needle here\n");
  return cwd;
}

test('a failing bash ends in "Command exited with code N" after a blank line; an aborted and a timed-out one end in their own sentences', async () => {
  const cwd = tree("bash-status");
  const failed = await realTool("bash", { command: "echo out; exit 2" }, cwd);
  expect(failed.isError).toBe(true);
  expect(text(failed)).toBe("out\n\n\nCommand exited with code 2");
  const silent = await realTool("bash", { command: "exit 3" }, cwd);
  expect(text(silent)).toBe("(no output)\n\nCommand exited with code 3");
  const timed = await realTool("bash", { command: "sleep 5", timeout: 1 }, cwd);
  expect(text(timed)).toBe("Command timed out after 1 seconds");
  const ok = await realTool("bash", { command: "echo hi" }, cwd);
  expect(ok.isError).toBeUndefined();
  expect(text(ok)).toBe("hi\n");
});

test('a successful write says "Successfully wrote to <path>", and an edit\'s details.diff lines start with +, - or a space then the line number', async () => {
  const cwd = tree("write-edit");
  expect(
    text(await realTool("write", { path: "src/w.ts", content: "a\nb\n" }, cwd)),
  ).toBe("Successfully wrote to src/w.ts");
  const edited = await realTool(
    "edit",
    {
      path: "src/a.ts",
      edits: [{ oldText: "const b = 3;", newText: "const b = 4;" }],
    },
    cwd,
  );
  const diff = (edited.details as { diff: string }).diff;
  for (const line of diff.split("\n")) expect(line).toMatch(/^[-+ ] ?\d+ /);
  expect(diff).toContain("-3 const b = 3;");
  expect(diff).toContain("+3 const b = 4;");
});

test("read, grep, find and ls notices are one trailing bracketed paragraph and nothing else in the text is", async () => {
  const cwd = tree("notices");
  const read = await realTool(
    "read",
    { path: "src/a.ts", offset: 2, limit: 1 },
    cwd,
  );
  expect(text(read)).toBe(
    "const needle = 2;\n\n[2 more lines in file. Use offset=3 to continue.]",
  );
  const grep = await realTool("grep", { pattern: "e", limit: 1 }, cwd);
  expect(text(grep)).toMatch(
    /^src\/\w\.ts:\d+: .*\n\n\[1 matches limit reached\. Use limit=2 for more, or refine pattern\]$/,
  );
  expect(
    (grep.details as { matchLimitReached: number }).matchLimitReached,
  ).toBe(1);
  const find = await realTool("find", { pattern: "*.ts", limit: 1 }, cwd);
  expect(text(find)).toMatch(
    /\n\n\[1 results limit reached\. Use limit=2 for more, or refine pattern\]$/,
  );
  const ls = await realTool("ls", { path: "src", limit: 1 }, cwd);
  expect(text(ls)).toMatch(
    /\n\n\[1 entries limit reached\. Use limit=2 for more\]$/,
  );
});

test('grep match lines are "path:line: text" and with context also "path-line- text"; find and ls print one entry per line and say so when nothing is found, with details undefined', async () => {
  const cwd = tree("shapes");
  const grep = await realTool("grep", { pattern: "needle" }, cwd);
  // ripgrep searches files in parallel, so the order of files is not fixed
  expect(text(grep).split("\n").sort()).toEqual([
    "src/a.ts:2: const needle = 2;",
    "src/b.ts:1: needle here",
  ]);
  const context = await realTool(
    "grep",
    { pattern: "needle", context: 1 },
    cwd,
  );
  expect(text(context)).toContain("src/a.ts-1- const a = 1;");
  expect(text(context)).toContain("src/a.ts:2: const needle = 2;");
  const none = await realTool("grep", { pattern: "zzz" }, cwd);
  expect(text(none)).toBe("No matches found");
  expect(none.details).toBeUndefined();
  const find = await realTool("find", { pattern: "*.ts" }, cwd);
  expect(text(find)).toBe("src/a.ts\nsrc/b.ts");
  const nothing = await realTool("find", { pattern: "*.zz" }, cwd);
  expect(text(nothing)).toBe("No files found matching pattern");
  expect(nothing.details).toBeUndefined();
  expect(text(await realTool("ls", { path: "src" }, cwd))).toBe("a.ts\nb.ts");
  mkdirSync(join(cwd, "empty"));
  const empty = await realTool("ls", { path: "empty" }, cwd);
  expect(text(empty)).toBe("(empty directory)");
  expect(empty.details).toBeUndefined();
});

// A compatibility canary on the pinned copy's source: the string pins break on harmless
// renames by design. A failure here after a Pi upgrade means: re-derive the ordering in the
// new pinned copy before touching this test.
test("resumed and reloaded sessions build their rows before session_start", () => {
  const source = readFileSync(
    "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js",
    "utf8",
  );
  // rebindCurrentSession: renderCurrentSessionState runs before bindCurrentSessionExtensions
  const rebind = source.slice(source.indexOf("async rebindCurrentSession("));
  const rendered = rebind.indexOf("this.renderCurrentSessionState()");
  const bound = rebind.indexOf("await this.bindCurrentSessionExtensions()");
  expect(rendered).toBeGreaterThanOrEqual(0);
  expect(bound).toBeGreaterThanOrEqual(0);
  expect(rendered).toBeLessThan(bound);
  // reload: the chat is rebuilt in beforeSessionStart
  expect(source).toContain(
    "reload({ beforeSessionStart: restoreChatBeforeSessionStart })",
  );
});
