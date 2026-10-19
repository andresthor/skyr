/**
 * The ask_user dialog, drawn in place of the input editor. It owns the keyboard until the user
 * answers or declines, and knows nothing of Pi's runtime: questions in, answers out through `done`.
 */
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { keyName, sanitize } from "../tools/render.js";
import type { AskQuestion } from "./index.js";

/** One question's answer: the picked labels as the model wrote them, and the user's own words. */
export interface Answer {
  labels: string[];
  other?: string;
}

interface Deps {
  theme: Pick<Theme, "fg">;
  keys: Pick<KeybindingsManager, "matches" | "getKeys">;
  /** `undefined` = declined with Esc; an `Error` = the dialog threw and closed. */
  done(result: Answer[] | undefined | Error): void;
}

const PLACEHOLDER = "type an answer";

/** The question dialog. Sanitizes every model string itself, and calls `done` at most once. */
export function createAskDialog(
  questions: readonly AskQuestion[],
  deps: Deps,
): Component & Focusable {
  const [question] = questions;
  if (!question) throw new Error("ask_user: the dialog needs a question");
  return new AskDialog(question, deps);
}

class AskDialog implements Component, Focusable {
  focused = false;
  private readonly text: string;
  private readonly options: {
    raw: string;
    label: string;
    description?: string;
  }[];
  // An Input, not an Editor: it keeps no paste store, so nothing typed here can come back as a marker
  private readonly input: Input;
  private cursor = 0;
  private finished = false;

  constructor(
    question: AskQuestion,
    private readonly deps: Deps,
  ) {
    this.text = sanitize(question.question);
    this.options = (question.options ?? []).map((o) => ({
      raw: o.label,
      label: sanitize(o.label),
      ...(o.description === undefined
        ? {}
        : { description: sanitize(o.description) }),
    }));
    this.input = new Input({
      prompt: "",
      placeholder: PLACEHOLDER,
      placeholderStyle: (t) => deps.theme.fg("dim", t),
    });
  }

  private get onInput(): boolean {
    return this.cursor === this.options.length;
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
    this.input.invalidate();
  }

  private finish(result: Answer[] | undefined | Error): void {
    if (this.finished) return;
    this.finished = true;
    this.deps.done(result);
  }

  private key(data: string): void {
    const { keys } = this.deps;
    if (keys.matches(data, "tui.select.up"))
      this.cursor = Math.max(0, this.cursor - 1);
    else if (keys.matches(data, "tui.select.down"))
      this.cursor = Math.min(this.options.length, this.cursor + 1);
    else if (keys.matches(data, "tui.select.confirm")) this.confirm();
    else if (keys.matches(data, "tui.select.cancel")) {
      if (this.onInput && this.input.getValue() !== "") this.input.setValue("");
      else this.finish(undefined);
    } else if (this.onInput) this.input.handleInput(data);
  }

  private confirm(): void {
    const option = this.options[this.cursor];
    const other = this.input.getValue().trim();
    if (option) this.finish([{ labels: [option.raw] }]);
    else if (other !== "") this.finish([{ labels: [], other }]);
  }

  private draw(width: number): string[] {
    const { theme, keys } = this.deps;
    const rule = theme.fg("accent", "─".repeat(width));
    const wrap = (text: string, indent: number) =>
      wrapTextWithAnsi(text, Math.max(1, width - indent));
    const marker = (on: boolean) => (on ? theme.fg("accent", " > ") : "   ");

    const lines = [rule];
    for (const line of wrap(this.text, 1))
      lines.push(` ${theme.fg("text", line)}`);
    lines.push("");
    this.options.forEach((o, i) => {
      lines.push(marker(i === this.cursor) + theme.fg("text", o.label));
      if (o.description)
        for (const line of wrap(o.description, 5))
          lines.push(`     ${theme.fg("muted", line)}`);
    });

    const lead =
      marker(this.onInput) +
      theme.fg("text", this.options.length ? "Other" : "Answer") +
      "  ";
    this.input.focused = this.focused && this.onInput;
    const typed = this.input.getValue();
    const field = this.onInput
      ? (this.input.render(Math.max(1, width - visibleWidth(lead)))[0] ?? "")
      : typed
        ? theme.fg("text", sanitize(typed))
        : theme.fg("dim", PLACEHOLDER);
    lines.push(lead + field);

    const hint = `${keyName(keys, "tui.select.up")}/${keyName(keys, "tui.select.down")} move · ${keyName(keys, "tui.select.confirm")} answer · ${keyName(keys, "tui.select.cancel")} cancel`;
    lines.push("", ` ${theme.fg("muted", hint)}`, rule);
    return lines;
  }
}
