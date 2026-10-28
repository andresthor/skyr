/**
 * A tool's transcript row as a ledger record (`renderShell: "self"`). Pi stacks two components
 * for a row, the call's and the result's, and draws no frame for a `"self"` tool; the record is
 * one line, so it is drawn once. The call component draws it, at paint time, from the result
 * the result renderer stored in `context.state` in the same update; the result component then
 * draws nothing. It draws the whole row itself only when the call component never drew a
 * settled one: in an HTML export, which draws the call before any result exists, or when
 * `renderCall` threw and Pi drew its own text.
 *
 * An HTML export draws `renderCall` with `isPartial: true` and nothing in its context tells
 * that from a live call, so every finished skyr row there has its running head above it.
 *
 * Nothing here ticks. A running row is static, because a line that changes above the viewport
 * makes Pi's regular renderer clear the terminal's scrollback.
 */
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Markdown,
  type MarkdownTheme,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { glyphsOf, tierOf } from "./caps.js";
import { fitToWidth } from "./fit.js";
import { formatDuration, plural } from "./format.js";
import { type Paint, styled } from "./palette.js";
import {
  drawRail,
  drawRecord,
  type Fact,
  type RecordSpec,
  railRoom,
} from "./record.js";
import { sanitize } from "./text.js";

export interface Row {
  readonly head: RecordSpec;
  /** Child records under the head (a lane tree). */
  readonly children?: readonly RecordSpec[];
  /**
   * Lines under the record, all sanitized. Until the row is expanded only the first `collapsed`
   * show, with a muted note of how many are hidden; expanded shows them all. With `markdown`
   * ink the lines are markdown source, drawn with Pi's markdown colours in the colour tier and as
   * plain text in the others; the count is of the lines it comes to at the width.
   */
  readonly rail?: {
    readonly lines: readonly string[];
    readonly collapsed: number;
    readonly ink: "muted" | "text" | "markdown";
  };
}

/** A final result as Pi hands it to `renderResult`. */
export interface Settled {
  readonly content: readonly { type: string; text?: string }[];
  readonly details: unknown;
  readonly isError: boolean;
  /** Pi's measure of the call; absent for a result saved before Pi recorded it, and in an export. */
  readonly durationMs?: number;
}

export interface ToolView<Args> {
  /** Streaming arguments are partial: any field can be missing. */
  readonly args: Readonly<Partial<Args>>;
  readonly settled?: Settled;
  readonly expanded: boolean;
}

/** What `renderCall` and `renderResult` share through Pi's `context.state`. */
interface RowState {
  settled?: Settled;
  /** Whether the call component drew the settled record at its last paint. */
  drew?: boolean;
}

type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

const paintOf = (theme: Theme): Paint => ({
  theme,
  mode: tierOf(process.env),
});

/** Pi's markdown colours, read from the theme a renderer is handed, as `getMarkdownTheme` reads the global. */
const markdownThemeOf = (theme: Theme): MarkdownTheme => ({
  heading: (text) => theme.fg("mdHeading", text),
  link: (text) => theme.fg("mdLink", text),
  linkUrl: (text) => theme.fg("mdLinkUrl", text),
  code: (text) => theme.fg("mdCode", text),
  codeBlock: (text) => theme.fg("mdCodeBlock", text),
  codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
  quote: (text) => theme.fg("mdQuote", text),
  quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
  hr: (text) => theme.fg("mdHr", text),
  listBullet: (text) => theme.fg("mdListBullet", text),
  bold: (text) => theme.bold(text),
  italic: (text) => theme.italic(text),
  underline: (text) => theme.underline(text),
  strikethrough: (text) => theme.strikethrough(text),
});

const isDrawn = (line: string) => stripTerminalSequences(line).trim() !== "";

/** What a drawn component keeps between paints: markdown caches its parse by text and width. */
interface Memo {
  markdown?: Markdown;
  source?: string;
}

function markdownLines(
  theme: Theme,
  memo: Memo,
  source: string,
  width: number,
): string[] {
  if (!memo.markdown)
    memo.markdown = new Markdown(source, 0, 0, markdownThemeOf(theme));
  else if (memo.source !== source) memo.markdown.setText(source);
  memo.source = source;
  // Markdown pads each line out to the width
  const lines = memo.markdown.render(width).map((line) => line.trimEnd());
  while (lines.length > 0 && !isDrawn(lines.at(-1) ?? "")) lines.pop();
  return lines;
}

function linesOf(
  theme: Theme,
  memo: Memo,
  row: Row,
  expanded: boolean,
  width: number,
  pad: number,
): string[] {
  const paint = paintOf(theme);
  const { ellipsis } = glyphsOf(paint.mode);
  const out = [drawRecord(paint, row.head, width, pad)];
  for (const child of row.children ?? [])
    out.push(drawRecord(paint, child, width, pad));
  const { rail } = row;
  if (!rail) return out;
  const wantsMarkdown = rail.ink === "markdown";
  // Markdown draws 24-bit colour, hyperlinks and Unicode rules, which NO_COLOR and TERM=dumb forbid
  const markdown = wantsMarkdown && paint.mode === "color";
  const rendered = markdown
    ? markdownLines(
        theme,
        memo,
        rail.lines.join("\n"),
        railRoom(paint, width, pad),
      )
    : rail.lines;
  // A preview of markdown spends its lines on text, not on the blank lines between blocks
  const lines =
    wantsMarkdown && !expanded ? rendered.filter(isDrawn) : rendered;
  const shown = expanded ? lines : lines.slice(0, rail.collapsed);
  const ink = markdown ? "styled" : wantsMarkdown ? "text" : rail.ink;
  out.push(...drawRail(paint, shown, ink, width, pad));
  const hidden = lines.length - shown.length;
  if (hidden > 0)
    out.push(
      ...drawRail(
        paint,
        [`${ellipsis} ${plural(hidden, "more line")}`],
        "muted",
        width,
        pad,
      ),
    );
  return out;
}

/**
 * A component that draws at paint time, outside any handler Pi guards: a throw while drawing
 * becomes one line naming the cause, and every line is cut to the width.
 */
function drawn(render: (width: number) => string[]): Component {
  return {
    invalidate() {},
    render(width) {
      if (width <= 0) return [];
      try {
        return render(width).map((line) => fitToWidth(line, width, ""));
      } catch (cause) {
        const mark = glyphsOf(tierOf(process.env)).mark.failed;
        const why = sanitize(
          cause instanceof Error ? cause.message : String(cause),
        );
        return [fitToWidth(`${mark} row failed to draw: ${why}`, width, "")];
      }
    },
  };
}

const argsOf = <Args>(args: unknown): Partial<Args> =>
  typeof args === "object" && args !== null ? args : {};

/**
 * The `renderCall` and `renderResult` of a ledger row. `view` is pure and total: it is handed
 * partial arguments while they stream, no result while the call runs, and details of any shape
 * a saved session may hold. It runs at paint time, so a throw in it or in drawing becomes one
 * line carrying the cause instead of leaving Pi's renderer.
 */
export function toolRenderers<Args>(view: (v: ToolView<Args>) => Row) {
  return {
    renderShell: "self" as const,
    renderCall(args: unknown, theme: Theme, context: Context): Component {
      const state: RowState = context.state;
      const { expanded, outputPad } = context;
      const memo: Memo = {};
      return drawn((width) => {
        state.drew = state.settled !== undefined;
        const row = view({
          args: argsOf<Args>(args),
          settled: state.settled,
          expanded,
        });
        return linesOf(theme, memo, row, expanded, width, outputPad);
      });
    },
    renderResult(
      result: Pick<Settled, "content" | "details">,
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: Context,
    ): Component {
      const state: RowState = context.state;
      if (!options.isPartial)
        state.settled = {
          content: result.content,
          details: result.details,
          isError: context.isError,
          durationMs: context.durationMs,
        };
      const { expanded } = options;
      const memo: Memo = {};
      return drawn((width) => {
        if (state.drew || state.settled === undefined) return [];
        const row = view({
          args: argsOf<Args>(context.args),
          settled: state.settled,
          expanded,
        });
        return linesOf(theme, memo, row, expanded, width, context.outputPad);
      });
    },
  };
}

/**
 * The first line of a result's text, sanitized, with a leading `<tool>: ` removed: a record
 * already says which tool failed, and the model-facing message names it.
 */
export function reasonOf(content: Settled["content"], tool: string): string {
  const text = content.find((c) => c.type === "text")?.text ?? "";
  const first = sanitize(text.split("\n")[0] ?? "").trim();
  return first.startsWith(`${tool}: `) ? first.slice(tool.length + 2) : first;
}

/** The lines of a result's text after the first, sanitized, blank ones dropped: a failure's rail. */
export function restOf(content: Settled["content"]): string[] {
  const text = content.find((c) => c.type === "text")?.text ?? "";
  return text
    .split("\n")
    .slice(1)
    .map((line) => sanitize(line).trim())
    .filter((line) => line !== "");
}

/** Pi's measure of the call as a fact; none without one. */
export function durationFact(settled: Settled | undefined): Fact[] {
  return settled?.durationMs === undefined
    ? []
    : [{ text: formatDuration(settled.durationMs), kind: "measure" }];
}

/**
 * A custom message as ledger records, or as its text where `records` finds none or throws.
 * Returning undefined or throwing would hand the message to Pi's purple box, which draws a
 * model's or a process's text as markdown with its escape sequences intact, so this does
 * neither. Collapsed, the text shows `previewLines` of its lines.
 */
export function messageComponent(
  theme: Theme,
  message: { content: string | readonly { type: string; text?: string }[] },
  options: { expanded: boolean; outputPad: number },
  previewLines: number,
  records: (text: string) => readonly Row[] | undefined,
): Component {
  const { expanded, outputPad } = options;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const asText = (before: string[] = []) =>
    drawn((width) => {
      const paint = paintOf(theme);
      const lines = [...before, ...text.split("\n").map(sanitize)];
      const shown = expanded ? lines : lines.slice(0, previewLines);
      const hidden = lines.length - shown.length;
      return [
        ...shown,
        ...(hidden > 0
          ? [`${glyphsOf(paint.mode).ellipsis} ${plural(hidden, "more line")}`]
          : []),
      ].map(
        (line) =>
          `${" ".repeat(outputPad)}${styled(paint, fitToWidth(line, Math.max(0, width - 2 * outputPad), glyphsOf(paint.mode).ellipsis), { fg: paint.theme.colors.muted })}`,
      );
    });
  try {
    const rows = records(text);
    if (!rows) return asText();
    const memos = rows.map((): Memo => ({}));
    return drawn((width) =>
      rows.flatMap((row, i) =>
        linesOf(theme, memos[i] ?? {}, row, expanded, width, outputPad),
      ),
    );
  } catch (cause) {
    const mark = glyphsOf(tierOf(process.env)).mark.failed;
    const why = sanitize(
      cause instanceof Error ? cause.message : String(cause),
    );
    return asText([`${mark} could not draw this message: ${why}`]);
  }
}

type Head = Omit<RecordSpec, "mark" | "facts">;

/** A failed call: its reason as the explaining fact, and the rest of its message on a rail. */
export function failedRow(head: Head, settled: Settled, tool: string): Row {
  return {
    head: {
      ...head,
      mark: "failed",
      facts: [
        { text: reasonOf(settled.content, tool), kind: "explain" },
        ...durationFact(settled),
      ],
    },
    rail: { lines: restOf(settled.content), collapsed: 3, ink: "muted" },
  };
}

/** A result whose details this build does not know: done, with the result's first line. */
export function plainRow(head: Head, settled: Settled, tool: string): Row {
  return {
    head: {
      ...head,
      mark: "done",
      facts: [
        { text: reasonOf(settled.content, tool), kind: "measure" },
        ...durationFact(settled),
      ],
    },
  };
}
