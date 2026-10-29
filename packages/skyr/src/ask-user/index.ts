/**
 * ask_user: the model asks the user a question and waits for the answer. The terminal draws the
 * dialog in place of the input editor; a host that answers form requests over Pi's event bus
 * gets one form instead; every other run hides the tool from the model and refuses a call that
 * arrives anyway.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { hostCapabilities } from "../tengi.js";
import { glyphsOf, tierOf } from "../ui/caps.js";
import {
  durationFact,
  failedRow,
  plainRow,
  type Row,
  type ToolView,
  toolRenderers,
} from "../ui/row.js";
import { clip, oneLine, quoted, sanitize } from "../ui/text.js";
import {
  type Answers,
  answerLine,
  HEADER_WIDTH,
  shortHeader,
} from "./answers.js";
import { createAskDialog } from "./dialog.js";
import { buildForm, parseForm } from "./form.js";
import { askHost } from "./host.js";

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
const CLOSED =
  "ask_user: the client closed the dialog without an answer. Do not guess the answer; end your turn and wait for the user's next message.";
const ERROR_CHARS = 200;
/** How much of each answer a result keeps for its transcript row. */
const ANSWER_CHARS = 200;

const asked = (question: string) => sanitize(question).trim().toLowerCase();

type Offer = "dialog" | "form" | "none";

function offerFor(
  mode: ExtensionContext["mode"] | undefined,
  events: ExtensionAPI["events"],
): Offer {
  // rpc has a UI too, but its custom() resolves undefined at once; only a host's form can answer there
  if (mode === "tui") return "dialog";
  // Pi builds the first loadout before session_start, when no request goes out yet
  if (mode === undefined) return "none";
  return hostCapabilities(events)?.formRequests ? "form" : "none";
}

const failed = (why: string) =>
  new Error(
    `ask_user: the dialog failed (${oneLine(why, ERROR_CHARS)}); ask the question in your reply instead`,
  );

/**
 * Asks through the host's form, with the dialog's contract: a decline is `undefined`; an abort, a
 * closed form, a refused answer or a failure is thrown with the text the model should read.
 */
async function viaHost(
  events: ExtensionAPI["events"],
  toolCallId: string,
  questions: readonly AskQuestion[],
  signal: AbortSignal | undefined,
): Promise<Answers | undefined> {
  const outcome = await askHost(
    events,
    { toolCallId, ...buildForm(questions) },
    signal,
  );
  if (outcome.kind === "aborted") throw new Error(ABORTED);
  if (outcome.kind === "untaken") throw failed(outcome.why);
  const { reply } = outcome;
  // A cancel the host answered from the signal's own abort is the abort, whichever listener ran first
  if (reply.cancelling || (reply.action === "cancel" && signal?.aborted))
    throw new Error(ABORTED);
  if (reply.action === "accept") return parseForm(questions, reply.content);
  if (reply.action === "decline") return undefined;
  throw reply.error === undefined ? new Error(CLOSED) : failed(reply.error);
}

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
  answers: Answers,
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

/** What the user told the model, one `header → answer` per question, as a transcript row's subject. */
function subjectOf(details: AskDetails): string {
  if (details.outcome === "declined") return "";
  const { ellipsis, sep, to } = glyphsOf(tierOf(process.env));
  return details.answers
    .map(
      (a) =>
        `${shortHeader(a.header, ellipsis)} ${to} ${sanitize(a.answer) || "not answered"}`,
    )
    .join(sep);
}

/** The headers of the questions being asked, from arguments that may still be streaming. */
function headersOf(args: Partial<Static<typeof Params>>): string {
  const { ellipsis, sep } = glyphsOf(tierOf(process.env));
  return Array.isArray(args.questions)
    ? args.questions
        .map((q) => q?.header)
        .filter((h): h is string => typeof h === "string")
        .map((h) => shortHeader(h, ellipsis))
        .join(sep)
    : "";
}

/** The ledger record of a question: what was asked while it waits, the receipt once answered. */
function askRow({ args, settled }: ToolView<Static<typeof Params>>): Row {
  const head = { verb: "ask", subjectKind: "text" } as const;
  const asking = [headersOf(args)];
  if (!settled)
    return { head: { ...head, mark: "running", subject: asking, facts: [] } };
  const duration = durationFact(settled);
  if (settled.isError)
    return failedRow({ ...head, subject: asking }, settled, "ask_user");
  const { details } = settled;
  if (!isAsked(details))
    return plainRow({ ...head, subject: asking }, settled, "ask_user");
  if (details.outcome === "declined")
    return {
      head: {
        ...head,
        mark: "stopped",
        subject: asking,
        facts: [
          { text: "declined", kind: "explain" },
          { text: "the model was told to stop and wait", kind: "extra" },
          ...duration,
        ],
      },
    };
  const answered = details.answers.filter((a) => a.answer !== "").length;
  const total = details.answers.length;
  return {
    head: {
      ...head,
      mark: answered === total ? "done" : "mixed",
      subject: [subjectOf(details)],
      facts: [
        {
          text:
            answered === total
              ? `${total} answered`
              : `${answered} of ${total} answered`,
          kind: "measure",
        },
        ...duration,
      ],
    },
  };
}

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
 * Asks in the dialog, drawn in place of the editor until the user answers or declines
 * (`undefined`); an abort, or a failure inside `custom()` to open or to draw, is thrown with the
 * text the model should read.
 */
async function inDialog(
  ui: ExtensionContext["ui"],
  questions: readonly AskQuestion[],
  signal: AbortSignal | undefined,
): Promise<Answers | undefined> {
  // Pi restores the editor with setText(getText()), which drops the paste store a [paste #…]
  // marker points into; written out in full first, the draft survives that restore
  ui.setEditorText(ui.getEditorText());
  let onAbort: (() => void) | undefined;
  let answers: Answers | undefined | Error;
  try {
    answers = await ui.custom<Answers | undefined | Error>(
      (tui, theme, keys, done) => {
        onAbort = () => done(undefined);
        signal?.addEventListener("abort", onAbort, { once: true });
        // The factory is the only place with the terminal
        tui.terminal.write("\x07");
        return createAskDialog(questions, {
          paint: { theme, mode: tierOf(process.env) },
          keys,
          done,
        });
      },
    );
  } catch (error: unknown) {
    throw failed(error instanceof Error ? error.message : String(error));
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
  if (answers instanceof Error) throw failed(answers.message);
  // An answer given before a late abort is kept; only an empty close reads the signal
  if (answers === undefined && signal?.aborted) throw new Error(ABORTED);
  return answers;
}

export function registerAskUser(pi: ExtensionAPI): void {
  // prepareLoadout gets no ctx, so it reads the mode session_start cached
  let mode: ExtensionContext["mode"] | undefined;
  const take = dialogQueue();
  const offer = () => offerFor(mode, pi.events);

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    mode = ctx.mode;
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
      offer() === "none" ? { hiddenDeclarations: ["ask_user"] } : undefined,

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      // A hidden declaration stays callable, so a call can still arrive here
      const how = offer();
      if (how === "none") throw new Error(NO_TERMINAL);
      validate(params.questions);
      const release = await take(signal);
      try {
        if (signal?.aborted) throw new Error(ABORTED);
        const answers =
          how === "dialog"
            ? await inDialog(ctx.ui, params.questions, signal)
            : await viaHost(pi.events, toolCallId, params.questions, signal);
        if (answers === undefined)
          return {
            content: [{ type: "text", text: DECLINED }],
            details: { outcome: "declined" },
          };
        return {
          content: [
            { type: "text", text: answerText(params.questions, answers) },
          ],
          details: {
            outcome: "answered",
            answers: answers.map((a, i) => ({
              header: params.questions[i]?.header ?? "",
              answer: a ? clip(answerLine(a), ANSWER_CHARS) : "",
            })),
          },
        };
      } finally {
        release();
      }
    },

    ...toolRenderers<Static<typeof Params>>(askRow),
  });
}
