/** The ledger rows of Pi's `grep`, `find` and `ls`. */

import { plural } from "../../ui/format.js";
import type { Fact } from "../../ui/record.js";
import {
  durationFact,
  failedRow,
  type Head,
  type Row,
  type ToolView,
} from "../../ui/row.js";
import { sanitize } from "../../ui/text.js";
import {
  countLines,
  type Details,
  detailsOf,
  limited,
  pathSubject,
  railOf,
  strOf,
  textOf,
  withoutNotice,
} from "./shapes.js";

interface GrepArgs {
  pattern: string;
  path: string;
  glob: string;
  context: number;
}
interface FindArgs {
  pattern: string;
  path: string;
}
interface LsArgs {
  path: string;
}

/**
 * The shared body of a finished search row: `facts` from the listing, the `truncated` extra
 * where the tool cut, the duration, and the listing on a rail when expanded.
 */
function listed(
  head: Head,
  { settled, expanded }: Pick<ToolView<unknown>, "settled" | "expanded">,
  details: Details,
  listing: string,
  counts: Fact[],
): Row {
  const facts: Fact[] = [
    ...counts,
    ...(limited(details)
      ? [{ text: "truncated", kind: "extra" } as const]
      : []),
    ...durationFact(settled),
  ];
  return {
    head: { ...head, mark: "done", facts },
    ...(expanded && listing !== ""
      ? {
          rail: { lines: railOf(listing), collapsed: 0, ink: "muted" as const },
        }
      : {}),
  };
}

const MATCH_LINE = /^(.+?):\d+: /;

const GREP_DETAILS = {
  truncation: "truncation",
  matchLimitReached: "number",
  linesTruncated: "boolean",
} as const;

export function grepView({
  args,
  settled,
  expanded,
}: ToolView<GrepArgs>): Row | undefined {
  const pattern = `"${sanitize(strOf(args.pattern) ?? "")}"`;
  const path = strOf(args.path) === undefined ? "" : pathSubject(args.path);
  const glob = sanitize(strOf(args.glob) ?? "");
  const subject = [
    [pattern, path, glob && `(${glob})`].filter(Boolean).join(" "),
    [pattern, path].filter(Boolean).join(" "),
    pattern,
  ].filter((s, i, all) => all.indexOf(s) === i);
  const head: Head = { verb: "grep", subject, subjectKind: "text" };
  if (!settled) return { head: { ...head, mark: "running", facts: [] } };
  if (settled.isError) return failedRow(head, settled, "grep");
  const details = detailsOf(settled.details, GREP_DETAILS);
  if (!details) return undefined;
  const text = textOf(settled.content);
  if (text.trim() === "No matches found")
    return listed(head, { settled, expanded }, details, "", [
      { text: "no matches", kind: "measure" },
    ]);
  const listing = limited(details) ? withoutNotice(text) : text;
  const lines = listing.split("\n").filter((line) => line !== "");
  // Context lines use another separator and are not matches, so a count would be a guess
  const exact =
    !(typeof args.context === "number" && args.context > 0) &&
    lines.length > 0 &&
    lines.every((line) => MATCH_LINE.test(line));
  const files = new Set(lines.map((line) => MATCH_LINE.exec(line)?.[1]));
  return listed(
    head,
    { settled, expanded },
    details,
    listing,
    exact
      ? [
          { text: plural(lines.length, "match", "matches"), kind: "measure" },
          { text: plural(files.size, "file", "files"), kind: "measure" },
        ]
      : [],
  );
}

const FIND_DETAILS = {
  truncation: "truncation",
  resultLimitReached: "number",
} as const;

export function findView({
  args,
  settled,
  expanded,
}: ToolView<FindArgs>): Row | undefined {
  const pattern = sanitize(strOf(args.pattern) ?? "");
  const path = strOf(args.path) === undefined ? "" : pathSubject(args.path);
  const head: Head = {
    verb: "find",
    subject: [path ? `${pattern} in ${path}` : pattern, pattern],
    subjectKind: "text",
  };
  if (!settled) return { head: { ...head, mark: "running", facts: [] } };
  if (settled.isError) return failedRow(head, settled, "find");
  const details = detailsOf(settled.details, FIND_DETAILS);
  if (!details) return undefined;
  const text = textOf(settled.content);
  if (text.trim() === "No files found matching pattern")
    return listed(head, { settled, expanded }, details, "", [
      { text: "no files", kind: "measure" },
    ]);
  const listing = limited(details) ? withoutNotice(text) : text;
  return listed(head, { settled, expanded }, details, listing, [
    { text: plural(countLines(listing), "file", "files"), kind: "measure" },
  ]);
}

const LS_DETAILS = {
  truncation: "truncation",
  entryLimitReached: "number",
} as const;

export function lsView({
  args,
  settled,
  expanded,
}: ToolView<LsArgs>): Row | undefined {
  const head: Head = {
    verb: "ls",
    subject: [pathSubject(strOf(args.path))],
    subjectKind: "path",
  };
  if (!settled) return { head: { ...head, mark: "running", facts: [] } };
  if (settled.isError) return failedRow(head, settled, "ls");
  const details = detailsOf(settled.details, LS_DETAILS);
  if (!details) return undefined;
  const text = textOf(settled.content);
  if (text.trim() === "(empty directory)")
    return listed(head, { settled, expanded }, details, "", [
      { text: "empty", kind: "measure" },
    ]);
  const listing = limited(details) ? withoutNotice(text) : text;
  return listed(head, { settled, expanded }, details, listing, [
    { text: plural(countLines(listing), "entry", "entries"), kind: "measure" },
  ]);
}
