/**
 * ask_user: the model asks the user a question in place of the input editor and waits for the
 * answer. Only an interactive terminal can answer, so every other mode hides the tool from the
 * model and refuses a call that arrives anyway.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, TruncatedText } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  clip,
  errorRow,
  firstLine,
  oneLine,
  quoted,
  sanitize,
  styled,
  took,
  toolRow,
} from "../tools/render.js";
import {
  type Answer,
  alignHeaders,
  answerLine,
  createAskDialog,
  HEADER_WIDTH,
  shortHeader,
} from "./dialog.js";

const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

const Option = Type.Object({
  label: Type.String({ description: "Choice text, 1-5 words" }),
  description: Type.Optional(
    Type.String({ description: "What choosing it means or costs" }),
  ),
  recommended: Type.Optional(
    Type.Boolean({
      description:
        "You advise this option; the dialog marks it and starts on it",
    }),
  ),
});

const Question = Type.Object({
  question: Type.String({ description: "The full question, ending in ?" }),
  header: Type.String({
    description: `Short label shown for the question, up to ${HEADER_WIDTH} columns; a wide character takes two`,
  }),
  options: Type.Optional(
    Type.Array(Option, {
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      description: "Omit for a free-text question",
    }),
  ),
  multiSelect: Type.Optional(
    Type.Boolean({ description: "Allow several options; default false" }),
  ),
});

const Params = Type.Object({
  questions: Type.Array(Question, { minItems: 1, maxItems: MAX_QUESTIONS }),
});

export type AskQuestion = Static<typeof Question>;

const NO_TERMINAL =
  "ask_user: this run has no interactive terminal, so nobody can answer. Choose the most reasonable option yourself, say which you assumed, and continue.";
const ABORTED =
  "ask_user: aborted before the user answered; ask again if you still need the answer";
const DECLINED =
  "The user declined to answer. Do not guess their answers or act as if they chose; end your turn and wait for their next message.";
const UNANSWERED =
  "The user left every question marked (not answered) open. Do not assume answers for them or ask them again; go on with what was answered and say in your reply what stays open.";
const ERROR_CHARS = 200;
/** How much of each answer a result keeps for its transcript row. */
const ANSWER_CHARS = 200;

const asked = (question: string) => sanitize(question).trim().toLowerCase();

// Throws, naming the question, on what the schema cannot express and the dialog could not draw
function validate(questions: readonly AskQuestion[]): void {
  questions.forEach((q, i) => {
    const n = i + 1;
    if (sanitize(q.question).trim() === "")
      throw new Error(
        `ask_user: question ${n} has no question text; write the full question, ending in ?`,
      );
    const where = `question ${n} (${quoted(sanitize(q.question), 60)})`;
    if (sanitize(q.header).trim() === "")
      throw new Error(
        `ask_user: ${where} has no visible header; give a short label of up to ${HEADER_WIDTH} columns`,
      );
    const same = questions.findIndex(
      (other) => asked(other.question) === asked(q.question),
    );
    if (same < i)
      throw new Error(
        `ask_user: questions ${same + 1} and ${n} both ask ${quoted(sanitize(q.question), 60)}; each question must differ`,
      );
    const header = shortHeader(q.header);
    const twin = questions.findIndex((o) => shortHeader(o.header) === header);
    if (twin < i)
      throw new Error(
        `ask_user: questions ${twin + 1} and ${n} both show the header ${quoted(header, 40)}; give each question its own header of up to ${HEADER_WIDTH} columns`,
      );
    const seen = new Set<string>();
    for (const option of q.options ?? []) {
      const label = sanitize(option.label).trim();
      if (label === "")
        throw new Error(
          `ask_user: ${where} has an option with no visible label; give every option a label`,
        );
      const key = label.toLowerCase();
      if (key === "other")
        throw new Error(
          `ask_user: ${where} has an option labelled "Other"; the dialog adds that row itself, so drop it`,
        );
      if (seen.has(key))
        throw new Error(
          `ask_user: ${where} lists ${quoted(sanitize(option.label), 40)} twice; labels within a question must differ`,
        );
      seen.add(key);
    }
    if (q.multiSelect && !q.options)
      throw new Error(
        `ask_user: ${where} is multiSelect but has no options; give ${MIN_OPTIONS}-${MAX_OPTIONS} options or drop multiSelect`,
      );
    const recommended = (q.options ?? []).filter((o) => o.recommended).length;
    if (recommended > 1 && !q.multiSelect)
      throw new Error(
        `ask_user: ${where} marks ${recommended} options recommended; mark at most one, or set multiSelect`,
      );
  });
}

function answerText(
  questions: readonly AskQuestion[],
  answers: readonly (Answer | undefined)[],
): string {
  const lines = answers.map(
    (a, i) =>
      `${i + 1}. ${questions[i]?.question} -> ${a ? answerLine(a) : "(not answered)"}`,
  );
  if (answers.some((a) => !a)) lines.push(UNANSWERED);
  return ["The user answered.", ...lines].join("\n");
}

/**
 * What a result keeps for its transcript row, which Pi redraws from it on a resume. An empty
 * `answer` is a question left unanswered: a given answer is never empty.
 */
type AskDetails =
  | { outcome: "answered"; answers: { header: string; answer: string }[] }
  | { outcome: "declined" };

// Persisted details may come from an older build or another extension's tool of this name
function isAsked(details: unknown): details is AskDetails {
  if (typeof details !== "object" || details === null) return false;
  if (!("outcome" in details)) return false;
  if (details.outcome === "declined") return true;
  if (details.outcome !== "answered" || !("answers" in details)) return false;
  const { answers } = details;
  return (
    Array.isArray(answers) &&
    answers.length > 0 &&
    answers.every(
      (a: unknown) =>
        typeof a === "object" &&
        a !== null &&
        "header" in a &&
        typeof a.header === "string" &&
        "answer" in a &&
        typeof a.answer === "string",
    )
  );
}

/**
 * One dialog at a time. `take` resolves with a release once every earlier caller has released;
 * it rejects with the abort text if the signal is aborted first, without letting a later caller
 * open while an earlier dialog is still up.
 */
function dialogQueue(): (
  signal: AbortSignal | undefined,
) => Promise<() => void> {
  let queue: Promise<void> = Promise.resolve();
  return (signal) => {
    if (signal?.aborted) return Promise.reject(new Error(ABORTED));
    const prior = queue;
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    // Chained on the prior holder, so an aborted waiter's release cannot open the next one early
    queue = prior.then(() => mine);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        release();
        reject(new Error(ABORTED));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void prior.then(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      });
    });
  };
}

/**
 * Shows the dialog in place of the editor until the user answers, declines or the signal aborts
 * (`undefined` for both). A failure inside `custom()`, to open or to draw, comes back as the
 * `Error` rather than thrown.
 */
async function show(
  ui: ExtensionContext["ui"],
  questions: readonly AskQuestion[],
  signal: AbortSignal | undefined,
): Promise<(Answer | undefined)[] | undefined | Error> {
  // Pi restores the editor with setText(getText()), which drops the paste store a [paste #…]
  // marker points into; written out in full first, the draft survives that restore
  ui.setEditorText(ui.getEditorText());
  let onAbort: (() => void) | undefined;
  try {
    return await ui.custom<(Answer | undefined)[] | undefined | Error>(
      (tui, theme, keys, done) => {
        onAbort = () => done(undefined);
        signal?.addEventListener("abort", onAbort, { once: true });
        // The factory is the only place with the terminal
        tui.terminal.write("\x07");
        return createAskDialog(questions, { theme, keys, done });
      },
    );
  } catch (error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export function registerAskUser(pi: ExtensionAPI): void {
  let interactive = false;
  const take = dialogQueue();

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    // mode, not hasUI: RPC has a UI, but its custom() resolves undefined at once
    interactive = ctx.mode === "tui";
  });

  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: `Ask the user 1-${MAX_QUESTIONS} questions in one dialog and wait for their answers. Each question has ${MIN_OPTIONS}-${MAX_OPTIONS} options (one choice or several) or none for a free-text answer. Use it only when blocked on a decision that is the user's to make and that you cannot settle from the request, the code or a sensible default. The dialog adds an "Other" free-text row itself; do not add one. Set recommended: true on the option you advise.`,
    promptSnippet: "Ask the user a structured question and wait for the answer",
    promptGuidelines: [
      `Put the open questions of one decision into a single ask_user call (up to ${MAX_QUESTIONS}) instead of asking one at a time.`,
    ],
    parameters: Params,
    exposure: "model-only",
    prepareLoadout: () =>
      interactive ? undefined : { hiddenDeclarations: ["ask_user"] },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // A hidden declaration stays callable, so a call can still arrive here
      if (!interactive) throw new Error(NO_TERMINAL);
      validate(params.questions);
      const release = await take(signal);
      try {
        if (signal?.aborted) throw new Error(ABORTED);
        const result = await show(ctx.ui, params.questions, signal);
        if (result instanceof Error)
          throw new Error(
            `ask_user: the dialog failed (${oneLine(result.message, ERROR_CHARS)}); ask the question in your reply instead`,
          );
        if (result === undefined) {
          if (signal?.aborted) throw new Error(ABORTED);
          return {
            content: [{ type: "text", text: DECLINED }],
            details: { outcome: "declined" },
          };
        }
        // An answer given before a late abort is kept
        return {
          content: [
            { type: "text", text: answerText(params.questions, result) },
          ],
          details: {
            outcome: "answered",
            answers: result.map((a, i) => ({
              header: params.questions[i]?.header ?? "",
              answer: a ? clip(answerLine(a), ANSWER_CHARS) : "",
            })),
          },
        };
      } finally {
        release();
      }
    },

    renderCall(args, theme) {
      // Streaming arguments arrive partial, so nothing in them is guaranteed yet
      const headers = Array.isArray(args.questions)
        ? args.questions
            .map((q) => q?.header)
            .filter((h): h is string => typeof h === "string")
            .map(shortHeader)
        : [];
      return toolRow(theme, [
        ["toolTitle", "ask_user", true],
        ["muted", ` ${headers.join(" · ")}`],
      ]);
    },

    renderResult(result, _options, theme, context) {
      const time = took(context);
      if (context.isError) return errorRow(theme, result.content, time);
      const { details } = result;
      if (!isAsked(details))
        return toolRow(theme, [["muted", firstLine(result.content)], ...time]);
      if (details.outcome === "declined")
        return toolRow(theme, [["warning", "declined"], ...time]);
      // Built outside toolRow, whose sanitize would collapse the padding that aligns the answers
      const headers = alignHeaders(
        details.answers.map((a) => shortHeader(a.header)),
      );
      const suffix = styled(theme, time);
      const box = new Container();
      details.answers.forEach((a, i) => {
        box.addChild(
          new TruncatedText(
            theme.fg("muted", headers[i] ?? "") +
              (a.answer
                ? theme.fg("text", sanitize(a.answer))
                : theme.fg("warning", "not answered")) +
              (i === 0 ? suffix : ""),
          ),
        );
      });
      return box;
    },
  });
}
