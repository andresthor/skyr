/**
 * The ask_user dialog, drawn in place of the input editor. It owns the keyboard until the user
 * answers or declines, and knows nothing of Pi's runtime: questions in, answers out through `done`.
 * One question finishes on Enter; two to four get a tab each and a Review tab that sends
 * whatever is answered, or declines when nothing is.
 */
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Glyphs, glyphsOf } from "../ui/caps.js";
import { fitToWidth } from "../ui/fit.js";
import { guard } from "../ui/guard.js";
import { keyName } from "../ui/hint.js";
import { type Paint, selected, styled, type Token } from "../ui/palette.js";
import { sanitize } from "../ui/text.js";
import {
  type Answer,
  type Answers,
  answerLine,
  shortHeader,
} from "./answers.js";
import type { AskQuestion } from "./index.js";

interface Deps {
  paint: Paint;
  /** Colours the rule rows with the thinking level's colour, which the colour tier alone uses. */
  rule: (text: string) => string;
  keys: Pick<KeybindingsManager, "matches" | "getKeys">;
  /**
   * `undefined` = declined with Esc or submitted with nothing answered; an `undefined` entry = a
   * question left unanswered; an `Error` = the dialog threw and closed.
   */
  done(result: Answers | undefined | Error): void;
}

const PLACEHOLDER = "type an answer";

/** One key hint; `rank` is how long it survives a narrow pane, the highest last. */
interface Hint {
  text: string;
  rank: number;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

const asError = (cause: unknown) =>
  cause instanceof Error ? cause : new Error(String(cause));

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

  constructor(question: AskQuestion, paint: Paint, glyphs: Glyphs) {
    this.text = sanitize(question.question);
    this.header = shortHeader(question.header, glyphs.ellipsis);
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
      placeholderStyle: (t) => styled(paint, t, { fg: paint.theme.colors.dim }),
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
  /** The page shown; `pages.length` is the Review tab, which exists only with several pages. */
  private tab = 0;
  private finished = false;
  private readonly glyphs: Glyphs;
  readonly render: (width: number) => string[];

  constructor(
    questions: readonly AskQuestion[],
    private readonly deps: Deps,
  ) {
    this.glyphs = glyphsOf(deps.paint.mode);
    this.pages = questions.map((q) => new Page(q, deps.paint, this.glyphs));
    // Deferred: Pi swaps the editor back on done, which must not happen mid-render
    this.render = guard(
      (width) =>
        this.draw(width).map((line) =>
          fitToWidth(line, width, this.glyphs.ellipsis),
        ),
      (cause) => queueMicrotask(() => this.finish(asError(cause))),
    );
  }

  private ink(text: string, token: Token, bold = false): string {
    const { paint } = this.deps;
    return styled(paint, text, { fg: paint.theme.colors[token], bold });
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
      this.finish(asError(error));
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
    else if (matchesKey(data, Key.space)) this.tick(page);
    else this.digit(page, DIGITS.findIndex((d) => matchesKey(data, d)) + 1);
  }

  // Between tabs a tick or a radio pick counts as an answer; Enter would also move on.
  private tick(page: Page): void {
    if (page.multi && !page.ticked.delete(page.cursor))
      page.ticked.add(page.cursor);
    if (this.tabbed) page.accept();
  }

  /** A row's number: picks the option like Enter, ticks it like Space, or moves to Other. */
  private digit(page: Page, n: number): void {
    if (n === 0 || n > page.options.length + 1) return;
    page.cursor = n - 1;
    if (page.onInput) return;
    if (page.multi) this.tick(page);
    else this.confirm(page);
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
    const page = this.page;
    return [
      this.topRule(width),
      ...(page ? this.question(page, width) : this.review()),
      this.bottomRule(width),
    ];
  }

  private bareRule(cols: number): string {
    const { paint, rule } = this.deps;
    const glyphs = this.glyphs.rule.repeat(Math.max(0, cols));
    return paint.mode === "color" ? rule(glyphs) : glyphs;
  }

  /**
   * A rule row with `left` after its lead and `right` before its tail, rule between; undefined
   * when they leave no column of rule. Without `right`, `left` is followed by rule to the edge.
   */
  private framed(
    width: number,
    left: string,
    right: string,
  ): string | undefined {
    const lead = left === "" ? " " : ` ${left} `;
    const used = 2 + visibleWidth(lead);
    const start = this.bareRule(2) + lead;
    if (right === "")
      return used <= width ? start + this.bareRule(width - used) : undefined;
    const fill = width - used - visibleWidth(right) - 4;
    return fill >= 1
      ? `${start}${this.bareRule(fill)} ${right} ${this.bareRule(2)}`
      : undefined;
  }

  private topRule(width: number): string {
    const left = `${this.ink("?", "warning")} ${this.ink("ask_user", "text", true)}`;
    for (const right of [...this.tabsAndCount(), ""]) {
      const row = this.framed(width, left, right);
      if (row !== undefined) return row;
    }
    return this.bareRule(width);
  }

  /** What the top rule can say of where the user is, from the most to the least. */
  private tabsAndCount(): string[] {
    if (!this.tabbed) return [];
    const { paint } = this.deps;
    const { mark, sep } = this.glyphs;
    const onReview = this.tab === this.pages.length;
    const active = (label: string) =>
      selected(paint, ` ${label} `, `[${label}]`);
    const tabs = [...this.pages.map((p) => p.header), "Review"].map(
      (label, i) => {
        if (i === this.tab) return active(label);
        const page = this.pages[i];
        if (!page) return this.ink(label, "text");
        return page.answer()
          ? `${this.ink(`${mark.done} `, "success")}${this.ink(label, "text")}`
          : this.ink(label, "muted");
      },
    );
    const count = this.ink(
      onReview
        ? `${this.pages.filter((p) => p.answer()).length} of ${this.pages.length} answered`
        : `${this.tab + 1} of ${this.pages.length}`,
      "muted",
    );
    const dim = this.ink(sep, "dim");
    return [
      `${tabs.join(dim)}  ${count}`,
      `${tabs[this.tab]}  ${count}`,
      count,
    ];
  }

  private bottomRule(width: number): string {
    const hints = this.hints();
    // The lowest rank goes first, the rightmost of equals; the cancel key is the last to go
    for (;;) {
      const text = hints.map((h) => h.text).join(this.glyphs.sep);
      const row = this.framed(width, "", this.ink(text, "muted"));
      if (row !== undefined || hints.length <= 1)
        return row ?? this.bareRule(width);
      const ranks = hints.map((h) => h.rank);
      hints.splice(ranks.lastIndexOf(Math.min(...ranks)), 1);
    }
  }

  private question(page: Page, width: number): string[] {
    const { paint } = this.deps;
    const { colors } = paint.theme;
    const wrap = (text: string, indent: number) =>
      wrapTextWithAnsi(text, Math.max(1, width - indent));
    // The cursor row and what hangs under it, as one block: filled in colour, bold in mono
    const block = (rows: string[], selected: boolean) =>
      rows.map((row) => {
        const cut = fitToWidth(row, width, this.glyphs.ellipsis);
        if (!selected || paint.mode !== "color") return cut;
        return styled(paint, cut + " ".repeat(width - visibleWidth(cut)), {
          bg: colors.selectedBg,
        });
      });
    const label = (text: string, selected: boolean) =>
      selected && paint.mode === "mono"
        ? this.ink(text, "text", true)
        : this.ink(text, "text");
    const marker = (on: boolean) =>
      on ? ` ${this.ink(this.glyphs.now, "accent")} ` : "   ";
    const number = (n: number) => `${this.ink(String(n), "accent", true)}  `;
    const box = (i: number) =>
      page.multi
        ? page.ticked.has(i)
          ? "[x] "
          : "[ ] "
        : this.tabbed
          ? page.picked === i
            ? `(${this.glyphs.mark.running}) `
            : "( ) "
          : "";
    const indent = 6 + box(0).length;

    const lines: string[] = [];
    for (const line of wrap(page.text, 1))
      lines.push(` ${this.ink(line, "text")}`);
    lines.push("");
    page.options.forEach((o, i) => {
      const selected = i === page.cursor;
      lines.push(
        ...block(
          [
            marker(selected) +
              number(i + 1) +
              label(box(i) + o.label, selected) +
              (o.recommended ? ` ${this.ink("recommended", "success")}` : ""),
            ...(o.description
              ? wrap(o.description, indent).map(
                  (line) => " ".repeat(indent) + this.ink(line, "muted"),
                )
              : []),
          ],
          selected,
        ),
      );
    });

    const lead =
      marker(page.onInput) +
      (page.options.length ? number(page.options.length + 1) : "") +
      label(page.options.length ? "Other" : "Answer", page.onInput) +
      "  ";
    for (const p of this.pages) p.input.focused = false;
    page.input.focused = this.focused && page.onInput;
    const typed = page.input.getValue();
    const field = page.onInput
      ? (page.input.render(Math.max(1, width - visibleWidth(lead)))[0] ?? "")
      : typed
        ? this.ink(sanitize(typed), "text")
        : this.ink(PLACEHOLDER, "dim");
    lines.push(...block([lead + field], page.onInput));
    return lines;
  }

  private review(): string[] {
    const headers = alignHeaders(this.pages.map((p) => p.header));
    return this.pages.map((p, i) => {
      const answer = p.answer();
      return ` ${this.ink(headers[i] ?? "", "muted")}${
        answer
          ? this.ink(sanitize(answerLine(answer)), "text")
          : this.ink("not answered", "warning")
      }`;
    });
  }

  /** The keys that work now, in display order. */
  private hints(): Hint[] {
    const { keys } = this.deps;
    const key = (id: Parameters<typeof keyName>[1]) => keyName(keys, id);
    const hints: Hint[] = [];
    const page = this.page;
    if (page) {
      if (page.options.length) {
        hints.push({
          text: `1-${page.options.length + 1} ${page.multi ? "tick" : "pick"}`,
          rank: 4,
        });
        hints.push({
          text: `${key("tui.select.up")}/${key("tui.select.down")} move`,
          rank: 2,
        });
      }
      if (page.multi) hints.push({ text: "space tick", rank: 3 });
      else if (this.tabbed && page.options.length)
        hints.push({ text: "space pick", rank: 3 });
      hints.push({ text: `${key("tui.select.confirm")} answer`, rank: 5 });
    } else {
      const answers = this.answers();
      // With nothing answered Enter declines like the cancel key, which says so below
      if (answers.some((a) => a))
        hints.push({
          text: `${key("tui.select.confirm")} ${answers.every((a) => a) ? "send" : "send anyway"}`,
          rank: 5,
        });
    }
    // Shift+Tab has no action id of its own, so the hint names it literally
    if (this.tabbed)
      hints.push({
        text: `${key("tui.input.tab")}/shift+tab switch`,
        rank: 1,
      });
    hints.push({ text: `${key("tui.select.cancel")} decline`, rank: 6 });
    return hints;
  }
}
