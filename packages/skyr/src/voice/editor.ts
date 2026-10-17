/**
 * Live dictation text in Pi's input editor.
 *
 * Mechanism: a `CustomEditor` subclass installed once per session with
 * `ctx.ui.setEditorComponent`. The interim segment is never written into the
 * editor's buffer; `render()` draws it after the cursor as dim italic ghost text
 * (`spliceGhost`). Each final is committed with `insertTextAtCursor`, which puts it
 * at the cursor, keeps whatever the user typed around it, and is one undo step. So
 * Enter, undo and history only ever see firm text, and interim jitter can't clobber
 * the buffer. `setEditorText` would lose the cursor and the undo stack.
 *
 * The base class is passed in because the package may not import pi-coding-agent
 * statically (src/pi.ts is the one value seam).
 */
import type {
  CustomEditor,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { DictationSink } from "./dictation.js";
import {
  DRY_MS,
  FALLBACK_PALETTE,
  renderRule,
  spliceGhost,
  type VoiceKeys,
  type VoiceMode,
  type VoicePalette,
  type VoiceSnapshot,
} from "./indicator.js";

/** The text to insert so a segment reads naturally between what is before and after the cursor. */
export function spacedSegment(
  before: string,
  after: string,
  segment: string,
): string {
  const text = segment.trim();
  if (!text) return "";
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && /^[\w"'(`]/.test(after) ? " " : "";
  return lead + text + trail;
}

/** What a VoiceEditor draws on top of Pi's editor. */
export interface VoiceDecor {
  ghost: string;
  /** Recent commits, newest first; `at` is when each landed. */
  drying: { chars: number; lead: number; at: number }[];
  /** What the bottom rule shows while voice is on; undefined leaves Pi's own rule. */
  rule?: VoiceSnapshot;
  mode?: VoiceMode;
}

export interface VoiceEditorLike {
  decor: VoiceDecor;
  /** Consulted before Pi sees a key; return true to swallow it. */
  keyHook?: (data: string, keys: KeybindingsManager) => boolean;
  commit(segment: string): void;
  /** Drop finals held back while the editor was hidden. */
  discardPending(): void;
  /** Whether the editor has keyboard focus; false while a `ctx.ui.custom()` card replaces it. */
  readonly focused: boolean;
  getText(): string;
  setText(text: string): void;
  invalidate(): void;
}

type CustomEditorClass = typeof CustomEditor;

export function createVoiceEditorClass(
  Base: CustomEditorClass,
  now: () => number = Date.now,
) {
  return class VoiceEditor extends Base implements VoiceEditorLike {
    decor: VoiceDecor = {
      ghost: "",
      drying: [],
    };
    /** The palette for this render, re-read every frame so /theme reaches the ghost and drying colours. */
    palette: () => VoicePalette = () => FALLBACK_PALETTE;
    keyHook?: (data: string, keys: KeybindingsManager) => boolean;
    private readonly keys: KeybindingsManager;
    private pending: string[] = [];

    constructor(...args: ConstructorParameters<CustomEditorClass>) {
      super(...args);
      this.keys = args[2];
      // `focused` is a class field on pi-tui's Editor, so an accessor has to be defined per instance.
      // Pi restores a `ctx.ui.custom()` card's editor with setText(saved) and then focuses it, so
      // finals that arrived meanwhile are held here and land once focus is back.
      let focused = false;
      Object.defineProperty(this, "focused", {
        get: () => focused,
        set: (on: boolean) => {
          focused = on;
          if (on && this.pending.length)
            for (const seg of this.pending.splice(0)) this.commit(seg);
        },
        configurable: true,
        enumerable: true,
      });
    }

    override handleInput(data: string): void {
      if (this.keyHook?.(data, this.keys)) return;
      super.handleInput(data);
    }

    override render(width: number): string[] {
      const base = super.render(width);
      const { ghost, drying, mode } = this.decor;
      if (!ghost && !drying.length) return base;
      // this editor is permanent: a throw here would take the input bar down with it
      try {
        const t = now();
        return spliceGhost(base, {
          width,
          paddingX: this.getPaddingX(),
          ghost,
          drying: drying.map((s) => ({ ...s, age: t - s.at })),
          mode,
          // private in pi-tui's types, but it is what tells the bottom rule from the autocomplete rows
          below:
            (this as unknown as { renderedAutocompleteHeight?: number })
              .renderedAutocompleteHeight ?? 0,
          palette: this.palette(),
        });
      } catch {
        return base;
      }
    }

    protected override renderBottomBorder(
      width: number,
      hiddenLineCount: number,
    ): string {
      const { rule, mode } = this.decor;
      // pi-tui calls this from render() before the ghost's guard: a throw must fall back here too
      try {
        const row =
          rule &&
          renderRule(rule, {
            width,
            hiddenBelow: hiddenLineCount,
            rule: (s) => this.borderColor(s),
            keys: this.hintKeys(),
            palette: this.palette(),
            mode,
          });
        if (row !== undefined) return row;
      } catch {}
      return super.renderBottomBorder(width, hiddenLineCount);
    }

    /** The first key of each binding, named the way Pi's own hints name keys. */
    private hintKeys(): VoiceKeys {
      const name = (
        id: Parameters<KeybindingsManager["getKeys"]>[0],
        unbound: string,
      ) => {
        const key = this.keys.getKeys(id)[0] ?? unbound;
        return process.platform === "darwin"
          ? key.replace(/\balt\b/g, "option")
          : key;
      };
      return {
        submit: name("tui.input.submit", "enter"),
        cancel: name("tui.select.cancel", "escape"),
        undo: name("tui.editor.undo", "ctrl+-"),
      };
    }

    commit(segment: string): void {
      if (!this.focused) {
        this.pending.push(segment);
        return;
      }
      const { line, col } = this.getCursor();
      const row = this.getLines()[line] ?? "";
      const before = col === 0 && line > 0 ? "\n" : row.slice(0, col);
      const insert = spacedSegment(before, row.slice(col), segment);
      if (!insert) return;
      this.insertTextAtCursor(insert);
      const t = now();
      this.decor.drying = [
        {
          chars: insert.trim().length,
          lead: insert.length - insert.trimStart().length,
          at: t,
        },
        ...this.decor.drying.filter((s) => t - s.at < DRY_MS),
      ];
    }

    discardPending(): void {
      this.pending = [];
    }
  };
}

/**
 * Routes dictation into whichever VoiceEditor is current, or into plain
 * `setEditorText` when another extension owns the editor (no ghost there).
 */
export function editorSink(
  target: () => VoiceEditorLike | undefined,
  fallback: { get(): string; set(text: string): void },
  repaint: () => void,
): DictationSink {
  let snapshot = "";
  let committed = "";
  return {
    begin() {
      const ed = target();
      snapshot = ed ? ed.getText() : fallback.get();
      committed = snapshot;
      if (ed) ed.decor = { ...ed.decor, ghost: "", drying: [] };
      repaint();
    },
    interim(segment) {
      const ed = target();
      if (ed) ed.decor.ghost = segment;
      else fallback.set(committed + spacedSegment(committed, "", segment));
      repaint();
    },
    final(segment) {
      const ed = target();
      if (ed) {
        ed.decor.ghost = "";
        ed.commit(segment);
      } else {
        committed += spacedSegment(committed, "", segment);
        fallback.set(committed);
      }
      repaint();
    },
    end() {
      const ed = target();
      if (ed) ed.decor = { ...ed.decor, ghost: "" };
      else fallback.set(committed);
      repaint();
    },
    revert() {
      const ed = target();
      if (ed) {
        ed.decor = { ...ed.decor, ghost: "", drying: [] };
        ed.discardPending();
        if (ed.getText() !== snapshot) ed.setText(snapshot);
      } else fallback.set(snapshot);
      repaint();
    },
  };
}
