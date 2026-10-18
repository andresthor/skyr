/**
 * The display loop: voice's state goes to the editor's bottom rule while our editor can carry
 * it, and to the footer status row only when it cannot. The footer row is cleared, never left
 * as a permanent line, and it is set only when it changes. The tick runs only while voice can
 * still move. Driven on Pi's real editor and fake timers, with the facts stubbed.
 */
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createVoiceDisplay } from "../src/voice/display.js";
import { DRY_MS } from "../src/voice/ghost.js";
import type { VoiceSnapshot } from "../src/voice/indicator.js";
import type { VoiceMode } from "../src/voice/palette.js";
import { realEditor, snap, testPaint } from "./voice.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

class FakeStatusUi {
  lines: (string | undefined)[] = [];
  setStatus = (key: string, text: string | undefined) => {
    expect(key).toBe("skyr.voice");
    this.lines.push(text);
  };
  get last() {
    return this.lines.at(-1);
  }
}

type Editor = ReturnType<typeof realEditor>;

/** A display over `editor` (undefined: another extension owns it), started on a fresh footer. */
function setup(editor?: Editor, mode: VoiceMode = "color") {
  const ui = new FakeStatusUi();
  const repaint = vi.fn();
  const facts = { now: snap() as VoiceSnapshot };
  const display = createVoiceDisplay({
    facts: () => facts.now,
    editor: () => editor,
    paint: () => testPaint(mode),
    repaint,
  });
  display.start(ui);
  return { ui, repaint, facts, display };
}

const bottomRow = (ed: Editor) =>
  stripTerminalSequences(ed.render(72).at(-1) ?? "");
const footer = (ui: FakeStatusUi) => stripTerminalSequences(ui.last ?? "");

test("with our editor focused, voice is on the rule and the footer stays clear", () => {
  const ed = realEditor();
  const { ui } = setup(ed);
  expect(bottomRow(ed)).toContain("listening");
  expect(ui.lines).toEqual([undefined]);
});

test("when a card hides our editor, the footer carries voice and the rule lets go", () => {
  const ed = realEditor();
  const { ui, display } = setup(ed);
  expect(ui.last).toBeUndefined();
  ed.focused = false;
  display.refresh();
  expect(bottomRow(ed)).toBe("─".repeat(72));
  expect(footer(ui)).toMatch(/^voice ● listening /);
  ed.focused = true;
  display.refresh();
  expect(ui.last).toBeUndefined();
  expect(bottomRow(ed)).toContain("listening");
});

test("if the rule ever fails to draw, voice moves to the footer instead of vanishing", () => {
  const ed = realEditor({
    paint: () => {
      throw new Error("theme went away");
    },
  });
  const { ui, display } = setup(ed);
  expect(ui.last).toBeUndefined();
  // the failed frame still draws Pi's own rule; the next refresh finds the editor can't carry voice
  expect(bottomRow(ed)).toBe("─".repeat(72));
  display.refresh();
  expect(footer(ui)).toMatch(/^voice ● listening /);
});

test("a foreign editor means the footer, and idle clears it rather than leaving a row", () => {
  const { ui, facts, display } = setup(undefined);
  expect(ui.last).toBeDefined();
  facts.now = snap({ state: "idle" });
  display.refresh();
  expect(ui.last).toBeUndefined();
});

test("the footer is set only when its row changes", () => {
  const { ui, facts, display } = setup(undefined);
  facts.now = snap({ state: "idle" });
  display.refresh();
  display.refresh();
  expect(ui.lines).toEqual([expect.any(String), undefined]);
  facts.now = snap();
  display.refresh();
  display.refresh();
  expect(ui.lines).toHaveLength(3);
});

test("the tick repaints every 50 ms while a dictation runs, and stops once voice is idle", () => {
  const { repaint, facts, display } = setup(realEditor());
  expect(repaint).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(150);
  expect(repaint).toHaveBeenCalledTimes(4);
  facts.now = snap({ state: "idle" });
  display.refresh();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(150);
  expect(repaint).toHaveBeenCalledTimes(5);
});

test("after the dictation ends, the tick runs on while a committed span dries, then stops", () => {
  const ed = realEditor();
  ed.commit("hello there");
  const { facts, display } = setup(ed);
  facts.now = snap({ state: "idle" });
  display.refresh();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(DRY_MS + 50);
  expect(vi.getTimerCount()).toBe(0);
});

test("mic levels reach the meter on the tick, and clearMeter empties it for the next dictation", () => {
  const { ui, display } = setup(undefined, "ascii");
  const empty = footer(ui);
  // a −20 dBFS syllable, held for two bars
  for (let i = 0; i < 4; i++) {
    display.level(0.1);
    vi.advanceTimersByTime(50);
  }
  expect(footer(ui)).not.toBe(empty);
  display.clearMeter();
  display.refresh();
  expect(footer(ui)).toBe(empty);
  // the next tick samples the history, so the old tail must be gone from it too
  vi.advanceTimersByTime(50);
  expect(footer(ui)).toBe(empty);
});

test("stop shows the idle facts once, clearing the rule and the footer, and leaves no tick", () => {
  const ed = realEditor();
  const { ui, facts, display } = setup(ed);
  ed.focused = false;
  display.refresh();
  expect(ui.last).toBeDefined();
  ed.focused = true;
  facts.now = snap({ state: "idle" });
  display.stop();
  expect(ui.last).toBeUndefined();
  expect(bottomRow(ed)).toBe("─".repeat(72));
  expect(vi.getTimerCount()).toBe(0);
  // let go: a second stop or a late refresh writes nothing
  const written = ui.lines.length;
  display.stop();
  display.refresh();
  expect(ui.lines).toHaveLength(written);
});
