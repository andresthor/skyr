/**
 * The ask_user dialog, drawn in place of the input editor. It owns the keyboard until the user
 * answers or declines, and knows nothing of Pi's runtime: questions in, answers out through `done`.
 * One question finishes on Enter; two to four get a tab each and a Submit tab to review them,
 * which submits whatever is answered, or declines when nothing is.
 */
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { keyName } from "../ui/hint.js";
import { sanitize } from "../ui/text.js";
import {
  type Answer,
  type Answers,
  answerLine,
  shortHeader,
} from "./answers.js";
import type { AskQuestion } from "./index.js";

interface Deps {
  theme: Pick<Theme, "fg" | "bg" | "bold">;
  keys: Pick<KeybindingsManager, "matches" | "getKeys">;
  /**
   * `undefined` = declined with Esc or submitted with nothing answered; an `undefined` entry = a
   * question left unanswered; an `Error` = the dialog threw and closed.
   */
  done(result: Answers | undefined | Error): void;
}

const PLACEHOLDER = "type an answer";

/** Each header padded so the text after it starts at one column, two past the widest. */
function alignHeaders(headers: readonly string[]): string[] {
  const widest = Math.max(...headers.map((h) => visibleWidth(h)));
  return headers.map((h) => h + " ".repeat(widest - visibleWidth(h) + 2));
}

/** The question dialog. Sanitizes every model string itself, and calls `done` at most once. */
export function createAskDialog(
  questions: readonly AskQuestion[],
  deps: Deps,
): Component & Focusable {
  if (questions.length === 0)
    throw new Error("ask_user: the dialog needs a question");
  return new AskDialog(questions, deps);
}

/** One question's rows and what the user has done on them; it survives tab switches. */
class Page {
  readonly text: string;
  readonly header: string;
  readonly multi: boolean;
  readonly options: {
    raw: string;
    label: string;
    description?: string;
    recommended: boolean;
  }[];
  // An Input, not an Editor: it keeps no paste store, so nothing typed here can come back as a marker
  readonly input: Input;
  readonly ticked = new Set<number>();
  cursor: number;
  /** Single choice: the option accepted last, or "other" for the typed answer. */
  picked: number | "other" | undefined;
  /** An answer has been accepted here at least once. */
  confirmed = false;

  constructor(question: AskQuestion, theme: Deps["theme"]) {
    this.text = sanitize(question.question);
    this.header = shortHeader(question.header);
    this.multi = question.multiSelect === true;
    this.options = (question.options ?? []).map((o) => ({
      raw: o.label,
      label: sanitize(o.label),
      ...(o.description === undefined
        ? {}
        : { description: sanitize(o.description) }),
      recommended: o.recommended === true,
    }));
    this.cursor = Math.max(
      0,
      this.options.findIndex((o) => o.recommended),
    );
    this.input = new Input({
      prompt: "",
      placeholder: PLACEHOLDER,
      placeholderStyle: (t) => theme.fg("dim", t),
    });
  }

  get onInput(): boolean {
    return this.cursor === this.options.length;
  }

  get typed(): string {
    return this.input.getValue().trim();
  }

  /** Several choices or none: the ticked labels in option order and the typed text, if any. */
  private ticks(): Answer | undefined {
    const other = this.typed;
    const labels = this.options
      .filter((_, i) => this.ticked.has(i))
      .map((o) => o.raw);
    if (!labels.length && other === "") return undefined;
    return { labels, ...(other === "" ? {} : { other }) };
  }

  private get single(): boolean {
    return !this.multi && this.options.length > 0;
  }

  /**
   * Takes the answer: the option under the cursor on a single choice, else what is ticked and
   * typed; false when there is nothing to take.
   */
  accept(): boolean {
    if (!this.single) {
      if (!this.ticks()) return false;
    } else if (this.onInput) {
      if (this.typed === "") return false;
      this.picked = "other";
    } else {
      // a single choice keeps one answer, so marking an option drops the typed one
      this.picked = this.cursor;
      this.input.setValue("");
    }
    this.confirmed = true;
    return true;
  }

  /** The accepted answer as it stands now; undefined until one was accepted. */
  answer(): Answer | undefined {
    if (!this.confirmed) return undefined;
    if (!this.single) return this.ticks();
    if (this.picked === "other")
      return this.typed === "" ? undefined : { labels: [], other: this.typed };
    const option =
      this.picked === undefined ? undefined : this.options[this.picked];
    return option && { labels: [option.raw] };
  }
}

class AskDialog implements Component, Focusable {
  focused = false;
  private readonly pages: Page[];
  /** The page shown; `pages.length` is the Submit tab, which exists only with several pages. */
  private tab = 0;
  private finished = false;

  constructor(
    questions: readonly AskQuestion[],
    private readonly deps: Deps,
  ) {
    this.pages = questions.map((q) => new Page(q, deps.theme));
  }

  private get tabbed(): boolean {
    return this.pages.length > 1;
  }

  private get page(): Page | undefined {
    return this.pages[this.tab];
  }

  handleInput(data: string): void {
    if (this.finished) return;
    try {
      this.key(data);
    } catch (error: unknown) {
      this.finish(error instanceof Error ? error : new Error(String(error)));
    }
  }

  render(width: number): string[] {
    try {
      return this.draw(width).map((line) => truncateToWidth(line, width));
    } catch (error: unknown) {
      // Deferred: Pi swaps the editor back on done, which must not happen mid-render
      queueMicrotask(() =>
        this.finish(error instanceof Error ? error : new Error(String(error))),
      );
      return [];
    }
  }

  invalidate(): void {
    for (const page of this.pages) page.input.invalidate();
  }

  private finish(result: Answers | undefined | Error): void {
    if (this.finished) return;
    this.finished = true;
    this.deps.done(result);
  }

  private answers(): Answers {
    return this.pages.map((p) => p.answer());
  }

  private key(data: string): void {
    const { keys } = this.deps;
    const page = this.page;
    const tabs = this.pages.length + 1;
    if (keys.matches(data, "tui.select.cancel")) {
      if (page?.onInput && page.input.getValue() !== "")
        page.input.setValue("");
      else this.finish(undefined);
    } else if (this.tabbed && keys.matches(data, "tui.input.tab"))
      this.tab = (this.tab + 1) % tabs;
    else if (this.tabbed && matchesKey(data, Key.shift("tab")))
      this.tab = (this.tab + tabs - 1) % tabs;
    else if (!page) {
      if (keys.matches(data, "tui.select.confirm")) this.submit();
    } else if (keys.matches(data, "tui.select.up"))
      page.cursor = Math.max(0, page.cursor - 1);
    else if (keys.matches(data, "tui.select.down"))
      page.cursor = Math.min(page.options.length, page.cursor + 1);
    else if (keys.matches(data, "tui.select.confirm")) this.confirm(page);
    else if (page.onInput) page.input.handleInput(data);
    // Space has no action id; on the Other row it is typing, so it acts on option rows only.
    // Between tabs a tick or a radio pick counts as an answer; Enter would also move on.
    else if (matchesKey(data, Key.space)) {
      if (page.multi && !page.ticked.delete(page.cursor))
        page.ticked.add(page.cursor);
      if (this.tabbed) page.accept();
    }
  }

  private confirm(page: Page): void {
    if (!page.accept()) return;
    if (!this.tabbed) {
      this.finish(this.answers());
      return;
    }
    // Forward only: a question the user tabbed past is theirs to leave unanswered
    const next = this.pages.findIndex((p, i) => i > this.tab && !p.answer());
    this.tab = next === -1 ? this.pages.length : next;
  }

  private submit(): void {
    const answers = this.answers();
    this.finish(answers.some((a) => a) ? answers : undefined);
  }

  private draw(width: number): string[] {
    const { theme } = this.deps;
    const rule = theme.fg("accent", "─".repeat(width));
    const lines = [rule];
    if (this.tabbed) lines.push(this.chips(width), "");
    const page = this.page;
    lines.push(...(page ? this.question(page, width) : this.review()));
    lines.push("");
    // Wrapped, not cut: a cut drops the end of the hint, where cancel is
    for (const line of wrapTextWithAnsi(this.hint(), Math.max(1, width - 1)))
      lines.push(` ${theme.fg("muted", line)}`);
    lines.push(rule);
    return lines;
  }

  private chips(width: number): string {
    const { theme } = this.deps;
    const active = (label: string) =>
      theme.bg("selectedBg", theme.bold(theme.fg("text", ` ${label} `)));
    const chips = this.pages.map((p, i) => {
      if (i === this.tab) return active(p.header);
      return p.answer()
        ? ` ${theme.fg("accent", "✓ ")}${theme.fg("text", p.header)} `
        : ` ${theme.fg("dim", p.header)} `;
    });
    const submit =
      this.tab === this.pages.length
        ? active("Submit")
        : ` ${theme.fg("text", "Submit")} `;
    const row = ` ${[...chips, submit].join(" ")}`;
    if (visibleWidth(row) <= width) return row;
    const page = this.page;
    return page
      ? ` ${active(page.header)} ${theme.fg("muted", `(${this.tab + 1}/${this.pages.length})`)}`
      : ` ${active("Submit")}`;
  }

  private question(page: Page, width: number): string[] {
    const { theme } = this.deps;
    const wrap = (text: string, indent: number) =>
      wrapTextWithAnsi(text, Math.max(1, width - indent));
    const marker = (on: boolean) => (on ? theme.fg("accent", " > ") : "   ");
    const box = (i: number) =>
      page.multi
        ? page.ticked.has(i)
          ? "[x] "
          : "[ ] "
        : this.tabbed
          ? page.picked === i
            ? "(•) "
            : "( ) "
          : "";
    const indent = " ".repeat(visibleWidth(marker(false) + box(0)) + 2);

    const lines: string[] = [];
    for (const line of wrap(page.text, 1))
      lines.push(` ${theme.fg("text", line)}`);
    lines.push("");
    page.options.forEach((o, i) => {
      lines.push(
        marker(i === page.cursor) +
          theme.fg("text", box(i) + o.label) +
          (o.recommended ? ` ${theme.fg("success", "recommended")}` : ""),
      );
      if (o.description)
        for (const line of wrap(o.description, indent.length))
          lines.push(indent + theme.fg("muted", line));
    });

    const lead =
      marker(page.onInput) +
      theme.fg("text", page.options.length ? "Other" : "Answer") +
      "  ";
    for (const p of this.pages) p.input.focused = false;
    page.input.focused = this.focused && page.onInput;
    const typed = page.input.getValue();
    const field = page.onInput
      ? (page.input.render(Math.max(1, width - visibleWidth(lead)))[0] ?? "")
      : typed
        ? theme.fg("text", sanitize(typed))
        : theme.fg("dim", PLACEHOLDER);
    lines.push(lead + field);
    return lines;
  }

  private review(): string[] {
    const { theme } = this.deps;
    const headers = alignHeaders(this.pages.map((p) => p.header));
    return this.pages.map((p, i) => {
      const answer = p.answer();
      return ` ${theme.fg("muted", headers[i] ?? "")}${
        answer
          ? theme.fg("text", sanitize(answerLine(answer)))
          : theme.fg("warning", "not answered")
      }`;
    });
  }

  private hint(): string {
    const { keys } = this.deps;
    const key = (id: Parameters<typeof keyName>[1]) => keyName(keys, id);
    const cancel = `${key("tui.select.cancel")} cancel`;
    // Shift+Tab has no action id of its own, so the hint names it literally
    const tab = this.tabbed
      ? `${key("tui.input.tab")}/shift+tab switch · `
      : "";
    const page = this.page;
    if (page) {
      const space = page.multi
        ? "space tick · "
        : this.tabbed && page.options.length
          ? "space pick · "
          : "";
      return `${key("tui.select.up")}/${key("tui.select.down")} move · ${space}${key("tui.select.confirm")} answer · ${tab}${cancel}`;
    }
    const answers = this.answers();
    const submit = answers.every((a) => a)
      ? "submit"
      : answers.some((a) => a)
        ? "submit anyway"
        : "decline";
    return `${key("tui.select.confirm")} ${submit} · ${tab}${cancel}`;
  }
}
