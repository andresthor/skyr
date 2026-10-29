/**
 * What the built-in rows read of Pi's tool results. Pi puts counts in text, not in `details`,
 * and a saved session may hold any shape, so everything here is checked, and a fact that
 * cannot be read exactly is left out rather than guessed.
 */
import { homedir } from "node:os";
import { isRecord } from "../../guards.js";
import type { Settled } from "../../ui/row.js";
import { sanitize, sanitizeBlock } from "../../ui/text.js";

export type Details = Readonly<Record<string, unknown>>;
type Kind = "truncation" | "number" | "boolean" | "string";

/**
 * `details` when each key of `spec` it holds has its type, `{}` for none; undefined for a
 * shape this build does not know. Keys outside `spec` are ignored, so a newer Pi adding one
 * keeps the record.
 */
export function detailsOf(
  details: unknown,
  spec: Readonly<Record<string, Kind>>,
): Details | undefined {
  if (details === undefined || details === null) return {};
  if (!isRecord(details)) return undefined;
  for (const [key, kind] of Object.entries(spec)) {
    const value = details[key];
    if (value === undefined) continue;
    const fits =
      kind === "truncation"
        ? isRecord(value) && typeof value.truncated === "boolean"
        : typeof value === kind;
    if (!fits) return undefined;
  }
  return details;
}

/** The truncation a tool reports, when it cut its output. */
export const truncationOf = (details: Details) =>
  isRecord(details.truncation) && details.truncation.truncated === true
    ? details.truncation
    : undefined;

/** Whether the tool cut what it returned, by any of the flags the search tools and read set. */
export const limited = (details: Details): boolean =>
  truncationOf(details) !== undefined ||
  details.linesTruncated === true ||
  ["matchLimitReached", "resultLimitReached", "entryLimitReached"].some(
    (key) => details[key] !== undefined,
  );

export const strOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const numOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The text blocks of a result, joined as Pi's own renderers join them. */
export const textOf = (content: Settled["content"]): string =>
  content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

const NOTICE = /\n\n\[[^\n]*\]$/;

/** The text without its one trailing bracketed paragraph, which is where every Pi tool puts a limit notice. */
export const withoutNotice = (text: string): string => text.replace(NOTICE, "");

/** Lines in `text`; a final newline ends a line instead of starting one. */
export function countLines(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n");
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

/** A path as a subject: the home directory as `~`, and `.` for none. */
export function pathSubject(raw: string | undefined): string {
  const path = sanitize(raw ?? "");
  const home = sanitize(homedir());
  if (path === "") return ".";
  return home !== "" && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
}

/** Output as rail lines: sanitized, tabs as two spaces, blank lines dropped. The rail caps them. */
export const outputLines = (text: string): string[] =>
  sanitizeBlock(text)
    .split("\n")
    .map((line) => line.replaceAll("\t", "  ").trimEnd())
    .filter((line) => line.trim() !== "");
