// The working line above the editor's top rule, on Pi's real editor and Pi's real status
// indicators.
import {
  CustomEditor,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  parseColor,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { withWorkingLine } from "../src/chrome/editor.js";
import { createWorking, type Working } from "../src/chrome/working.js";
import type { Paint } from "../src/ui/palette.js";
import { loaderIndicator } from "../src/ui/spinner.js";
import { createVoiceEditorClass } from "../src/voice/editor.js";
import { CORPUS, piScreen, realIndicator, WIDTHS_SWEEP } from "./ui.js";
import {
  agentDirWith,
  keybindings,
  mountedEditor,
  registeredVoice,
  styledRuns,
  testPaint,
  testTheme,
  voiceCtx,
  withCreds,
} from "./voice.js";

const START = 1_000_000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the property under test
const CONTROL = /[\u0000-\u001f\u007f\u202e\u200b]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the one escape the line may carry
const SGR = /\x1b\[[\d;]*m/g;

beforeEach(() => {
  // Date and the indicators' own interval only: voice's session start awaits real file reads
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

type EditorClass<E extends CustomEditor> = new (
  ...args: ConstructorParameters<typeof CustomEditor>
) => E;

interface LineOptions {
  working?: Working;
  notify?: ExtensionUIContext["notify"];
  paint?: Paint;
  rows?: number;
  paddingX?: number;
}

/** An editor wrapped in the working line, built as Pi builds a custom editor: embedding the working status. */
function lineEditor<E extends CustomEditor>(
  Base: EditorClass<E>,
  {
    working = createWorking(),
    notify = vi.fn(),
    paint = testPaint(),
    rows = 40,
    paddingX = 0,
  }: LineOptions = {},
) {
  const Editor = withWorkingLine(Base, { paint, working, notify });
  const ed = new Editor(
    { terminal: { rows }, requestRender: () => {} } as never,
    { borderColor: (s: string) => s, selectList: {} } as never,
    keybindings(),
    { embedWorkingStatus: true, paddingX },
  );
  ed.focused = true;
  return ed;
}

const plain = (rows: string[]) => rows.map(stripTerminalSequences);

/** The working indicator as skyr gives it to Pi, which is what the line draws for. */
const skyrIndicator = (message = "Working", paint = testPaint()) =>
  realIndicator("working", message, { indicator: loaderIndicator(paint) });

/** A run of the main agent that began `ago` ms ago. */
function runningFor(ago: number) {
  const working = createWorking();
  working.agentStart();
  vi.advanceTimersByTime(ago);
  return working;
}

test("with a working indicator a line above the top rule shows the glyph, Pi's message, the elapsed time and the interrupt key, and the top rule is plain", () => {
  const working = createWorking();
  working.agentStart();
  const ed = lineEditor(CustomEditor, { working, paddingX: 1 });
  ed.setWorkingStatusIndicator(skyrIndicator());
  vi.advanceTimersByTime(12_000);

  const rows = plain(ed.render(60));
  expect(rows[0]).toBe(" ✦ Working  (12s · escape interrupt)");
  expect(rows[1]).toBe("─".repeat(60));
});

test("retry, compaction and branch-summary indicators draw Pi's own text after skyr's glyph, with no elapsed time of skyr's", () => {
  const paint = testPaint();
  const { warning, accent, text } = paint.theme.colors;
  const cases = [
    [
      "retry",
      "Retrying (2/5) in 4s... (escape to cancel)",
      "✸",
      warning,
      warning,
    ],
    ["compaction", "Auto-compacting... (escape to cancel)", "✸", accent, text],
    [
      "branchSummary",
      "Summarizing branch... (escape to cancel)",
      "✸",
      accent,
      text,
    ],
  ] as const;
  for (const [kind, message, glyph, glyphColour, textColour] of cases) {
    const working = runningFor(9_000);
    const ed = lineEditor(CustomEditor, { working, paint, paddingX: 1 });
    ed.setWorkingStatusIndicator(realIndicator(kind, message));
    vi.advanceTimersByTime(3_000);

    const [line = ""] = ed.render(80);
    expect(stripTerminalSequences(line)).toBe(` ${glyph} ${message}`);
    const colourOf = (part: string) =>
      styledRuns(line).find((run) => run.text.includes(part))?.fg;
    expect(colourOf(glyph)).toEqual(glyphColour);
    expect(colourOf(message)).toEqual(textColour);
  }
});

test("without an indicator the editor renders exactly as the editor it wraps", () => {
  const wrapped = lineEditor(CustomEditor, { paddingX: 1 });
  const bare = lineEditor(CustomEditor, { paddingX: 1 });
  wrapped.setText("hello");
  bare.setText("hello");
  expect(wrapped.render(40)).toEqual(bare.render(40));
  wrapped.setWorkingStatusIndicator(skyrIndicator());
  wrapped.setWorkingStatusIndicator(undefined);
  expect(wrapped.render(40)).toEqual(bare.render(40));
});

test("the voice ghost text lands on the cursor row with the line present", () => {
  const Voice = createVoiceEditorClass(CustomEditor, {
    keyHook: () => false,
    paint: testPaint(),
  });
  const ed = lineEditor(Voice);
  ed.setText("hi");
  ed.ghost(" there");
  const without = ed.render(60);
  ed.setWorkingStatusIndicator(skyrIndicator());
  const rows = ed.render(60);

  expect(rows.slice(1)).toEqual(without);
  expect(plain(rows)[2]).toContain("there");
});

test("while dictation holds the interrupt key the line does not name it", () => {
  let dictating = true;
  const Voice = createVoiceEditorClass(CustomEditor, {
    keyHook: () => false,
    paint: testPaint(),
    dictating: () => dictating,
  });
  const working = createWorking();
  working.agentStart();
  const ed = lineEditor(Voice, { working, paddingX: 1 });
  ed.setWorkingStatusIndicator(skyrIndicator());
  expect(plain(ed.render(60))[0]).toBe(" · Working  (0s)");
  dictating = false;
  expect(plain(ed.render(60))[0]).toContain("escape interrupt");
});

test("the cursor marker appears once, on the content row", () => {
  const ed = lineEditor(CustomEditor);
  ed.setWorkingStatusIndicator(skyrIndicator());
  const rows = ed.render(60);
  const marked = rows.flatMap((row, i) =>
    row.includes(CURSOR_MARKER) ? [i] : [],
  );
  expect(marked).toEqual([2]);
});

test("a throw while drawing the line puts Pi's status back in the top rule on that frame, the line is not tried again, and the user is told once", async () => {
  const state = vi.fn(() => {
    throw new Error("state unreadable");
  });
  const notify = vi.fn();
  const ed = lineEditor(CustomEditor, { working: { state }, notify });
  ed.setWorkingStatusIndicator(skyrIndicator());

  for (let frame = 0; frame < 3; frame++) {
    const rows = plain(ed.render(60));
    // rule, one content row, bottom rule: no line, and Pi's status in the rule
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Working");
  }
  expect(state).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(notify).toHaveBeenCalledTimes(1);
  const [message, level] = notify.mock.calls[0] ?? [];
  expect(message).toContain("state unreadable");
  expect(message).toContain("/reload brings it back");
  expect(level).toBe("warning");
});

test("an indicator another extension set, or one with a single frame, is left to Pi's top rule", () => {
  for (const frames of [["x", "y"], ["•"]]) {
    const ed = lineEditor(CustomEditor);
    ed.setWorkingStatusIndicator(
      realIndicator("working", "Working", { indicator: { frames } }),
    );
    const rows = plain(ed.render(60));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Working");
  }
});

test("the line follows a theme switch", () => {
  const ctx = voiceCtx();
  const paint = testPaint("color", ctx.ui.theme);
  const ed = lineEditor(CustomEditor, { paint });
  ed.setWorkingStatusIndicator(skyrIndicator());
  const glyphColour = () =>
    styledRuns(ed.render(60)[0] ?? "").find((run) => run.text === "·")?.fg;
  expect(glyphColour()).toEqual(paint.theme.colors.accent);
  const red = parseColor("#ff0000");
  ctx.ui.theme = testTheme({ colors: { accent: red } });
  expect(glyphColour()).toEqual(red);
});

test("an indicator whose border text does not start with its spinner is left to Pi's top rule", () => {
  const ed = lineEditor(CustomEditor);
  ed.setWorkingStatusIndicator(
    realIndicator("working", "Working", { indicator: { frames: [] } }),
  );
  const rows = plain(ed.render(60));
  expect(rows).toHaveLength(3);
  expect(rows[0]).toContain("Working");
});

test("a terminal under 12 rows gets Pi's in-border status instead of the line", () => {
  const indicator = skyrIndicator();
  const short = lineEditor(CustomEditor, { rows: 11 });
  short.setWorkingStatusIndicator(indicator);
  const shortRows = plain(short.render(60));
  expect(shortRows).toHaveLength(3);
  expect(shortRows[0]).toContain("Working");

  const tall = lineEditor(CustomEditor, { rows: 12 });
  tall.setWorkingStatusIndicator(indicator);
  expect(tall.render(60)).toHaveLength(4);
});

test("a click on the first content row lands there with the line present, and a click on the line is absorbed", () => {
  const ed = lineEditor(CustomEditor);
  ed.setText("abcdef");
  ed.setWorkingStatusIndicator(skyrIndicator());
  ed.render(40);
  const click = (x: number, y: number) =>
    ed.handleMouse({
      type: "click",
      button: "left",
      x,
      y,
      screenX: x,
      screenY: y,
      width: 40,
      height: 4,
      shift: false,
      alt: false,
      ctrl: false,
    });

  click(3, 2);
  expect(ed.getCursor()).toEqual({ line: 0, col: 3 });
  expect(click(1, 0)).toEqual({ handled: true, focus: true });
  expect(ed.getCursor()).toEqual({ line: 0, col: 3 });
});

test("an editor built mid-run and handed a live indicator draws the line at once", () => {
  const working = runningFor(30_000);
  const ed = lineEditor(CustomEditor, { working });
  ed.setWorkingStatusIndicator(skyrIndicator());
  expect(plain(ed.render(60))[0]).toMatch(/Working {2}\(30s · /);
});

test("the elapsed time counts from agent_start and reads 1m04s after 64 seconds", () => {
  const working = runningFor(64_000);
  const ed = lineEditor(CustomEditor, { working });
  // The indicator arrives later than the run began: its own age must not be what is counted
  ed.setWorkingStatusIndicator(skyrIndicator());
  expect(plain(ed.render(60))[0]).toContain("(1m04s · ");
});

test("the line fits every width 0-200 with a hostile working message, and carries none of its escapes", () => {
  const working = createWorking();
  working.agentStart();
  const ed = lineEditor(CustomEditor, { working, paddingX: 1 });
  const bare = lineEditor(CustomEditor, { paddingX: 1 });
  const indicators = CORPUS.map((message) => skyrIndicator(message));
  for (const indicator of indicators) {
    ed.setWorkingStatusIndicator(indicator);
    for (const width of WIDTHS_SWEEP) {
      const rows = ed.render(width);
      const bareRows = bare.render(width).length;
      if (rows.length !== bareRows + 1) {
        // Only a zero-width pane has no room for the line
        expect([width, rows.length]).toEqual([0, bareRows]);
        continue;
      }
      const [line = ""] = rows;
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(stripTerminalSequences(line)).not.toMatch(CONTROL);
      expect(line.replace(SGR, "")).not.toMatch(CONTROL);
    }
  }
});

test("the ascii tier draws the line in plain ASCII with no escape", () => {
  const working = createWorking();
  working.agentStart();
  const ed = lineEditor(CustomEditor, {
    working,
    paint: testPaint("ascii"),
    paddingX: 1,
  });
  ed.setWorkingStatusIndicator(skyrIndicator("Working", testPaint("ascii")));
  vi.advanceTimersByTime(12_000);
  const [line = ""] = ed.render(60);
  expect(line).toBe(" | Working  (12s - escape interrupt)");
});

test("the editor starts no timer: rendering it adds none beyond the indicator's own", () => {
  const ed = lineEditor(CustomEditor);
  ed.setWorkingStatusIndicator(skyrIndicator());
  const timers = vi.getTimerCount();
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  for (let i = 0; i < 20; i++) {
    ed.render(60);
    vi.advanceTimersByTime(80);
  }
  expect(vi.getTimerCount()).toBe(timers);
  expect(setTimeoutSpy).not.toHaveBeenCalled();
  expect(setIntervalSpy).not.toHaveBeenCalled();
});

test("the editor with its line never crashes Pi's renderer at 20, 40 and 86 columns", () => {
  const working = createWorking();
  working.agentStart();
  working.toolStart("a", "bash", { command: `${CORPUS[1]} ${CORPUS[14]}` });
  const ed = lineEditor(CustomEditor, { working, paddingX: 1 });
  ed.setText(CORPUS[1] ?? "");
  ed.setWorkingStatusIndicator(skyrIndicator(CORPUS[1]));
  for (const width of [20, 40, 86]) {
    const { firstFrameCrash, crash } = piScreen(ed, width);
    expect(firstFrameCrash).toBeUndefined();
    expect(crash).toBeUndefined();
  }
});

test("voice's mounted editor carries the working line", async () => {
  withCreds();
  agentDirWith();
  const voice = registeredVoice({ mode: "color" });
  const ctx = voiceCtx();
  await voice.handlers.get("session_start")?.(null, ctx);
  const ed = mountedEditor(ctx.ui);
  ed.setWorkingStatusIndicator(skyrIndicator());

  const rows = plain(ed.render(60));
  expect(rows[0]).toMatch(/^[·✧✦] Working {2}\(/);
  expect(rows[1]).toBe("─".repeat(60));
});

test("under TERM=dumb a long action reaches the screen as printable ASCII", () => {
  const working = createWorking();
  working.agentStart();
  working.toolStart("a", "bash", { command: "a".repeat(400) });
  const ed = lineEditor(CustomEditor, { working, paint: testPaint("ascii") });
  ed.setWorkingStatusIndicator(skyrIndicator("Working", testPaint("ascii")));
  for (const width of [40, 100, 200])
    expect(ed.render(width)[0]).toMatch(/^[\x20-\x7e]*$/);
});
