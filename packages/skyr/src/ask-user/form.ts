/**
 * ask_user's questions as one ACP form in the agentui v1 shape, and the form's answer back as the
 * dialog's own result. Property `question_<i>` holds question i's pick (an index string, or a list
 * of them for a multi-select, or the text of a free-text question); `question_<i>_custom` holds
 * the user's own words beside a question with options. Pure: no extension API, no bus, no side
 * effects.
 */
import { sanitize } from "../ui/text.js";
import { type Answers, shortHeader } from "./answers.js";
import type { FormRequest } from "./host.js";
import type { AskQuestion } from "./index.js";

const text = (s: string) => sanitize(s).trim();

/** The request's `message` and `requestedSchema`; strings the user sees are sanitised here. */
export function buildForm(
  questions: readonly AskQuestion[],
): Omit<FormRequest, "toolCallId"> {
  const properties: Record<string, unknown> = {};
  questions.forEach((q, i) => {
    const key = `question_${i}`;
    const base = {
      title: shortHeader(q.header),
      description: text(q.question),
    };
    const options = q.options ?? [];
    if (options.length === 0) {
      properties[key] = { type: "string", ...base };
      return;
    }
    const choices = options.map((o, j) => ({
      const: String(j),
      title: text(o.label),
      ...(o.description === undefined
        ? {}
        : { description: text(o.description) }),
      ...(o.recommended
        ? { _meta: { "agentui/option": { recommended: true } } }
        : {}),
    }));
    properties[key] = q.multiSelect
      ? {
          type: "array",
          ...base,
          items: { anyOf: choices },
          maxItems: options.length,
        }
      : { type: "string", ...base, oneOf: choices };
    properties[`${key}_custom`] = {
      type: "string",
      title: "Other",
      description: q.multiSelect
        ? "Add your own answer to your picks"
        : "Type your own answer instead",
      _meta: {
        "agentui/field": q.multiSelect
          ? { otherFor: key }
          : { otherFor: key, exclusiveWith: key },
      },
    };
  });
  return {
    message:
      questions.length === 1
        ? "Please answer this question."
        : "Please answer the following questions.",
    requestedSchema: { type: "object", properties, required: [] },
  };
}

const refused = (fault: string) =>
  new Error(
    `ask_user: the client's answer was refused (${fault}); ask the question in your reply instead`,
  );

// An index the form could have produced: a canonical non-negative integer string
const isIndex = (v: unknown): v is string =>
  typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);

// A client's text is as untrusted as the model's; "" is no answer
function words(n: number, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw refused(`question ${n}'s own words are not text`);
  const line = text(value);
  return line === "" ? undefined : line;
}

/**
 * The accepted form's `content` as the dialog's answers, one slot per question, `undefined` for a
 * question left open; `undefined` when nothing at all was answered, which is a decline. Throws,
 * naming the fault without echoing user text, on an answer the form could not have produced.
 */
export function parseForm(
  questions: readonly AskQuestion[],
  content: Record<string, unknown> | undefined,
): Answers | undefined {
  const c = content ?? {};
  const answers = questions.map((q, i) => {
    const n = i + 1;
    const value = c[`question_${i}`];
    const options = q.options ?? [];
    if (options.length === 0) {
      const other = words(n, value);
      return other === undefined ? undefined : { labels: [], other };
    }
    const picks = indexes(q, n, value, options.length);
    const other = words(n, c[`question_${i}_custom`]);
    // A client that ignores exclusiveWith may send both; the user's own words are the answer
    if (!q.multiSelect && other !== undefined) return { labels: [], other };
    if (picks.length === 0 && other === undefined) return undefined;
    const labels = options
      .filter((_, j) => picks.includes(j))
      .map((o) => o.label);
    return other === undefined ? { labels } : { labels, other };
  });
  return answers.some((a) => a) ? answers : undefined;
}

function indexes(
  q: AskQuestion,
  n: number,
  value: unknown,
  count: number,
): number[] {
  // An untouched field may come back as "" rather than omitted
  if (value === undefined || value === "") return [];
  let raw: unknown[];
  if (!q.multiSelect) raw = [value];
  else if (Array.isArray(value)) raw = value;
  else throw refused(`question ${n}'s picks are not a list`);
  const picks = raw.map((v) => {
    if (!isIndex(v))
      throw refused(`question ${n}'s pick is not an option index`);
    const k = Number(v);
    if (k >= count)
      throw refused(
        `question ${n} picks an option past the last; its options are 0-${count - 1}`,
      );
    return k;
  });
  const twice = picks.find((k, i) => picks.indexOf(k) !== i);
  if (twice !== undefined)
    throw refused(`question ${n} picks option ${twice} twice`);
  return picks;
}
