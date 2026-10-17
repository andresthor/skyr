/**
 * Voice dictation visuals. Pure: state in, ANSI rows out; no I/O, no timers.
 *
 *   renderRule()          the editor's bottom rule while voice is on: meter, mic light, state, keys
 *   renderStatus()        the same marks as a footer row, for when the editor can't carry them
 *   createLevelHistory()  levels in at whatever rate the mic delivers, one smoothed bar per BAR_MS
 *   spliceGhost()         decorates Pi's Editor.render(): dim italic interim after the cursor, freshly
 *                         committed words born in the accent and drying to text
 *
 * Every glyph is in U+2580–259F or is a width-1 symbol. Never braille.
 */
import {
  type Color,
  colorToHex,
  colorToOklch,
  foregroundAnsi,
  mixColors,
  oklchColor,
  parseColor,
  sliceByColumn,
  type TerminalColorMode,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { SPEECH_DBFS, type VoiceState } from "./dictation.js";

export const TICK_MS = 50;
export const DRY_MS = 300;

/** One smoothed bar cell per this many ms of recording. */
const BAR_MS = 100;

/** What the terminal can show: `mono` is NO_COLOR (glyphs and attributes, no colour), `ascii` is TERM=dumb. */
export type VoiceMode = "color" | "mono" | "ascii";

type VoiceToken = "accent" | "text" | "muted" | "dim" | "error" | "warning";

/** Theme colours plus the terminal's colour mode, so 256-colour terminals get 256-colour escapes. */
export interface VoicePalette {
  colors: Record<VoiceToken, Color>;
  mode: TerminalColorMode;
}

/** Corti dark token values: the palette when there is no theme to read. */
export const FALLBACK_PALETTE: VoicePalette = {
  colors: {
    accent: parseColor("#B8F818"),
    text: parseColor("#d4d4d4"),
    muted: parseColor("#808080"),
    dim: parseColor("#666666"),
    error: parseColor("#cc6666"),
    warning: parseColor("#d7af5f"),
  },
  mode: "truecolor",
};

/** The narrow shape of Pi's Theme the palette reads; `colors` is concrete in every colour mode. */
interface ThemeLike {
  readonly colors: Readonly<Record<VoiceToken, Color>>;
  getColorMode(): TerminalColorMode;
}

/** The theme's token colours and the terminal colour mode it renders in. */
export function paletteFromTheme(theme: ThemeLike | undefined): VoicePalette {
  if (!theme) return FALLBACK_PALETTE;
  const { accent, text, muted, dim, error, warning } = theme.colors;
  return {
    colors: { accent, text, muted, dim, error, warning },
    mode: theme.getColorMode(),
  };
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};
/** Colours `s` in the palette's mode; mono and ascii draw no colour at all. */
const painter =
  (P: VoicePalette, mode: VoiceMode) =>
  (c: Color, s: string): string =>
    mode === "color" ? `${foregroundAnsi(c, P.mode)}${s}\x1b[39m` : s;

/** The least perceptual distance (OKLab ΔE) between the wet start colour and the text it dries into. */
const WET_CONTRAST = 0.15;

const oklab = (c: Color): [number, number, number] => {
  const { l, c: chroma, h } = colorToOklch(c);
  const r = (h * Math.PI) / 180;
  return [l, chroma * Math.cos(r), chroma * Math.sin(r)];
};
const deltaE = (a: Color, b: Color) => {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

/**
 * The accent a commit is born in. Themes whose accent sits close to their text colour get the
 * same hue pushed brighter and more saturated until the flash can be seen.
 */
function wetStart(accent: Color, text: Color): Color {
  if (deltaE(accent, text) >= WET_CONTRAST) return accent;
  const { l, c, h } = colorToOklch(accent);
  const away = l >= colorToOklch(text).l ? 1 : -1;
  let lifted = accent;
  for (let k = 1; k <= 40 && deltaE(lifted, text) < WET_CONTRAST; k++)
    // round-trip through hex so the distance is measured on the colour a terminal can show
    lifted = parseColor(
      colorToHex(oklchColor(clamp01(l + away * 0.01 * k), c + 0.006 * k, h)),
    );
  return lifted;
}

const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape bytes are exactly what the pattern must name
  /\x1b\[[\d;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07]*\x07/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");
const graphemes = new Intl.Segmenter();

export interface LevelHistory {
  push(level: number): void;
  /** Advance `dt` ms; returns the committed bars, newest first. */
  sample(dt: number): number[];
  reset(): void;
}

/** Fast attack, quick decay, so syllables stand apart instead of merging. */
export function createLevelHistory({
  size = 48,
  attack = 0.8,
  decay = 0.5,
  barMs = BAR_MS,
} = {}): LevelHistory {
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
      cur += (pending - cur) * (pending > cur ? attack : decay);
      pending = 0;
      held = Math.max(held, cur);
      since += dt;
      if (since >= barMs) {
        since -= barMs;
        bars.unshift(held);
        if (bars.length > size) bars.length = size;
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

const pad = (n: number) => " ".repeat(Math.max(0, n));

/** A status row with a message needs room; pi truncates further to the terminal's width. */
const ERROR_COLS = 60;

/**
 * The footer row, for when the editor's rule can't carry voice: another extension owns the
 * editor, or a card hides it. The rule's marks without its key hints, led by `voice` so a
 * neighbouring status can't claim them; undefined clears the row.
 */
export function renderStatus(
  s: VoiceSnapshot,
  {
    palette = FALLBACK_PALETTE,
    mode = "color",
  }: { palette?: VoicePalette; mode?: VoiceMode } = {},
): string | undefined {
  const T = palette.colors;
  const fg = painter(palette, mode);
  const ascii = mode === "ascii";
  const label = fg(T.muted, "voice");
  if (s.state === "error") {
    const text = sliceByColumn(s.message, 0, ERROR_COLS - 8, true);
    return `${label} ${fg(T.error, ascii ? "x" : "✗")}${fg(T.muted, ` ${text}`)}`;
  }
  const phase = phaseOf(s);
  if (!phase)
    return s.discarded ? `${label} ${fg(T.muted, "discarded")}` : undefined;
  const { light, word, advisories } = marks(s, phase, palette, mode, false);
  const sep = ascii ? ", " : fg(T.dim, " · ");
  // the footer collapses runs of spaces, so silence is dim rule cells rather than padding
  const silence = (x: string) => fg(T.dim, ascii ? x.replaceAll("─", "-") : x);
  const meter =
    phase === "listening" || phase === "tail"
      ? meterCells(s.bars, silence, palette, mode)
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
  palette: VoicePalette,
  mode: VoiceMode,
  steady: boolean,
): { light: string; word: string; advisories: string[] } {
  const T = palette.colors;
  const fg = painter(palette, mode);
  const ascii = mode === "ascii";
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
    const n = (Math.floor(s.t / 300) % 3) + 1;
    word += fg(T.dim, (ascii ? "." : "·").repeat(n));
    if (steady) word += " ".repeat(3 - n);
  }
  const advisories: string[] = [];
  if (phase === "starting" && s.sinceStart > 1500)
    advisories.push(fg(T.warning, "no audio yet"));
  if (s.state === "arming" && s.micOpen && s.sinceStart > 1500)
    advisories.push(fg(T.muted, "connecting"));
  if (phase === "listening" && !s.heardSpeech && s.sinceStart > 4000)
    advisories.push(fg(T.warning, "no voice yet"));
  if (phase === "listening" && s.capLeftMs !== undefined)
    advisories.push(fg(T.warning, `${Math.ceil(s.capLeftMs / 1000)}s left`));
  return { light, word, advisories };
}

// pi-tui's fake-cursor cell exactly as a focused editor emits it at end of line:
// CURSOR_MARKER + renderFakeCursor(" "). test/voice-anchor.test.ts re-derives it from the pinned copy.
export const CURSOR_CELL = "\x1b_pi:c\x07\x1b_pi:fc\x07 \x1b_pi:/fc\x07";
const CURSOR_MARKER = "\x1b_pi:c\x07";

function wrapWords(text: string, first: number, rest: number): string[] {
  const out: string[] = [];
  let line = "";
  let cap = first;
  if (cap <= 0) {
    // no room left on the cursor row: the ghost starts on the next one
    out.push("");
    cap = rest;
    text = text.trimStart();
  }
  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;
    if (visibleWidth(line + word) > cap && line.trim()) {
      out.push(line);
      line = word.trimStart();
      cap = rest;
    } else line += word;
    while (visibleWidth(line) > cap && cap > 0) {
      // whole graphemes, so an emoji is never split from its variation selector
      const chars = Array.from(graphemes.segment(line), (g) => g.segment);
      let head = "";
      while (chars.length && visibleWidth(head + chars[0]) <= cap)
        head += chars.shift();
      if (!head) head = chars.shift() ?? "";
      out.push(head);
      line = chars.join("");
      cap = rest;
    }
  }
  if (line) out.push(line);
  return out;
}

interface DryingSpan {
  chars: number;
  lead: number;
  age: number;
}

export interface GhostInput {
  width: number;
  /** The editor's horizontal padding (`editorPaddingX`). */
  paddingX?: number;
  /** Interim text, drawn after the cursor. */
  ghost?: string;
  /**
   * Freshly committed spans, newest first. The newest ends at the cursor; each span is `chars`
   * long, `lead` characters separate it from the older one before it, and it landed `age` ms ago.
   */
  drying?: readonly DryingSpan[];
  /** Rows the editor drew under its bottom rule (the autocomplete list). */
  below?: number;
  palette?: VoicePalette;
  /** `ascii` draws no decoration at all; `mono` keeps the ghost as italic and faint text. */
  mode?: VoiceMode;
}

/**
 * Decorates Pi's `Editor.render(width)` output, which is [top rule, ...text, bottom rule,
 * ...autocomplete]; rules are found by position, so typed dashes are never mistaken for
 * one. Only the cursor-at-end-of-line layout gets a ghost, which dictation produces; if the
 * user moves the cursor mid-dictation, the ghost hides until it returns.
 */
export function spliceGhost(
  lines: string[],
  {
    width,
    paddingX = 0,
    ghost = "",
    drying = [],
    below = 0,
    palette = FALLBACK_PALETTE,
    mode = "color",
  }: GhostInput,
): string[] {
  const out = lines.slice();
  if (mode === "ascii") return out;
  const T = palette.colors;
  const fg = painter(palette, mode);
  const topRule = 0;
  const botRule = out.length - 1 - below;
  if (botRule <= topRule) return out;
  const ci = out.findIndex(
    (l, i) => i > topRule && i < botRule && l.includes(CURSOR_CELL),
  );
  if (ci < 0) return out;

  const cursorRow = out[ci];
  // findIndex found the row, so it is present; `split` always yields a first element
  let before = cursorRow?.split(CURSOR_CELL)[0] ?? "";
  const beforeText = stripAnsi(before);
  const wet = drying.filter((s) => s.chars > 0 && s.age < DRY_MS);
  if (wet.length) {
    const start = wetStart(T.accent, T.text);
    // each span dries on its own clock, so a final landing mid-dry never snaps the one before it
    const colours = wet.map((s) =>
      mixColors(start, T.text, smooth(s.age / DRY_MS), "oklch"),
    );
    // the span covering distance `d` back from the cursor, or -1 for the separators between spans
    const spanAt = (d: number): number => {
      let from = 0;
      for (const [i, s] of wet.entries()) {
        if (d >= from && d < from + s.chars) return i;
        from += s.chars + s.lead;
      }
      return -1;
    };
    const reach = wet.reduce((n, s) => n + s.chars + s.lead, 0);
    // NO_COLOR has no colour to fade, so the span is bold until it dries
    const style = (c: Color, s: string) =>
      mode === "color" ? fg(c, s) : `\x1b[1m${s}\x1b[22m`;
    // paints `text` from its end leftwards; `d0` is its last character's distance from the cursor
    const paintTail = (text: string, d0: number): string => {
      let tail = "";
      let run = "";
      let runSpan = -1;
      const flush = () => {
        const c = colours[runSpan];
        if (run) tail = (c ? style(c, run) : run) + tail;
        run = "";
      };
      let i = text.length - 1;
      for (let d = d0; i >= paddingX && d < reach; i--, d++) {
        const span = spanAt(d);
        if (span !== runSpan) {
          flush();
          runSpan = span;
        }
        run = text.charAt(i) + run;
      }
      flush();
      return text.slice(0, i + 1) + tail;
    };
    const hasMarker = before.includes(CURSOR_MARKER);
    const plain = stripAnsi(before);
    before = paintTail(plain, 0) + (hasMarker ? CURSOR_MARKER : "");
    // older spans sit on the wrapped rows above; the space eaten at each wrap counts as one
    let d = Math.max(0, plain.length - paddingX) + 1;
    for (let i = ci - 1; i > topRule && d < reach; i--) {
      const row = out[i];
      if (row === undefined) break;
      const text = stripAnsi(row).replace(/ +$/, "");
      out[i] = paintTail(text, d) + pad(width - visibleWidth(text));
      d += Math.max(0, text.length - paddingX) + 1;
    }
  }
  const used = visibleWidth(beforeText) + 1;
  if (!ghost) {
    out[ci] = before + CURSOR_CELL + pad(width - used);
    return out;
  }

  // faint carries the ghost where the theme's dim is close to its text colour, and under NO_COLOR
  const style = (s: string) => `\x1b[2m\x1b[3m${fg(T.dim, s)}\x1b[23m\x1b[22m`;
  // server text is untrusted: escape bytes must never reach the terminal, and plain text
  // lets the wrap cuts land between characters, never inside colour markup
  const g = stripAnsi(ghost).replace(/^\s+/, "");
  const sep =
    visibleWidth(beforeText) > paddingX && !/\s$/.test(beforeText) ? " " : "";
  // the editor's own layout width: with padding the cursor may overflow into it, without it one column is kept
  const layout = Math.max(1, width - 2 * paddingX - (paddingX ? 0 : 1));
  const parts = wrapWords(
    sep + g,
    Math.max(0, paddingX + layout - used),
    layout,
  );
  const first = parts[0] ?? "";
  out[ci] =
    before +
    CURSOR_CELL +
    style(first) +
    pad(width - used - visibleWidth(first));
  const extra = parts.slice(1).map((p) => {
    const q = p.replace(/^\s+/, "");
    return pad(paddingX) + style(q) + pad(width - paddingX - visibleWidth(q));
  });
  out.splice(ci + 1, 0, ...extra);
  return out;
}

/** What a voice display needs to know at one moment; the controller and editor own the facts. */
export interface VoiceSnapshot {
  state: VoiceState;
  /** ms since this state began: the finishing ellipsis steps on it. */
  t: number;
  /** ms since the dictation started: the slow-start and silence advisories wait on it. */
  sinceStart: number;
  micOpen: boolean;
  accepted: boolean;
  heardSpeech: boolean;
  /** Committed meter bars in `meterUnit`s, newest first. */
  bars: readonly number[];
  /** The error line while `state` is `error`. */
  message: string;
  /** Committed text was just reverted: offer the undo, briefly. */
  discarded?: boolean;
  /** ms left before the dictation's hard cap, while it is close. */
  capLeftMs?: number;
}

const METER_FLOOR_DB = -60;
const METER_SPAN_DB = 50;

/** A chunk's RMS as the meter's 0..1 unit: −60…−10 dBFS, so close-mic speech never clips. */
export function meterUnit(rms: number): number {
  const db = rms > 0 ? 20 * Math.log10(rms) : METER_FLOOR_DB;
  return clamp01((db - METER_FLOOR_DB) / METER_SPAN_DB);
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
  /** Text rows scrolled out below the editor; Pi's own `↓ N more` label. */
  hiddenBelow?: number;
  /** The editor's `borderColor`: Pi colours its rules by thinking level and bash mode. */
  rule: (s: string) => string;
  keys: VoiceKeys;
  palette?: VoicePalette;
  mode?: VoiceMode;
}

/**
 * The editor's bottom rule while voice is on, exactly `width` columns: the meter rises out of the
 * rule, then the mic light, the state and any advisory, and the keys that apply right now. Narrow
 * widths drop whole elements; undefined means voice has nothing to say and Pi draws its own rule.
 */
export function renderRule(
  s: VoiceSnapshot,
  {
    width,
    hiddenBelow = 0,
    rule,
    keys,
    palette = FALLBACK_PALETTE,
    mode = "color",
  }: RuleOptions,
): string | undefined {
  const T = palette.colors;
  const fg = painter(palette, mode);
  const ascii = mode === "ascii";
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
    const more = hiddenBelow > 0 ? ` ↓ ${hiddenBelow} more ` : "";
    const fill =
      more && n >= visibleWidth(more) + 2
        ? (() => {
            const a = Math.floor((n - visibleWidth(more)) / 2);
            return `${line(a)}${more}${line(n - a - visibleWidth(more))}`;
          })()
        : line(n);
    return `${head} ${fill}${tail}`;
  };
  const first = (rows: (string | undefined)[]) =>
    rows.find((r) => r !== undefined) ?? line(width);

  if (s.state === "error") {
    const mark = fg(T.error, ascii ? "x" : "✗");
    const room = Math.max(0, width - 9);
    const full = s.message;
    const text =
      visibleWidth(full) <= room
        ? full
        : `${sliceByColumn(full, 0, room - 1, true)}…`;
    return first([compose(`${mark}${fg(T.muted, ` ${text}`)}`, "")]);
  }
  if (!phase) {
    return s.discarded
      ? first([
          compose(fg(T.muted, "discarded"), key(keys.undo, "undo")),
          compose(fg(T.muted, "discarded"), ""),
        ])
      : undefined;
  }

  const { light, word, advisories } = marks(s, phase, palette, mode, true);

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
      ? meterCells(s.bars, rule, palette, mode)
      : line(METER_CELLS);
  const lw = `${light} ${word}`;
  const phrase = advisories.length ? [lw, ...advisories].join(sep) : lw;
  return first([
    compose(phrase, hints, meter),
    compose(phrase, fewerHints, meter),
    compose(phrase, "", meter),
    compose(lw, "", meter),
    compose(phrase, ""),
    compose(lw, ""),
    compose(light, ""),
  ]);
}

/** Eight cells, newest on the right: the rule in silence, speech rising from ▂ to █ against its own recent peak. */
function meterCells(
  bars: readonly number[],
  rule: (s: string) => string,
  palette: VoicePalette,
  mode: VoiceMode,
): string {
  const fg = painter(palette, mode);
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
    if (mode === "ascii") {
      out += k < 4 ? "=" : "#";
      continue;
    }
    const top = k === RISE.length - 1;
    const colour = shade(
      palette.colors.accent,
      -0.22 + (0.22 * k) / (RISE.length - 1) + (top ? 0.04 : 0),
      top ? 1.3 : 1,
    );
    out += fg(colour, RISE.charAt(k));
  }
  return out;
}
