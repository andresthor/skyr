/**
 * Voice dictation visuals. Pure: state in, ANSI rows out; no I/O, no timers.
 *
 *   renderStatus()        the one-row footer status artist: state glyph + level bars, SGR allowed
 *   createLevelHistory()  levels in at whatever rate the mic delivers, one smoothed bar per BAR_MS
 *   spliceGhost()         decorates Pi's Editor.render(): dim italic interim after the cursor, freshly
 *                         committed words born in the accent and drying to text, live rules recoloured
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
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import type { VoiceState } from "./dictation.js";

export const TICK_MS = 50;
export const DRY_MS = 300;

/** One smoothed bar cell per this many ms of recording. */
const BAR_MS = 100;

/** What the terminal can show: `mono` is NO_COLOR (glyphs and attributes, no colour), `ascii` is TERM=dumb. */
export type VoiceMode = "color" | "mono" | "ascii";

type VoiceToken = "accent" | "text" | "muted" | "dim" | "border" | "error";

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
    border: parseColor("#3f5c12"),
    error: parseColor("#cc6666"),
  },
  mode: "truecolor",
};

/** The narrow shape of Pi's Theme the palette reads; `colors` is concrete in every colour mode. */
interface ThemeLike {
  readonly colors: Readonly<Record<VoiceToken, Color>>;
  getColorMode(): TerminalColorMode;
}

/** Reads the live theme's token colours so the indicator follows theme switches. */
export function paletteFromTheme(theme: ThemeLike | undefined): VoicePalette {
  if (!theme) return FALLBACK_PALETTE;
  const { accent, text, muted, dim, border, error } = theme.colors;
  return {
    colors: { accent, text, muted, dim, border, error },
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
const RESET = "\x1b[0m";

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

const LOWER = "▁▂▃▄▅▆▇";
/** Bottom k/8 of a cell. */
const lo = (k: number) => (k >= 8 ? "█" : k <= 0 ? " " : LOWER.charAt(k - 1));
const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape bytes are exactly what the pattern must name
  /\x1b\[[\d;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07]*\x07/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/**
 * Terminal columns, erring wide: pi-tui aborts the whole render when a line exceeds
 * the terminal, so anything outside the known narrow ranges counts as two.
 */
export function cellWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      c < 0x20 ||
      (c >= 0x300 && c < 0x370) ||
      c === 0x200b ||
      (c >= 0xfe00 && c <= 0xfe0f)
    )
      continue;
    const narrow =
      c < 0x1100 ||
      (c >= 0x2000 && c <= 0x206f) ||
      (c >= 0x2190 && c <= 0x21ff) ||
      (c >= 0x2500 && c <= 0x25ff) ||
      c === 0x2713 ||
      c === 0x2717;
    w += narrow ? 1 : 2;
  }
  return w;
}

export interface LevelHistory {
  push(level: number): void;
  /** Advance one frame; returns [live, ...committed], newest first. */
  sample(dt?: number): number[];
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
    sample(dt = TICK_MS) {
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
      return [held, ...bars];
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
const MAX_BARS = 6;

export interface StatusInput {
  state: VoiceState;
  /** Smoothed 0..1 level, newest sample. */
  level: number;
  /** Previously smoothed levels, newest first (up to 6 shown). */
  levels?: readonly number[];
  /** ms since this state began — the arming pulse and the transcribing drain run on it. */
  t?: number;
  message?: string;
  palette?: VoicePalette;
  mode?: VoiceMode;
}

/** Truncates to whole visible columns, erring wide exactly like `cellWidth`. */
function truncate(text: string, max: number): string {
  let w = 0;
  let out = "";
  for (const ch of text) {
    const cw = cellWidth(ch);
    if (w + cw > max) return out;
    out += ch;
    w += cw;
  }
  return out;
}

/**
 * One row for the footer status line ("idle" → undefined, a `setStatus(key, undefined)`
 * clear). pi's footer passes SGR and truncates by width, so the row is coloured here and
 * bounded by `cellWidth` here; mono draws the same glyphs uncoloured, ascii one plain form.
 */
export function renderStatus({
  state,
  level,
  levels = [],
  t = 0,
  message = "",
  palette = FALLBACK_PALETTE,
  mode = "color",
}: StatusInput): string | undefined {
  const T = palette.colors;
  const fg = painter(palette, mode);
  const ascii = mode === "ascii";
  if (state === "idle") return undefined;
  if (state === "error") {
    const text = truncate(
      `${ascii ? "x" : "✗"} voice · ${message}`,
      ERROR_COLS,
    );
    return mode === "color"
      ? `${fg(T.error, text.slice(0, 1))}${fg(T.muted, text.slice(1))}${RESET}`
      : text;
  }
  if (ascii) return "[mic]";
  const glyph =
    state === "listening"
      ? fg(T.accent, "●")
      : state === "arming"
        ? // filled for the first 300 ms of each 600 ms cycle
          t % 600 < 300
          ? fg(T.accent, "●")
          : fg(T.muted, "·")
        : fg(T.muted, "…");
  if (state === "arming") return `${glyph}${fg(T.muted, " voice")}`;
  const drain = state === "transcribing" ? clamp01(t / 600) : 0;
  let crest = "";
  for (let i = 0; i < MAX_BARS; i++) {
    const v = clamp01(levels[i] ?? level) * (1 - drain);
    const k = 1 + Math.round(clamp01(v * 1.3) ** 1.25 * 7);
    crest += fg(k <= 1 ? T.dim : T.accent, lo(k));
  }
  return `${glyph}${crest}`;
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
    if (cellWidth(line + word) > cap && line.trim()) {
      out.push(line);
      line = word.trimStart();
      cap = rest;
    } else line += word;
    while (cellWidth(line) > cap && cap > 0) {
      const chars = [...line];
      let head = "";
      while (chars.length && cellWidth(head + chars[0]) <= cap)
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

export interface DryingSpan {
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
  /** Mic open: rules drawn in the theme's border colour. */
  live?: boolean;
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
    live = false,
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
  const top = out[topRule];
  const bottom = out[botRule];
  // both rows exist: topRule is 0 and the early return bounds botRule inside
  if (top === undefined || bottom === undefined) return out;
  if (live && mode === "color") {
    out[topRule] = fg(T.border, stripAnsi(top));
    out[botRule] = fg(T.border, stripAnsi(bottom));
  }
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
    /** The span covering distance `d` back from the cursor, or -1 for the separators between spans. */
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
    /** Paints `text` from its end leftwards, `d0` being the distance of its last character from the cursor. */
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
      out[i] = paintTail(text, d) + pad(width - cellWidth(text));
      d += Math.max(0, text.length - paddingX) + 1;
    }
  }
  const used = cellWidth(beforeText) + 1;
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
    cellWidth(beforeText) > paddingX && !/\s$/.test(beforeText) ? " " : "";
  // the editor's own layout width: with padding the cursor may overflow into it, without it one column is kept
  const layout = Math.max(1, width - 2 * paddingX - (paddingX ? 0 : 1));
  const parts = wrapWords(
    sep + g,
    Math.max(0, paddingX + layout - used),
    layout,
  );
  const first = parts[0] ?? "";
  out[ci] =
    before + CURSOR_CELL + style(first) + pad(width - used - cellWidth(first));
  const extra = parts.slice(1).map((p) => {
    const q = p.replace(/^\s+/, "");
    return pad(paddingX) + style(q) + pad(width - paddingX - cellWidth(q));
  });
  out.splice(ci + 1, 0, ...extra);
  return out;
}
