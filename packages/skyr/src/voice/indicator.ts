/**
 * What voice shows of a dictation: `renderRule()` for the editor's bottom rule while voice is
 * on, `renderStatus()` for the footer row when the editor can't carry it, and the level history
 * that turns mic levels in at whatever rate they arrive into one smoothed bar per BAR_MS. All
 * wording is decided once in `voiceView()`; the two renderers are layout only.
 *
 * Every glyph is in U+2580–259F or is a width-1 symbol. Never braille.
 */
import {
  type Color,
  colorToOklch,
  oklchColor,
  sliceByColumn,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type DictationFacts, SPEECH_DBFS } from "./dictation.js";
import { dbfs } from "./mic.js";
import { clamp01, FALLBACK_PALETTE, type Paint, paintFor } from "./palette.js";

/** One smoothed bar cell per this many ms of recording. */
const BAR_MS = 100;
/** Bars kept: 4.8 s, the window the meter auto-ranges its peak over. */
const HISTORY_BARS = 48;
/** The share of the gap to the newest level closed per tick, rising and falling. */
const ATTACK = 0.8;
const DECAY = 0.5;

interface LevelHistory {
  push(level: number): void;
  /** Advance `dt` ms; returns the committed bars, newest first. */
  sample(dt: number): number[];
  reset(): void;
}

/** Fast attack, quick decay, so syllables stand apart instead of merging. */
export function createLevelHistory(): LevelHistory {
  const bars: number[] = [];
  let pending = 0;
  let cur = 0;
  let held = 0;
  let since = 0;
  return {
    push(level) {
      pending = Math.max(pending, clamp01(level));
    },
    sample(dt) {
      cur += (pending - cur) * (pending > cur ? ATTACK : DECAY);
      pending = 0;
      held = Math.max(held, cur);
      since += dt;
      if (since >= BAR_MS) {
        since -= BAR_MS;
        bars.unshift(held);
        if (bars.length > HISTORY_BARS) bars.length = HISTORY_BARS;
        held = cur;
      }
      return bars.slice();
    },
    reset() {
      bars.length = 0;
      pending = 0;
      cur = 0;
      held = 0;
      since = 0;
    },
  };
}

/** The footer's whole error row: the `voice ✗` prefix plus the message;
 * pi truncates further to the terminal's width. */
const ERROR_COLS = 60;
const ERROR_PREFIX_COLS = 8;
/** Non-message columns in the rule's `── ✗ <message> ──`, plus one spare as compose keeps. */
const ERROR_ROW_MARGIN = 9;

/** Warn this long before the hard cap, so the cap is first advisory, then fact. */
const CAP_WARN_MS = 15_000;
/** Say "no voice yet" this long before silence fails the dictation. */
const NO_VOICE_WARN_MS = 4_000;
/** The slow-start advisories wait this long, so an ordinary start never flickers them. */
const SLOW_START_MS = 1_500;
/** One step of the finishing ellipsis per this many ms. */
const ELLIPSIS_MS = 300;

/**
 * The footer row, for when the editor's rule can't carry voice: another extension owns the
 * editor, or a card hides it. The rule's marks without its key hints, led by `voice` so a
 * neighbouring status can't claim them; undefined clears the row.
 */
export function renderStatus(
  s: VoiceSnapshot,
  { paint = paintFor(FALLBACK_PALETTE, "color") }: { paint?: Paint } = {},
): string | undefined {
  const { colors: T, ascii, fg } = paint;
  const label = fg(T.muted, "voice");
  const view = voiceView(s);
  if (view.kind === "error") {
    const text = sliceByColumn(
      view.message,
      0,
      ERROR_COLS - ERROR_PREFIX_COLS,
      true,
    );
    return `${label} ${fg(T.error, ascii ? "x" : "✗")}${fg(T.muted, ` ${text}`)}`;
  }
  if (view.kind === "off") return undefined;
  if (view.kind === "discarded") return `${label} ${fg(T.muted, "discarded")}`;
  const light = view.recording
    ? ascii
      ? "[rec]"
      : fg(T.accent, "●")
    : ascii
      ? "[...]"
      : fg(T.muted, "○");
  // the footer collapses runs of spaces, so the ellipsis is drawn without its rule-side padding
  const word =
    fg(T.muted, view.word) +
    (view.dots ? fg(T.dim, (ascii ? "." : "·").repeat(view.dots)) : "");
  const sep = ascii ? ", " : fg(T.dim, " · ");
  // the footer collapses runs of spaces, so silence is dim rule cells rather than padding
  const silence = (x: string) => fg(T.dim, ascii ? x.replaceAll("─", "-") : x);
  const meter = view.recording
    ? meterCells(s.bars, silence, paint)
    : silence("─".repeat(METER_CELLS));
  const advisories = view.advisories.map((a) => fg(T[a.tone], a.text));
  return `${[`${label} ${light} ${word}`, ...advisories].join(sep)} ${meter}`;
}

/** An advisory line: `tone` picks the palette token it draws in. */
interface Advisory {
  text: string;
  tone: "warning" | "muted";
}

/** What voice can say about one moment, with every wording decision made: no ANSI, no layout. */
type VoiceView =
  | { kind: "off" }
  | { kind: "error"; message: string }
  | { kind: "discarded" }
  | {
      kind: "live";
      /** The mic is open: the light stays on through the tail after Enter. */
      recording: boolean;
      word: "starting" | "listening" | "finishing";
      /** Steps of the finishing ellipsis: server work, never motion in the meter. */
      dots: 0 | 1 | 2 | 3;
      /** What the bound keys would do right now. */
      offer: "keep" | "cancel" | "discard";
      advisories: Advisory[];
    };

/** Reads the facts once, deciding everything the displays then only have to draw. */
function voiceView(s: VoiceSnapshot): VoiceView {
  const phase = phaseOf(s);
  if (s.state === "error") return { kind: "error", message: s.message };
  if (s.state === "discarded") return { kind: "discarded" };
  if (!phase) return { kind: "off" };
  const word =
    phase === "starting"
      ? "starting"
      : phase === "listening"
        ? "listening"
        : "finishing";
  // one step of the finishing ellipsis per ELLIPSIS_MS, wrapping after three: server work,
  // never motion in the meter
  const step = (Math.floor(s.stateMs / ELLIPSIS_MS) % 3) + 1;
  const dots: 0 | 1 | 2 | 3 =
    phase === "tail" || phase === "finishing"
      ? step === 1
        ? 1
        : step === 2
          ? 2
          : 3
      : 0;
  const advisories: Advisory[] = [];
  if (phase === "starting" && s.sinceStartMs > SLOW_START_MS)
    advisories.push({ text: "no audio yet", tone: "warning" });
  if (s.state === "arming" && s.micOpen && s.sinceStartMs > SLOW_START_MS)
    advisories.push({ text: "connecting", tone: "muted" });
  if (
    phase === "listening" &&
    !s.heardSpeech &&
    s.noSpeechLeftMs !== undefined &&
    s.noSpeechLeftMs <= NO_VOICE_WARN_MS
  )
    advisories.push({ text: "no voice yet", tone: "warning" });
  if (s.state === "listening" && s.capLeftMs <= CAP_WARN_MS)
    advisories.push({
      text: `${Math.ceil(Math.max(0, s.capLeftMs) / 1000)}s left`,
      tone: "warning",
    });
  // Enter keeps speech; before Corti accepts, its audio waits for acceptance
  const canKeep = s.heardSpeech;
  return {
    kind: "live",
    recording: phase === "listening" || phase === "tail",
    word,
    dots,
    offer:
      phase === "listening" && canKeep
        ? "keep"
        : phase === "listening" || phase === "starting"
          ? "cancel"
          : "discard",
    advisories,
  };
}

/** What a voice display needs to know at one moment: the controller's facts plus the meter bars. */
export type VoiceSnapshot = DictationFacts & {
  /** Committed meter bars in `meterUnit`s, newest first. */
  bars: readonly number[];
};

const METER_FLOOR_DB = -60;
const METER_SPAN_DB = 50;

/** A chunk's RMS as the meter's 0..1 unit: −60…−10 dBFS, so close-mic speech never clips. */
export function meterUnit(rms: number): number {
  return clamp01((dbfs(rms) - METER_FLOOR_DB) / METER_SPAN_DB);
}

const METER_CELLS = 8;
const RISE = "▂▃▄▅▆▇█";
/** Auto-ranging never stretches less than this much above the gate to full height, so a quiet room stays quiet. */
const MIN_RANGE_DB = 15;

/** The accent at a shifted OKLCH lightness, same hue: short bars recede toward the
 * background, peaks come forward — whichever side of the background the accent sits on. */
function shade(c: Color, dL: number, chroma = 1): Color {
  const { l, c: ch, h } = colorToOklch(c);
  return oklchColor(
    Math.min(0.95, Math.max(0.2, l + dL)),
    Math.min(0.37, ch * chroma),
    h,
  );
}

type Phase = "starting" | "listening" | "tail" | "finishing";

function phaseOf(s: VoiceSnapshot): Phase | undefined {
  if (s.state === "arming") return s.micOpen ? "listening" : "starting";
  if (s.state === "listening") return "listening";
  if (s.state === "transcribing") return s.micOpen ? "tail" : "finishing";
  return undefined;
}

/** Key names as Pi prints them in its own hints; an empty name means the binding is unbound, and its hint is dropped. */
export interface VoiceKeys {
  submit: string;
  cancel: string;
  undo: string;
}

interface RuleOptions {
  width: number;
  /** Text rows scrolled out below the editor: Pi's `↓ N more` label sits on the right, in place of any hints. */
  hiddenBelow?: number;
  /** The editor's `borderColor`: Pi colours its rules by thinking level and bash mode. */
  rule: (s: string) => string;
  keys: VoiceKeys;
  paint?: Paint;
}

/**
 * The editor's bottom rule while voice is on, exactly `width` columns: the meter rises out of the
 * rule, then the mic light, the state and any advisory, and the keys that apply right now. Narrow
 * widths drop whole elements: hints, meter, advisories, word, light. Undefined means voice has
 * nothing to say or nothing fits, and Pi draws its own rule.
 */
export function renderRule(
  s: VoiceSnapshot,
  {
    width,
    hiddenBelow = 0,
    rule,
    keys,
    paint = paintFor(FALLBACK_PALETTE, "color"),
  }: RuleOptions,
): string | undefined {
  const { colors: T, ascii, fg } = paint;
  const view = voiceView(s);
  const line = (n: number) => rule("─".repeat(Math.max(0, n)));
  const key = (k: string, what: string) =>
    k ? `${fg(T.dim, k)}${fg(T.muted, ` ${what}`)}` : "";
  const sep = ascii ? ", " : fg(T.dim, " · ");

  // `── left ──…── right ──`, or undefined when it can't fit
  const compose = (left: string, right: string, meter = "") => {
    const head = meter
      ? `${line(2)}${meter}${line(1)} ${left}`
      : `${line(2)} ${left}`;
    const tail = right ? ` ${right} ${line(2)}` : line(2);
    const n = width - visibleWidth(head) - visibleWidth(tail) - 1;
    if (n < 1) return undefined;
    return `${head} ${line(n)}${tail}`;
  };
  const first = (rows: (string | undefined)[]) =>
    rows.find((r) => r !== undefined);
  const more = hiddenBelow > 0 ? rule(`↓ ${hiddenBelow} more`) : undefined;

  if (view.kind === "error") {
    const mark = fg(T.error, ascii ? "x" : "✗");
    // as wide as `── ✗ ` before the message, ` ──` after it, plus compose's spare column
    const room = Math.max(0, width - ERROR_ROW_MARGIN);
    const full = view.message;
    const text =
      visibleWidth(full) <= room
        ? full
        : `${sliceByColumn(full, 0, room - 1, true)}…`;
    const cause = `${mark}${fg(T.muted, ` ${text}`)}`;
    return first([compose(cause, more ?? ""), compose(cause, "")]);
  }
  if (view.kind === "discarded") {
    const notice = fg(T.muted, "discarded");
    return first([
      compose(notice, more ?? key(keys.undo, "undo")),
      compose(notice, ""),
    ]);
  }
  if (view.kind === "off") return undefined;

  const light = view.recording
    ? ascii
      ? "[rec]"
      : fg(T.accent, "●")
    : ascii
      ? "[...]"
      : fg(T.muted, "○");
  // the ellipsis keeps a fixed three cells on the rule, so the row never shifts under it
  const word =
    fg(T.muted, view.word) +
    (view.dots
      ? fg(T.dim, (ascii ? "." : "·").repeat(view.dots)) +
        " ".repeat(3 - view.dots)
      : "");
  const advisories = view.advisories.map((a) => fg(T[a.tone], a.text));
  const lw = `${light} ${word}`;
  const phrase = advisories.length ? [lw, ...advisories].join(sep) : lw;

  // an unbound id draws no hint at all: the rule never names a key that isn't there
  const hints =
    view.offer === "keep"
      ? [key(keys.submit, "keep"), key(keys.cancel, "discard")]
          .filter(Boolean)
          .join(sep)
      : key(keys.cancel, view.offer);
  const fewerHints =
    view.offer === "keep" ? key(keys.cancel, "discard") : hints;

  const meter = view.recording
    ? meterCells(s.bars, rule, paint)
    : line(METER_CELLS);
  return first([
    compose(phrase, more ?? hints, meter),
    compose(phrase, more ?? fewerHints, meter),
    compose(phrase, "", meter),
    compose(phrase, ""),
    compose(lw, ""),
    compose(light, ""),
  ]);
}

/** Eight cells, newest on the right: the rule in silence, speech rising from ▂ to █ against its own recent peak. */
function meterCells(
  bars: readonly number[],
  rule: (s: string) => string,
  paint: Paint,
): string {
  const fg = paint.fg;
  const toDb = (u: number) => METER_FLOOR_DB + u * METER_SPAN_DB;
  const lo = SPEECH_DBFS;
  const hi = Math.max(lo + MIN_RANGE_DB, ...bars.map(toDb));
  let out = "";
  for (let i = METER_CELLS - 1; i >= 0; i--) {
    const u = bars[i];
    const db = u === undefined ? Number.NEGATIVE_INFINITY : toDb(u);
    if (db < lo) {
      out += rule("─");
      continue;
    }
    const k = Math.round(clamp01((db - lo) / (hi - lo)) * (RISE.length - 1));
    if (paint.ascii) {
      out += k < 4 ? "=" : "#";
      continue;
    }
    const top = k === RISE.length - 1;
    // same direction rule as wetStart: the lightness runs away from the background, so a
    // short bar recedes on a light theme exactly as it does on a dark one
    const away = paint.light ? -1 : 1;
    const colour = shade(
      paint.colors.accent,
      away * (-0.22 + (0.22 * k) / (RISE.length - 1) + (top ? 0.04 : 0)),
      top ? 1.3 : 1,
    );
    out += fg(colour, RISE.charAt(k));
  }
  return out;
}
