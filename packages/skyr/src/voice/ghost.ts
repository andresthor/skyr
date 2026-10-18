/**
 * The ghost decoration voice draws into Pi's editor rows: interim text after the cursor as
 * dim italic ghost, and freshly committed words born in the accent colour, drying back to
 * text over `DRY_MS`. Everything here decorates lines Pi's editor already rendered; nothing
 * draws from scratch, and only the cursor-at-end-of-line layout gets a ghost, which
 * dictation produces — the ghost hides until the cursor returns there.
 */
import {
  type Color,
  colorToHex,
  colorToOklch,
  mixColors,
  oklchColor,
  parseColor,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { sanitize } from "../tools/render.js";
import { clamp01, FALLBACK_PALETTE, type Paint, paintFor } from "./palette.js";

export const DRY_MS = 300;

const pad = (n: number) => " ".repeat(Math.max(0, n));

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

const smooth = (x: number) => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};

const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape bytes are exactly what the pattern must name
  /\x1b\[[\d;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07]*\x07/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");
const graphemes = new Intl.Segmenter();

// pi-tui's fake-cursor cell exactly as a focused editor emits it at end of line:
// CURSOR_MARKER + renderFakeCursor(" "). test/voice-ghost.test.ts re-derives it from the pinned copy.
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

interface GhostInput {
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
  paint?: Paint;
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
    paint = paintFor(FALLBACK_PALETTE, "color"),
  }: GhostInput,
): string[] {
  const out = lines.slice();
  // `ascii` (TERM=dumb) draws no decoration at all; `mono` keeps the ghost as italic faint text
  if (paint.ascii) return out;
  const { colors: T, colour, fg } = paint;
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
      colour ? fg(c, s) : `\x1b[1m${s}\x1b[22m`;
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
  // one display line: a newline would move the terminal's cursor inside a row Pi measured as one
  const g = sanitize(ghost).trimStart();
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
