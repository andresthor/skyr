/**
 * The VoiceEditor over a fake base editor, and the two-faced sink routing dictation to an
 * editor or into plain text. The fake implements only the surface these paths touch; Pi's
 * real editor and runtime stay out. Everything is driven through the class's public
 * surface — ghost, commit, reset, showRule, animating — because nothing else may see its
 * decoration state.
 */
import type {
  CustomEditor,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { parseColor, stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createVoiceEditorClass,
  editorSink,
  type VoiceEditorLike,
  type VoiceEditorOptions,
} from "../src/voice/editor.js";
import { DRY_MS } from "../src/voice/ghost.js";
import type { VoiceTheme } from "../src/voice/palette.js";
import {
  CURSOR_CELL,
  editorRows,
  keybindings,
  realEditor,
  snap,
  styledRuns,
  testPaint,
  testTheme,
} from "./voice.js";

/** A minimal stand-in for pi-tui's Editor: [top rule, ...text rows, bottom rule], with the fake cursor at end of the cursor line. */
class FakeEditor {
  text = "";
  cursorLine = 0;
  cursorCol = 0;
  paddingX = 0;
  throwsOnRender = false;
  enteredKeys: string[] = [];
  /** Pi sets this per thinking level and bash mode; the test marks it to see where it is used. */
  borderColor = (s: string) => `<${s}>`;

  handleInput(data: string): void {
    this.enteredKeys.push(data);
  }

  render(width: number): string[] {
    if (this.throwsOnRender) throw new Error("base render blew up");
    return [
      "─".repeat(width),
      ...editorRows(this.text, width, {
        cursorLine: this.cursorLine,
        paddingX: this.paddingX,
      }),
      this.renderBottomBorder(width, 0),
    ];
  }

  renderBottomBorder(width: number, _hiddenLineCount: number): string {
    return this.borderColor("─".repeat(width));
  }

  getPaddingX(): number {
    return this.paddingX;
  }

  getCursor(): { line: number; col: number } {
    const line = this.text.split("\n")[this.cursorLine] ?? "";
    return {
      line: this.cursorLine,
      col: Math.min(this.cursorCol, line.length),
    };
  }

  getLines(): string[] {
    return this.text.split("\n");
  }

  getText(): string {
    return this.text;
  }

  getExpandedText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
    this.cursorCol = 0;
    this.cursorLine = 0;
  }

  insertTextAtCursor(insert: string): void {
    const lines = this.text.split("\n");
    const row = lines[this.cursorLine] ?? "";
    lines[this.cursorLine] =
      row.slice(0, this.cursorCol) + insert + row.slice(this.cursorCol);
    this.cursorCol += insert.length;
    this.text = lines.join("\n");
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// the fake satisfies the base class only structurally; the editor's own surface is what these tests use
const FakeBase = FakeEditor as unknown as typeof CustomEditor;

/** VoiceEditorLike's `focused` is a settable own accessor on the instance, so the test types it as one. */
type EditorInstance = Omit<VoiceEditorLike, "focused"> &
  FakeEditor & { focused: boolean };

function fresh(
  text = "",
  opts: {
    cursorCol?: number;
    cursorLine?: number;
    paddingX?: number;
    throwsOnRender?: boolean;
    focused?: boolean;
    paint?: VoiceEditorOptions["paint"];
    keyHook?: VoiceEditorOptions["keyHook"];
    keys?: KeybindingsManager;
  } = {},
): EditorInstance {
  const VoiceEditor = createVoiceEditorClass(FakeBase, {
    paint: opts.paint ?? testPaint(),
    keyHook: opts.keyHook ?? (() => false),
  });
  const ed = new VoiceEditor(
    {} as never,
    {} as never,
    opts.keys ?? keybindings(),
  ) as unknown as EditorInstance;
  ed.text = text;
  ed.cursorCol = opts.cursorCol ?? 0;
  ed.cursorLine = opts.cursorLine ?? 0;
  ed.paddingX = opts.paddingX ?? 0;
  ed.throwsOnRender = opts.throwsOnRender ?? false;
  ed.focused = opts.focused ?? true;
  return ed;
}

/** The fake's own render, undecorated — the shape super.render() would return. */
const baseRender = (editor: FakeEditor, width = 40): string[] =>
  FakeEditor.prototype.render.call(editor, width);

describe("commit", () => {
  test.each([
    ["", 0, "hi", "hi"],
    ["hello, and", 5, "world", "hello world, and"],
    ["hello x", 6, "world", "hello world x"],
    ['before"quoted"', 6, "{ ", 'before { "quoted"'],
  ])(
    "a final joins %j at column %i with one space on each side, only where missing",
    (text, cursorCol, segment, after) => {
      const editor = fresh(text, { cursorCol });
      editor.commit(segment);
      expect(editor.text).toBe(after);
    },
  );

  test("a final commits at the cursor and stays on the clock until DRY_MS passes", () => {
    const editor = fresh("hello ", { cursorCol: 6 });
    editor.commit("world");
    expect(editor.text).toBe("hello world");
    expect(editor.animating).toBe(true);
    vi.advanceTimersByTime(DRY_MS - 1);
    expect(editor.animating).toBe(true);
    vi.advanceTimersByTime(1);
    expect(editor.animating).toBe(false);
  });

  test("a second final dries on its own clock, so the first never resets it", () => {
    const editor = fresh("hello ", { cursorCol: 6 });
    editor.commit("world");
    vi.advanceTimersByTime(DRY_MS);
    expect(editor.animating).toBe(false);
    editor.commit("more");
    expect(editor.animating).toBe(true);
  });

  test("a blank segment inserts nothing and leaves nothing drying", () => {
    const editor = fresh("hello ", { cursorCol: 6 });
    editor.commit("   ");
    expect(editor.text).toBe("hello ");
    expect(editor.animating).toBe(false);
  });

  test("a commit at the start of a line joins across the newline", () => {
    const editor = fresh("first\n", { cursorLine: 1, cursorCol: 0 });
    editor.commit("next");
    expect(editor.text).toBe("first\nnext");
  });

  test("an unfocused editor holds finals, and focus drains them in arrival order", () => {
    const editor = fresh("start", {
      cursorCol: 5,
      focused: false,
    });
    editor.commit("one");
    expect(editor.text).toBe("start");
    expect(editor.animating).toBe(false);
    editor.commit("two");
    expect(editor.text).toBe("start");
    editor.focused = true;
    expect(editor.text).toBe("start one two");
    expect(editor.animating).toBe(true);
  });
});

describe("render", () => {
  test("a buffer with no decoration comes back exactly as the base drew it, cursor cell and all", () => {
    const editor = fresh("hello", { paddingX: 2 });
    expect(editor.render(40)).toEqual(baseRender(editor));
  });

  test("a committed span fades over its drying window, rather than staying wet and then vanishing", () => {
    const editor = fresh("hello", { paddingX: 2, cursorCol: 5 });
    editor.commit("world");
    const colour = () =>
      styledRuns(editor.render(40)[1] ?? "").find((r) => r.text.includes("w"))
        ?.fg;
    const wet = colour();
    vi.advanceTimersByTime(DRY_MS / 2);
    const drying = colour();
    expect(wet).toBeDefined();
    expect(drying).toBeDefined();
    expect(drying).not.toEqual(wet);
  });

  test("the ghost draws beside the cursor cell, a fresh span is wet, and a dried span is colourless again", () => {
    const editor = fresh("hello", {
      paddingX: 2,
      cursorCol: 5,
    });
    editor.commit("world");
    editor.ghost("again");
    const rows = editor.render(40);
    expect(rows).toHaveLength(3);
    const row = rows[1] ?? "";
    expect(row.includes(CURSOR_CELL)).toBe(true);
    const runs = styledRuns(row);
    expect(runs).toContainEqual(
      expect.objectContaining({ text: " again", italic: true, dim: true }),
    );
    expect(runs).toContainEqual(
      expect.objectContaining({ text: "world", fg: expect.anything() }),
    );
    // once the span is past its drying window the render equals the ghost-only form
    vi.advanceTimersByTime(DRY_MS);
    const ghostOnly = fresh("hello world", {
      paddingX: 2,
      cursorCol: 11,
    });
    ghostOnly.ghost("again");
    expect(editor.render(40)).toEqual(ghostOnly.render(40));
  });

  test("a mid-session theme switch through Pi's live theme handle reaches ghost and firm colours", () => {
    let theme = testTheme({ colors: { dim: parseColor("#767676") } });
    // like Pi's theme proxy: one handle, reading whichever theme is current
    const live: VoiceTheme = {
      get colors() {
        return theme.colors;
      },
      get appearance() {
        return theme.appearance;
      },
      style: (text, style) => theme.style(text, style),
    };
    const editor = fresh("hello", {
      paddingX: 2,
      paint: testPaint("color", live),
    });
    editor.ghost("world");
    const ghostColour = () =>
      styledRuns(editor.render(40)[1] ?? "").find((r) => r.italic)?.fg;
    expect(ghostColour()).toEqual(parseColor("#767676"));
    theme = testTheme({ colors: { dim: parseColor("#666666") } });
    expect(ghostColour()).toEqual(parseColor("#666666"));
  });

  test("a broken base editor still fails loudly; voice hides only its own drawing errors", () => {
    const editor = fresh("hello", {
      throwsOnRender: true,
    });
    editor.ghost("world");
    expect(() => editor.render(40)).toThrow("base render blew up");
  });

  test("the key hook swallows keys it owns and forwards the rest to the base editor", () => {
    let swallow = true;
    let seen = "";
    const editor = fresh("", {
      keyHook: (data) => {
        seen = data;
        return swallow;
      },
    });
    editor.handleInput("esc");
    expect(seen).toBe("esc");
    expect(editor.enteredKeys).toEqual([]);
    swallow = false;
    editor.handleInput("a");
    expect(seen).toBe("a");
    expect(editor.enteredKeys).toEqual(["a"]);
  });
});

describe("bottom rule", () => {
  const listening = snap();

  test("while voice is on, the bottom rule is the voice rule, in Pi's rule colour and Pi's key names", () => {
    const editor = fresh("hello");
    expect(editor.showRule(listening)).toBe(true);
    // the test's border marker takes visible columns, so give the hints room to stay
    const bottom = editor.render(120).at(-1) ?? "";
    expect(stripTerminalSequences(bottom)).toContain("● listening");
    expect(stripTerminalSequences(bottom)).toContain(
      "enter keep · escape discard",
    );
    // the rule cells are drawn through the editor's own border colour, never recoloured
    expect(bottom.startsWith("<──>")).toBe(true);
    expect(bottom.endsWith("<──>")).toBe(true);
  });

  test("showRule clears the rule and says so when the editor is hidden behind a card", () => {
    const editor = fresh("hello");
    expect(editor.showRule(listening)).toBe(true);
    editor.focused = false;
    expect(editor.showRule(listening)).toBe(false);
    const bottom = editor.render(120).at(-1) ?? "";
    expect(stripTerminalSequences(bottom)).not.toContain("listening");
  });

  test("an unbound binding draws no hint, rather than naming a key that isn't there", () => {
    const keys = keybindings();
    keys.setUserBindings({ "app.interrupt": [] });
    const editor = fresh("hello", { keys });
    editor.showRule(listening);
    const bottom = stripTerminalSequences(editor.render(120).at(-1) ?? "");
    expect(bottom).toContain("enter keep");
    expect(bottom).not.toContain("escape");
    expect(bottom).not.toContain("discard");
  });

  test("with voice off, the bottom rule is Pi's own", () => {
    const editor = fresh("hello");
    expect(editor.render(40).at(-1)).toBe(`<${"─".repeat(40)}>`);
  });

  test("a throw while drawing the voice rule leaves Pi's rule, never a broken input bar", () => {
    const editor = fresh("hello", {
      paint: testPaint("color", {
        ...testTheme(),
        style: () => {
          throw new Error("theme went away");
        },
      }),
    });
    expect(editor.showRule(listening)).toBe(true);
    expect(editor.render(40).at(-1)).toBe(`<${"─".repeat(40)}>`);
    // and the editor says it can no longer carry the rule, so voice moves to the footer
    expect(editor.showRule(listening)).toBe(false);
  });
});

describe("reset", () => {
  test("reset clears the ghost, the drying spans and finals held while hidden", () => {
    const editor = fresh("start", {
      cursorCol: 5,
      focused: false,
    });
    editor.commit("held");
    editor.ghost("ghost");
    editor.reset();
    editor.focused = true;
    expect(editor.text).toBe("start");
    expect(editor.render(40)).toEqual(baseRender(editor));
  });
});

describe("editorSink", () => {
  function pair(editor?: EditorInstance) {
    const edits: string[] = [];
    const snap = "previous words typed";
    const sink = editorSink(
      () => editor,
      { get: () => snap, set: (t) => edits.push(t) },
      () => {},
    );
    return { editor, sink, edits, snap };
  }

  /** Whether the editor's own render currently draws the italic ghost. */
  const ghostDrawn = (editor: EditorInstance) =>
    editor
      .render(editor.text.length + 21)
      .some((l) => styledRuns(l).some((r) => r.italic));

  test("with an editor: interims are decor only, finals commit, and Esc puts the buffer back", () => {
    const editor = fresh("previous words typed", {
      cursorCol: 20,
    });
    editor.focused = true;
    const { sink } = pair(editor);
    sink.begin();
    expect(editor.text).toBe("previous words typed");
    sink.interim("more stuff");
    expect(ghostDrawn(editor)).toBe(true);
    expect(editor.text).toBe("previous words typed");
    sink.final("more stuff");
    expect(ghostDrawn(editor)).toBe(false);
    expect(editor.text).toBe("previous words typed more stuff");
    sink.end();
    expect(editor.text).toBe("previous words typed more stuff");
    expect(sink.revert()).toBe(true);
    expect(editor.text).toBe("previous words typed");
    expect(editor.animating).toBe(false);
  });

  test("Esc keeps a pasted block: Enter then sends what it would have sent before dictating", () => {
    const ed = realEditor();
    const pasted = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    ed.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    expect(ed.getText()).toContain("[paste #1 +40 lines]");
    const sink = editorSink(
      () => ed,
      { get: () => "", set: () => {} },
      () => {},
    );
    sink.begin();
    sink.final("and more");
    expect(sink.revert()).toBe(true);
    expect(ed.getExpandedText()).toBe(pasted);
  });

  test("an editor's finals held while hidden die with the revert: refocus commits nothing", () => {
    const editor = fresh("start", {
      cursorCol: 5,
      focused: false,
    });
    const { sink } = pair(editor);
    sink.begin();
    sink.final("hidden words");
    expect(editor.text).toBe("start"); // still buffered
    expect(sink.revert()).toBe(false);
    editor.focused = true;
    expect(editor.text).toBe("start");
  });

  test("without an editor the dictation rides setEditorText: the final replaces the live interim, revert restores the snapshot", () => {
    const { edits, sink, snap } = pair();
    sink.begin();
    expect(edits).toEqual([]);
    sink.interim("tree data");
    expect(edits).toEqual([`${snap} tree data`]);
    sink.interim("tree data structures");
    expect(edits).toEqual([
      `${snap} tree data`,
      `${snap} tree data structures`,
    ]);
    sink.final("tree data structures");
    expect(edits).toEqual([
      `${snap} tree data`,
      `${snap} tree data structures`,
      `${snap} tree data structures`,
    ]);
    sink.end();
    expect(edits.at(-1)).toBe(`${snap} tree data structures`);
    // the buffer changed, but the fallback falls to plain text: no undo is on offer
    expect(sink.revert()).toBe(false);
    expect(edits.at(-1)).toBe(snap);
  });
});
