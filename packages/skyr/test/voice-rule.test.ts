/**
 * The bottom rule voice draws into Pi's editor: exactly `width` columns in every state and mode,
 * one mark per fact (the meter for speech, the light for the mic, the word for the phase, the
 * keys for what they do now), and nothing drawn when voice has nothing to say. Then the footer
 * row that carries the same marks when the rule can't.
 */
import {
  colorToOklch,
  parseColor,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { SPEECH_DBFS } from "../src/voice/dictation.js";
import {
  renderRule,
  renderStatus,
  type VoiceSnapshot,
} from "../src/voice/indicator.js";
import type { VoiceMode } from "../src/voice/palette.js";
import { HINT_KEYS, snap, styledRuns, testPaint, testTheme } from "./voice.js";

const rule = (s: string) => s;
const SILENCE = Array.from({ length: 8 }, () => -58);
const draw = (
  s: Partial<VoiceSnapshot>,
  o: { width?: number; mode?: VoiceMode; hiddenBelow?: number } = {},
) =>
  renderRule(snap(s), {
    width: o.width ?? 72,
    rule,
    keys: HINT_KEYS,
    paint: testPaint(o.mode),
    hiddenBelow: o.hiddenBelow ?? 0,
  });
const plain = (s: Partial<VoiceSnapshot>, o = {}) =>
  stripTerminalSequences(draw(s, o) ?? "");
/** A 256-colour terminal gets indexed colour only, never a 24-bit one, and some colour at all. */
const expectIndexed = (row: string) => {
  const coloured = styledRuns(row).filter((r) => r.fg);
  expect(coloured.length).toBeGreaterThan(0);
  for (const run of coloured) expect(run.fg?.kind).toBe("indexed");
};

const STATES: Partial<VoiceSnapshot>[] = [
  { state: "arming", micOpen: false, sinceStartMs: 300 },
  { state: "arming", micOpen: false, sinceStartMs: 2000 },
  { state: "arming", heardSpeech: false, sinceStartMs: 2000 },
  { state: "listening" },
  {
    state: "listening",
    bars: SILENCE,
    heardSpeech: false,
    noSpeechLeftMs: 3_000,
  },
  { state: "listening", capLeftMs: 9_500 },
  { state: "transcribing", stateMs: 100 },
  { state: "transcribing", micOpen: false, stateMs: 700 },
  { state: "error", message: "connection to Corti lost · words kept" },
  { state: "error", message: "x".repeat(200) },
  { state: "discarded" },
];

test("every row is exactly the width, at every width, in every state and mode", () => {
  for (const mode of ["color", "mono", "ascii"] as const)
    for (const s of STATES)
      for (let width = 9; width <= 140; width++) {
        const row = draw(s, { width, mode, hiddenBelow: width % 3 });
        // undefined hands the row to Pi's own rule; 16 columns hold every state's last rung
        if (width >= 16)
          expect(row, `${mode} ${s.state} @${width}`).toBeDefined();
        if (row !== undefined)
          expect(visibleWidth(row), `${mode} ${s.state} @${width}`).toBe(width);
      }
});

test("idle draws nothing, so Pi's own rule stands", () => {
  expect(draw({ state: "idle" })).toBeUndefined();
});

test("a thinking pause and waiting on the server never look alike", () => {
  const pause = plain({ state: "listening", bars: SILENCE });
  const finishing = plain({
    state: "transcribing",
    micOpen: false,
    stateMs: 700,
  });
  expect(pause).toContain("● listening");
  expect(finishing).toContain("○ finishing");
  expect(pause).not.toBe(finishing);
});

test("Enter is offered once speech was heard, accepted by Corti or not", () => {
  expect(plain({ heardSpeech: false })).toContain("escape cancel");
  expect(plain({ heardSpeech: false })).not.toContain("keep");
  expect(plain({ state: "arming" })).toContain("enter keep");
  expect(plain({})).toContain("enter keep · escape discard");
  // finishing swallows Enter, so only the discard is offered
  expect(plain({ state: "transcribing", stateMs: 50 })).toMatch(
    /escape discard ──$/,
  );
  expect(plain({ state: "transcribing", stateMs: 50 })).not.toContain("keep");
});

test("the mic light stays on through the tail after Enter, and goes out when the mic closes", () => {
  expect(plain({ state: "transcribing", stateMs: 50 })).toContain(
    "● finishing·",
  );
  expect(
    plain({ state: "transcribing", micOpen: false, stateMs: 50 }),
  ).toContain("○ finishing·");
});

test("silence is the rule itself: no meter cell rises for anything below the speech gate", () => {
  const quiet = SILENCE.map(() => SPEECH_DBFS - 0.5);
  expect(plain({ bars: quiet })).toMatch(/^─{11} ● listening/);
});

/** The rendered meter's glyph colours: glyph → OKLCH lightness of the colour it drew in. */
function meterLightness(row: string): Record<string, number> {
  const light: Record<string, number> = {};
  for (const { text, fg } of styledRuns(row))
    for (const glyph of text)
      if (fg && /[\u2582-\u2588]/.test(glyph))
        light[glyph] = colorToOklch(fg).l;
  return light;
}

test("short bars recede toward the background on a light theme, as on a dark one", () => {
  // a bar at the speech gate (▂) against one near full height (█)
  const bars = [SPEECH_DBFS + 0.1, -20];
  const dark = meterLightness(draw({ bars }, { mode: "color" })!);
  const light = meterLightness(
    renderRule(snap({ bars }), {
      width: 72,
      hiddenBelow: 0,
      rule,
      keys: HINT_KEYS,
      paint: testPaint("color", testTheme({ appearance: "light" })),
    })!,
  );
  expect(dark["█"]!).toBeGreaterThan(dark["▂"]!);
  expect(light["▂"]!).toBeGreaterThan(light["█"]!);
});

test("speech spans the full ramp against its own recent peak, so syllables stand apart", () => {
  const row = plain({});
  const meter = row.slice(2, 10);
  expect(meter).toContain("█");
  expect(meter).toMatch(/[▂▃]/);
  expect(new Set(meter).size).toBeGreaterThanOrEqual(4);
  // a quiet room can't stretch near-gate noise to full height
  const soft = SILENCE.map(() => SPEECH_DBFS + 2);
  expect(plain({ bars: soft }).slice(2, 10)).not.toContain("█");
});

test("the finishing ellipsis steps every 300 ms and keeps the row from shifting", () => {
  const at = (stateMs: number) =>
    plain({ state: "transcribing", micOpen: false, stateMs });
  expect(at(0)).toContain("finishing·   ");
  expect(at(300)).toContain("finishing··  ");
  expect(at(600)).toContain("finishing··· ");
  expect(at(0).length).toBe(at(600).length);
});

test("advisories ride with the word they qualify", () => {
  expect(
    plain({ state: "arming", micOpen: false, sinceStartMs: 2000 }),
  ).toContain("○ starting · no audio yet");
  expect(
    plain({ bars: SILENCE, heardSpeech: false, noSpeechLeftMs: 3_000 }),
  ).toContain("● listening · no voice yet");
  expect(plain({ capLeftMs: 9_500 })).toContain("● listening · 10s left");
  expect(plain({ state: "arming", sinceStartMs: 2000 })).toContain(
    "● listening · connecting",
  );
});

test("the rule keeps Pi's colour: every rule cell goes through the editor's own border colour", () => {
  const row = renderRule(snap({ bars: SILENCE }), {
    width: 40,
    hiddenBelow: 0,
    rule: (s) => `<${s}>`,
    keys: HINT_KEYS,
    paint: testPaint(),
  })!;
  expect(row.startsWith("<──>")).toBe(true);
  expect(row.endsWith("<──>")).toBe(true);
});

test("a scrolled editor's ↓ N more takes the hints' place, ahead of any advisory", () => {
  const row = plain({ capLeftMs: 9_500 }, { width: 72, hiddenBelow: 3 });
  expect(row).toMatch(/● listening · 10s left ─+ ↓ 3 more ──$/);
  expect(row).not.toContain("escape");
  expect(plain({ state: "discarded" }, { hiddenBelow: 3 })).toMatch(
    /^── discarded ─+ ↓ 3 more ──$/,
  );
  expect(
    plain(
      { state: "error", message: "connection to Corti lost" },
      { hiddenBelow: 3 },
    ),
  ).toMatch(/^── ✗ connection to Corti lost ─+ ↓ 3 more ──$/);
});

test('"no voice yet" appears in the last 4 s before silence fails the dictation, and not while Corti connects', () => {
  const quiet = (noSpeechLeftMs: number | undefined) =>
    plain({ bars: SILENCE, heardSpeech: false, noSpeechLeftMs });
  expect(quiet(4_100)).not.toContain("no voice yet");
  expect(quiet(3_900)).toContain("no voice yet");
  expect(
    plain({
      state: "arming",
      bars: SILENCE,
      heardSpeech: false,
      noSpeechLeftMs: undefined,
      sinceStartMs: 9_000,
    }),
  ).not.toContain("no voice yet");
});

test("the meter drops before an advisory: a narrow rule still says time is running out", () => {
  for (let width = 33; width <= 43; width++) {
    expect(plain({ capLeftMs: 14_000 }, { width })).toContain("14s left");
    expect(
      plain(
        { bars: SILENCE, heardSpeech: false, noSpeechLeftMs: 3_000 },
        { width },
      ),
    ).toContain("no voice yet");
  }
});

test("when not even the mic light fits, voice draws nothing and Pi's own rule, scroll label included, stands", () => {
  expect(draw({}, { width: 7, hiddenBelow: 3 })).toBeUndefined();
  expect(draw({}, { width: 10, mode: "ascii" })).toBeUndefined();
});

test("an unbound key draws no hint at all, so nothing pretends to name a key that isn't there", () => {
  const half = renderRule(snap(), {
    width: 72,
    hiddenBelow: 0,
    rule,
    keys: { submit: "", cancel: "escape", undo: "ctrl+-" },
    paint: testPaint(),
  })!;
  expect(stripTerminalSequences(half)).toContain("escape discard");
  expect(stripTerminalSequences(half)).not.toContain("keep");
  expect(stripTerminalSequences(half)).not.toMatch(/· ·/);
  const none = renderRule(snap(), {
    width: 72,
    hiddenBelow: 0,
    rule,
    keys: { submit: "", cancel: "", undo: "" },
    paint: testPaint(),
  })!;
  expect(stripTerminalSequences(none)).not.toContain("keep");
  expect(stripTerminalSequences(none)).not.toContain("cancel");
  expect(stripTerminalSequences(none)).not.toContain("discard");
});

test("after Esc reverted committed words, the rule says so and names the undo", () => {
  expect(plain({ state: "discarded" })).toMatch(
    /^── discarded ─+ ctrl\+- undo ──$/,
  );
});

test("an error names its cause on the rule, truncated by whole columns", () => {
  expect(
    plain({ state: "error", message: "connection to Corti lost" }),
  ).toMatch(/^── ✗ connection to Corti lost ─+$/);
  // clipped to exactly the one rule cell a row keeps
  expect(
    plain({ state: "error", message: "x".repeat(200) }, { width: 30 }),
  ).toMatch(/^── ✗ x+… ───$/);
});

test("TERM=dumb marks are ASCII; NO_COLOR keeps the glyphs without colour; 256-colour stays indexed", () => {
  const dumb = draw({}, { mode: "ascii" })!;
  expect(dumb).not.toContain("\x1b");
  expect(dumb).toContain("[rec] listening");
  expect(dumb).toMatch(/[=#]{3}/);
  const mono = draw({}, { mode: "mono" })!;
  expect(mono).not.toContain("\x1b[");
  expect(mono).toContain("●");
  const indexed = renderRule(snap({}), {
    width: 72,
    hiddenBelow: 0,
    rule,
    keys: HINT_KEYS,
    paint: testPaint("color", testTheme({ colorMode: "256color" })),
  })!;
  expectIndexed(indexed);
});

test("the footer row names voice first, so a neighbouring status can't claim its marks", () => {
  expect(
    stripTerminalSequences(
      renderStatus(
        snap({ state: "arming", micOpen: false, sinceStartMs: 300 }),
        { paint: testPaint() },
      )!,
    ),
  ).toBe("voice ○ starting ────────");
  expect(
    stripTerminalSequences(
      renderStatus(snap({ state: "transcribing", micOpen: false }), {
        paint: testPaint(),
      })!,
    ),
  ).toBe("voice ○ finishing· ────────");
  expect(
    stripTerminalSequences(
      renderStatus(snap({ state: "discarded" }), { paint: testPaint() })!,
    ),
  ).toBe("voice discarded");
  // the footer collapses runs of spaces, so the row never relies on them
  expect(renderStatus(snap(), { paint: testPaint() })!).not.toMatch(/ {2}/);
});

test("the error row names the cause, truncated by whole columns", () => {
  const row = renderStatus(
    snap({
      state: "error",
      message: "microphone blocked · allow it in System Settings › Privacy",
    }),
    { paint: testPaint() },
  )!;
  // the footer caps the message at its own width before the terminal does; the cause stays whole
  expect(stripTerminalSequences(row)).toMatch(
    /^voice ✗ microphone blocked · allow it in /,
  );
  const short = renderStatus(
    snap({ state: "error", message: "microphone blocked" }),
    { paint: testPaint() },
  )!;
  expect(stripTerminalSequences(short)).toBe("voice ✗ microphone blocked");
  const long = renderStatus(snap({ state: "error", message: "x".repeat(90) }), {
    paint: testPaint(),
  })!;
  // the footer's error row is 60 columns whole, prefix included
  expect(visibleWidth(long)).toBe(60);
});

test("a message that fits the footer's 60 columns shows whole; one column more is cut to end in …", () => {
  const row = (message: string) =>
    stripTerminalSequences(
      renderStatus(snap({ state: "error", message }), { paint: testPaint() })!,
    );
  const fits = row("x".repeat(52));
  expect(fits).toBe(`voice ✗ ${"x".repeat(52)}`);
  expect(visibleWidth(fits)).toBe(60);
  const cut = row("x".repeat(53));
  expect(cut).toBe(`voice ✗ ${"x".repeat(51)}…`);
  expect(visibleWidth(cut)).toBe(60);
});

test("TERM=dumb and NO_COLOR forms: ASCII marks, or the glyphs without colour", () => {
  const dumb = renderStatus(snap(), { paint: testPaint("ascii") })!;
  expect(dumb).toMatch(/^voice \[rec\] listening [-=#]{8}$/);
  const mono = renderStatus(snap(), { paint: testPaint("mono") })!;
  expect(mono).not.toContain("\x1b[");
  expect(mono).toContain("●");
});

test("the footer row reads the theme it is given, so it follows theme switches", () => {
  const accent = parseColor("#157937");
  const row = renderStatus(snap(), {
    paint: testPaint("color", testTheme({ colors: { accent } })),
  })!;
  expect(styledRuns(row)).toContainEqual(
    expect.objectContaining({ text: "●", fg: accent }),
  );
  expectIndexed(
    renderStatus(snap(), {
      paint: testPaint("color", testTheme({ colorMode: "256color" })),
    })!,
  );
});

test("the footer carries the rule's advisories, so a hidden editor still hears about the cap", () => {
  expect(
    stripTerminalSequences(
      renderStatus(snap({ capLeftMs: 9_500 }), { paint: testPaint() })!,
    ),
  ).toMatch(/^voice ● listening · 10s left /);
  expect(
    stripTerminalSequences(
      renderStatus(
        snap({ state: "arming", micOpen: false, sinceStartMs: 2000 }),
        { paint: testPaint() },
      )!,
    ),
  ).toBe("voice ○ starting · no audio yet ────────");
});
