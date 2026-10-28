/**
 * Fixtures shared by the ui tests: Pi's real screen renderer over a silent terminal, to learn
 * what Pi does with a component's lines.
 */
import {
  CustomMessageComponent,
  type ExtensionUIContext,
  initTheme,
  type MessageRenderer,
  ToolExecutionComponent,
  type ToolRenderers,
  type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Terminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { onTestFinished } from "vitest";
// biome-ignore lint/style/noRestrictedImports: Pi builds its HTML export of tool rows with this but does not export it from its root
import { createToolHtmlRenderer } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";
// biome-ignore lint/style/noRestrictedImports: Pi builds its status indicators with these classes but does not export them from its root
import * as indicators from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js";
import { plainTheme, scratchDir, widgetHost } from "./session.js";
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

/** One call skyr made on a UI context. */
interface UiCall {
  method: string;
  args: unknown[];
}

/**
 * A UI context that records every surface call skyr can make, in order. `setWidget` also holds
 * widgets as `widgetHost` does; `overrides` replace any method.
 */
export function recordingUi(overrides: Partial<ExtensionUIContext> = {}) {
  const { setWidget, ...widgets } = widgetHost();
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
    setFooter: recorder("setFooter"),
    setWorkingIndicator: recorder("setWorkingIndicator"),
    setWorkingMessage: recorder("setWorkingMessage"),
    setEditorComponent: recorder("setEditorComponent"),
    getEditorComponent: recorder("getEditorComponent"),
    notify: recorder("notify"),
    theme: plainTheme,
  };
  // The object holds the surface skyr calls, not Pi's whole context: one cast, here.
  const ui = { ...methods, ...overrides } as unknown as ExtensionUIContext;
  return { ui, calls, ...widgets };
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
