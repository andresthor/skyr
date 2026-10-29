/** The ledger rows of Pi's `read`, `write` and `edit`. */
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { tierOf } from "../../ui/caps.js";
import { plural } from "../../ui/format.js";
import type { Fact } from "../../ui/record.js";
import {
  durationFact,
  failedRow,
  type Head,
  type LedgerRenderers,
  type Memo,
  type Row,
  type ToolView,
  toolRenderers,
} from "../../ui/row.js";
import {
  countLines,
  detailsOf,
  limited,
  numOf,
  outputLines,
  pathSubject,
  strOf,
  textOf,
  truncationOf,
  withoutNotice,
} from "./shapes.js";

/** Pi's renderers read `file_path` as well as `path`, so the row does too. */
const pathOf = (args: { path?: unknown; file_path?: unknown }) =>
  strOf(args.path) ?? strOf(args.file_path);

/** No subject until the path has streamed in: `write .` would claim a directory. */
const fileSubject = (args: { path?: unknown; file_path?: unknown }) => {
  const path = pathOf(args);
  return path === undefined ? "" : pathSubject(path);
};

interface ReadArgs {
  path: string;
  file_path: string;
  offset: number;
  limit: number;
}

/** `path:start-end` from the arguments; plain `path` when the whole file was asked for. */
function readSubject(args: Partial<ReadArgs>): string[] {
  const path = fileSubject(args);
  const offset = numOf(args.offset);
  const limit = numOf(args.limit);
  if (path === "" || (offset === undefined && limit === undefined))
    return [path];
  const start = offset ?? 1;
  const end = limit === undefined ? "" : start + limit - 1;
  return [`${path}:${start}-${end}`, path];
}

/** The notice Pi appends when a `limit` stopped the read short of the end of the file. */
const MORE_LINES =
  /\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/;

export function readView({
  args,
  settled,
  expanded,
}: ToolView<ReadArgs>): Row | undefined {
  const head: Head = {
    verb: "read",
    subject: readSubject(args),
    subjectKind: "path",
  };
  if (!settled) return { head: { ...head, mark: "running", facts: [] } };
  if (settled.isError) return failedRow(head, settled, "read");
  const details = detailsOf(settled.details, { truncation: "truncation" });
  if (!details) return undefined;
  const truncation = truncationOf(details);
  const text = textOf(settled.content);
  const body = truncation ? withoutNotice(text) : text.replace(MORE_LINES, "");
  const image = settled.content.some((c) => c.type === "image");
  const lines = numOf(truncation?.outputLines) ?? countLines(body);
  const facts: Fact[] = [
    ...(image
      ? [{ text: "image", kind: "measure" } as const]
      : lines > 0
        ? [{ text: plural(lines, "line", "lines"), kind: "measure" } as const]
        : []),
    ...(limited(details)
      ? [{ text: "truncated", kind: "extra" } as const]
      : []),
    ...durationFact(settled),
  ];
  return {
    head: { ...head, mark: "done", facts },
    ...(expanded && !image && body !== ""
      ? {
          rail: {
            lines: outputLines(body),
            collapsed: 0,
            ink: "muted" as const,
          },
        }
      : {}),
  };
}

interface WriteArgs {
  path: string;
  file_path: string;
  content: string;
}

export function writeView({
  args,
  settled,
  expanded,
}: ToolView<WriteArgs>): Row | undefined {
  const head: Head = {
    verb: "write",
    subject: [fileSubject(args)],
    subjectKind: "path",
  };
  if (!settled) return { head: { ...head, mark: "running", facts: [] } };
  if (settled.isError) return failedRow(head, settled, "write");
  if (!detailsOf(settled.details, {})) return undefined;
  const content = strOf(args.content);
  return {
    head: {
      ...head,
      mark: "done",
      facts: [
        ...(content === undefined
          ? []
          : [
              {
                text: plural(countLines(content), "line", "lines"),
                kind: "measure",
              } as const,
            ]),
        ...durationFact(settled),
      ],
    },
    ...(expanded && content
      ? {
          rail: {
            lines: outputLines(content),
            collapsed: 0,
            ink: "muted" as const,
          },
        }
      : {}),
  };
}

interface EditArgs {
  path: string;
  file_path: string;
}

/** The diff Pi computed for a call that has not finished, kept on the box of its own call renderer. */
function previewOf(state: object): string | undefined {
  const box: unknown = (state as { callComponent?: unknown }).callComponent;
  if (typeof box !== "object" || box === null) return undefined;
  const preview: unknown = (box as { preview?: unknown }).preview;
  if (typeof preview !== "object" || preview === null) return undefined;
  const diff = (preview as { diff?: unknown }).diff;
  return typeof diff === "string" ? diff : undefined;
}

const DIFF_LINES = 6;

/**
 * An edit's diff as rail lines: Pi's own colours in the colour tier, plain text in the others,
 * which draw no colour at all. The text is sanitized first because it is file content. The
 * colouring is kept in the row's memo, so a repaint reuses it and a new theme redoes it.
 */
function diffRail(
  diff: string,
  renderDiff: (diff: string) => string,
  memo: Memo,
): { lines: string[]; ink: "styled" | "text" } {
  const text = outputLines(diff);
  const plain = { lines: text, ink: "text" as const };
  if (tierOf(process.env) !== "color") return plain;
  if (memo.coloured?.diff !== diff) {
    try {
      memo.coloured = {
        diff,
        lines: renderDiff(text.join("\n")).split("\n"),
      };
    } catch {
      // Pi's diff colours come from its global theme; without it the text is still the diff
      return plain;
    }
  }
  return { lines: memo.coloured.lines, ink: "styled" };
}

/** `+N −M` from a diff's own lines. */
function changes(diff: string): string {
  const lines = diff.split("\n");
  const minus = tierOf(process.env) === "ascii" ? "-" : "−";
  return `+${lines.filter((l) => l.startsWith("+")).length} ${minus}${lines.filter((l) => l.startsWith("-")).length}`;
}

function editViewOf(renderDiff: (diff: string) => string) {
  return ({
    args,
    settled,
    state,
    memo,
  }: ToolView<EditArgs>): Row | undefined => {
    const head: Head = {
      verb: "edit",
      subject: [fileSubject(args)],
      subjectKind: "path",
    };
    if (!settled) {
      const preview = previewOf(state);
      return {
        head: { ...head, mark: "running", facts: [] },
        ...(preview === undefined
          ? {}
          : {
              rail: {
                ...diffRail(preview, renderDiff, memo),
                collapsed: DIFF_LINES,
              },
            }),
      };
    }
    if (settled.isError) return failedRow(head, settled, "edit");
    const details = detailsOf(settled.details, {
      diff: "string",
      firstChangedLine: "number",
    });
    const diff = strOf(details?.diff);
    if (diff === undefined) return undefined;
    return {
      head: {
        ...head,
        mark: "done",
        facts: [
          { text: changes(diff), kind: "measure" },
          ...durationFact(settled),
        ],
      },
      rail: { ...diffRail(diff, renderDiff, memo), collapsed: DIFF_LINES },
    };
  };
}

/**
 * The edit row's renderers. Pi works out an edit's preview inside its own call renderer, from
 * the file on disk, and asks for a redraw when it is ready; skyr drives that renderer first on
 * every call, hands it nothing of its own, and reads what it left in `context.state`.
 */
export function editRenderers(
  base: ToolRenderers,
  renderDiff: (diff: string) => string,
): LedgerRenderers {
  const ours = toolRenderers(editViewOf(renderDiff), base);
  return {
    ...ours,
    renderCall(args, theme, context) {
      try {
        base.renderCall?.(args, theme, {
          ...context,
          lastComponent: undefined,
        });
      } catch {
        // The preview is decoration: without it the row still has its head
      }
      return ours.renderCall(args, theme, context);
    },
  };
}
