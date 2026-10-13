/**
 * Voice dictation visuals. Pure: state in, ANSI rows out; no I/O, no timers.
 *
 *   renderStatus()        the one-row footer status artist: state glyph + level bars, SGR allowed
 *   createLevelHistory()  levels in at whatever rate the mic delivers, one smoothed bar per BAR_MS
 *   spliceGhost()         decorates Pi's Editor.render(): dim italic interim after the cursor, freshly
 *                         committed words born lime and drying to text, brand-green rules while live
 *
 * Every glyph is in U+2580–259F or is a width-1 symbol. Never braille.
 */
import type { VoiceState } from "./dictation.js";

export const TICK_MS = 50;
export const DRY_MS = 300;

/** One smoothed bar cell per this many ms of recording. */
const BAR_MS = 100;

export interface VoicePalette {
  accent: string;
  text: string;
  muted: string;
  dim: string;
  borderMuted: string;
  border: string;
  error: string;
}

/** corti-dark / corti-light token values; used when a theme can't be read as truecolor. */
export const PALETTES: Record<"dark" | "light", VoicePalette> = {
  dark: {
    accent: "#B8F818",
    text: "#d4d4d4",
    muted: "#808080",
    dim: "#666666",
    borderMuted: "#505050",
    border: "#3f5c12",
    error: "#cc6666",
  },
  light: {
    accent: "#157937",
    text: "#1f2328",
    muted: "#6c6c6c",
    dim: "#767676",
    borderMuted: "#b0b0b0",
    border: "#9fbf6a",
    error: "#aa5555",
  },
};

interface ThemeLike {
  name?: string;
  getFgAnsi(token: string): string;
}

/** Reads the live theme's token colours so the indicator follows theme switches. */
export function paletteFromTheme(theme: ThemeLike | undefined): VoicePalette {
  const base = theme?.name?.includes("light") ? PALETTES.light : PALETTES.dark;
  if (!theme) return base;
  const out = { ...base };
  for (const key of Object.keys(base) as (keyof VoicePalette)[]) {
    try {
      const m = /38;2;(\d+);(\d+);(\d+)m/.exec(theme.getFgAnsi(key));
      if (m)
        out[key] =
          `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
    } catch {}
  }
  return out;
}

const rgb = (h: string) =>
  [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};
function mix(a: string, b: string, k: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const u = clamp01(k);
  const to = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${to(ar + (br - ar) * u)}${to(ag + (bg - ag) * u)}${to(ab + (bb - ab) * u)}`;
}
const fg = (hex: string, s: string) => {
  const [r, g, b] = rgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
};
const RESET = "\x1b[0m";

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
  theme?: VoicePalette;
  /** TERM=dumb and friends: one plain form, no blocks, no colour. */
  ascii?: boolean;
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
 * bounded by `cellWidth` here, and an `ascii` terminal gets the same shape uncoloured.
 */
export function renderStatus({
  state,
  level,
  levels = [],
  t = 0,
  message = "",
  theme = PALETTES.dark,
  ascii = false,
}: StatusInput): string | undefined {
  const T = theme;
  if (state === "idle") return undefined;
  if (state === "error") {
    const text = truncate(
      `${ascii ? "x" : "✗"} voice · ${message}`,
      ERROR_COLS,
    );
    return ascii
      ? text
      : `${fg(T.error, text.slice(0, 1))}${fg(T.muted, text.slice(1))}${RESET}`;
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

export interface GhostInput {
  width: number;
  /** The editor's horizontal padding (`editorPaddingX`). */
  paddingX?: number;
  /** Interim text, drawn after the cursor. */
  ghost?: string;
  /** The last `chars` characters before the cursor were committed `age` ms ago. */
  firm?: { chars: number; age: number } | null;
  /** Mic open: rules drawn in the brand green. */
  live?: boolean;
  /** Rows the editor drew under its bottom rule (the autocomplete list). */
  below?: number;
  theme?: VoicePalette;
  /** TERM=dumb and friends: no decoration at all, not even the coloured rules. */
  ascii?: boolean;
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
    firm = null,
    live = false,
    below = 0,
    theme = PALETTES.dark,
    ascii = false,
  }: GhostInput,
): string[] {
  const out = lines.slice();
  if (ascii) return out;
  const T = theme;
  const topRule = 0;
  const botRule = out.length - 1 - below;
  if (botRule <= topRule) return out;
  const top = out[topRule];
  const bottom = out[botRule];
  // both rows exist: topRule is 0 and the early return bounds botRule inside
  if (top === undefined || bottom === undefined) return out;
  if (live) {
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
  if (firm && firm.chars > 0 && firm.age < DRY_MS) {
    const wet = mix(T.accent, T.text, smooth(firm.age / DRY_MS));
    const hasMarker = before.includes(CURSOR_MARKER);
    const plain = stripAnsi(before);
    const k = Math.min(firm.chars, Math.max(0, plain.length - paddingX));
    before =
      plain.slice(0, plain.length - k) +
      fg(wet, plain.slice(plain.length - k)) +
      (hasMarker ? CURSOR_MARKER : "");
    // the rest of the span sits on the wrapped rows above; the space eaten at each wrap counts as one
    let left = firm.chars - k - 1;
    for (let i = ci - 1; i > topRule && left > 0; i--) {
      const row = out[i];
      if (row === undefined) break;
      const text = stripAnsi(row).replace(/ +$/, "");
      const n = Math.min(left, Math.max(0, text.length - paddingX));
      out[i] =
        text.slice(0, text.length - n) +
        fg(wet, text.slice(text.length - n)) +
        pad(width - cellWidth(text));
      left -= n + 1;
    }
  }
  const used = cellWidth(beforeText) + 1;
  if (!ghost) {
    out[ci] = before + CURSOR_CELL + pad(width - used);
    return out;
  }

  const style = (s: string) => `\x1b[3m${fg(T.dim, s)}\x1b[23m`;
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
