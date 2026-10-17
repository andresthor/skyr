/**
 * The presenter seam, v1 = the footer status row. Every animated row is ≤ 8 visible columns by
 * the extension's own width-erring measure, the error line truncates whole columns, and "idle"
 * exists as `setStatus(key, undefined)`, never as a permanent row.
 */
import { parseColor } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import {
  cellWidth,
  FALLBACK_PALETTE,
  renderStatus,
  stripAnsi,
} from "../src/voice/indicator.js";
import {
  statusPresenter,
  VOICE_STATUS_KEY,
  type VoiceSnapshot,
} from "../src/voice/presenter.js";

const snap = (s: Partial<VoiceSnapshot> = {}): VoiceSnapshot => ({
  state: "listening",
  level: 0.5,
  message: "",
  t: 0,
  ...s,
});

/** A second palette, as a light theme would give, so a switch is visible in the escapes. */
const LIGHT = {
  ...FALLBACK_PALETTE,
  colors: { ...FALLBACK_PALETTE.colors, accent: parseColor("#157937") },
};

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

test("animated rows stay within 8 columns; the idle state clears, never a permanent row", () => {
  const ui = new FakeStatusUi();
  const present = statusPresenter(ui);
  present.update(snap({ state: "listening", level: 1 }));
  expect(ui.last).toContain("●");
  for (const state of ["arming", "listening", "transcribing"] as const) {
    present.update(snap({ state, level: 1, t: 300 }));
    present.update(snap({ state, level: 1, t: 500 }));
    expect(cellWidth(ui.last ?? "")).toBeLessThanOrEqual(8);
  }
  present.update(snap({ state: "idle" }));
  expect(ui.last).toBeUndefined();
});

test("silent bars are hairlines, not full accent blocks", () => {
  const row = renderStatus(snap({ state: "listening", level: 0 }))!;
  // the dim colour leaves as SGR, not raw hex
  expect(row).toContain("\x1b[38;2;102;102;102m");
  expect(row).not.toContain("\x1b[38;2;184;248;24m▁");
});

test("the error line names the state and the reason, truncated by whole columns", () => {
  const row = renderStatus({
    state: "error",
    level: 0,
    message: "microphone blocked · System Settings › Privacy",
  })!;
  expect(stripAnsi(row)).toBe(
    "✗ voice · microphone blocked · System Settings › Privacy",
  );
  expect(cellWidth(row)).toBeLessThanOrEqual(60);
  expect(row.startsWith(`\x1b[38;2;204;102;102m✗`)).toBe(true);
  const long = renderStatus({
    state: "error",
    level: 0,
    message: "x".repeat(90),
  })!;
  expect(cellWidth(long)).toBeLessThanOrEqual(60);
});

test("TERM=dumb forms are plain: `[mic]` live, `x voice` for the error", () => {
  expect(renderStatus({ state: "listening", level: 1, mode: "ascii" })).toBe(
    "[mic]",
  );
  expect(renderStatus({ state: "arming", level: 0, mode: "ascii" })).toBe(
    "[mic]",
  );
  expect(
    renderStatus({
      state: "error",
      level: 0,
      message: "needs sox",
      mode: "ascii",
    }),
  ).toBe("x voice · needs sox");
});

test("the status row reads the palette afresh each frame, so it follows theme switches", () => {
  const ui = new FakeStatusUi();
  const present = statusPresenter(ui, {
    palette: () => (ui.lines.length % 2 ? LIGHT : FALLBACK_PALETTE),
  });
  present.update(snap({ state: "listening", level: 1 }));
  expect(ui.last!.startsWith("\x1b[38;2;184;248;24m●")).toBe(true);
  present.update(snap({ state: "listening", level: 1 }));
  expect(ui.last!.startsWith("\x1b[38;2;21;121;55m●")).toBe(true);
});

test("arming pulses on a ~600 ms cycle; transcribing drains the bars", () => {
  const filled = renderStatus(snap({ state: "arming", level: 0, t: 0 }))!;
  const hollow = renderStatus(snap({ state: "arming", level: 0, t: 400 }))!;
  expect(filled).toContain("●");
  expect(hollow).toContain("·");
  const full = renderStatus(snap({ state: "transcribing", level: 1, t: 0 }))!;
  const drained = renderStatus(
    snap({ state: "transcribing", level: 1, t: 2000 }),
  )!;
  expect(cellWidth(full)).toBe(7);
  expect(cellWidth(drained)).toBe(7);
  // after the drain no accent bar remains: everything dried to the dim colour
  expect(drained).toBe(
    renderStatus(snap({ state: "transcribing", level: 0, t: 2000 }))!,
  );
});

test("NO_COLOR draws the same glyphs uncoloured; a 256-colour theme never gets 24-bit escapes", () => {
  const mono = renderStatus({ state: "listening", level: 1, mode: "mono" })!;
  expect(mono).not.toContain("\x1b[");
  expect(mono).toContain("●");
  const indexed = renderStatus({
    state: "listening",
    level: 1,
    palette: { ...FALLBACK_PALETTE, mode: "256color" },
  })!;
  expect(indexed).not.toContain("\x1b[38;2;");
  expect(indexed).toContain("\x1b[38;5;");
});
