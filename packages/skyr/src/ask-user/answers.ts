/**
 * The text ask_user's surfaces share: the dialog, the transcript rows and the host form.
 */
import type { Glyphs } from "../ui/caps.js";
import { fitToWidth } from "../ui/fit.js";
import { clip, sanitize } from "../ui/text.js";
import type { AskQuestion } from "./index.js";

/** One question's answer: the picked labels as the model wrote them, and the user's own words. */
export interface Answer {
  labels: string[];
  other?: string;
}

/** The dialog's result: one slot per question, `undefined` where the user left it open. */
export type Answers = (Answer | undefined)[];

export const HEADER_WIDTH = 12;

/**
 * A question's header as every ask_user surface draws it: sanitized, cut to `HEADER_WIDTH` columns.
 * The transcript rows pass the tier's ellipsis; the checks on what the model sent keep the default,
 * so a refusal never depends on the terminal.
 */
export function shortHeader(raw: string, ellipsis = "…"): string {
  return fitToWidth(sanitize(raw).trim(), HEADER_WIDTH, ellipsis);
}

/**
 * One answer as the model reads it and every ask_user surface shows it: the labels, then the
 * user's own words, marked. Not sanitized: whoever draws it sanitizes it.
 */
export function answerLine(answer: Answer): string {
  const parts = [...answer.labels];
  if (answer.other !== undefined) parts.push(`[own words] ${answer.other}`);
  return parts.join("; ");
}

/** How much of each answer a result keeps for its transcript row. */
export const ANSWER_CHARS = 200;

/**
 * One question's header as the model wrote it and its answer as `answerLine` reads it, kept in a
 * result's details. An empty `answer` is a question left unanswered: a given answer is never empty.
 */
export interface AnswerEntry {
  header: string;
  answer: string;
}

/** `answers` paired with the headers of the questions they answer, each answer cut to `max` characters. */
export function answerEntries(
  questions: readonly Pick<AskQuestion, "header">[],
  answers: Answers,
  max = Number.POSITIVE_INFINITY,
): AnswerEntry[] {
  return answers.map((a, i) => ({
    header: questions[i]?.header ?? "",
    answer: a ? clip(answerLine(a), max) : "",
  }));
}

/**
 * What the user told the model, one `header → answer` per question, as the dialog's review page
 * and the transcript row both say it. Sanitized, not cut: each surface fits it to its width.
 */
export function receiptOf(
  entries: readonly AnswerEntry[],
  { ellipsis, sep, to }: Pick<Glyphs, "ellipsis" | "sep" | "to">,
): string {
  return entries
    .map(
      (e) =>
        `${shortHeader(e.header, ellipsis)} ${to} ${sanitize(e.answer) || "not answered"}`,
    )
    .join(sep);
}
