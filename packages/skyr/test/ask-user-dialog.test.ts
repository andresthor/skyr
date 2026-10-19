/** The ask_user dialog on its own: keys in, lines and `done` out. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { createAskDialog } from "../src/ask-user/dialog.js";
import type { AskQuestion } from "../src/ask-user/index.js";
import { keybindings } from "./voice.js";

const plain = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const SPACE = " ";
const TAB = "\t";
const BACKTAB = "\x1b[Z";

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

test("a single question finishes on Enter with the option under the cursor", () => {
  const d = dialog();
  d.press(DOWN, UP, UP, DOWN, ENTER);
  expect(d.done.mock.calls).toEqual([[[{ labels: ["Postgres"] }]]]);
});

test("the keys follow Pi's bindings when the user rebinds them", () => {
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

test("Enter on the Other row with no text does nothing", () => {
  const d = dialog();
  d.press(DOWN, DOWN, ENTER);
  expect(d.done).not.toHaveBeenCalled();
});

test("Esc on the Other row clears typed text before a second Esc cancels", () => {
  const d = dialog();
  d.press(DOWN, DOWN, "a", "b", "c");
  expect(d.text().join("\n")).toContain("Other  abc");
  d.press(ESC);
  expect(d.done).not.toHaveBeenCalled();
  expect(d.text().join("\n")).not.toContain("abc");
  d.press(ESC);
  expect(d.done.mock.calls).toEqual([[undefined]]);
});

test("text typed on the Other row is the answer, spaces included", () => {
  const d = dialog();
  d.press(DOWN, DOWN, "use", " ", "both", ENTER);
  expect(d.done.mock.calls).toEqual([[[{ labels: [], other: "use both" }]]]);
});

test("a question with no options has only the answer field, and the cursor starts on it", () => {
  const d = dialog([{ question: "What should it be called?", header: "Name" }]);
  expect(d.text().join("\n")).toContain("Answer");
  d.press("skyr", ENTER);
  expect(d.done.mock.calls).toEqual([[[{ labels: [], other: "skyr" }]]]);
});

const features: AskQuestion = {
  question: "Which features should ship?",
  header: "Features",
  multiSelect: true,
  options: [
    { label: "Auth" },
    { label: "Billing", recommended: true },
    { label: "Search" },
  ],
};

test("a multi-select question returns every ticked label in option order", () => {
  const d = dialog([features]);
  expect(d.text().join("\n")).toContain("space tick");
  d.press(DOWN, SPACE, UP, UP, SPACE, SPACE, SPACE, ENTER);
  expect(d.done.mock.calls).toEqual([[[{ labels: ["Auth", "Search"] }]]]);
});

test("Enter on a multi-select question with nothing ticked or typed does nothing", () => {
  const d = dialog([features]);
  d.press(ENTER);
  expect(d.done).not.toHaveBeenCalled();
});

test("on a multi-select question's Other row Space is typing, so the typed answer keeps its spaces", () => {
  const d = dialog([features]);
  d.press(UP, SPACE, DOWN, DOWN, DOWN, ..."use the queue", ENTER);
  expect(d.done.mock.calls).toEqual([
    [[{ labels: ["Auth"], other: "use the queue" }]],
  ]);
});

test("the cursor starts on the recommended option, which the dialog marks", () => {
  const d = dialog([
    {
      ...storage,
      options: [{ label: "SQLite" }, { label: "Postgres", recommended: true }],
    },
  ]);
  expect(d.text()).toContain(" > Postgres recommended");
  d.press(ENTER);
  expect(d.done.mock.calls).toEqual([[[{ labels: ["Postgres"] }]]]);
});

test("a multi-select question starts with nothing ticked, its recommended option included", () => {
  const multi = dialog([features]);
  const lines = multi.text();
  expect(lines).toContain(" > [ ] Billing recommended");
  expect(lines.join("\n")).not.toContain("[x]");
  multi.press(SPACE);
  expect(multi.text()).toContain(" > [x] Billing recommended");
});

const scope: AskQuestion = {
  question: "How far should the change reach?",
  header: "Scope",
  options: [{ label: "A" }, { label: "B" }],
};
const naming: AskQuestion = {
  question: "What should it be called?",
  header: "Name",
};

test("several questions: Tab and Shift+Tab move through them and Submit, Enter advances to the next unanswered one, answers survive a round trip, and Submit with one unanswered jumps to it", () => {
  const d = dialog([scope, storage, naming]);
  const screen = () => d.text().join("\n");
  expect(d.text()[1]).toBe("  Scope   Storage   Name   Submit ");
  d.press(ENTER);
  expect(screen()).toContain(storage.question);
  expect(d.text()[1]).toContain("✓ Scope");
  d.press(TAB, TAB);
  expect(screen()).toContain(" Scope    A");
  expect(screen()).toContain(" Storage  not answered");
  expect(screen()).toContain("enter go to Storage · escape cancel");
  d.press(ENTER);
  expect(screen()).toContain(storage.question);
  d.press(BACKTAB);
  expect(d.text()).toContain(" > (•) A");
  d.press(TAB, DOWN, ENTER);
  expect(screen()).toContain(naming.question);
  d.press(..."skyr", ENTER);
  expect(screen()).toContain("enter submit · tab next · escape cancel");
  expect(d.done).not.toHaveBeenCalled();
  d.press(ENTER);
  expect(d.done.mock.calls).toEqual([
    [
      [
        { labels: ["A"] },
        { labels: ["Postgres"] },
        { labels: [], other: "skyr" },
      ],
    ],
  ]);
});

test("across tabs a single choice keeps one answer: the last one taken with Enter", () => {
  const otherLast = dialog([scope, storage]);
  otherLast.press(ENTER, BACKTAB, DOWN, DOWN, ..."mine", ENTER, ENTER, ENTER);
  expect(otherLast.done.mock.calls[0]?.[0]?.[0]).toEqual({
    labels: [],
    other: "mine",
  });
  const optionLast = dialog([scope, storage]);
  optionLast.press(DOWN, DOWN, ..."mine", ENTER, BACKTAB, UP, UP, ENTER);
  optionLast.press(ENTER, ENTER);
  expect(optionLast.done.mock.calls[0]?.[0]?.[0]).toEqual({ labels: ["A"] });
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
  const wideMulti: AskQuestion = {
    ...wide,
    multiSelect: true,
    options: wide.options?.map((o) => ({ ...o, recommended: true })),
  };
  for (const width of [1, 8, 24, 80]) {
    for (const [question, cursorOnOther] of [
      [wide, false],
      [wide, true],
      [wideMulti, false],
    ] as const) {
      const d = dialog([question]);
      if (cursorOnOther) d.press(DOWN, DOWN, "漢字🙂".repeat(30));
      else d.press(SPACE);
      for (const line of d.component.render(width))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const four = dialog([wide, wideMulti, scope, naming]);
    for (const keys of [[], [ENTER], [TAB, TAB, TAB, TAB]]) {
      four.press(...keys);
      for (const line of four.component.render(width))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  }

  // too narrow for every chip: only the active one, with where it stands
  const narrow = dialog([
    scope,
    storage,
    naming,
    { ...naming, header: "Owner" },
  ]);
  expect(narrow.text(24)[1]).toBe("  Scope  (1/4)");
  narrow.press(BACKTAB);
  expect(narrow.text(24)[1]).toBe("  Submit ");
});
