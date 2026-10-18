/**
 * Text that reaches a terminal or a model. Tool rows, and the one set of invisible characters
 * stripped from anything a model, a web page or a server produced.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, TruncatedText } from "@earendil-works/pi-tui";

export type Segment = [color: ThemeColor, text: string, bold?: boolean];

/**
 * Characters that take no width but change what text means: C0 and C1 controls other than
 * newline and tab, the soft hyphen, bidi marks, overrides and isolates, zero-widths, the
 * byte-order mark, interlinear annotation marks, tag characters, and lone surrogates (measured
 * as zero columns, printed as a one-column U+FFFD). ZWJ and ZWNJ are left out on purpose, since
 * they carry meaning in emoji sequences and in Persian and Indic text.
 */
const INVISIBLE =
  /(?![\n\t])[\p{Cc}\p{Cs}\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;

/** Strips invisible characters, keeping newlines and tabs so a page's markdown survives. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/**
 * One-line row text: drops whole terminal sequences, collapses whitespace, then strips
 * invisible characters. Newlines become spaces, so this is not for body text a model reads.
 */
export function sanitize(raw: string): string {
  // Whole sequences first: dropping the escape byte alone leaves the payload as visible text.
  return stripInvisible(stripTerminalSequences(raw).replace(/\s+/g, " "));
}

/** Model-supplied text bound for an error message: its length is unbounded, so keep it readable. */
/** The errno of a filesystem/DNS error ("ENOENT", …), "error" when it has none. */
export function errnoOf(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  return typeof code === "string" ? code : "error";
}

export function clip(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function toolRow(theme: Theme, segments: Segment[]): TruncatedText {
  const line = segments
    .map(([color, raw, bold]) => {
      const text = sanitize(raw);
      return theme.fg(color, bold ? theme.bold(text) : text);
    })
    .join("");
  return new TruncatedText(line);
}

/** The first line of a thrown tool's message, for its red row, followed by `after`. */
export function errorRow(
  theme: Theme,
  content: { type: string; text?: string }[],
  after: Segment[] = [],
): TruncatedText {
  const text = content.find((c) => c.type === "text")?.text ?? "";
  return toolRow(theme, [["error", text.split("\n")[0] ?? ""], ...after]);
}

/** A timed row's clock, kept in the row's `context.state`, which Pi shares across its renders. */
export interface Timing {
  startedAt?: number;
  endedAt?: number;
  ticker?: ReturnType<typeof setInterval>;
}

export function seconds(ms: number): Segment[] {
  return [["muted", ` · ${(ms / 1000).toFixed(1)}s`]];
}

// Pi can drop a running row before its result renders (a chat rebuild, an HTML export), and
// only `took` stops the ticker; this bound, well past any web tool's deadline, stops it otherwise.
const TICK_LIMIT_MS = 5 * 60_000;

/**
 * For `renderCall`: starts the clock when Pi starts executing the call and redraws the row each
 * second until `took` stops it. Returns the running time as a row suffix; nothing before the start
 * or after the result. A row the TUI rebuilds from a saved session never starts; an HTML export
 * starts and ends each row at once, so it shows ` · 0.0s`, as Pi's bash row shows `Took 0.0s`.
 */
export function elapsed(context: {
  state: Timing;
  executionStarted: boolean;
  invalidate: () => void;
}): Segment[] {
  const { state } = context;
  if (context.executionStarted && state.startedAt === undefined) {
    const startedAt = Date.now();
    state.startedAt = startedAt;
    state.ticker = setInterval(() => {
      if (Date.now() - startedAt < TICK_LIMIT_MS) context.invalidate();
      else clearInterval(state.ticker);
    }, 1000);
  }
  if (state.startedAt === undefined || state.endedAt !== undefined) return [];
  return seconds(Date.now() - state.startedAt);
}

/**
 * For `renderResult`: on a final result, or an error, stops the clock and returns the time taken;
 * a partial result is mid-stream, so it keeps the clock running.
 */
export function took(context: {
  state: Timing;
  isError?: boolean;
  isPartial?: boolean;
}): Segment[] {
  const { state } = context;
  if (state.startedAt === undefined) return [];
  if (context.isPartial && !context.isError)
    return seconds(Date.now() - state.startedAt);
  state.endedAt ??= Date.now();
  clearInterval(state.ticker);
  state.ticker = undefined;
  return seconds(state.endedAt - state.startedAt);
}
