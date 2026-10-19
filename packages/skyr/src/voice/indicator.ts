/**
 * What voice shows of a dictation: `renderRule()` for the editor's bottom rule while voice is
 * on, `renderStatus()` for the footer row when the editor can't carry it, and the level history
 * that turns mic levels in at whatever rate they arrive into one smoothed bar per BAR_MS. All
 * wording is decided once in `voiceView()`, and every mark the two displays share is drawn once,
 * in `marks()`.
 *
 * Every glyph is in U+2580–259F or is a width-1 symbol. Never braille.
 */
import {
  type Color,
  colorToOklch,
  oklchColor,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { cutToWidth } from "../tools/render.js";
import { type DictationFacts, SPEECH_DBFS } from "./dictation.js";
import { clamp01, type Paint, styled } from "./palette.js";

/** One smoothed bar cell per this many ms of recording. */
const BAR_MS = 100;
/** Bars kept: 4.8 s, the window the meter auto-ranges its peak over. */
const HISTORY_BARS = 48;
/** The share of the gap to the newest level closed per tick, rising and falling. */
const ATTACK = 0.8;
const DECAY = 0.5;
/** The meter holds levels within −60…−10 dBFS, so close-mic speech never clips. */
const METER_FLOOR_DB = -60;
const METER_CEILING_DB = -10;

interface LevelHistory {
  /** A chunk's level in dBFS, held within the meter's range. */
  push(dbfs: number): void;
  /** Advance `dt` ms; returns the committed bars, newest first. */
  sample(dt: number): number[];
  reset(): void;
}

/** Fast attack, quick decay, so syllables stand apart instead of merging. */
export function createLevelHistory(): LevelHistory {
  const bars: number[] = [];
  let pending = METER_FLOOR_DB;
  let cur = METER_FLOOR_DB;
  let held = METER_FLOOR_DB;
  let since = 0;
  return {
    push(dbfs) {
      pending = Math.max(pending, Math.min(METER_CEILING_DB, dbfs));
    },
    sample(dt) {
      cur += (pending - cur) * (pending > cur ? ATTACK : DECAY);
      pending = METER_FLOOR_DB;
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
      pending = METER_FLOOR_DB;
      cur = METER_FLOOR_DB;
      held = METER_FLOOR_DB;
      since = 0;
    },
  };
}

/** The footer's whole error row: the `voice ✗` prefix plus the message;
 * pi truncates further to the terminal's width. */
const ERROR_COLS = 60;

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
  { paint }: { paint: Paint },
): string | undefined {
  const T = paint.theme.colors;
  const ascii = paint.mode === "ascii";
  const fg = (c: Color, text: string) => styled(paint, text, { fg: c });
  const label = fg(T.muted, "voice");
  const m = marks(paint);
  const view = voiceView(s);
  if (view.kind === "error") {
    const prefix = visibleWidth(`${label} ${m.cause("")}`);
    return `${label} ${m.cause(m.cut(view.message, ERROR_COLS - prefix))}`;
  }
  if (view.kind === "off") return undefined;
  if (view.kind === "discarded") return `${label} ${m.discarded}`;
  // the footer collapses runs of spaces, so silence is dim rule cells rather than padding
  const silence = (x: string) => fg(T.dim, ascii ? x.replaceAll("─", "-") : x);
  const meter = view.recording
    ? meterCells(s.bars, silence, paint)
    : silence("─".repeat(METER_CELLS));
  const lw = `${label} ${m.light(view)} ${m.word(view)}`;
  return `${[lw, ...m.advisories(view)].join(m.sep)} ${meter}`;
}

/** An advisory line: `tone` picks the theme colour it draws in. */
interface Advisory {
  text: string;
  tone: "warning" | "muted";
}

/** What voice can say about one moment, with every wording decision made: no ANSI, no layout. */
type VoiceView =
  | { kind: "off" }
  | { kind: "error"; message: string }
  | { kind: "discarded" }
  | LiveView;

interface LiveView {
  kind: "live";
  /** The mic is open: the light stays on through the tail after Enter. */
  recording: boolean;
  word: "starting" | "listening" | "finishing";
  /** Steps of the finishing ellipsis: server work, never motion in the meter. */
  dots: 0 | 1 | 2 | 3;
  /** What the bound keys would do right now. */
  offer: "keep" | "cancel" | "discard";
  advisories: Advisory[];
}

/** The view's marks as both displays draw them: the same glyphs, words and colours on each. */
function marks(paint: Paint) {
  const T = paint.theme.colors;
  const ascii = paint.mode === "ascii";
  const fg = (c: Color, text: string) => styled(paint, text, { fg: c });
  const ellipsis = ascii ? "..." : "…";
  return {
    sep: ascii ? ", " : fg(T.dim, " · "),
    cut: (text: string, cols: number) => cutToWidth(text, cols, ellipsis),
    discarded: fg(T.muted, "discarded"),
    /** The error mark, then `text`: the error's message, clipped to the display's room. */
    cause: (text: string) =>
      `${fg(T.error, ascii ? "x" : "✗")}${fg(T.muted, ` ${text}`)}`,
    light: (v: LiveView) =>
      v.recording
        ? ascii
          ? "[rec]"
          : fg(T.accent, "●")
        : ascii
          ? "[...]"
          : fg(T.muted, "○"),
    /** The word and its ellipsis, without the rule's padding: the footer collapses runs of spaces. */
    word: (v: LiveView) =>
      fg(T.muted, v.word) +
      (v.dots ? fg(T.dim, (ascii ? "." : "·").repeat(v.dots)) : ""),
    advisories: (v: LiveView) => v.advisories.map((a) => fg(T[a.tone], a.text)),
  };
}

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
  /** Committed meter bars in dBFS, newest first. */
  bars: readonly number[];
};

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
  hiddenBelow: number;
  /** The editor's `borderColor`: Pi colours its rules by thinking level and bash mode. */
  rule: (s: string) => string;
  keys: VoiceKeys;
  paint: Paint;
}

/**
 * The editor's bottom rule while voice is on, exactly `width` columns: the meter rises out of the
 * rule, then the mic light, the state and any advisory, and the keys that apply right now. Narrow
 * widths drop whole elements: hints, meter, advisories, word, light. Undefined means voice has
 * nothing to say or nothing fits, and Pi draws its own rule.
 */
export function renderRule(
  s: VoiceSnapshot,
  { width, hiddenBelow, rule, keys, paint }: RuleOptions,
): string | undefined {
  const T = paint.theme.colors;
  const fg = (c: Color, text: string) => styled(paint, text, { fg: c });
  const m = marks(paint);
  const view = voiceView(s);
  const line = (n: number) => rule("─".repeat(Math.max(0, n)));
  const key = (k: string, what: string) =>
    k ? `${fg(T.dim, k)}${fg(T.muted, ` ${what}`)}` : "";

  // the ends of `── left ──…── right ──`, and the rule cells left between them at this width
  const ends = (left: string, right: string, meter = "") => {
    const head = meter
      ? `${line(2)}${meter}${line(1)} ${left}`
      : `${line(2)} ${left}`;
    const tail = right ? ` ${right} ${line(2)}` : line(2);
    return {
      head,
      tail,
      fill: width - visibleWidth(head) - visibleWidth(tail) - 1,
    };
  };
  // the whole row, or undefined when not one rule cell fits between the ends
  const compose = (left: string, right: string, meter = "") => {
    const { head, tail, fill } = ends(left, right, meter);
    if (fill < 1) return undefined;
    return `${head} ${line(fill)}${tail}`;
  };
  const first = (rows: (string | undefined)[]) =>
    rows.find((r) => r !== undefined);
  const more = hiddenBelow > 0 ? rule(`↓ ${hiddenBelow} more`) : undefined;

  if (view.kind === "error") {
    // the columns a message may take, keeping one rule cell
    const cause = m.cause(m.cut(view.message, ends(m.cause(""), "").fill - 1));
    return first([compose(cause, more ?? ""), compose(cause, "")]);
  }
  if (view.kind === "discarded")
    return first([
      compose(m.discarded, more ?? key(keys.undo, "undo")),
      compose(m.discarded, ""),
    ]);
  if (view.kind === "off") return undefined;

  const light = m.light(view);
  // the ellipsis keeps a fixed three cells on the rule, so the row never shifts under it
  const word = m.word(view) + (view.dots ? " ".repeat(3 - view.dots) : "");
  const advisories = m.advisories(view);
  const lw = `${light} ${word}`;
  const phrase = advisories.length ? [lw, ...advisories].join(m.sep) : lw;

  // an unbound id draws no hint at all: the rule never names a key that isn't there
  const hints =
    view.offer === "keep"
      ? [key(keys.submit, "keep"), key(keys.cancel, "discard")]
          .filter(Boolean)
          .join(m.sep)
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
  const lo = SPEECH_DBFS;
  const hi = Math.max(lo + MIN_RANGE_DB, ...bars);
  let out = "";
  for (let i = METER_CELLS - 1; i >= 0; i--) {
    const db = bars[i] ?? Number.NEGATIVE_INFINITY;
    if (db < lo) {
      out += rule("─");
      continue;
    }
    const k = Math.round(clamp01((db - lo) / (hi - lo)) * (RISE.length - 1));
    if (paint.mode === "ascii") {
      out += k < 4 ? "=" : "#";
      continue;
    }
    const top = k === RISE.length - 1;
    // same direction rule as wetStart: the lightness runs away from the background, so a
    // short bar recedes on a light theme exactly as it does on a dark one
    const away = paint.theme.appearance === "light" ? -1 : 1;
    const colour = shade(
      paint.theme.colors.accent,
      away * (-0.22 + (0.22 * k) / (RISE.length - 1) + (top ? 0.04 : 0)),
      top ? 1.3 : 1,
    );
    out += styled(paint, RISE.charAt(k), { fg: colour });
  }
  return out;
}
