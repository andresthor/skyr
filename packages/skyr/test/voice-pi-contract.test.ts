// Pi behaviour the voice design rests on. A failure here after a Pi upgrade means the design
// changes, not the test.
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  renderFakeCursor,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
// Pi builds its app bindings with this class but does not export it from its root
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createVoiceEditorClass } from "../src/voice/editor.js";
import { VOICE_SHORTCUT } from "../src/voice/index.js";
import { CURSOR_CELL, stripAnsi } from "../src/voice/indicator.js";
import { scratchDir } from "./session.js";
import { keybindings, snap } from "./voice.js";

/** Pi's resolved app bindings with no keybindings.json, as interactive mode builds them. */
const piBindings = () => KeybindingsManager.create(scratchDir("agent"));

/** A real Pi editor, focused, with voice's subclass on top. */
function realEditor() {
  const VoiceEditor = createVoiceEditorClass(CustomEditor);
  const ed = new VoiceEditor(
    { terminal: { rows: 40 }, requestRender: () => {} } as never,
    { borderColor: (s: string) => s, selectList: {} } as never,
    keybindings(),
  );
  ed.focused = true;
  return ed;
}

test("the ghost's anchor is pi-tui's cursor marker followed by its fake-cursor space", () => {
  expect(CURSOR_CELL).toBe(`${CURSOR_MARKER}${renderFakeCursor(" ")}`);
});

test("pi's editor draws its bottom rule through renderBottomBorder, so the voice rule reaches the screen", () => {
  const ed = realEditor();
  ed.decor.rule = snap();
  const bottom = ed.render(60).at(-1) ?? "";
  expect(stripAnsi(bottom)).toContain("● listening");
  expect(visibleWidth(bottom)).toBe(60);
});

test("pi's editor keeps its autocomplete height in a numeric renderedAutocompleteHeight field", () => {
  const ed = realEditor() as unknown as Record<string, unknown>;
  expect(typeof ed.renderedAutocompleteHeight).toBe("number");
});

test.each([
  "tui.input.submit",
  "tui.select.cancel",
  "tui.editor.undo",
] as const)(
  "pi binds %s by default, so voice's key hook and hints have a key to match",
  (id) => {
    expect(piBindings().getKeys(id).length).toBeGreaterThan(0);
  },
);

test("no built-in binding claims ctrl+space, so Pi neither skips nor shadows the voice shortcut", () => {
  const claimed = Object.entries(piBindings().getEffectiveConfig()).filter(
    ([, keys]) => [keys ?? []].flat().includes(VOICE_SHORTCUT),
  );
  expect(claimed).toEqual([]);
});
