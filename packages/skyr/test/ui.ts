/**
 * Fixtures shared by the ui tests: Pi's real screen renderer over a silent terminal, to learn
 * what Pi does with a component's lines.
 */
import { readFileSync } from "node:fs";
import {
  CustomMessageComponent,
  type ExtensionFactory,
  type ExtensionUIContext,
  initTheme,
  type MessageRenderer,
  type Theme,
  ToolExecutionComponent,
  type ToolRenderers,
  type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  parseColor,
  styleText,
  type Terminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { onTestFinished } from "vitest";
// biome-ignore lint/style/noRestrictedImports: Pi builds its HTML export of tool rows with this but does not export it from its root
import { createToolHtmlRenderer } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";
// biome-ignore lint/style/noRestrictedImports: Pi builds its status indicators with these classes but does not export them from its root
import * as indicators from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js";
import { loadPi, type PiModule } from "../src/pi.js";
import { plainTheme, scratchDir, widgetHost } from "./session.js";
import { shellRuntime } from "./shells-runtime.js";
import { testTheme } from "./voice.js";

function silentTerminal(
  columns: number,
  rows: number,
  sink: (data: string) => void = () => {},
): Terminal {
  return {
    start() {},
    stop() {},
    async drainInput() {},
    write: sink,
    columns,
    rows,
    kittyProtocolActive: false,
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  };
}

/**
 * Draws `component` at `width` columns on a real `TuiMainScreen` and reports what Pi threw for
 * it. Pi checks line widths only when it redraws a changed line, never on its first frame, so
 * the component is drawn three times: first alone (`firstFrameCrash`), then a one-column primer,
 * then the component again as a change (`crash`).
 */
export function piScreen(
  component: Component,
  width: number,
): { firstFrameCrash?: Error; crash?: Error } {
  const screen = new TuiMainScreen(
    silentTerminal(width, 40),
    false,
    scratchDir("pi-screen"),
  );
  let shown: "component" | "primer" = "component";
  screen.addChild({
    invalidate() {},
    render: (w) => (shown === "component" ? component.render(w) : ["."]),
  });
  const draw = (): Error | undefined => {
    try {
      screen.renderNow();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  const firstFrameCrash = draw();
  shown = "primer";
  draw();
  shown = "component";
  const crash = draw();
  return { firstFrameCrash, crash };
}

/**
 * A real `TuiMainScreen` in regular mode, `rows` tall, that hands back what each frame wrote to
 * the terminal. The first frame is the screen's first render, which writes without clearing.
 */
export function scrollScreen(rows: number, columns = 40) {
  const writes: string[] = [];
  const screen = new TuiMainScreen(
    silentTerminal(columns, rows, (data) => writes.push(data)),
    false,
    scratchDir("scroll-screen"),
  );
  let lines: string[] = [];
  screen.addChild({ invalidate() {}, render: () => lines });
  return {
    /** Draws `next` and returns everything the terminal was sent for it. */
    show(next: string[]): string {
      lines = next;
      writes.length = 0;
      screen.renderNow();
      return writes.join("");
    },
  };
}

/** What a stream gives Pi for a tool row's result. */
export interface RowResult {
  content: { type: string; text?: string }[];
  details?: unknown;
  isError?: boolean;
  durationMs?: number;
}

let themed = false;

const themeOnce = () => {
  if (themed) return;
  initTheme("dark");
  themed = true;
};

/**
 * A tool row as Pi draws it: the real `ToolExecutionComponent` over `definition`'s renderers,
 * driven the way the interactive mode drives it. Pi's own theme is initialised on first use,
 * since the component reads it as a global.
 */
export function toolRowHost(
  definition: ToolRenderers,
  args: unknown,
  { outputPad = 1 }: { outputPad?: number } = {},
) {
  themeOnce();
  const component = new ToolExecutionComponent(
    "probe",
    "call-1",
    args,
    { outputPad },
    definition,
    { requestRender() {} } as never,
    process.cwd(),
  );
  return {
    lines: (width: number) => component.render(width),
    start: () => component.markExecutionStarted(),
    streamArgs: (next: unknown) => component.updateArgs(next),
    argsComplete: () => component.setArgsComplete(),
    /** The final result, or with `partial` a mid-run update. */
    update(result: RowResult, partial = false) {
      component.updateResult({ isError: false, ...result }, partial);
    },
    expand: (on: boolean) => component.setExpanded(on),
    invalidate: () => component.invalidate(),
  };
}

/**
 * A custom message as Pi draws it: the real `CustomMessageComponent` over `renderer`, which Pi
 * rebuilds on every expand and invalidate.
 */
export function messageHost(
  renderer: MessageRenderer,
  message: {
    customType: string;
    content: string | { type: string; text?: string }[];
    details?: unknown;
  },
  {
    expanded = false,
    outputPad = 1,
  }: { expanded?: boolean; outputPad?: number } = {},
) {
  themeOnce();
  const component = new CustomMessageComponent(
    {
      role: "custom",
      display: true,
      timestamp: 0,
      ...message,
    } as never,
    renderer,
    undefined,
    outputPad,
  );
  if (expanded) component.setExpanded(true);
  return {
    lines: (width: number) => component.render(width),
    expand: (on: boolean) => component.setExpanded(on),
    invalidate: () => component.invalidate(),
  };
}

/**
 * Pi's HTML export of one tool call: the call drawn on its own, then the result drawn on its own,
 * collapsed and expanded, as the exporter does. Each is HTML, or undefined when it threw or
 * the tool has no renderer. The theme is skyr's test theme, which a renderer reads as it does Pi's.
 */
export function htmlRender(
  definition: ToolRenderers,
  args: unknown,
  result: RowResult,
) {
  const exporter = createToolHtmlRenderer({
    getToolRenderers: () => definition,
    theme: testTheme() as never,
    cwd: process.cwd(),
    width: 100,
  });
  return {
    call: exporter.renderCall("call-1", "probe", args),
    result: exporter.renderResult(
      "call-1",
      "probe",
      result.content,
      result.details,
      result.isError ?? false,
    ),
  };
}

/** Pi's seven built-in tools. */
export const BUILTIN_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

const definitionOf = (pi: PiModule, name: BuiltinTool, cwd: string) =>
  ({
    read: pi.createReadToolDefinition,
    bash: pi.createBashToolDefinition,
    edit: pi.createEditToolDefinition,
    write: pi.createWriteToolDefinition,
    grep: pi.createGrepToolDefinition,
    find: pi.createFindToolDefinition,
    ls: pi.createLsToolDefinition,
  })[name](cwd);

/** Pi's own renderers for a built-in tool: what Pi draws when no extension restyles it. */
export async function piRenderers(
  name: BuiltinTool,
  cwd = process.cwd(),
): Promise<ToolRenderers> {
  // The seven definitions differ in argument type, which a renderer is only ever handed as unknown
  const { renderShell, renderCall, renderResult } = definitionOf(
    await loadPi(),
    name,
    cwd,
  ) as unknown as ToolRenderers;
  return { renderShell, renderCall, renderResult };
}

/**
 * The renderers for a call as Pi resolves them: the extensions' resolvers in load order, each
 * handed a `next` that runs the rest and then `base`, as `ExtensionRunner.resolveToolRenderers`
 * does. Written out here so the chain's rules are Pi's, not skyr's. Mirror of
 * ../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:542-546 of the
 * pinned runtime; "Pi's real chain runs the resolvers after a resolver that calls next()
 * twice, once per next()" in test/ui-pi-contract.test.ts holds the real chain to it.
 */
export function resolveChain(
  resolvers: readonly ((
    name: string,
    next: () => ToolRenderers | undefined,
  ) => ToolRenderers | undefined)[],
  name: string,
  base: () => ToolRenderers | undefined,
): ToolRenderers | undefined {
  const resolve = (index: number): ToolRenderers | undefined => {
    const resolver = resolvers[index];
    return resolver ? resolver(name, () => resolve(index + 1)) : base();
  };
  return resolve(0);
}

/** A built-in tool's row as Pi's interactive mode draws it, with `resolvers` in the chain over Pi's own renderers. */
export async function builtinHost(
  name: BuiltinTool,
  args: unknown,
  resolvers: Parameters<typeof resolveChain>[0] = [],
  options: { outputPad?: number } = {},
) {
  const base = await piRenderers(name);
  const renderers = resolveChain(resolvers, name, () => base);
  if (!renderers) throw new Error(`no renderers resolved for ${name}`);
  return toolRowHost(renderers, args, options);
}

/**
 * What Pi's tool puts in the result of a call, run for real over `cwd`: the thrown message of a
 * failing call becomes an error result, as Pi's agent loop makes it.
 */
export async function realTool(
  name: BuiltinTool,
  args: Record<string, unknown>,
  cwd: string,
): Promise<RowResult & { structuredContent?: unknown }> {
  const definition = definitionOf(await loadPi(), name, cwd);
  const context = {
    cwd,
    sessionManager: {
      getSessionId: () => "probe",
      getSessionFile: () => undefined,
    },
  };
  try {
    return await (
      definition.execute as (...a: unknown[]) => Promise<RowResult>
    )("call-1", args, undefined, undefined, context);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
  }
}

/** One tool call and its saved result, to be put in a session before it is exported. */
export interface SavedCall {
  name: string;
  args: Record<string, unknown>;
  result: RowResult;
}

/**
 * Pi's HTML export of a session holding `calls`, with `extension` loaded: the real
 * `AgentSession.exportToHtml`, so the export template's own skip list decides which tools reach
 * the extension's resolver. Returns the HTML.
 */
export async function piExport(
  extension: ExtensionFactory,
  calls: readonly SavedCall[],
): Promise<string> {
  const runtime = await shellRuntime({ extensions: [extension] });
  const { session } = runtime;
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  session.sessionManager.appendMessage({
    role: "user",
    content: "go",
    timestamp: 1,
  });
  session.sessionManager.appendMessage({
    role: "assistant",
    content: calls.map((c, i) => ({
      type: "toolCall",
      id: `call-${i}`,
      name: c.name,
      arguments: c.args,
    })),
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage,
    stopReason: "toolUse",
    timestamp: 2,
  } as never);
  calls.forEach((c, i) => {
    session.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: `call-${i}`,
      toolName: c.name,
      content: c.result.content,
      details: c.result.details,
      isError: c.result.isError ?? false,
      timestamp: 3 + i,
    } as never);
  });
  const file = `${scratchDir("export")}/export.html`;
  await session.exportToHtml(file);
  return readFileSync(file, "utf8");
}

/** What an export pre-rendered from the tool renderers, by tool-call id: its call, and its result collapsed and expanded, as HTML. */
export function exportedRows(html: string): Record<
  string,
  {
    callHtml?: string;
    resultHtmlCollapsed?: string;
    resultHtmlExpanded?: string;
  }
> {
  const encoded = html.match(/[A-Za-z0-9+/]{1000,}={0,2}/)?.[0] ?? "";
  const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  return data.renderedTools ?? {};
}

/** The colour each thinking level's rule is drawn in by `piTheme`. */
const THINKING_COLOURS: Readonly<Record<string, string>> & { off: string } = {
  off: "#505050",
  minimal: "#6e6e6e",
  low: "#5f87af",
  medium: "#81a2be",
  high: "#b294bb",
  xhigh: "#d183e8",
};

/**
 * The Pi `Theme` a `custom()` factory is handed, as far as skyr reads it: `plainTheme`'s colours
 * and a plain `style`, the token-name `fg`/`bg`/`bold` drawing text unchanged, and a
 * `getThinkingBorderColor` that colours by level as Pi's does.
 */
export function piTheme(): Theme {
  const theme = {
    ...plainTheme,
    fg: (_token: string, text: string) => text,
    bg: (_token: string, text: string) => text,
    bold: (text: string) => text,
    getThinkingBorderColor: (level: string) => (text: string) =>
      styleText(
        text,
        { fg: parseColor(THINKING_COLOURS[level] ?? THINKING_COLOURS.off) },
        "truecolor",
      ),
  };
  // Pi's Theme is a class with private state; the dialog reads only these members
  return theme as unknown as Theme;
}

const ESC = "\x1b";
const BEL = "\x07";
const cp = (...points: number[]) => String.fromCodePoint(...points);

/** Strings a terminal row can meet: wide, joined, combining, control, hostile and oversized. */
export const CORPUS: readonly string[] = [
  "hello world",
  cp(0x6f22, 0x5b57, 0x304b, 0x306a),
  cp(0x1f44d),
  cp(0x1f9d1, 0x200d, 0x1f4bb),
  cp(0x2714, 0xfe0f),
  `e${cp(0x301)}`,
  "a\tb",
  `${ESC}[2J`,
  `${ESC}]8;;https://x.test${BEL}link${ESC}]8;;${BEL}`,
  `${ESC}]52;c;cHduZWQ=${BEL}`,
  `${ESC}[1m${ESC}[31mbold ${ESC}[4mnested${ESC}[0m plain`,
  `${cp(0x202e)}rtl`,
  `zero${cp(0x200b)}width`,
  "• × ■ □ ← ─ … ·",
  "x".repeat(300),
  "",
];

/** Every width a pane can have in tests, 0 through 200. */
export const WIDTHS_SWEEP: readonly number[] = Array.from(
  { length: 201 },
  (_, i) => i,
);

type Footer = Component & { dispose?(): void };

/** What a footer factory is handed to draw with: the part of Pi's `TUI` skyr reads. */
interface FooterTui {
  requestRender(): void;
  terminal: { rows: number; columns: number };
}

/**
 * A recording `setFooter` that holds the footer as Pi does: a set disposes the held component
 * first, then calls the factory with `(tui, theme, footerData)` and holds what it returns.
 * `footerData` is Pi's read-only provider over state the test controls. The held footer is
 * disposed when the test ends.
 */
function footerHost() {
  let held: Footer | undefined;
  // Pi disposes the footer when its session ends, which is what releases the footer's clock tick
  onTestFinished(() => {
    held?.dispose?.();
    held = undefined;
  });
  let renderRequests = 0;
  const waiting: (() => void)[] = [];
  let branch: string | null | Error = "main";
  const statuses = new Map<string, string>();
  const listeners = new Set<() => void>();
  const footerData = {
    getGitBranch() {
      if (branch instanceof Error) throw branch;
      return branch;
    },
    getExtensionStatuses: () => statuses as ReadonlyMap<string, string>,
    getAvailableProviderCount: () => 1,
    onBranchChange(callback: () => void) {
      listeners.add(callback);
      return () => void listeners.delete(callback);
    },
  };
  return {
    /** The extension statuses `getExtensionStatuses` reports; a test fills it. */
    statuses,
    /** The component Pi holds in the footer slot, if an extension set one. */
    footer: (): Footer | undefined => held,
    /** How many repaints the footer has asked of Pi's TUI. */
    renders: () => renderRequests,
    /** Settles at the footer's next repaint request, which is how a test waits for an event-driven change. */
    nextRender: () => new Promise<void>((done) => waiting.push(done)),
    /** Branch subscribers still live. */
    subscribers: () => listeners.size,
    /**
     * Changes the branch and tells the subscribers, as Pi's git watcher does. An `Error` makes
     * `getGitBranch` throw it from then on.
     */
    setBranch(next: string | null | Error) {
      branch = next;
      for (const callback of [...listeners]) callback();
    },
    /** Disposes the held footer and empties the slot, as Pi's `resetExtensionUI` does. */
    resetFooter() {
      held?.dispose?.();
      held = undefined;
    },
    setFooter(
      factory:
        | ((
            tui: FooterTui,
            theme: typeof plainTheme,
            data: typeof footerData,
          ) => Footer)
        | undefined,
    ) {
      held?.dispose?.();
      held = undefined;
      if (!factory) return;
      held = factory(
        {
          requestRender() {
            renderRequests++;
            for (const done of waiting.splice(0)) done();
          },
          terminal: { rows: 40, columns: 100 },
        },
        plainTheme,
        footerData,
      );
    },
  };
}

/** One call skyr made on a UI context. */
interface UiCall {
  method: string;
  args: unknown[];
}

/**
 * A UI context that records every surface call skyr can make, in order. `setWidget` and
 * `setFooter` also hold what they are given as `widgetHost` and `footerHost` do; `overrides`
 * replace any method.
 */
export function recordingUi(overrides: Partial<ExtensionUIContext> = {}) {
  const { setWidget, ...widgets } = widgetHost();
  const { setFooter, ...footers } = footerHost();
  const calls: UiCall[] = [];
  const recorder =
    (method: string, then?: (...args: never[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return then?.(...(args as never[]));
    };
  const methods = {
    setWidget: recorder("setWidget", setWidget),
    setStatus: recorder("setStatus"),
    setTitle: recorder("setTitle"),
    setFooter: recorder("setFooter", setFooter),
    setWorkingIndicator: recorder("setWorkingIndicator"),
    setWorkingMessage: recorder("setWorkingMessage"),
    setEditorComponent: recorder("setEditorComponent"),
    getEditorComponent: recorder("getEditorComponent"),
    notify: recorder("notify"),
    theme: plainTheme,
  };
  // The object holds the surface skyr calls, not Pi's whole context: one cast, here.
  const ui = { ...methods, ...overrides } as unknown as ExtensionUIContext;
  return { ui, calls, ...widgets, ...footers };
}

/**
 * A status indicator as Pi hands one to the editor, in colours that need no initialised theme:
 * a `WorkingStatusIndicator` for `working`, the base class for the other kinds (their subclasses
 * reach for the global theme). `color` stands in for Pi's spinner and message colours, and
 * `indicator` for the options an extension set, `requestRender` for what Pi's TUI would do on
 * a tick. Disposed when the test ends.
 */
export function realIndicator(
  kind: indicators.StatusIndicator["kind"],
  message = "Working",
  {
    indicator,
    color = (text: string) => text,
    requestRender = () => {},
  }: {
    indicator?: WorkingIndicatorOptions;
    color?: (text: string) => string;
    requestRender?: () => void;
  } = {},
): indicators.StatusIndicator {
  const ui = { requestRender } as never;
  const made =
    kind === "working"
      ? new indicators.WorkingStatusIndicator(ui, message, indicator, color)
      : new indicators.StatusIndicator(
          kind,
          ui,
          color,
          color,
          message,
          indicator,
        );
  onTestFinished(() => made.dispose());
  return made;
}
