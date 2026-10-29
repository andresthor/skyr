// The bar's keys in Pi's real editor: ↑ and ↓ move the open bar's highlight, and every other
// case leaves the key to the editor.
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { withBarKeys } from "../src/chrome/bar-keys.js";
import { keybindings } from "./voice.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";

/** A real Pi editor under the bar's keys, over a bar that records what it is asked. */
function barEditor(
  o: { listing?: () => boolean; user?: Parameters<typeof keybindings>[0] } = {},
) {
  const bar = {
    listing: vi.fn(o.listing ?? (() => true)),
    move: vi.fn(() => true),
    close: vi.fn(),
  };
  const notify = vi.fn();
  const Editor = withBarKeys(CustomEditor, { bar, notify });
  const ed = new Editor(
    { terminal: { rows: 40 }, requestRender: () => {} } as never,
    { borderColor: (s: string) => s, selectList: {} } as never,
    keybindings(o.user),
  );
  ed.focused = true;
  ed.addToHistory("earlier");
  return { ed, bar, notify };
}

test("with the bar listing and an empty draft, ↓ and ↑ move the bar and do not reach the editor's history", () => {
  const { ed, bar } = barEditor();
  ed.handleInput(DOWN);
  ed.handleInput(UP);
  expect(bar.move.mock.calls).toEqual([[1], [-1]]);
  expect(ed.getText()).toBe("");
});

test("↑ reaches the editor's history when the bar is closed, when the tab is not listed, or when the draft is not empty", () => {
  const closed = barEditor({ listing: () => false });
  closed.ed.handleInput(UP);
  expect(closed.ed.getText()).toBe("earlier");
  expect(closed.bar.move).not.toHaveBeenCalled();

  const drafted = barEditor();
  drafted.ed.setText("draft");
  drafted.ed.handleInput(UP);
  expect(drafted.bar.move).not.toHaveBeenCalled();
  expect(drafted.ed.getText()).toBe("draft");
});

test("autocomplete showing takes ↑ and ↓", () => {
  const { ed, bar } = barEditor();
  vi.spyOn(ed, "isShowingAutocomplete").mockReturnValue(true);
  ed.handleInput(DOWN);
  ed.handleInput(UP);
  expect(bar.move).not.toHaveBeenCalled();
});

test("rebinding tui.select.down moves the bar's key and gives the old key back to the editor", () => {
  const { ed, bar } = barEditor({ user: { "tui.select.down": "ctrl+n" } });
  ed.handleInput("\x0e");
  expect(bar.move.mock.calls).toEqual([[1]]);
  ed.handleInput(DOWN);
  expect(bar.move).toHaveBeenCalledTimes(1);
});

test("alt+j and alt+k are never taken, and neither are keys the bar does not use", () => {
  const { ed, bar } = barEditor();
  for (const key of ["\x1bj", "\x1bk", "a", "\r", "\x1b", "\x1b[C"])
    ed.handleInput(key);
  expect(bar.move).not.toHaveBeenCalled();
  expect(bar.close).not.toHaveBeenCalled();
});

test("a throw from the bar is reported once, the key still reaches the editor, and later keys pass straight through", async () => {
  const { ed, bar, notify } = barEditor({
    listing: () => {
      throw new Error("bar gone");
    },
  });
  ed.handleInput(UP);
  expect(ed.getText()).toBe("earlier");
  await Promise.resolve();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0]?.[0]).toContain("bar gone");
  expect(notify.mock.calls[0]?.[1]).toBe("warning");

  ed.handleInput(DOWN);
  ed.handleInput(UP);
  await Promise.resolve();
  expect(bar.listing).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledTimes(1);
});

test("↑ and ↓ reach the editor's history when the bar has nothing to move", () => {
  const { ed, bar } = barEditor();
  bar.move.mockReturnValue(false);
  ed.handleInput(UP);
  expect(bar.move).toHaveBeenCalledTimes(1);
  expect(ed.getText()).toBe("earlier");
});
