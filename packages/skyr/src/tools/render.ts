/**
 * One-line tool rows. Their text comes from models, web pages and servers, so it is
 * sanitised before pi-tui lays it out.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, TruncatedText } from "@earendil-works/pi-tui";

export type Segment = [color: ThemeColor, text: string, bold?: boolean];

/**
 * One-line row text: drops terminal sequences whole, then invisible characters, and collapses
 * whitespace. Strips newlines too, so it is not for body text a model reads.
 */
export function sanitize(raw: string): string {
  // Whole sequences first: dropping the escape byte alone leaves the payload as visible text.
  return stripTerminalSequences(raw)
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "");
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

/** The first line of a thrown tool's message, for its red row. */
export function errorRow(
  theme: Theme,
  content: { type: string; text?: string }[],
): TruncatedText {
  const text = content.find((c) => c.type === "text")?.text ?? "";
  return toolRow(theme, [["error", text.split("\n")[0] ?? ""]]);
}
