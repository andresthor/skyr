/**
 * The working line: one row above an editor's top rule while Pi works, with a spinner, what the
 * agent is doing, the time since the run began and the key that interrupts it.
 *
 * Pi hands a status indicator to an editor that asks for it, and the editor's own top rule then
 * carries the status. This mixin takes the indicator instead and keeps it, so the rule stays
 * plain, and gives it back for any frame the line cannot be drawn in: a short terminal, an
 * indicator in a shape it does not know, a throw. Pi's status is then exactly what it would
 * have been without the mixin. The line owns no timer: it is redrawn when Pi's loader ticks, and
 * the glyph, the shimmer and the elapsed time are all read from the clock at each frame.
 */
import type {
  CustomEditor,
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { glyphsOf } from "../ui/caps.js";
import { fitToWidth } from "../ui/fit.js";
import { formatElapsed } from "../ui/format.js";
import { keyName } from "../ui/hint.js";
import { type Paint, styled } from "../ui/palette.js";
import { frameAt, situationOf, variantFor } from "../ui/spinner.js";
import { oneLine, sanitize } from "../ui/text.js";
import type { Working } from "./working.js";

// biome-ignore lint/suspicious/noExplicitAny: TypeScript accepts a class mixin only over an any[] constructor (TS2545)
type MixinArgs = any[];
type EditorClass = new (...args: MixinArgs) => CustomEditor;
type Indicator = NonNullable<
  Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]
>;

/** Implemented by an editor class under the line whose key hook takes the interrupt key while it is on. */
export interface InterruptClaim {
  readonly interruptTaken: boolean;
}

export interface WorkingLineDeps {
  readonly paint: Paint;
  readonly working: Working;
  /** Tells the user once that the line stopped drawing. */
  readonly notify: ExtensionUIContext["notify"];
}

type Token = keyof Paint["theme"]["colors"];
/** A piece of the line's plain text and the colour it is drawn in. */
type Part = readonly [plain: string, token: Token];

const widthOf = (parts: readonly Part[]) =>
  parts.reduce((sum, [plain]) => sum + visibleWidth(plain), 0);

/** Below this many terminal rows the editor needs the room more than a line does. */
const MIN_ROWS = 12;

/** Wide enough that Pi cuts no border text before the line does. */
const PROBE_WIDTH = 500;

/**
 * `Base` with a working line drawn above its top rule while Pi has handed it a working indicator;
 * Pi's in-border status whenever the line is off.
 */
export function withWorkingLine<B extends EditorClass>(
  Base: B,
  { paint, working, notify }: WorkingLineDeps,
): B {
  const glyphs = glyphsOf(paint.mode);

  class WorkingLineEditor extends Base {
    /** Pi's indicator, held here so the top rule stays plain while the line shows. */
    private held: Indicator | undefined;
    /** When `held` arrived: the line's glyph runs from here, as Pi's own spinner does. */
    private heldSince = 0;
    /** Drawing the line threw once: for this editor's life Pi's status stays in the rule. */
    private lineFailed = false;
    /** Rows drawn above the rule last frame, which a mouse event's row has to discount. */
    private head = 0;
    private readonly lineKeys: KeybindingsManager;

    constructor(...args: MixinArgs) {
      super(...args);
      this.lineKeys = (args as ConstructorParameters<typeof CustomEditor>)[2];
    }

    override setWorkingStatusIndicator(indicator: Indicator | undefined) {
      if (indicator !== this.held) this.heldSince = Date.now();
      this.held = indicator;
      super.setWorkingStatusIndicator(undefined);
    }

    override render(width: number): string[] {
      let line: string | undefined;
      // The editor is permanent, and its render is not caught: a throw here takes the input down
      try {
        line = this.lineFailed ? undefined : this.lineFor(width);
      } catch (cause) {
        this.lineFailed = true;
        const reason = cause instanceof Error ? cause.message : String(cause);
        queueMicrotask(() => {
          try {
            notify(
              `skyr: the working line stopped drawing after an error (${oneLine(reason, 120)}); /reload brings it back`,
              "warning",
            );
          } catch {
            // The session that would show it may be gone
          }
        });
      }
      // Decided before the base draws its rule, which shows a status only while it holds one
      super.setWorkingStatusIndicator(
        line === undefined ? this.held : undefined,
      );
      this.head = line === undefined ? 0 : 1;
      const body = super.render(width);
      return line === undefined ? body : [line, ...body];
    }

    // A click on the line becomes a click above the editor's first row, which it absorbs
    override handleMouse(event: TuiMouseEvent) {
      return super.handleMouse(
        this.head ? { ...event, y: event.y - this.head } : event,
      );
    }

    /** The parenthesis after the text, longest first: elapsed and the interrupt key, then elapsed alone. */
    private hints(elapsedMs: number): Part[][] {
      const elapsed = formatElapsed(elapsedMs);
      const open: Part = ["(", "dim"];
      const close: Part = [")", "dim"];
      // An extension's key hook may hold the interrupt key; naming it would promise the wrong stop
      const taken = (this as Partial<InterruptClaim>).interruptTaken === true;
      const key = taken ? "" : keyName(this.lineKeys, "app.interrupt");
      const short = [open, [elapsed, "dim"], close] satisfies Part[];
      return key
        ? [
            [
              open,
              [elapsed, "dim"],
              [glyphs.sep, "dim"],
              [key, "muted"],
              [" interrupt)", "dim"],
            ],
            short,
          ]
        : [short];
    }

    /** The row above the rule, or undefined when Pi's own status should show instead. */
    private lineFor(width: number): string | undefined {
      const held = this.held;
      if (!held || width <= 0 || this.tui.terminal.rows < MIN_ROWS)
        return undefined;
      const spinner = held.renderSpinnerInBorder(PROBE_WIDTH);
      const border = held.renderInBorder(PROBE_WIDTH);
      const rest = border.slice(spinner.length);
      // Anything but a spinner and its message is a shape this line does not know how to draw
      if (!spinner || !border.startsWith(spinner) || !/^( |$)/.test(rest))
        return undefined;
      // The working indicator is skyr's frames unless another extension set its own; theirs, or a
      // single frame that starts no interval, is left to Pi. Stripped, since the colour goes stale.
      if (
        held.kind === "working" &&
        !variantFor("thinking", paint.mode).frames.includes(
          stripTerminalSequences(spinner),
        )
      )
        return undefined;

      const now = Date.now();
      const state = working.state();
      const isWorking = held.kind === "working";
      // The agent's own action reads better than "Working"; Pi's text is all the other kinds have
      const text =
        (isWorking ? state.action : undefined) ?? sanitize(rest).trim();
      const glyph = frameAt(
        variantFor(situationOf(held.kind, state.tools), paint.mode),
        now - this.heldSince,
      );
      const pad = " ".repeat(
        Math.min(this.getPaddingX(), Math.floor((width - 1) / 2)),
      );
      const lead = pad.length + visibleWidth(glyph);

      const textWidth = visibleWidth(text);
      const hint = isWorking
        ? this.hints(now - (state.since ?? this.heldSince))
        : [];
      const tail = hint.find(
        (parts) => lead + 1 + textWidth + 2 + widthOf(parts) <= width,
      );
      const { colors } = paint.theme;
      const fg = (plain: string, token: Token) =>
        styled(paint, plain, { fg: colors[token] });
      const retrying = held.kind === "retry";
      const textToken: Token = retrying
        ? "warning"
        : isWorking
          ? "muted"
          : "text";
      let row = `${pad}${fg(glyph, retrying ? "warning" : "accent")}`;
      if (text && width - lead - 1 > 0) {
        row += ` ${fg(fitToWidth(text, width - lead - 1, glyphs.ellipsis), textToken)}`;
        if (tail)
          row += `  ${tail.map(([plain, token]) => fg(plain, token)).join("")}`;
      }
      return fitToWidth(row, width, "");
    }
  }
  return WorkingLineEditor;
}
