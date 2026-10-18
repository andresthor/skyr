/**
 * The VoiceEditor over a fake base editor, and the two-faced sink routing dictation to an
 * editor or into plain text. The fake implements only the surface these paths touch; Pi's
 * real editor and runtime stay out.
 */
import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import { parseColor } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
  createVoiceEditorClass,
  editorSink,
  type VoiceEditorLike,
} from "../src/voice/editor.js";
import { CURSOR_CELL, DRY_MS, stripAnsi } from "../src/voice/ghost.js";
import { FALLBACK_PALETTE, paintFor } from "../src/voice/palette.js";
import { editorRows, keybindings, snap } from "./voice.js";

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

const nowAt = 1_000_000;
const now = () => nowAt;

// the fake satisfies the base class only structurally; the editor's own surface is what these tests use
const VoiceEditor = createVoiceEditorClass(
  FakeEditor as unknown as typeof CustomEditor,
  now,
);

/** VoiceEditorLike's `focused` is a settable own accessor on the instance, so the test types it as one. */
type EditorInstance = Omit<VoiceEditorLike, "focused"> &
  Pick<InstanceType<typeof VoiceEditor>, "keyHook" | "paint"> &
  FakeEditor & { focused: boolean };

function fresh(
  text = "",
  opts: {
    cursorCol?: number;
    cursorLine?: number;
    paddingX?: number;
    throwsOnRender?: boolean;
    focused?: boolean;
  } = {},
): EditorInstance {
  const ed = new VoiceEditor(
    {} as never,
    {} as never,
    keybindings(),
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

  test("a final commits at the cursor and marks it wet", () => {
    const editor = fresh("hello ", { cursorCol: 6 });
    editor.commit("world");
    expect(editor.text).toBe("hello world");
    expect(editor.decor.drying).toEqual([{ chars: 5, lead: 0, at: nowAt }]);
    editor.commit("more");
    // a second final keeps the first drying on its own clock, newest first
    expect(editor.decor.drying).toEqual([
      { chars: 4, lead: 1, at: nowAt },
      { chars: 5, lead: 0, at: nowAt },
    ]);
  });

  test("a blank segment inserts nothing and leaves the wet span alone", () => {
    const editor = fresh("hello ", { cursorCol: 6 });
    editor.commit("   ");
    expect(editor.text).toBe("hello ");
    expect(editor.decor.drying).toEqual([]);
  });

  test("a commit at the start of a line joins across the newline", () => {
    const editor = fresh("first\n", { cursorLine: 1, cursorCol: 0 });
    editor.commit("next");
    expect(editor.text).toBe("first\nnext");
  });

  test("an unfocused editor holds finals, and focus drains them in arrival order", () => {
    const editor = fresh("start", { cursorCol: 5, focused: false });
    editor.commit("one");
    expect(editor.text).toBe("start");
    expect(editor.decor.drying).toEqual([]);
    editor.commit("two");
    editor.focused = true;
    expect(editor.text).toBe("start one two");
    expect(editor.decor.drying[0]).toEqual({ chars: 3, lead: 1, at: nowAt });
  });
});

describe("render", () => {
  test("a buffer with no decoration comes back exactly as the base drew it, cursor cell and all", () => {
    const editor = fresh("hello", { paddingX: 2 });
    expect(editor.render(40)).toEqual(baseRender(editor));
  });

  test("the ghost draws beside the cursor cell, a fresh span is wet, and a dried span is colourless again", () => {
    const editor = fresh("hello", { paddingX: 2 });
    editor.decor.ghost = "world";
    editor.decor.drying = [{ chars: 5, lead: 0, at: nowAt - 100 }];
    const rows = editor.render(40);
    expect(rows).toHaveLength(3);
    const row = rows[1] ?? "";
    expect(row.includes(CURSOR_CELL)).toBe(true);
    expect(row.includes("\x1b[3m")).toBe(true); // dim italic ghost
    expect(row.includes("\x1b[38;2;")).toBe(true); // the wet foreground
    // once the span is past its drying window the render equals the ghost-only form
    editor.decor.drying = [{ chars: 5, lead: 0, at: nowAt - DRY_MS }];
    const ghostOnly = fresh("hello", { paddingX: 2 });
    ghostOnly.decor.ghost = "world";
    expect(editor.render(40)).toEqual(ghostOnly.render(40));
  });

  test("the paint is read per frame, so a mid-session theme switch reaches ghost and firm colours", () => {
    const editor = fresh("hello", { paddingX: 2 });
    editor.decor.ghost = "world";
    editor.paint = () =>
      paintFor(
        {
          ...FALLBACK_PALETTE,
          colors: { ...FALLBACK_PALETTE.colors, dim: parseColor("#767676") },
        },
        "color",
      );
    const row = editor.render(40)[1] ?? "";
    // the ghost's dim colour is the live palette's dim, not the fallback's
    expect(row).toContain("\x1b[38;2;118;118;118m");
    editor.paint = () => paintFor(FALLBACK_PALETTE, "color");
    expect(editor.render(40)[1] ?? "").toContain("\x1b[38;2;102;102;102m");
  });

  test("a base render throw propagates: the catch guards only the decoration maths", () => {
    const editor = fresh("hello", { throwsOnRender: true });
    editor.decor.ghost = "world";
    expect(() => editor.render(40)).toThrow("base render blew up");
  });

  test("the key hook swallows keys it owns and forwards the rest to the base editor", () => {
    const editor = fresh("");
    let seen = "";
    editor.keyHook = (data) => {
      seen = data;
      return true;
    };
    editor.handleInput("esc");
    expect(seen).toBe("esc");
    expect(editor.enteredKeys).toEqual([]);
    editor.keyHook = (data) => {
      seen = data;
      return false;
    };
    editor.handleInput("a");
    expect(seen).toBe("a");
    expect(editor.enteredKeys).toEqual(["a"]);
  });
});

describe("bottom rule", () => {
  const listening = snap();

  test("while voice is on, the bottom rule is the voice rule, in Pi's rule colour and Pi's key names", () => {
    const editor = fresh("hello");
    editor.decor.rule = listening;
    // the test's border marker takes visible columns, so give the hints room to stay
    const bottom = editor.render(120).at(-1) ?? "";
    expect(stripAnsi(bottom)).toContain("● listening");
    expect(stripAnsi(bottom)).toContain("enter keep · escape discard");
    // the rule cells are drawn through the editor's own border colour, never recoloured
    expect(bottom.startsWith("<──>")).toBe(true);
    expect(bottom.endsWith("<──>")).toBe(true);
  });

  test("with voice off, the bottom rule is Pi's own", () => {
    const editor = fresh("hello");
    expect(editor.render(40).at(-1)).toBe(`<${"─".repeat(40)}>`);
  });

  test("a throw while drawing the voice rule leaves Pi's rule, never a broken input bar", () => {
    const editor = fresh("hello");
    editor.decor.rule = listening;
    editor.paint = () => {
      throw new Error("theme went away");
    };
    expect(editor.render(40).at(-1)).toBe(`<${"─".repeat(40)}>`);
    // and the presenter is told, so voice moves to the footer rather than vanishing
    expect(editor.decor.ruleFailed).toBe(true);
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

  test("with an editor: interims are decor only, finals commit, and Esc puts the buffer back", () => {
    const editor = fresh("previous words typed", { cursorCol: 20 });
    editor.focused = true;
    const { sink } = pair(editor);
    sink.begin();
    expect(editor.text).toBe("previous words typed");
    sink.interim("more stuff");
    expect(editor.decor.ghost).toBe("more stuff");
    expect(editor.text).toBe("previous words typed");
    sink.final("more stuff");
    expect(editor.decor.ghost).toBe("");
    expect(editor.text).toBe("previous words typed more stuff");
    sink.end();
    expect(editor.text).toBe("previous words typed more stuff");
    expect(sink.revert()).toBe(true);
    expect(editor.text).toBe("previous words typed");
    expect(editor.decor.drying).toEqual([]);
  });

  test("an editor's finals held while hidden die with the revert: refocus commits nothing", () => {
    const started = fresh("start", { cursorCol: 5 });
    started.focused = false;
    const editor = started;
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
