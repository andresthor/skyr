/** The ask_user dialog on its own: keys in, lines and `done` out. */
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { createAskDialog } from "../src/ask-user/dialog.js";
import type { AskQuestion } from "../src/ask-user/index.js";
import type { Tier } from "../src/ui/caps.js";
import type { ThemeLike } from "../src/ui/palette.js";
import { keybindings, testPaint, testTheme } from "./voice.js";

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
  o: {
    keys?: ReturnType<typeof keybindings>;
    mode?: Tier;
    theme?: ThemeLike;
  } = {},
) {
  const done = vi.fn();
  const component = createAskDialog(questions, {
    paint: testPaint(o.mode, o.theme),
    rule: (text) => text,
    keys: o.keys ?? keybindings(),
    done,
  });
  component.focused = true;
  const press = (...keys: string[]) => {
    for (const key of keys) component.handleInput?.(key);
  };
  const text = (width = 60) =>
    component.render(width).map((l) => stripTerminalSequences(l).trimEnd());
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
  expect(rebound.text(100).join("\n")).toContain("up/ctrl+n move");
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
  expect(d.text(100).join("\n")).toContain("space tick");
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
  expect(d.text()).toContain(" › 2  Postgres recommended");
  d.press(ENTER);
  expect(d.done.mock.calls).toEqual([[[{ labels: ["Postgres"] }]]]);
});

test("a multi-select question starts with nothing ticked, its recommended option included", () => {
  const multi = dialog([features]);
  const lines = multi.text();
  expect(lines).toContain(" › 2  [ ] Billing recommended");
  expect(lines.join("\n")).not.toContain("[x]");
  multi.press(SPACE);
  expect(multi.text()).toContain(" › 2  [x] Billing recommended");
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

test("several questions: Tab and Shift+Tab move through them and Review, Enter advances to the next unanswered one, and answers survive a round trip", () => {
  const d = dialog([scope, storage, naming]);
  const screen = () => d.text().join("\n");
  expect(d.text(80)[0]).toMatch(/Scope\s+·\s+Storage\s+·\s+Name\s+·\s+Review/);
  expect(d.text(80)[0]).toContain("1 of 3");
  d.press(ENTER);
  expect(screen()).toContain(storage.question);
  expect(d.text(80)[0]).toContain("✓ Scope");
  expect(d.text(80)[0]).toContain("2 of 3");
  d.press(TAB, TAB);
  expect(receipt(d)).toBe(
    "Scope → A · Storage → not answered · Name → not answered",
  );
  d.press(BACKTAB, BACKTAB, BACKTAB);
  expect(d.text()).toContain(" › 1  (•) A");
  d.press(TAB, DOWN, ENTER);
  expect(screen()).toContain(naming.question);
  d.press(..."skyr", ENTER);
  expect(bottom(d)).toContain(
    "enter send · tab/shift+tab switch · escape decline",
  );
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

test("Enter never goes back to a question the user tabbed past, and Review sends it as unanswered", () => {
  const d = dialog([scope, storage, naming]);
  const screen = () => d.text().join("\n");
  d.press(TAB, ENTER);
  expect(screen()).toContain(naming.question);
  d.press(..."skyr", ENTER);
  expect(receipt(d)).toMatch(/^Scope → not answered · Storage → SQLite/);
  expect(bottom(d)).toContain("enter send anyway · ");
  d.press(ENTER);
  expect(d.done.mock.calls).toEqual([
    [[undefined, { labels: ["SQLite"] }, { labels: [], other: "skyr" }]],
  ]);
});

test("unticking every box leaves a question unanswered, so Review declines", () => {
  const d = dialog([features, storage]);
  d.press(SPACE, SPACE, BACKTAB);
  expect(d.text(80)[0]).not.toContain("✓");
  expect(bottom(d)).not.toContain("enter decline");
  expect(bottom(d)).toContain("escape decline");
  d.press(ENTER);
  expect(d.done.mock.calls).toEqual([[undefined]]);
});

test("Review with nothing answered declines, and its hint says so", () => {
  const d = dialog([scope, storage]);
  d.press(BACKTAB);
  expect(bottom(d)).not.toContain("enter decline");
  expect(bottom(d)).toContain("escape decline");
  d.press(ENTER);
  expect(d.done.mock.calls).toEqual([[undefined]]);
});

test("Space marks a tabbed single choice without moving on, and does nothing on a lone question", () => {
  const tabbed = dialog([scope, storage]);
  expect(bottom(tabbed)).toContain("space pick · ");
  tabbed.press(DOWN, SPACE);
  expect(tabbed.text()).toContain(" › 2  (•) B");
  expect(tabbed.text().join("\n")).toContain(scope.question);
  tabbed.press(TAB);
  expect(tabbed.text(80)[0]).toContain("✓ Scope");

  // a lone question draws no radio mark, so Space accepts nothing and the Other draft stays
  const lone = dialog([storage]);
  lone.press(DOWN, DOWN, ..."draft", UP, SPACE);
  expect(lone.done).not.toHaveBeenCalled();
  expect(lone.text().join("\n")).toContain("Other  draft");
});

test("between tabs a Space tick is an answer, so Review sends it without Enter", () => {
  const d = dialog([features, storage]);
  d.press(SPACE, TAB, ENTER);
  expect(receipt(d)).toBe("Features → Billing · Storage → SQLite");
  d.press(ENTER);
  expect(d.done.mock.calls).toEqual([
    [[{ labels: ["Billing"] }, { labels: ["SQLite"] }]],
  ]);
});

test("across tabs a single choice keeps one answer: the last one taken", () => {
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

test("the Review tab marks an answer in the user's own words as the transcript row does", () => {
  const d = dialog([scope, naming]);
  d.press(ENTER, ..."skyr", ENTER);
  expect(receipt(d)).toBe("Scope → A · Name → [own words] skyr");
});

/** The review page's body, as the one line of text it reads as at a wide pane. */
function receipt(d: ReturnType<typeof dialog>, width = 200): string {
  return d
    .text(width)
    .slice(1, -1)
    .map((l) => l.trim())
    .join(" ");
}

/** The bottom rule, as plain text. */
function bottom(d: ReturnType<typeof dialog>, width = 100): string {
  return d.text(width).at(-1) ?? "";
}

test("hints drop in order, and the decline key is the last to go", () => {
  const d = dialog([features, storage]);
  const all = bottom(d, 200);
  for (const hint of [
    "up/down move",
    "space tick",
    "enter answer",
    "tab/shift+tab switch",
    "escape decline",
  ])
    expect(all).toContain(hint);
  const kept = (width: number) =>
    [
      "tab/shift+tab switch",
      "up/down move",
      "space tick",
      "enter answer",
      "escape decline",
    ].filter((h) => bottom(d, width).includes(h));
  // the lowest rank goes first: switch, then move, then tick, then answer
  expect(kept(200)).toHaveLength(5);
  let previous = 5;
  for (let width = 200; width >= 14; width--) {
    const left = kept(width);
    expect(left.length).toBeLessThanOrEqual(previous);
    previous = left.length;
    if (left.length > 0) expect(left).toContain("escape decline");
    if (width >= 22) expect(left).toContain("escape decline");
  }
  expect(bottom(d, 14)).toBe("─".repeat(14));
});

test("the bottom rule is one row at every width", () => {
  for (const questions of [[storage], [features, storage]]) {
    const d = dialog(questions);
    for (let width = 1; width <= 120; width++) {
      const rows = d.text(width);
      expect(rows.at(-1)).toMatch(/^[─ a-z/+\-1-9·]*$/);
      expect(visibleWidth(rows.at(-1) ?? "")).toBeLessThanOrEqual(width);
      expect(rows.at(-2)).not.toMatch(/^─+$/);
    }
  }
});

const four = [scope, storage, naming, { ...naming, header: "Owner" }];

test("the top rule ladder: all tabs, active tab with count, count, bare rule", () => {
  const d = dialog(four);
  const top = (width: number) => d.text(width)[0] ?? "";
  expect(top(120)).toMatch(
    /Scope\s+·\s+Storage\s+·\s+Name\s+·\s+Owner\s+·\s+Review\s+1 of 4 ──$/,
  );
  expect(top(40)).toMatch(/^── \? ask_user ─+\s+Scope\s+1 of 4 ──$/);
  expect(top(26)).toMatch(/^── \? ask_user ─+ 1 of 4 ──$/);
  expect(top(18)).toBe("── ? ask_user ────");
  expect(top(10)).toBe("─".repeat(10));
  d.press(TAB, TAB);
  expect(top(40)).toMatch(/Name\s+3 of 4/);
});

test("the top rule shows 'k of N answered' on the last tab", () => {
  const d = dialog([scope, storage]);
  d.press(ENTER, TAB);
  expect(d.text(80)[0]).toContain("1 of 2 answered");
  d.press(BACKTAB, ENTER);
  expect(d.text(80)[0]).toContain("2 of 2 answered");
});

test("a single question has no tabs and no count", () => {
  const top = dialog([storage]).text(80)[0] ?? "";
  expect(top).toMatch(/^── \? ask_user ─+$/);
  expect(top).not.toContain(" of ");
});

test("a cut header keeps the style it is drawn in: no reset inside the tab strip", () => {
  // Real SGR, so a reset that ends a background or colour early shows in the line
  const long = { ...scope, header: "Infrastructure choice" };
  const d = dialog([long, storage]);
  const strip = d.component.render(80)[0] ?? "";
  expect(stripTerminalSequences(strip)).toContain(" Infrastruct… ");
  expect(strip).not.toContain("\x1b[0m");
});

test("a throw while drawing or handling a key closes the dialog with that error instead of reaching the TUI's stack", async () => {
  const throwing: ThemeLike = {
    ...testTheme(),
    style: () => {
      throw new Error("boom");
    },
  };
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
});

const ESC_CODE = "\x1b";
const sgrCodes = (raw: string) =>
  [...raw.matchAll(new RegExp(`${ESC_CODE}\\[([0-9;:]*)m`, "g"))].flatMap((m) =>
    (m[1] ?? "").split(/[;:]/),
  );

test("under TERM=dumb the dialog draws no escape and only ASCII", () => {
  const d = dialog([scope, { ...storage, header: "Infrastructure choice" }], {
    mode: "ascii",
  });
  for (const keys of [[], [ENTER], [ENTER]]) {
    d.press(...keys);
    const raw = d.component.render(60).join("\n");
    expect(raw).not.toContain(ESC_CODE);
    expect(raw).toMatch(/^[\x20-\x7e\n]*$/);
  }
  expect(d.component.render(60)[0]).toMatch(/^-- \? ask_user -+ /);
  expect(d.component.render(60).at(-1)).toMatch(/^-- -+ .* --$/);
});

test("under NO_COLOR the dialog keeps bold and draws no colour or background", () => {
  const d = dialog([scope, storage], { mode: "mono" });
  for (const keys of [[], [ENTER]]) {
    d.press(...keys);
    const codes = sgrCodes(d.component.render(60).join("\n"));
    expect(codes).toContain("1");
    // bold, inverse and their ends; any 3x, 4x, 9x or 10x code is a colour or a background
    for (const code of codes)
      expect(["0", "1", "7", "22", "27"]).toContain(code);
  }
});

test("a cut label ends in the tier's ellipsis", () => {
  const long: AskQuestion = {
    ...storage,
    options: [{ label: "x".repeat(100) }, { label: "y" }],
  };
  expect(dialog([long]).text(30).join("\n")).toContain(`${"x".repeat(23)}…`);
  const ascii = dialog([long], { mode: "ascii" }).text(30).join("\n");
  expect(ascii).toContain(`${"x".repeat(21)}...`);
  expect(ascii).not.toContain("…");
});

test("the recommended mark is a word, not colour alone", () => {
  const rec = dialog([features], { mode: "mono" });
  expect(rec.text()).toContain(" › 2  [ ] Billing recommended");
});

test("rule rows are made of the rule glyph at widths 1-80 and never overflow", () => {
  for (const mode of ["color", "ascii"] as const) {
    const glyph = mode === "ascii" ? "-" : "─";
    const d = dialog([scope, storage], { mode });
    for (let width = 1; width <= 80; width++) {
      const lines = d.text(width);
      for (const rule of [lines[0], lines.at(-1)]) {
        expect(visibleWidth(rule ?? "")).toBeLessThanOrEqual(width);
        expect(rule?.replace(/[^─-]/g, "").length).toBeGreaterThan(0);
        expect(rule?.startsWith(glyph)).toBe(true);
      }
    }
  }
});

test("a digit picks its option and moves to the next unanswered question", () => {
  const d = dialog([scope, storage, naming]);
  d.press("2");
  expect(d.text()).toContain(` ${storage.question}`);
  d.press("1");
  expect(d.text()).toContain(` ${naming.question}`);
  d.press(..."skyr", ENTER, ENTER);
  expect(d.done.mock.calls).toEqual([
    [
      [
        { labels: ["B"] },
        { labels: ["SQLite"] },
        { labels: [], other: "skyr" },
      ],
    ],
  ]);
});

test("a digit on a lone question answers it", () => {
  const d = dialog([storage]);
  d.press("2");
  expect(d.done.mock.calls).toEqual([[[{ labels: ["Postgres"] }]]]);
});

test("a digit ticks and unticks on a multi-select question", () => {
  const d = dialog([features]);
  d.press("1", "3", "1");
  expect(d.text()).toContain(" › 1  [ ] Auth");
  expect(d.text()).toContain("   3  [x] Search");
  d.press(ENTER);
  expect(d.done.mock.calls).toEqual([[[{ labels: ["Search"] }]]]);
});

test("a tick by digit between tabs counts as an answer, as a Space tick does", () => {
  const d = dialog([features, storage]);
  d.press("2", TAB);
  expect(d.text(80)[0]).toContain("✓ Features");
});

test("with the Other input focused a digit is typed, and so on a free-text question", () => {
  const d = dialog([storage]);
  d.press(DOWN, DOWN, "1", "2");
  expect(d.text()).toContain(" › 3  Other  12");
  expect(d.done).not.toHaveBeenCalled();
  const free = dialog([naming]);
  free.press("4", "2", ENTER);
  expect(free.done.mock.calls).toEqual([[[{ labels: [], other: "42" }]]]);
});

test("the Other row's number moves the cursor there and the next digit is typed", () => {
  const d = dialog([storage]);
  d.press("3");
  expect(d.done).not.toHaveBeenCalled();
  expect(d.text()).toContain(" › 3  Other  type an answer");
  d.press("1", ENTER);
  expect(d.done.mock.calls).toEqual([[[{ labels: [], other: "1" }]]]);
  const multi = dialog([features]);
  multi.press("4", "7");
  expect(multi.text()).toContain(" › 4  Other  7");
});

test("a Kitty-encoded and a keypad digit pick too, and type on the Other row", () => {
  for (const digit of ["\x1b[50u", "\x1b[57401u"]) {
    const d = dialog([storage]);
    d.press(digit);
    expect(d.done.mock.calls).toEqual([[[{ labels: ["Postgres"] }]]]);
  }
  const typed = dialog([storage]);
  typed.press("3", "\x1b[49u");
  expect(typed.text()).toContain(" › 3  Other  1");
});

test("a shifted digit and a digit past the last row do nothing", () => {
  const d = dialog([storage]);
  d.press("\x1b[49;2u", "4", "9", "0");
  expect(d.done).not.toHaveBeenCalled();
  expect(d.text()).toContain(" › 1  SQLite");
  const review = dialog([scope, storage]);
  review.press(BACKTAB, "1");
  expect(review.done).not.toHaveBeenCalled();
});

test("a rebound select key beats a digit", () => {
  const d = dialog([storage], {
    keys: keybindings({ "tui.select.confirm": "1" }),
  });
  d.press(DOWN, "1");
  expect(d.done.mock.calls).toEqual([[[{ labels: ["Postgres"] }]]]);
});

test("the cursor row is marked by a glyph in every tier", () => {
  for (const [mode, glyph] of [
    ["color", "›"],
    ["mono", "›"],
    ["ascii", ">"],
  ] as const) {
    const d = dialog([storage], { mode });
    d.press(DOWN);
    expect(d.text()).toContain(` ${glyph} 2  Postgres`);
    expect(d.text()).toContain("   1  SQLite");
  }
});

test("in colour the cursor row and its description are filled to the width; elsewhere nothing is", () => {
  const filled = (mode: Tier) =>
    dialog([storage], { mode })
      .component.render(40)
      .filter((line) => line.includes("\x1b[48;"))
      .map((line) => visibleWidth(line));
  // the option row and the description under it
  expect(filled("color")).toEqual([40, 40]);
  expect(filled("mono")).toEqual([]);
  expect(filled("ascii")).toEqual([]);
});

test("the numbers and the 1-N hint match the rows", () => {
  const d = dialog([storage]);
  expect(bottom(d)).toContain("1-3 pick");
  expect(d.text().join("\n")).toMatch(
    /1 {2}SQLite[\s\S]*2 {2}Postgres[\s\S]*3 {2}Other/,
  );
  expect(bottom(dialog([features]))).toContain("1-4 tick");
  expect(bottom(dialog([naming]))).not.toMatch(/1-\d/);
  const review = dialog([scope, storage]);
  review.press(BACKTAB);
  expect(bottom(review)).not.toMatch(/1-\d/);
});

test("the review page is the receipt: one clause per question, unanswered ones say so", () => {
  const d = dialog([scope, storage, naming]);
  d.press(ENTER, TAB, ..."skyr", ENTER);
  expect(d.text()[0]).toContain("ask_user");
  expect(receipt(d)).toBe(
    "Scope → A · Storage → not answered · Name → [own words] skyr",
  );
  const ascii = dialog([scope, storage], { mode: "ascii" });
  ascii.press(ENTER, TAB);
  expect(receipt(ascii)).toBe("Scope -> A - Storage -> not answered");
});

test("a receipt wider than the pane wraps and every line fits 1-80", () => {
  const long: AskQuestion = {
    ...storage,
    header: "Infrastructure choice",
    options: [{ label: "漢字🙂".repeat(30) }, { label: "y" }],
  };
  const d = dialog([long, naming]);
  d.press(ENTER, ..."a long answer ".repeat(10), ENTER);
  for (let width = 1; width <= 80; width++)
    for (const line of d.component.render(width))
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  expect(d.text(30).length).toBeGreaterThan(4);
});
