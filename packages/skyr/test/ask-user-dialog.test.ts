/** The ask_user dialog on its own: keys in, lines and `done` out. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { createAskDialog } from "../src/ask-user/dialog.js";
import type { AskQuestion } from "../src/ask-user/index.js";
import { keybindings } from "./voice.js";

const plain = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

const storage: AskQuestion = {
  question: "Which storage should the cache use?",
  header: "Storage",
  options: [
    { label: "SQLite", description: "one file, no daemon" },
    { label: "Postgres" },
  ],
};

function dialog(
  questions: AskQuestion[] = [storage],
  o: { keys?: ReturnType<typeof keybindings>; theme?: Theme } = {},
) {
  const done = vi.fn();
  const component = createAskDialog(questions, {
    theme: o.theme ?? plain,
    keys: o.keys ?? keybindings(),
    done,
  });
  component.focused = true;
  const press = (...keys: string[]) => {
    for (const key of keys) component.handleInput?.(key);
  };
  const text = (width = 60) =>
    component.render(width).map((l) => stripTerminalSequences(l));
  return { component, done, press, text };
}

test("a single question finishes on Enter with the option under the cursor, and the keys follow Pi's bindings when the user rebinds them", () => {
  const plainKeys = dialog();
  plainKeys.press(DOWN, UP, UP, DOWN, ENTER);
  expect(plainKeys.done.mock.calls).toEqual([[[{ labels: ["Postgres"] }]]]);

  const rebound = dialog([storage], {
    keys: keybindings({ "tui.select.down": "ctrl+n" }),
  });
  expect(rebound.text().join("\n")).toContain("up/ctrl+n move");
  rebound.press(DOWN, ENTER);
  expect(rebound.done.mock.calls).toEqual([[[{ labels: ["SQLite"] }]]]);

  const moved = dialog([storage], {
    keys: keybindings({ "tui.select.down": "ctrl+n" }),
  });
  moved.press("\x0e", ENTER);
  expect(moved.done.mock.calls).toEqual([[[{ labels: ["Postgres"] }]]]);
});

test("the Other row owns typing: text goes to the field, Enter with no text does nothing, and Esc clears typed text before a second Esc cancels", () => {
  const d = dialog();
  d.press(DOWN, DOWN, ENTER);
  expect(d.done).not.toHaveBeenCalled();
  d.press("a", "b", "c");
  expect(d.text().join("\n")).toContain("Other  abc");
  d.press(ESC);
  expect(d.done).not.toHaveBeenCalled();
  expect(d.text().join("\n")).not.toContain("abc");
  d.press(ESC);
  expect(d.done.mock.calls).toEqual([[undefined]]);

  const typed = dialog();
  typed.press(DOWN, DOWN, "use", " ", "both", ENTER);
  expect(typed.done.mock.calls).toEqual([
    [[{ labels: [], other: "use both" }]],
  ]);

  // with no options, the field is the only row, and the cursor starts on it
  const free = dialog([
    { question: "What should it be called?", header: "Name" },
  ]);
  expect(free.text().join("\n")).toContain("Answer");
  free.press("skyr", ENTER);
  expect(free.done.mock.calls).toEqual([[[{ labels: [], other: "skyr" }]]]);
});

test("a throw while drawing or handling a key closes the dialog with that error instead of reaching the TUI's stack", async () => {
  const throwing = {
    fg: () => {
      throw new Error("boom");
    },
  } as unknown as Theme;
  const drawn = dialog([storage], { theme: throwing });
  expect(drawn.component.render(40)).toEqual([]);
  expect(drawn.done).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(drawn.done).toHaveBeenCalledTimes(1);
  expect(drawn.done.mock.calls[0]?.[0]).toEqual(new Error("boom"));
  drawn.component.render(40);
  await Promise.resolve();
  expect(drawn.done).toHaveBeenCalledTimes(1);

  const keys = keybindings();
  const keyed = dialog([storage], {
    keys: Object.assign(Object.create(keys), {
      matches: () => {
        throw new Error("boom");
      },
    }),
  });
  expect(() => keyed.press("x")).not.toThrow();
  keyed.press("y");
  expect(keyed.done.mock.calls).toEqual([[new Error("boom")]]);
});

test("every line fits the width, from 1 to 80 columns, with wide characters, emoji and a 200-column label", () => {
  const wide: AskQuestion = {
    question: `漢字で答えてください 🙂 ${"long ".repeat(30)}?`,
    header: "漢字🙂",
    options: [
      { label: "x".repeat(200), description: `🙂漢字 ${"y".repeat(200)}` },
      { label: "漢字🙂漢字🙂" },
    ],
  };
  for (const width of [1, 8, 24, 80]) {
    for (const cursorOnOther of [false, true]) {
      const d = dialog([wide]);
      if (cursorOnOther) d.press(DOWN, DOWN, "漢字🙂".repeat(30));
      for (const line of d.component.render(width))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  }
});
