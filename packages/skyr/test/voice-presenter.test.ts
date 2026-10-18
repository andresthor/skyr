/**
 * The presenter seam: voice's state goes to the editor's bottom rule while our editor is on
 * screen, and to the footer status row only when it is not. The footer row is cleared, never
 * left as a permanent line, and it is set only when it changes.
 */
import {
  parseColor,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import type { VoiceSnapshot } from "../src/voice/indicator.js";
import { renderStatus } from "../src/voice/indicator.js";
import {
  FALLBACK_PALETTE,
  paintFor,
  type VoiceMode,
} from "../src/voice/palette.js";
import { type RuleEditor, voicePresenter } from "../src/voice/presenter.js";
import { snap } from "./voice.js";

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

/**
 * A rule editor as these tests drive one: `showRule` carries only while focused and never
 * after a failure, and `carried` records what the rule holds for the assertions to read.
 */
function ruleEditor(
  o: { focused?: boolean; failed?: boolean } = {},
): RuleEditor & {
  focused: boolean;
  failed: boolean;
  carried: VoiceSnapshot | undefined;
} {
  return {
    focused: o.focused ?? true,
    failed: o.failed ?? false,
    carried: undefined,
    showRule(s) {
      const can = this.focused && !this.failed;
      this.carried = can ? s : undefined;
      return can;
    },
  };
}

function setup(editor?: RuleEditor) {
  const ui = new FakeStatusUi();
  const present = voicePresenter({
    editor: () => editor,
    status: ui,
    paint: () => paintFor(FALLBACK_PALETTE, "color"),
  });
  return { ui, present };
}

test("with our editor focused, voice is on the rule and the footer stays clear", () => {
  const editor = ruleEditor();
  const { ui, present } = setup(editor);
  present.update(snap());
  expect(editor.carried?.state).toBe("listening");
  expect(ui.lines).toEqual([undefined]);
});

test("when a card hides our editor, the footer carries voice and the rule lets go", () => {
  const editor = ruleEditor({ focused: true });
  const { ui, present } = setup(editor);
  present.update(snap());
  expect(ui.last).toBeUndefined();
  editor.focused = false;
  present.update(snap());
  expect(editor.carried).toBeUndefined();
  expect(stripTerminalSequences(ui.last ?? "")).toMatch(/^voice ● listening /);
  editor.focused = true;
  present.update(snap());
  expect(ui.last).toBeUndefined();
});

test("a foreign editor means the footer, and idle clears it rather than leaving a row", () => {
  const { ui, present } = setup(undefined);
  present.update(snap());
  expect(ui.last).toBeDefined();
  present.update(snap({ state: "idle" }));
  expect(ui.last).toBeUndefined();
});

test("the footer is set only when its row changes", () => {
  const { ui, present } = setup(undefined);
  present.update(snap({ state: "idle" }));
  present.update(snap({ state: "idle" }));
  expect(ui.lines).toEqual([undefined]);
  present.update(snap());
  present.update(snap());
  expect(ui.lines).toHaveLength(2);
});

/** The fallback paint in a given mode, as the old `palette`/`mode` pair read. */
const paint = (mode: VoiceMode = "color", palette = FALLBACK_PALETTE) =>
  paintFor(palette, mode);

test("the footer row names voice first, so a neighbouring status can't claim its marks", () => {
  expect(
    stripTerminalSequences(
      renderStatus(
        snap({ state: "arming", micOpen: false, sinceStartMs: 300 }),
      )!,
    ),
  ).toBe("voice ○ starting ────────");
  expect(
    stripTerminalSequences(
      renderStatus(snap({ state: "transcribing", micOpen: false }))!,
    ),
  ).toBe("voice ○ finishing· ────────");
  expect(
    stripTerminalSequences(renderStatus(snap({ state: "discarded" }))!),
  ).toBe("voice discarded");
  // the footer collapses runs of spaces, so the row never relies on them
  expect(renderStatus(snap())!).not.toMatch(/ {2}/);
});

test("the error row names the cause, truncated by whole columns", () => {
  const row = renderStatus(
    snap({
      state: "error",
      message: "microphone blocked · allow it in System Settings › Privacy",
    }),
  )!;
  // the footer caps the message at its own width before the terminal does; the cause stays whole
  expect(stripTerminalSequences(row)).toMatch(
    /^voice ✗ microphone blocked · allow it in /,
  );
  const short = renderStatus(
    snap({ state: "error", message: "microphone blocked" }),
  )!;
  expect(stripTerminalSequences(short)).toBe("voice ✗ microphone blocked");
  const long = renderStatus(snap({ state: "error", message: "x".repeat(90) }))!;
  // the footer's error row is 60 columns whole, prefix included
  expect(visibleWidth(long)).toBe(60);
});

test("TERM=dumb and NO_COLOR forms: ASCII marks, or the glyphs without colour", () => {
  expect(
    stripTerminalSequences(renderStatus(snap(), { paint: paint("ascii") })!),
  ).toMatch(/^voice \[rec\] listening [-=#]{8}$/);
  const mono = renderStatus(snap(), { paint: paint("mono") })!;
  expect(mono).not.toContain("\x1b[");
  expect(mono).toContain("●");
});

test("the footer row reads the palette it is given, so it follows theme switches", () => {
  const light = {
    ...FALLBACK_PALETTE,
    colors: { ...FALLBACK_PALETTE.colors, accent: parseColor("#157937") },
  };
  expect(renderStatus(snap(), { paint: paint("color", light) })).toContain(
    "\x1b[38;2;21;121;55m●",
  );
  expect(
    renderStatus(snap(), {
      paint: paint("color", { ...FALLBACK_PALETTE, mode: "256color" }),
    }),
  ).not.toContain("\x1b[38;2;");
});

test("the footer carries the rule's advisories, so a hidden editor still hears about the cap", () => {
  expect(
    stripTerminalSequences(renderStatus(snap({ capLeftMs: 9_500 }))!),
  ).toMatch(/^voice ● listening · 10s left /);
  expect(
    stripTerminalSequences(
      renderStatus(
        snap({ state: "arming", micOpen: false, sinceStartMs: 2000 }),
      )!,
    ),
  ).toBe("voice ○ starting · no audio yet ────────");
});

test("if the rule ever fails to draw, voice moves to the footer instead of vanishing", () => {
  const editor = ruleEditor({ failed: true });
  const { ui, present } = setup(editor);
  present.update(snap());
  expect(editor.carried).toBeUndefined();
  expect(stripTerminalSequences(ui.last ?? "")).toMatch(/^voice ● listening /);
});
