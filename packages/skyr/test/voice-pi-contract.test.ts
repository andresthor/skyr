// Pi behaviour the voice design rests on. A failure here after a Pi upgrade means the design
// changes, not the test.
import {
  CURSOR_MARKER,
  renderFakeCursor,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { keybindings, realEditor, snap } from "./voice.js";

test("a focused editor ends the cursor's line with pi-tui's cursor marker and a fake-cursor space, which the ghost anchors on", () => {
  const ed = realEditor();
  ed.setText("hello");
  expect(ed.render(40)).toContainEqual(
    expect.stringContaining(`hello${CURSOR_MARKER}${renderFakeCursor(" ")}`),
  );
});

test("pi's editor draws its bottom rule through renderBottomBorder, so the voice rule reaches the screen", () => {
  const ed = realEditor();
  ed.showRule(snap());
  const bottom = ed.render(60).at(-1) ?? "";
  expect(stripTerminalSequences(bottom)).toContain("● listening");
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
    expect(keybindings().getKeys(id).length).toBeGreaterThan(0);
  },
);

test("no built-in binding claims ctrl+space, so Pi neither skips nor shadows the voice shortcut", () => {
  const claimed = Object.entries(keybindings().getEffectiveConfig()).filter(
    ([, keys]) => [keys ?? []].flat().includes("ctrl+space"),
  );
  expect(claimed).toEqual([]);
});

test("pi's editor drops its paste store when its text is set, so a draft carried between editors keeps only the marker", () => {
  const ed = realEditor();
  const lines = Array.from({ length: 11 }, (_, i) => `line ${i}`).join("\n");
  ed.handleInput(`\x1b[200~${lines}\x1b[201~`);
  expect(ed.getText()).toMatch(/\[paste #1 \+11 lines\]/);
  expect(ed.getExpandedText()).toBe(lines);
  ed.setText(ed.getText());
  expect(ed.getExpandedText()).toMatch(/\[paste #1 \+11 lines\]/);
});
