/**
 * ask_user: the model asks the user a question in place of the input editor and waits for the
 * answer. Only an interactive terminal can answer, so every other mode hides the tool from the
 * model and refuses a call that arrives anyway.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  errorRow,
  oneLine,
  quoted,
  sanitize,
  took,
  toolRow,
} from "../tools/render.js";
import { type Answer, createAskDialog } from "./dialog.js";

const Option = Type.Object({
  label: Type.String({ description: "Choice text, 1-5 words" }),
  description: Type.Optional(
    Type.String({ description: "What choosing it means or costs" }),
  ),
});

const Question = Type.Object({
  question: Type.String({ description: "The full question, ending in ?" }),
  header: Type.String({
    description: "Short label shown for the question, up to 12 characters",
  }),
  options: Type.Optional(
    Type.Array(Option, {
      minItems: 2,
      maxItems: 4,
      description: "Omit for a free-text question",
    }),
  ),
});

const Params = Type.Object({
  questions: Type.Array(Question, { minItems: 1, maxItems: 1 }),
});

export type AskQuestion = Static<typeof Question>;

const NO_TERMINAL =
  "ask_user: this run has no interactive terminal, so nobody can answer. Choose the most reasonable option yourself, say which you assumed, and continue.";
const ABORTED =
  "ask_user: aborted before the user answered; ask again if you still need the answer";
const DECLINED =
  "The user declined to answer. Do not guess their answers or act as if they chose; end your turn and wait for their next message.";
const ERROR_CHARS = 200;

// Throws, naming the question, on what the schema cannot express and the dialog could not draw
function validate(questions: readonly AskQuestion[]): void {
  questions.forEach((q, i) => {
    const n = i + 1;
    if (sanitize(q.question).trim() === "")
      throw new Error(
        `ask_user: question ${n} has no question text; write the full question, ending in ?`,
      );
    const where = `question ${n} (${quoted(sanitize(q.question), 60)})`;
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
  });
}

function answerText(
  questions: readonly AskQuestion[],
  answers: readonly Answer[],
): string {
  const lines = answers.map((a, i) => {
    const parts = [...a.labels];
    if (a.other !== undefined) parts.push(`[own words] ${a.other}`);
    return `${i + 1}. ${questions[i]?.question} -> ${parts.join("; ")}`;
  });
  return ["The user answered.", ...lines].join("\n");
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
): Promise<Answer[] | undefined | Error> {
  // Pi restores the editor with setText(getText()), which drops the paste store a [paste #…]
  // marker points into; written out in full first, the draft survives that restore
  ui.setEditorText(ui.getEditorText());
  let onAbort: (() => void) | undefined;
  try {
    return await ui.custom<Answer[] | undefined | Error>(
      (_tui, theme, keys, done) => {
        onAbort = () => done(undefined);
        signal?.addEventListener("abort", onAbort, { once: true });
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
    description:
      'Ask the user a question in place of the editor and wait for the answer. Give 2-4 options to choose from, or none for a free-text answer. Use it only when blocked on a decision that is the user\'s to make and that you cannot settle from the request, the code or a sensible default. The dialog adds an "Other" free-text row itself; do not add one.',
    promptSnippet: "Ask the user a structured question and wait for the answer",
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
            details: undefined,
          };
        }
        // An answer given before a late abort is kept
        return {
          content: [
            { type: "text", text: answerText(params.questions, result) },
          ],
          details: undefined,
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
        : [];
      return toolRow(theme, [
        ["toolTitle", "ask_user", true],
        ["muted", ` ${headers.join(" · ")}`],
      ]);
    },

    renderResult(result, _options, theme, context) {
      const time = took(context);
      if (context.isError) return errorRow(theme, result.content, time);
      // Pi's fallback row strips only ANSI and C0 controls; the content holds raw model text
      const text = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      const rows = new Container();
      text.split("\n").forEach((line, i) => {
        rows.addChild(
          toolRow(theme, [["muted", line], ...(i === 0 ? time : [])]),
        );
      });
      return rows;
    },
  });
}
