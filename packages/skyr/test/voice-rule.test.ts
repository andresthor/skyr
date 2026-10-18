/**
 * The bottom rule voice draws into Pi's editor: exactly `width` columns in every state and mode,
 * one mark per fact (the meter for speech, the light for the mic, the word for the phase, the
 * keys for what they do now), and nothing drawn when voice has nothing to say.
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
  meterUnit,
  renderRule,
  type VoiceSnapshot,
} from "../src/voice/indicator.js";
import {
  FALLBACK_PALETTE,
  paintFor,
  type VoiceMode,
} from "../src/voice/palette.js";
import { HINT_KEYS, snap } from "./voice.js";

const rule = (s: string) => s;
const atDb = (db: number) => meterUnit(10 ** (db / 20));
const SILENCE = Array.from({ length: 8 }, () => atDb(-58));
/** The fallback paint in a given mode, as the old `palette`/`mode` pair read. */
const paint = (mode: VoiceMode = "color", palette = FALLBACK_PALETTE) =>
  paintFor(palette, mode);
const draw = (
  s: Partial<VoiceSnapshot>,
  o: { width?: number; mode?: VoiceMode; hiddenBelow?: number } = {},
) =>
  renderRule(snap(s), {
    width: o.width ?? 72,
    rule,
    keys: HINT_KEYS,
    paint: paint(o.mode),
    hiddenBelow: o.hiddenBelow,
  });
const plain = (s: Partial<VoiceSnapshot>, o = {}) =>
  stripTerminalSequences(draw(s, o) ?? "");

const STATES: Partial<VoiceSnapshot>[] = [
  { state: "arming", micOpen: false, sinceStartMs: 300 },
  { state: "arming", micOpen: false, sinceStartMs: 2000 },
  { state: "arming", accepted: false, heardSpeech: false, sinceStartMs: 2000 },
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

test("Enter is offered only once speech was heard on an accepted session", () => {
  expect(plain({ heardSpeech: false })).toContain("escape cancel");
  expect(plain({ heardSpeech: false })).not.toContain("keep");
  expect(plain({ accepted: false })).not.toContain("keep");
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
  const quiet = SILENCE.map(() => atDb(SPEECH_DBFS - 0.5));
  expect(plain({ bars: quiet })).toMatch(/^─{11} ● listening/);
});

/** The rendered meter's glyph colours: glyph → OKLCH lightness of the colour it drew in. */
function meterLightness(row: string): Record<string, number> {
  const light: Record<string, number> = {};
  for (const m of row.matchAll(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape bytes are exactly what the pattern must name
    /\x1b\[38;2;(\d+);(\d+);(\d+)m([\u2582-\u2588])/g,
  )) {
    const [r, g, b, glyph] = m.slice(1) as [string, string, string, string];
    const hex = (n: string) =>
      Number(n).toString(16).padStart(2, "0").toUpperCase();
    light[glyph] = colorToOklch(parseColor(`#${hex(r)}${hex(g)}${hex(b)}`)).l;
  }
  return light;
}

test("short bars recede toward the background on a light theme, as on a dark one", () => {
  // a bar at the speech gate (▂) against one near full height (█)
  const bars = [atDb(SPEECH_DBFS + 0.1), atDb(-20)];
  const dark = meterLightness(draw({ bars }, { mode: "color" })!);
  const light = meterLightness(
    renderRule(snap({ bars }), {
      width: 72,
      rule,
      keys: HINT_KEYS,
      paint: paint("color", { ...FALLBACK_PALETTE, appearance: "light" }),
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
  const soft = SILENCE.map(() => atDb(SPEECH_DBFS + 2));
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
  expect(
    plain({ state: "arming", accepted: false, sinceStartMs: 2000 }),
  ).toContain("● listening · connecting");
});

test("the rule keeps Pi's colour: every rule cell goes through the editor's own border colour", () => {
  const row = renderRule(snap({ bars: SILENCE }), {
    width: 40,
    rule: (s) => `<${s}>`,
    keys: HINT_KEYS,
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
      accepted: false,
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
    rule,
    keys: { submit: "", cancel: "escape", undo: "ctrl+-" },
    paint: paint(),
  })!;
  expect(stripTerminalSequences(half)).toContain("escape discard");
  expect(stripTerminalSequences(half)).not.toContain("keep");
  expect(stripTerminalSequences(half)).not.toMatch(/· ·/);
  const none = renderRule(snap(), {
    width: 72,
    rule,
    keys: { submit: "", cancel: "", undo: "" },
    paint: paint(),
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
  expect(
    plain({ state: "error", message: "x".repeat(200) }, { width: 30 }),
  ).toContain("…");
});

test("TERM=dumb marks are ASCII; NO_COLOR keeps the glyphs without colour; 256-colour stays indexed", () => {
  const dumb = plain({}, { mode: "ascii" });
  expect(dumb).toContain("[rec] listening");
  expect(dumb).toMatch(/[=#]{3}/);
  const mono = draw({}, { mode: "mono" })!;
  expect(mono).not.toContain("\x1b[");
  expect(mono).toContain("●");
  const indexed = renderRule(snap({}), {
    width: 72,
    rule,
    keys: HINT_KEYS,
    paint: paint("color", { ...FALLBACK_PALETTE, mode: "256color" }),
  })!;
  expect(indexed).not.toContain("\x1b[38;2;");
});
