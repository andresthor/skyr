/**
 * Text that reaches a terminal or a model: the one set of invisible characters stripped from
 * anything a model, a web page or a server produced.
 */
import { stripTerminalSequences } from "@earendil-works/pi-tui";

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

/**
 * Model-supplied text bound for an error message: its length is unbounded, so keep it readable.
 * Cuts between grapheme clusters, so an emoji sequence, a flag or a letter with its accents is
 * kept whole or dropped whole.
 */
export function clip(text: string, max = 120): string {
  // A cluster is at least one code unit, so text this short cannot hold more than `max`
  if (text.length <= max) return text;
  const kept: string[] = [];
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of segments.segment(text)) {
    if (kept.length === max) return `${kept.join("")}…`;
    kept.push(segment);
  }
  return text;
}

/** Server- or vendor-written text bound for a one-line message: sanitized, trimmed, clipped. */
export function oneLine(text: string, max: number): string {
  return clip(sanitize(text).trim(), max);
}

/**
 * Echoed user input in a message: clipped, then JSON-quoted, so controls, quotes and
 * backslashes show as escapes, and so does every other invisible character, as `\uXXXX`
 * (a tag character as its two surrogates).
 */
export function quoted(text: string, max: number): string {
  return JSON.stringify(clip(text, max)).replace(INVISIBLE, (c) =>
    Array.from(
      { length: c.length },
      (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`,
    ).join(""),
  );
}
