/**
 * The presenter seam: voice's state goes to the editor's bottom rule while our editor is on
 * screen, and to the footer status row only when it is not. The footer row is cleared, never
 * left as a permanent line, and it is set only when it changes.
 */
import { parseColor, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import {
  FALLBACK_PALETTE,
  meterUnit,
  renderStatus,
  stripAnsi,
  type VoiceSnapshot,
} from "../src/voice/indicator.js";
import {
  type RuleEditor,
  VOICE_STATUS_KEY,
  voicePresenter,
} from "../src/voice/presenter.js";

const snap = (s: Partial<VoiceSnapshot> = {}): VoiceSnapshot => ({
  state: "listening",
  t: 0,
  sinceStart: 2000,
  micOpen: true,
  accepted: true,
  heardSpeech: true,
  bars: [-30, -22, -40].map((db) => meterUnit(10 ** (db / 20))),
  message: "",
  ...s,
});

class FakeStatusUi {
  lines: (string | undefined)[] = [];
  setStatus = (key: string, text: string | undefined) => {
    expect(key).toBe(VOICE_STATUS_KEY);
    this.lines.push(text);
  };
  get last() {
    return this.lines.at(-1);
  }
}

function setup(editor?: RuleEditor) {
  const ui = new FakeStatusUi();
  const present = voicePresenter({
    editor: () => editor,
    status: ui,
    palette: () => FALLBACK_PALETTE,
    mode: "color",
  });
  return { ui, present };
}

test("with our editor focused, voice is on the rule and the footer stays clear", () => {
  const editor: RuleEditor = { decor: {}, focused: true };
  const { ui, present } = setup(editor);
  present.update(snap());
  expect(editor.decor.rule?.state).toBe("listening");
  expect(ui.lines).toEqual([undefined]);
});

test("when a card hides our editor, the footer carries voice and the rule lets go", () => {
  const editor = { decor: {} as RuleEditor["decor"], focused: true };
  const { ui, present } = setup(editor);
  present.update(snap());
  editor.focused = false;
  present.update(snap());
  expect(editor.decor.rule).toBeUndefined();
  expect(stripAnsi(ui.last ?? "")).toMatch(/^voice ● listening /);
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

test("the footer row names voice first, so a neighbouring status can't claim its marks", () => {
  expect(
    stripAnsi(renderStatus(snap({ state: "arming", micOpen: false }))!),
  ).toBe("voice ○ starting ────────");
  expect(
    stripAnsi(renderStatus(snap({ state: "transcribing", micOpen: false }))!),
  ).toBe("voice ○ finishing ────────");
  expect(
    stripAnsi(renderStatus(snap({ state: "idle", discarded: true }))!),
  ).toBe("voice discarded");
  // the footer collapses runs of spaces, so the row never relies on them
  expect(renderStatus(snap())!).not.toMatch(/ {2}/);
});

test("the error row names the cause, truncated by whole columns", () => {
  const row = renderStatus(
    snap({
      state: "error",
      message: "microphone blocked · System Settings › Privacy",
    }),
  )!;
  expect(stripAnsi(row)).toBe(
    "voice ✗ microphone blocked · System Settings › Privacy",
  );
  const long = renderStatus(snap({ state: "error", message: "x".repeat(90) }))!;
  expect(visibleWidth(long)).toBeLessThanOrEqual(60);
});

test("TERM=dumb and NO_COLOR forms: ASCII marks, or the glyphs without colour", () => {
  expect(stripAnsi(renderStatus(snap(), { mode: "ascii" })!)).toMatch(
    /^voice \[rec\] listening [-=#]{8}$/,
  );
  const mono = renderStatus(snap(), { mode: "mono" })!;
  expect(mono).not.toContain("\x1b[");
  expect(mono).toContain("●");
});

test("the footer row reads the palette it is given, so it follows theme switches", () => {
  const light = {
    ...FALLBACK_PALETTE,
    colors: { ...FALLBACK_PALETTE.colors, accent: parseColor("#157937") },
  };
  expect(renderStatus(snap(), { palette: light })).toContain(
    "\x1b[38;2;21;121;55m●",
  );
  expect(
    renderStatus(snap(), {
      palette: { ...FALLBACK_PALETTE, mode: "256color" },
    }),
  ).not.toContain("\x1b[38;2;");
});
