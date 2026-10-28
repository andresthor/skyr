/**
 * Fixtures shared by the ui tests: Pi's real screen renderer over a silent terminal, to learn
 * what Pi does with a component's lines.
 */
import {
  type Component,
  type Terminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { scratchDir } from "./session.js";

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
