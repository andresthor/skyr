/**
 * Fixtures shared by the ui tests: Pi's real screen renderer over a silent terminal, to learn
 * what Pi does with a component's lines.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Terminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { plainTheme, scratchDir, widgetHost } from "./session.js";

function silentTerminal(columns: number, rows: number): Terminal {
  return {
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
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
