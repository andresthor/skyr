/**
 * A ledger record: one transcript line, `mark verb subject ……… facts handle`, with no background.
 * Narrowing the pane drops its parts in a fixed order, because the subject says what the row is
 * about and the facts only qualify it: the handle, then decoration, then alternate subjects, then
 * counts and durations, and only then the subject itself, cut to a floor. A fact that explains
 * the mark (a failure's reason) outlives the subject's cut above that floor, since a row that
 * hides why it failed is worse than one that hides what it was; below it the subject keeps
 * its floor and the reason gives way.
 */
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { glyphsOf, type Mark } from "./caps.js";
import { fitToWidth } from "./fit.js";
import { markToken, type Paint, styled, type Token } from "./palette.js";
import { sanitize } from "./text.js";

export interface Fact {
  readonly text: string;
  /**
   * `extra` is decoration, dropped first. `measure` is a count or a duration. `explain` is why
   * the mark is what it is: cut last, never dropped before the subject is cut.
   */
  readonly kind: "extra" | "measure" | "explain";
  /** Accent ink instead of muted. */
  readonly accent?: true;
}

export interface RecordSpec {
  readonly mark: Mark;
  /** A child record: indented two columns under its parent, led by the branch glyph, with no verb. */
  readonly branch?: "mid" | "last";
  readonly verb?: string;
  /** Draws ` &` after the verb. */
  readonly background?: boolean;
  /** Longest first; the first that fits is drawn. At least one. */
  readonly subject: readonly string[];
  /** A `path` is cut in the middle so its last segment survives. */
  readonly subjectKind: "text" | "path";
  /** In line order. */
  readonly facts: readonly Fact[];
  /** 8 hex characters, dim, last. */
  readonly handle?: string;
}

/** Text and the ink it is drawn in. */
interface Part {
  readonly text: string;
  readonly token: Token;
  readonly bold?: true;
}

/** The verb field is this wide, padded, in a pane that has room for the columns it lines up. */
const VERB_FIELD = 8;
const ALIGN_FROM = 40;
/** The least of a subject worth drawing beside its explaining fact. */
const MIN_SUBJECT = 8;
/** Columns between the subject and the facts, and between the facts and the handle. */
const GAP = 2;
const MIN_SPACE = " ".repeat(GAP);

const widthOf = (parts: readonly Part[]) =>
  parts.reduce((sum, p) => sum + visibleWidth(p.text), 0);

/**
 * `path` cut in the middle, so the segment after the last `/` survives while it fits; when it
 * does not, the end of the path does, because the end says what it is.
 */
function cutPath(text: string, cols: number, ellipsis: string): string {
  const total = visibleWidth(text);
  if (total <= cols) return text;
  const slash = text.lastIndexOf("/");
  const tail = slash < 0 ? "" : text.slice(slash);
  const headRoom = cols - visibleWidth(tail);
  if (slash > 0 && headRoom > visibleWidth(ellipsis))
    return `${fitToWidth(text.slice(0, slash), headRoom, ellipsis)}${tail}`;
  const keep = cols - visibleWidth(ellipsis);
  return keep <= 0
    ? fitToWidth(text, cols, "")
    : `${ellipsis}${sliceByColumn(text, total - keep, keep, true)}`;
}

function factParts(facts: readonly Fact[], mark: Mark, sep: string): Part[] {
  return facts.flatMap((fact, i): Part[] => {
    const explains = fact.kind === "explain" && mark === "failed";
    const text: Part = fact.accent
      ? { text: fact.text, token: "accent" }
      : explains
        ? { text: fact.text, token: "error", bold: true }
        : { text: fact.text, token: "muted" };
    return i === 0 ? [text] : [{ text: sep, token: "dim" }, text];
  });
}

/** The subject drawn in `cols` columns; a path keeps its directories muted. */
function subjectParts(
  text: string,
  kind: RecordSpec["subjectKind"],
  cols: number,
  ellipsis: string,
): Part[] {
  if (kind === "text")
    return [{ text: fitToWidth(text, cols, ellipsis), token: "text" }];
  const cut = cutPath(text, cols, ellipsis);
  const slash = cut.lastIndexOf("/");
  return slash < 0
    ? [{ text: cut, token: "text" }]
    : [
        { text: cut.slice(0, slash + 1), token: "muted" },
        { text: cut.slice(slash + 1), token: "text" },
      ];
}

interface Variant {
  readonly handle: boolean;
  readonly facts: readonly Fact[];
  /** Index into the spec's subject alternates. */
  readonly subject: number;
}

/**
 * What a record can show, widest first: each variant is the one before it minus one more thing,
 * in the decided drop order.
 */
function variants(spec: RecordSpec): Variant[] {
  let current: Variant = {
    handle: spec.handle !== undefined,
    facts: spec.facts,
    subject: 0,
  };
  const out = [current];
  const step = (next: Partial<Variant>) => {
    current = { ...current, ...next };
    out.push(current);
  };
  const dropLast = (kind: Fact["kind"]) => {
    for (let i = current.facts.length - 1; i >= 0; i--)
      if (current.facts[i]?.kind === kind)
        step({ facts: current.facts.filter((_, j) => j !== i) });
  };
  if (spec.handle !== undefined) step({ handle: false });
  dropLast("extra");
  for (let s = 1; s < spec.subject.length; s++) step({ subject: s });
  dropLast("measure");
  return out;
}

/** The spec with every string sanitized, so no builder can let a raw one reach the terminal, and no empty fact drawn. */
function tidy({ handle, ...spec }: RecordSpec): RecordSpec {
  const id = handle === undefined ? "" : sanitize(handle);
  return {
    ...spec,
    ...(spec.verb !== undefined && { verb: sanitize(spec.verb) }),
    subject: spec.subject.map(sanitize),
    facts: spec.facts
      .map((fact) => ({ ...fact, text: sanitize(fact.text) }))
      .filter((fact) => fact.text !== ""),
    ...(id !== "" && { handle: id }),
  };
}

/**
 * One line, never wider than `width`, with `pad` columns each side. Strings are sanitized here.
 * The layout is `pad · branch · mark · verb field · subject ·
 * gap · facts · handle`, the facts and handle flush right.
 *
 * Ink: mark in `markToken`, verb `toolTitle` bold, subject `text` (a path's directories
 * `muted`), facts `muted` (`accent` where asked), an explaining fact bold in `error` on a failed
 * mark, separators and handle `dim`. `mono` keeps bold and drops colour; `ascii` draws no escape.
 * No background, ever.
 */
export function drawRecord(
  paint: Paint,
  raw: RecordSpec,
  width: number,
  pad: number,
): string {
  const spec = tidy(raw);
  const { ellipsis, sep, mark: marks, branch } = glyphsOf(paint.mode);
  const room = Math.max(0, width - 2 * pad);
  const ink = (parts: readonly Part[]) =>
    parts
      .map(({ text, token, bold }) =>
        styled(paint, text, { fg: paint.theme.colors[token], bold }),
      )
      .join("");

  const verbText = spec.verb ? spec.verb + (spec.background ? " &" : "") : "";
  const verb: Part[] = spec.verb
    ? [
        { text: spec.verb, token: "toolTitle", bold: true },
        ...(spec.background ? [{ text: " &", token: "muted" as const }] : []),
        {
          text: " ".repeat(
            (room >= ALIGN_FROM
              ? Math.max(0, VERB_FIELD - verbText.length)
              : 0) + 1,
          ),
          token: "text",
        },
      ]
    : [];
  const lead: Part[] = [
    ...(spec.branch
      ? [{ text: `  ${branch[spec.branch]} `, token: "dim" as const }]
      : []),
    { text: marks[spec.mark], token: markToken[spec.mark] },
    { text: " ", token: "text" },
    ...verb,
  ];
  const leadWidth = widthOf(lead);
  const handle: Part[] = spec.handle
    ? [{ text: spec.handle, token: "dim" }]
    : [];

  const draw = (
    subject: Part[],
    facts: readonly Part[],
    withHandle: boolean,
  ): string => {
    const right = [
      ...facts,
      ...(withHandle && facts.length > 0
        ? [{ text: MIN_SPACE, token: "text" as const }]
        : []),
      ...(withHandle ? handle : []),
    ];
    const gap =
      right.length === 0
        ? 0
        : Math.max(GAP, room - leadWidth - widthOf(subject) - widthOf(right));
    return fitToWidth(
      `${" ".repeat(pad)}${ink([...lead, ...subject, { text: " ".repeat(gap), token: "text" }, ...right])}`,
      width,
      "",
    );
  };

  for (const v of variants(spec)) {
    const subject = spec.subject[v.subject] ?? "";
    const facts = factParts(v.facts, spec.mark, sep);
    const need =
      leadWidth +
      visibleWidth(subject) +
      (facts.length > 0 || v.handle ? GAP : 0) +
      widthOf(facts) +
      (v.handle ? (facts.length > 0 ? GAP : 0) + widthOf(handle) : 0);
    if (need <= room)
      return draw(
        subjectParts(subject, spec.subjectKind, room, ellipsis),
        facts,
        v.handle,
      );
  }

  // Only the explaining facts are left: the subject gives way down to its floor, then they do
  const explain = spec.facts.filter((f) => f.kind === "explain");
  const subject = spec.subject.at(-1) ?? "";
  const explainText = factParts(explain, spec.mark, sep);
  const explainWidth = widthOf(explainText);
  const reserved = explainWidth > 0 ? GAP + explainWidth : 0;
  const subjectCols = Math.min(
    visibleWidth(subject),
    Math.max(MIN_SUBJECT, room - leadWidth - reserved),
  );
  const explainRoom = room - leadWidth - subjectCols - GAP;
  const shown =
    explainRoom <= 0
      ? []
      : explainWidth <= explainRoom
        ? explainText
        : [
            {
              ...(explainText[0] as Part),
              text: fitToWidth(
                explainText.map((p) => p.text).join(""),
                explainRoom,
                ellipsis,
              ),
            },
          ];
  return draw(
    subjectParts(subject, spec.subjectKind, subjectCols, ellipsis),
    shown,
    false,
  );
}

/**
 * The lines under a record: `  │ line`, the rail dim and the line in `ink`, each line cut with
 * the tier's ellipsis. Lines arrive sanitized.
 */
export function drawRail(
  paint: Paint,
  lines: readonly string[],
  ink: "muted" | "text",
  width: number,
  pad: number,
): string[] {
  const { ellipsis, rail } = glyphsOf(paint.mode);
  const colors = paint.theme.colors;
  const room = Math.max(0, width - 2 * pad - 2 - visibleWidth(rail) - 1);
  return lines.map((line) =>
    fitToWidth(
      `${" ".repeat(pad)}  ${styled(paint, `${rail} `, { fg: colors.dim })}${styled(paint, fitToWidth(line, room, ellipsis), { fg: colors[ink] })}`,
      width,
      "",
    ),
  );
}
