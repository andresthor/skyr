/**
 * Text that reaches a terminal or a model. Tool rows, key names for hints, and the cut that keeps a
 * row inside its width.
 */
import type {
  KeybindingsManager,
  MessageRenderer,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  sliceByColumn,
  Text,
  TruncatedText,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { sanitize } from "../ui/text.js";

export type Segment = [color: ThemeColor, text: string, bold?: boolean];

/**
 * The first key bound to `id`, spelled as Pi spells a key (`option` for `alt` on macOS); empty
 * when unbound. Not Pi's `keyText`: that reads the global bindings instead of `keys`, names
 * every bound key, and lives in pi-coding-agent, which a render path cannot load synchronously.
 */
export function keyName(
  keys: Pick<KeybindingsManager, "getKeys">,
  id: Parameters<KeybindingsManager["getKeys"]>[0],
): string {
  const key = keys.getKeys(id)[0] ?? "";
  return process.platform === "darwin"
    ? key.replace(/\balt\b/g, "option")
    : key;
}

/**
 * `text` whole when it fits in `cols` columns, else cut by whole columns to end in `ellipsis`,
 * with no escape added: unlike `truncateToWidth`, whose SGR reset around the ellipsis ends the
 * colour or background the text is drawn in, and puts escapes into a TERM=dumb row.
 */
export function cutToWidth(
  text: string,
  cols: number,
  ellipsis: string,
): string {
  return visibleWidth(text) <= cols
    ? text
    : `${sliceByColumn(text, 0, cols - visibleWidth(ellipsis), true)}${ellipsis}`;
}

/** Segments in their colours, as given: the caller has made their text safe to draw. */
export function styled(
  theme: Pick<Theme, "fg" | "bold">,
  segments: Segment[],
): string {
  return segments
    .map(([color, text, bold]) =>
      theme.fg(color, bold ? theme.bold(text) : text),
    )
    .join("");
}

export function toolRow(theme: Theme, segments: Segment[]): TruncatedText {
  return new TruncatedText(
    styled(
      theme,
      segments.map(([color, raw, bold]) => [color, sanitize(raw), bold]),
    ),
  );
}

/** The first line of a result's first text block; empty when it has none. */
export function firstLine(content: { type: string; text?: string }[]): string {
  const text = content.find((c) => c.type === "text")?.text ?? "";
  return text.split("\n")[0] ?? "";
}

/** The first line of a thrown tool's message, for its red row, followed by `after`. */
export function errorRow(
  theme: Theme,
  content: { type: string; text?: string }[],
  after: Segment[] = [],
): TruncatedText {
  return toolRow(theme, [["error", firstLine(content)], ...after]);
}

/** A timed row's clock, kept in the row's `context.state`, which Pi shares across its renders. */
export interface Timing {
  startedAt?: number;
  endedAt?: number;
  /** Present while the shared ticker redraws the row. */
  redraw?: () => void;
}

/** A token count: exact below a thousand, else rounded to thousands. */
export function tokens(n: number): string {
  return n < 1000 ? `${n} tok` : `${Math.round(n / 1000)}k tok`;
}

/** A span as a row shows it, to a tenth of a second: `3.0s`. */
export const secondsText = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function seconds(ms: number): Segment[] {
  return [["muted", ` · ${secondsText(ms)}`]];
}

// Only `took` stops a row's ticking, and Pi can drop a running row first (a chat rebuild, an
// HTML export); past this bound its clock freezes.
const TICK_LIMIT_MS = 5 * 60_000;

/** The running rows, redrawn each second by one ticker that runs only while a row is here. */
const ticking = new Set<Timing>();
let ticker: ReturnType<typeof setInterval> | undefined;

function startTicking(state: Timing, redraw: () => void): void {
  state.redraw = redraw;
  ticking.add(state);
  ticker ??= setInterval(() => {
    const now = Date.now();
    for (const row of ticking)
      if (now - (row.startedAt ?? now) < TICK_LIMIT_MS) row.redraw?.();
      else stopTicking(row);
  }, 1000);
}

function stopTicking(state: Timing): void {
  ticking.delete(state);
  state.redraw = undefined;
  if (ticking.size > 0 || ticker === undefined) return;
  clearInterval(ticker);
  ticker = undefined;
}

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
    state.startedAt = Date.now();
    startTicking(state, context.invalidate);
  }
  if (state.startedAt === undefined || state.endedAt !== undefined) return [];
  return seconds(Date.now() - state.startedAt);
}

/**
 * For `renderResult`: on a final result, or an error, stops the clock and returns the time taken,
 * Pi's recorded `durationMs` when it has one, so a row rebuilt from a saved session shows it too;
 * a partial result is mid-stream, so it keeps the clock running.
 */
export function took(context: {
  state: Timing;
  isError?: boolean;
  isPartial?: boolean;
  durationMs?: number | undefined;
}): Segment[] {
  const { state } = context;
  if (context.isPartial && !context.isError)
    return state.startedAt === undefined
      ? []
      : seconds(Date.now() - state.startedAt);
  if (state.startedAt !== undefined) {
    state.endedAt ??= Date.now();
    stopTicking(state);
  }
  if (context.durationMs !== undefined) return seconds(context.durationMs);
  return state.startedAt === undefined || state.endedAt === undefined
    ? []
    : seconds(state.endedAt - state.startedAt);
}

/** A message's text, one sanitized line per line. */
export function messageLines(
  message: Pick<Parameters<MessageRenderer>[0], "content">,
): string[] {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  return text.split("\n").map(sanitize);
}

/**
 * Draws a message as its text, one sanitized line per line, cut to `previewLines` until
 * expanded. Its text carries a model's or a process's output, which Pi's default renderer would
 * draw as markdown with its escape sequences intact.
 */
export function textMessageRenderer(previewLines: number): MessageRenderer {
  return (message, { expanded, outputPad }, theme) => {
    const lines = messageLines(message);
    const shown = expanded ? lines : lines.slice(0, previewLines);
    const hidden = lines.length - shown.length;
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(
      new Text(
        [
          ...shown,
          ...(hidden > 0 ? [theme.fg("muted", `… ${hidden} more lines`)] : []),
        ].join("\n"),
        0,
        0,
      ),
    );
    return box;
  };
}
