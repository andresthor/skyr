/**
 * The VoiceEditor over a fake base editor, and the two-faced sink routing dictation to an
 * editor or into plain text. The fake implements only the surface these paths touch; Pi's
 * real editor and runtime stay out.
 */
import type {
  CustomEditor,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { parseColor } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
  createVoiceEditorClass,
  editorSink,
  spacedSegment,
  type VoiceEditorLike,
} from "../src/voice/editor.js";
import {
  CURSOR_CELL,
  DRY_MS,
  FALLBACK_PALETTE,
  type VoicePalette,
} from "../src/voice/indicator.js";

const KEYS = {} as KeybindingsManager;

/** A minimal stand-in for pi-tui's Editor: [top rule, ...text rows, bottom rule], with the fake cursor at end of the cursor line. */
class FakeEditor {
  text = "";
  cursorLine = 0;
  cursorCol = 0;
  paddingX = 0;
  throwsOnRender = false;
  enteredKeys: string[] = [];

  handleInput(data: string): void {
    this.enteredKeys.push(data);
  }

  render(width: number): string[] {
    if (this.throwsOnRender) throw new Error("base render blew up");
    const pad = " ".repeat(this.paddingX);
    const rows = ["─".repeat(width)];
    this.text.split("\n").forEach((line, i) => {
      rows.push(
        `${pad}${line}${i === this.cursorLine ? CURSOR_CELL : ""}${" ".repeat(Math.max(0, width - this.paddingX - line.length))}`,
      );
    });
    rows.push("─".repeat(width));
    return rows;
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

  invalidate(): void {}
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
  FakeEditor & { focused: boolean; palette: () => VoicePalette };

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
    KEYS,
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

test("spacedSegment joins a segment into its surroundings with a single space on each side, only where missing", () => {
  expect(spacedSegment("", "", "hi")).toBe("hi");
  expect(spacedSegment("hello", ", and", "world")).toBe(" world");
  expect(spacedSegment("hello ", "x", "world")).toBe("world ");
  expect(spacedSegment("before", '"quoted"', "{ ")).toBe(" { ");
  expect(spacedSegment("some", "", "   ")).toBe("");
});

describe("commit", () => {
  test("a final commits at the cursor and marks it wet", () => {
    const editor = fresh("hello ", { cursorCol: 6 });
    editor.commit("world");
    expect(editor.text).toBe("hello world");
    expect(editor.decor.firm).toEqual({ chars: 5, at: nowAt });
    editor.commit("more");
    expect(editor.decor.firm).toEqual({ chars: 4, at: nowAt });
  });

  test("a blank segment inserts nothing and leaves the wet span alone", () => {
    const editor = fresh("hello ", { cursorCol: 6 });
    editor.commit("   ");
    expect(editor.text).toBe("hello ");
    expect(editor.decor.firm).toBeNull();
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
    expect(editor.decor.firm).toBeNull();
    editor.commit("two");
    editor.focused = true;
    expect(editor.text).toBe("start one two");
    expect(editor.decor.firm).toEqual({ chars: 3, at: nowAt });
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
    editor.decor.firm = { chars: 5, at: nowAt - 100 };
    const rows = editor.render(40);
    expect(rows).toHaveLength(3);
    const row = rows[1] ?? "";
    expect(row.includes(CURSOR_CELL)).toBe(true);
    expect(row.includes("\x1b[3m")).toBe(true); // dim italic ghost
    expect(row.includes("\x1b[38;2;")).toBe(true); // the wet foreground
    // once the span is past its drying window the render equals the ghost-only form
    editor.decor.firm = { chars: 5, at: nowAt - DRY_MS };
    const ghostOnly = fresh("hello", { paddingX: 2 });
    ghostOnly.decor.ghost = "world";
    expect(editor.render(40)).toEqual(ghostOnly.render(40));
  });

  test("the palette is read per frame, so a mid-session theme switch reaches ghost and firm colours", () => {
    const editor = fresh("hello", { paddingX: 2 });
    editor.decor.ghost = "world";
    editor.palette = () => ({
      ...FALLBACK_PALETTE,
      colors: { ...FALLBACK_PALETTE.colors, dim: parseColor("#767676") },
    });
    const row = editor.render(40)[1] ?? "";
    // the ghost's dim colour is the live palette's dim, not the fallback's
    expect(row).toContain("\x1b[38;2;118;118;118m");
    editor.palette = () => FALLBACK_PALETTE;
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
    expect(editor.decor.live).toBe(true);
    expect(editor.text).toBe("previous words typed");
    sink.interim("more stuff");
    expect(editor.decor.ghost).toBe("more stuff");
    expect(editor.text).toBe("previous words typed");
    sink.final("more stuff");
    expect(editor.decor.ghost).toBe("");
    expect(editor.text).toBe("previous words typed more stuff");
    sink.end();
    expect(editor.decor.live).toBe(false);
    expect(editor.text).toBe("previous words typed more stuff");
    sink.revert();
    expect(editor.text).toBe("previous words typed");
    expect(editor.decor.firm).toBeNull();
  });

  test("an editor's finals held while hidden die with the revert: refocus commits nothing", () => {
    const started = fresh("start", { cursorCol: 5 });
    started.focused = false;
    const editor = started;
    const { sink } = pair(editor);
    sink.begin();
    sink.final("hidden words");
    expect(editor.text).toBe("start"); // still buffered
    sink.revert();
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
    sink.revert();
    expect(edits.at(-1)).toBe(snap);
  });
});
