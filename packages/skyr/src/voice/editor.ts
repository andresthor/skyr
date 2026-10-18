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
 * Everything the editor draws — ghost, drying commits, the bottom rule — lives here
 * and nowhere else: the sink, the presenter and `index.ts` go through this surface
 * and never read or write decoration state directly.
 *
 * The base class and the per-session options (key hook, paint) are passed in because
 * the package may not import pi-coding-agent statically (src/pi.ts is the one value
 * seam), and both exist only once the host is mounted.
 */
import type {
  CustomEditor,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { DictationSink } from "./dictation.js";
import { DRY_MS, spliceGhost } from "./ghost.js";
import { renderRule, type VoiceKeys, type VoiceSnapshot } from "./indicator.js";
import { FALLBACK_PALETTE, type Paint, paintFor } from "./palette.js";

/** The text to insert so a segment reads naturally between what is before and after the cursor. */
function spacedSegment(before: string, after: string, segment: string): string {
  const text = segment.trim();
  if (!text) return "";
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && /^[\w"'(`]/.test(after) ? " " : "";
  return lead + text + trail;
}

/** A voice editor: edited text plus the dictation decoration only voice knows how to draw. */
export interface VoiceEditorLike {
  /** Whether the editor has keyboard focus; false while a `ctx.ui.custom()` card replaces it. */
  readonly focused: boolean;
  getText(): string;
  setText(text: string): void;
  /** The interim segment, drawn after the cursor; "" clears it. */
  ghost(text: string): void;
  /** A finished segment, inserted at the cursor as one undo step. */
  commit(segment: string): void;
  /** Clears everything dictating ever drew: ghost, drying spans, finals held while hidden. */
  reset(): void;
  /**
   * Carries `s` on the bottom rule, or clears it when undefined. False when this editor can't
   * carry it — hidden behind a card, or its rule drawing failed once — and the caller must show
   * voice somewhere else.
   */
  showRule(s: VoiceSnapshot | undefined): boolean;
  /** True while a committed span is still drying; reading prunes the spans that finished. */
  readonly animating: boolean;
}

/** What a mount builds the voice editor class with; both live for the session's life. */
export interface VoiceEditorOptions {
  /** Consulted before Pi sees a key; return true to swallow it. */
  keyHook?: (data: string, keys: KeybindingsManager) => boolean;
  /** The colours for each render, read every frame so /theme reaches the ghost and the rule. */
  paint?: () => Paint;
}

type CustomEditorClass = typeof CustomEditor;

export function createVoiceEditorClass(
  Base: CustomEditorClass,
  { keyHook, paint }: VoiceEditorOptions = {},
  now: () => number = Date.now,
) {
  return class VoiceEditor extends Base implements VoiceEditorLike {
    private ghostText = "";
    /** Recent commits, newest first; `at` is when each landed. */
    private drying: { chars: number; lead: number; at: number }[] = [];
    /** What the bottom rule carries while voice is on; undefined leaves Pi's own rule. */
    private rule: VoiceSnapshot | undefined;
    /** Drawing the rule threw once: for this editor's life, voice shows in the footer instead. */
    private ruleFailed = false;
    private readonly paint: () => Paint;
    private readonly keys: KeybindingsManager;
    private pending: string[] = [];

    constructor(...args: ConstructorParameters<CustomEditorClass>) {
      super(...args);
      this.keys = args[2];
      this.paint = paint ?? (() => paintFor(FALLBACK_PALETTE, "color"));
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
      if (keyHook?.(data, this.keys)) return;
      super.handleInput(data);
    }

    override render(width: number): string[] {
      const base = super.render(width);
      if (!this.ghostText && !this.drying.length) return base;
      // this editor is permanent: a throw here would take the input bar down with it
      try {
        const t = now();
        return spliceGhost(base, {
          width,
          paddingX: this.getPaddingX(),
          ghost: this.ghostText,
          drying: this.drying.map((s) => ({ ...s, age: t - s.at })),
          paint: this.paint(),
          // private in pi-tui's types, but it is what tells the bottom rule from the autocomplete rows
          below:
            (this as unknown as { renderedAutocompleteHeight?: number })
              .renderedAutocompleteHeight ?? 0,
        });
      } catch {
        return base;
      }
    }

    protected override renderBottomBorder(
      width: number,
      hiddenLineCount: number,
    ): string {
      // pi-tui calls this from render() before the ghost's guard: a throw must fall back here too
      try {
        const row =
          this.rule &&
          renderRule(this.rule, {
            width,
            hiddenBelow: hiddenLineCount,
            rule: (s) => this.borderColor(s),
            keys: this.hintKeys(),
            paint: this.paint(),
          });
        if (row !== undefined) return row;
      } catch {
        this.ruleFailed = true;
      }
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

    ghost(text: string): void {
      this.ghostText = text;
    }

    get animating(): boolean {
      const t = now();
      this.drying = this.drying.filter((s) => t - s.at < DRY_MS);
      return this.drying.length > 0;
    }

    reset(): void {
      this.ghostText = "";
      this.drying = [];
      this.pending = [];
    }

    showRule(s: VoiceSnapshot | undefined): boolean {
      if (!this.focused || this.ruleFailed) {
        this.rule = undefined;
        return false;
      }
      this.rule = s;
      return true;
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
      this.drying = [
        {
          chars: insert.trim().length,
          lead: insert.length - insert.trimStart().length,
          at: t,
        },
        ...this.drying.filter((s) => t - s.at < DRY_MS),
      ];
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
    // a dictation can only start while our editor is focused, so nothing is held pending now
    begin() {
      const ed = target();
      snapshot = ed ? ed.getText() : fallback.get();
      committed = snapshot;
      ed?.reset();
      repaint();
    },
    interim(segment) {
      const ed = target();
      if (ed) ed.ghost(segment);
      else fallback.set(committed + spacedSegment(committed, "", segment));
      repaint();
    },
    final(segment) {
      const ed = target();
      if (ed) {
        ed.ghost("");
        ed.commit(segment);
      } else {
        committed += spacedSegment(committed, "", segment);
        fallback.set(committed);
      }
      repaint();
    },
    end() {
      target()?.ghost("");
      repaint();
    },
    revert(): boolean {
      const ed = target();
      if (ed) {
        ed.reset();
        const changed = ed.getText() !== snapshot;
        if (changed) ed.setText(snapshot);
        repaint();
        return changed;
      }
      fallback.set(snapshot);
      repaint();
      // the fallback's writes are each their own undo step, so there is no one undo to offer
      return false;
    },
  };
}
