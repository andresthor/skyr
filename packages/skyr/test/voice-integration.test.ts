/**
 * `registerVoice` through its public interface: registration shape, the no-credential stub,
 * the headless start (no UI mount in a UI-less mode), the config pick-up from skyr.json, and
 * the refused-start guard. A minimal fake ExtensionAPI/ExtensionContext stands in for the host;
 * this drive reaches the same public entry the resource loader reaches in
 * test/pi-contract.test.ts for the other registrars.
 */
import { parseColor } from "@earendil-works/pi-tui";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type { SessionOptions } from "../src/voice/client.js";
import type { VoiceEditorLike } from "../src/voice/editor.js";
import { VoiceError } from "../src/voice/errors.js";
import { startRefusal, VOICE_SHORTCUT, voiceMode } from "../src/voice/index.js";
import {
  agentDirWith,
  CREDS,
  mountedEditor,
  registeredVoice,
  type ThemeStub,
  voiceCtx,
  withCreds,
} from "./voice.js";

/** A theme stub where every token is one colour, so any glyph names the theme. */
const theme = (hex: string): ThemeStub => {
  const c = parseColor(hex);
  return {
    colors: {
      accent: c,
      text: c,
      muted: c,
      dim: c,
      error: c,
      warning: c,
    },
    getColorMode: () => "truecolor",
  };
};

/** A fake session that records what each dictation was started with, and how it ended. */
function recording() {
  const starts: SessionOptions[] = [];
  const ends: { stopped: number; cancelled: number }[] = [];
  const start = (o: SessionOptions) => {
    starts.push(o);
    const end = { stopped: 0, cancelled: 0 };
    ends.push(end);
    return {
      stop: () => {
        end.stopped++;
        return Promise.resolve("");
      },
      cancel: () => {
        end.cancelled++;
      },
    };
  };
  return { starts, ends, start };
}

test("without credentials only the stub /voice exists, and it says so once", async () => {
  const pi = registeredVoice({ mode: "ascii" });
  expect(pi.commands.get("voice")?.description).toContain("speech-to-text");
  expect([...pi.shortcuts.keys()]).toEqual([]);
  const ctx = voiceCtx();
  await pi.commands.get("voice")!.handler("", ctx);
  expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  expect(ctx.ui.notify.mock.calls[0]?.[0]).toContain("CORTI_CLIENT_ID");
});

test("with credentials, a headless session_start reads the config but mounts no UI", async () => {
  withCreds();
  agentDirWith('{"voice": {"frobnicate": true}}');
  const pi = registeredVoice({ mode: "ascii" });
  const ctx = voiceCtx({ mode: "json", hasUI: false });
  const { ui } = ctx;
  await pi.handlers.get("session_start")!(null, ctx);
  // the malformed key is told about once, with the key named
  expect(ui.notify).toHaveBeenCalledTimes(1);
  expect(ui.notify.mock.calls[0]?.[0]).toMatch(/unknown key "frobnicate"/);
  expect(ui.notify.mock.calls[0]?.[1]).toBe("warning");
  // headless ⇒ no editor takeover, no status row
  expect(ui.setEditorComponent).not.toHaveBeenCalled();
  expect(ui.setStatus).not.toHaveBeenCalled();
  // and the shortcut exists regardless of UI mode
  expect([...pi.shortcuts.keys()]).toEqual([VOICE_SHORTCUT]);
});

test("a tui session_start mounts no widget, starts the status cleared, and dictation picks the config up", async () => {
  const creds = withCreds();
  agentDirWith(
    '{"voice": {"language": "da", "punctuation": "spoken", "keyterms": ["Skýr"], "replacements": [{"find": "teh", "replace": "the"}]}}',
  );
  const { starts, start } = recording();
  const pi = registeredVoice({ mode: "ascii", controller: { start } });
  const ctx = voiceCtx();
  await pi.handlers.get("session_start")!(null, ctx);
  expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(1);
  // the status row starts cleared, not drawn over anything permanent
  expect(ctx.ui.setStatus).toHaveBeenCalledWith("voice", undefined);
  expect(pi.shortcuts.get(VOICE_SHORTCUT)!.description).toContain("dictation");
  // the shortcut toggles a dictation that resolves the skyr.json config
  await pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
  expect(starts).toHaveLength(1);
  const sent = starts[0]!;
  expect(sent.language).toBe("da");
  expect(sent.punctuation).toBe("spoken");
  expect(sent.interims).toBe(true);
  expect(sent.keyterms).toContain("Skýr");
  expect(sent.keyterms).toContain("TypeScript");
  expect(sent.replacements).toContainEqual({ find: "teh", replace: "the" });
  expect(sent.creds).toEqual(creds);
  expect(sent.creds.clientSecret).toBe(CREDS.clientSecret);
});

test("the voice editor keeps Pi's working status in its top rule, as Pi's own editor does", async () => {
  withCreds();
  agentDirWith();
  const pi = registeredVoice({ mode: "ascii" });
  const ctx = voiceCtx();
  await pi.handlers.get("session_start")!(null, ctx);
  expect(mountedEditor(ctx.ui).embedWorkingStatus).toBe(true);
});

test("the refused start names the fix, only when a focused editor could have dictated", () => {
  expect(
    startRefusal(true, { focused: false } as unknown as VoiceEditorLike),
  ).toBeUndefined();
  expect(startRefusal(false, undefined)).toBeUndefined();
  expect(
    startRefusal(false, { focused: true } as unknown as VoiceEditorLike),
  ).toBeUndefined();
  expect(
    startRefusal(false, { focused: false } as unknown as VoiceEditorLike),
  ).toMatch(/a card or selector has the keyboard/);
});

test("a second session_start reinstates the voice editor, and a foreign factory keeps the fallback", async () => {
  withCreds();
  agentDirWith();
  const { starts, start } = recording();
  const pi = registeredVoice({ mode: "ascii", controller: { start } });
  const ctx = voiceCtx();
  await pi.handlers.get("session_start")!(null, ctx);
  expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(1);
  // second session: ours is still the installed factory, so it is reinstated, not skipped
  await pi.handlers.get("session_start")!(null, ctx);
  expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(2);
  // and dictation still goes through the controller afterwards
  await pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
  expect(starts).toHaveLength(1);

  // a foreign editor wins: nothing of ours is installed, dictation rides setEditorText
  const foreign = voiceCtx({ installed: () => ({}) });
  await pi.handlers.get("session_start")!(null, foreign);
  expect(foreign.ui.setEditorComponent).not.toHaveBeenCalled();
});

test("a mid-session theme switch reaches the status row and the editor's ghost/firm palette", async () => {
  withCreds();
  agentDirWith();
  const { starts, start } = recording();
  const pi = registeredVoice({ mode: "color", controller: { start } });
  const ctx = voiceCtx({ theme: theme("#0a141e") });
  await pi.handlers.get("session_start")!(null, ctx);
  await pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
  const row = ctx.ui.setStatus.mock.calls.at(-1)?.[1] as string;
  expect(row.startsWith("\x1b[38;2;10;20;30m")).toBe(true);
  // the switch: the same row is rendered from the other theme on the next render
  ctx.ui.theme = theme("#c8beb4");
  starts[0]!.onReady?.();
  const switched = ctx.ui.setStatus.mock.calls.at(-1)?.[1] as string;
  expect(switched.includes("\x1b[38;2;200;190;180m")).toBe(true);
  // and the editor reads the palette through the same live theme ref
  const ed = mountedEditor(ctx.ui);
  expect(ed.palette().colors.accent).toEqual(parseColor("#c8beb4"));
});

test("TERM=dumb is ascii; NO_COLOR is mono, keeping glyphs; FORCE_COLOR wins over NO_COLOR", () => {
  expect(voiceMode({ TERM: "dumb", NO_COLOR: "1" })).toBe("ascii");
  expect(voiceMode({ TERM: "xterm-256color", NO_COLOR: "1" })).toBe("mono");
  expect(voiceMode({ NO_COLOR: "1", FORCE_COLOR: "1" })).toBe("color");
  expect(voiceMode({ NO_COLOR: "" })).toBe("color");
  expect(voiceMode({})).toBe("color");
});

test("during dictation the rule rides our focused editor, and discarding committed words offers the undo", async () => {
  withCreds();
  agentDirWith();
  const { starts, start } = recording();
  const pi = registeredVoice({ mode: "color", controller: { start } });
  const ctx = voiceCtx();
  await pi.handlers.get("session_start")!(null, ctx);
  const ed = mountedEditor(ctx.ui);
  await pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
  expect(ed.decor.rule?.state).toBe("arming");
  // the footer stays clear while the rule carries voice
  expect(
    ctx.ui.setStatus.mock.calls.every(([, row]) => row === undefined),
  ).toBe(true);
  starts[0]!.onReady?.();
  starts[0]!.onFinal?.("hello there");
  expect(ed.getText()).toBe("hello there");
  await pi.commands.get("voice")!.handler("off", ctx);
  expect(ed.getText()).toBe("");
  expect(ed.decor.rule?.discarded).toBe(true);
  // with nothing committed, a cancel offers no undo: it would undo the user's own edit
  await pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
  await pi.commands.get("voice")!.handler("off", ctx);
  expect(ed.decor.rule?.discarded).toBe(false);
});

describe("keys through the voice editor, with Pi's real bindings", () => {
  const TAIL_MS = 400;

  /** A TUI session with our editor mounted and focused, on fake timers. */
  async function mounted() {
    withCreds();
    agentDirWith();
    const rec = recording();
    const pi = registeredVoice({
      mode: "ascii",
      controller: { start: rec.start, timing: { tailMs: TAIL_MS } },
    });
    const ctx = voiceCtx();
    await pi.handlers.get("session_start")!(null, ctx);
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const ed = mountedEditor(ctx.ui);
    const submitted = vi.fn();
    const escaped = vi.fn();
    ed.onSubmit = submitted;
    ed.onEscape = escaped;
    const toggle = () => pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
    return { ...rec, ctx, ed, submitted, escaped, toggle };
  }

  test("Enter during dictation stops it and is swallowed, so the half-heard prompt is never sent", async () => {
    const h = await mounted();
    await h.toggle();
    h.starts[0]!.onReady?.();
    h.starts[0]!.onFinal("hello there");
    h.ed.handleInput("\r");
    expect(h.submitted).not.toHaveBeenCalled();
    expect(h.ed.getText()).toBe("hello there");
    expect(h.ed.decor.rule?.state).toBe("transcribing");
    await vi.advanceTimersByTimeAsync(TAIL_MS);
    expect(h.ends[0]).toEqual({ stopped: 1, cancelled: 0 });
    expect(h.ed.decor.rule?.state).toBe("idle");
    // with no dictation running, Enter is Pi's again
    h.ed.handleInput("\r");
    expect(h.submitted).toHaveBeenCalledWith("hello there");
  });

  test("Esc during dictation discards it and puts the buffer back, without reaching Pi", async () => {
    const h = await mounted();
    h.ed.setText("draft");
    await h.toggle();
    h.starts[0]!.onReady?.();
    h.starts[0]!.onFinal("spoken words");
    expect(h.ed.getText()).toBe("draft spoken words");
    h.ed.handleInput("\x1b");
    expect(h.ed.getText()).toBe("draft");
    expect(h.ends[0]).toEqual({ stopped: 0, cancelled: 1 });
    expect(h.escaped).not.toHaveBeenCalled();
    expect(h.ed.decor.rule?.discarded).toBe(true);
  });

  test("any key clears an error line and still reaches the editor", async () => {
    const h = await mounted();
    await h.toggle();
    h.starts[0]!.onError(new VoiceError("network", "connection lost"));
    expect(h.ed.decor.rule?.state).toBe("error");
    h.ed.handleInput("a");
    expect(h.ed.decor.rule?.state).toBe("idle");
    expect(h.ed.getText()).toBe("a");
  });

  test("ctrl+space while a card has the keyboard refuses to start and says how to proceed", async () => {
    const h = await mounted();
    h.ed.focused = false;
    await h.toggle();
    expect(h.starts).toHaveLength(0);
    expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/a card or selector has the keyboard — close it/),
      "warning",
    );
  });
});
