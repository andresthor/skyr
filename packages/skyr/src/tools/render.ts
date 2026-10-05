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
 * byte-order mark, and tag characters. ZWJ and ZWNJ are left out on purpose, since they
 * carry meaning in emoji sequences and in Persian and Indic text.
 */
const INVISIBLE =
  /(?![\n\t])[\p{Cc}\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;

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
