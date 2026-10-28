/** Tool rows: segments in their colours, a running row's clock, and the text message renderer. */
import type {
  MessageRenderer,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Text,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { glyphsOf, tierOf } from "../ui/caps.js";
import { fitToWidth } from "../ui/fit.js";
import { sanitize } from "../ui/text.js";

export type Segment = [color: ThemeColor, text: string, bold?: boolean];

/** Segments in their colours, as given: the caller has made their text safe to draw. */
function styled(
  theme: Pick<Theme, "fg" | "bold">,
  segments: Segment[],
): string {
  return segments
    .map(([color, text, bold]) =>
      theme.fg(color, bold ? theme.bold(text) : text),
    )
    .join("");
}

/**
 * One line of `segments` (their text already safe to draw), cut by columns at render with the
 * tier's ellipsis before styling, and padded to the width. Unlike `TruncatedText`, whose cut
 * puts an SGR reset before its ellipsis, the colours run unbroken to the edge.
 */
export function segmentRow(
  theme: Pick<Theme, "fg" | "bold">,
  segments: Segment[],
): Component {
  const padded = (line: string, width: number) =>
    line + " ".repeat(Math.max(0, width - visibleWidth(line)));
  return {
    invalidate() {},
    render(width) {
      if (width <= 0) return [""];
      const plain = segments.map(([, text]) => text).join("");
      if (visibleWidth(plain) <= width)
        return [padded(styled(theme, segments), width)];
      const { ellipsis } = glyphsOf(tierOf(process.env));
      const withEllipsis = visibleWidth(ellipsis) < width;
      let left = fitToWidth(
        plain,
        withEllipsis ? width - visibleWidth(ellipsis) : width,
        "",
      ).length;
      const shown: Segment[] = [];
      for (const [color, text, bold] of segments) {
        if (left <= 0 && shown.length > 0) break;
        shown.push([color, text.slice(0, left), bold]);
        left -= text.length;
      }
      const last = shown.at(-1);
      if (withEllipsis && last) shown.push([last[0], ellipsis]);
      return [padded(styled(theme, shown), width)];
    },
  };
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
