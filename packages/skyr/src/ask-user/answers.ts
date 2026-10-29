/**
 * The text ask_user's surfaces share: the dialog, the transcript rows and the host form.
 */
import { fitToWidth } from "../ui/fit.js";
import { sanitize } from "../ui/text.js";

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
