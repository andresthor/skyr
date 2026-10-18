/**
 * Voice's rule and footer rows, and the meter both draw: `renderRule()` is the editor's
 * bottom rule while voice is on (meter, mic light, state, keys), `renderStatus()` the same
 * marks as a footer row for when the editor can't carry them, and the meter's level history
 * turns mic levels in at whatever rate they arrive into one smoothed bar per BAR_MS.
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

export const TICK_MS = 50;

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

/** A status row with a message needs room; pi truncates further to the terminal's width. */
const ERROR_COLS = 60;

/** Warn this long before the hard cap, so the cap is first advisory, then fact. */
const CAP_WARN_MS = 15_000;
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
  if (s.state === "error") {
    const text = sliceByColumn(s.message, 0, ERROR_COLS - 8, true);
    return `${label} ${fg(T.error, ascii ? "x" : "✗")}${fg(T.muted, ` ${text}`)}`;
  }
  const phase = phaseOf(s);
  if (s.state === "discarded") return `${label} ${fg(T.muted, "discarded")}`;
  if (!phase) return undefined;
  const { light, word, advisories } = marks(s, phase, paint, false);
  const sep = ascii ? ", " : fg(T.dim, " · ");
  // the footer collapses runs of spaces, so silence is dim rule cells rather than padding
  const silence = (x: string) => fg(T.dim, ascii ? x.replaceAll("─", "-") : x);
  const meter =
    phase === "listening" || phase === "tail"
      ? meterCells(s.bars, silence, paint)
      : silence("─".repeat(METER_CELLS));
  return `${[`${label} ${light} ${word}`, ...advisories].join(sep)} ${meter}`;
}

/**
 * The marks both surfaces draw: the mic light, the state word and the advisories. `steady` keeps
 * the finishing ellipsis in a fixed three cells, for the rule; the footer collapses that padding.
 */
function marks(
  s: VoiceSnapshot,
  phase: Phase,
  paint: Paint,
  steady: boolean,
): { light: string; word: string; advisories: string[] } {
  const { colors: T, ascii, fg } = paint;
  const light =
    phase === "listening" || phase === "tail"
      ? ascii
        ? "[rec]"
        : fg(T.accent, "●")
      : ascii
        ? "[...]"
        : fg(T.muted, "○");
  let word = fg(
    T.muted,
    phase === "starting"
      ? "starting"
      : phase === "listening"
        ? "listening"
        : "finishing",
  );
  if (phase === "tail" || phase === "finishing") {
    // server work is a slow textual ellipsis, never motion in the meter
    const n = (Math.floor(s.stateMs / ELLIPSIS_MS) % 3) + 1;
    word += fg(T.dim, (ascii ? "." : "·").repeat(n));
    if (steady) word += " ".repeat(3 - n);
  }
  const advisories: string[] = [];
  if (phase === "starting" && s.sinceStartMs > SLOW_START_MS)
    advisories.push(fg(T.warning, "no audio yet"));
  if (s.state === "arming" && s.micOpen && s.sinceStartMs > SLOW_START_MS)
    advisories.push(fg(T.muted, "connecting"));
  // half the failure window, so "no voice yet" can never appear after the "nothing heard" failure
  if (
    phase === "listening" &&
    !s.heardSpeech &&
    s.sinceStartMs > s.noSpeechMs / 2
  )
    advisories.push(fg(T.warning, "no voice yet"));
  if (s.state === "listening" && s.capLeftMs <= CAP_WARN_MS)
    advisories.push(
      fg(T.warning, `${Math.ceil(Math.max(0, s.capLeftMs) / 1000)}s left`),
    );
  return { light, word, advisories };
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

/** The accent at a shifted OKLCH lightness, same hue: short bars recede, peaks come forward. */
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

/** Key names as Pi prints them in its own hints. */
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
  const phase = phaseOf(s);
  const line = (n: number) => rule("─".repeat(Math.max(0, n)));
  const key = (k: string, what: string) =>
    `${fg(T.dim, k)}${fg(T.muted, ` ${what}`)}`;
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

  if (s.state === "error") {
    const mark = fg(T.error, ascii ? "x" : "✗");
    const room = Math.max(0, width - 9);
    const full = s.message;
    const text =
      visibleWidth(full) <= room
        ? full
        : `${sliceByColumn(full, 0, room - 1, true)}…`;
    const cause = `${mark}${fg(T.muted, ` ${text}`)}`;
    return first([compose(cause, more ?? ""), compose(cause, "")]);
  }
  if (s.state === "discarded") {
    const notice = fg(T.muted, "discarded");
    return first([
      compose(notice, more ?? key(keys.undo, "undo")),
      compose(notice, ""),
    ]);
  }
  if (!phase) return undefined;

  const { light, word, advisories } = marks(s, phase, paint, true);

  // Enter keeps only what the server will transcribe: speech, on an accepted session
  const canKeep = s.heardSpeech && s.accepted;
  const hints =
    phase === "listening" && canKeep
      ? `${key(keys.submit, "keep")}${sep}${key(keys.cancel, "discard")}`
      : phase === "listening" || phase === "starting"
        ? key(keys.cancel, "cancel")
        : key(keys.cancel, "discard");
  const fewerHints =
    phase === "listening" && canKeep ? key(keys.cancel, "discard") : hints;

  const meter =
    phase === "listening" || phase === "tail"
      ? meterCells(s.bars, rule, paint)
      : line(METER_CELLS);
  const lw = `${light} ${word}`;
  const phrase = advisories.length ? [lw, ...advisories].join(sep) : lw;
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
    const colour = shade(
      paint.colors.accent,
      -0.22 + (0.22 * k) / (RISE.length - 1) + (top ? 0.04 : 0),
      top ? 1.3 : 1,
    );
    out += fg(colour, RISE.charAt(k));
  }
  return out;
}
