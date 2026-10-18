/**
 * Voice through what it registers. Most tests call `registerVoice` on a fake Pi, because the
 * seam that replaces Corti and the microphone is reachable only there; the registerSkyr block
 * tests the entry a host calls, and one test loads skyr into a real Pi session.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { parseColor, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type { SessionOptions } from "../src/voice/client.js";
import { VoiceError } from "../src/voice/errors.js";
import { voiceMode } from "../src/voice/index.js";
import { parentSession } from "./session.js";
import {
  agentDirWith,
  CREDS,
  keybindings,
  mountedEditor,
  registeredSkyr,
  registeredVoice,
  styledRuns,
  testTheme,
  voiceCtx,
  withCreds,
} from "./voice.js";

// what voice promises Pi and the user: the key it binds and the footer status it owns
const VOICE_SHORTCUT = "ctrl+space";
const VOICE_STATUS_KEY = "skyr.voice";

/** A theme where every token is one colour, so any glyph names the theme. */
const theme = (hex: string) => {
  const c = parseColor(hex);
  return testTheme({
    colors: { accent: c, text: c, muted: c, dim: c, error: c, warning: c },
  });
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
        return Promise.resolve();
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
  expect(pi.commands.get("voice")?.description).toBe(
    "Dictate with Corti speech-to-text (needs CORTI_* credentials)",
  );
  expect([...pi.shortcuts.keys()]).toEqual([]);
  const ctx = voiceCtx();
  await pi.commands.get("voice")!.handler("", ctx);
  expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  expect(ctx.ui.notify.mock.calls[0]).toEqual([
    "voice: set CORTI_ENVIRONMENT, CORTI_TENANT_NAME, CORTI_CLIENT_ID and CORTI_CLIENT_SECRET to dictate",
    "warning",
  ]);
});

test("a set but malformed variable is named with the form it must take, in a warning", async () => {
  withCreds();
  process.env.CORTI_ENVIRONMENT = "eu.";
  onTestFinished(() => {
    process.env.CORTI_ENVIRONMENT = CREDS.environment;
  });
  const pi = registeredVoice({ mode: "ascii" });
  expect([...pi.shortcuts.keys()]).toEqual([]);
  const ctx = voiceCtx();
  await pi.commands.get("voice")!.handler("", ctx);
  expect(ctx.ui.notify.mock.calls[0]).toEqual([
    `voice: CORTI_ENVIRONMENT must be letters, digits or "-"; voice is off`,
    "warning",
  ]);
  // the value the user mistyped is never echoed
  expect(ctx.ui.notify.mock.calls[0]?.[0]).not.toContain("eu.");
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
  expect(ui.notify.mock.calls[0]?.[0]).toBe(
    "skyr.json: voice.frobnicate is not a setting; ignored (settings: language, interims, punctuation, keyterms, replacements)",
  );
  expect(ui.notify.mock.calls[0]?.[1]).toBe("warning");
  // headless ⇒ no editor takeover, no status row
  expect(ui.setEditorComponent).not.toHaveBeenCalled();
  expect(ui.setStatus).not.toHaveBeenCalled();
  // and the shortcut exists regardless of UI mode
  expect([...pi.shortcuts.keys()]).toEqual([VOICE_SHORTCUT]);
});

test("a tui session_start installs the voice editor and starts the status cleared", async () => {
  withCreds();
  agentDirWith();
  const { start } = recording();
  const pi = registeredVoice({ mode: "ascii", controller: { start } });
  const ctx = voiceCtx();
  await pi.handlers.get("session_start")!(null, ctx);
  expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(1);
  // the status row starts cleared, not drawn over anything permanent
  expect(ctx.ui.setStatus).toHaveBeenCalledWith(VOICE_STATUS_KEY, undefined);
  expect(pi.shortcuts.get(VOICE_SHORTCUT)!.description).toContain("dictation");
});

test("a dictation sends the skyr.json voice settings plus the built-in vocabulary", async () => {
  const creds = withCreds();
  agentDirWith(
    '{"voice": {"language": "da", "punctuation": "spoken", "keyterms": ["Skýr"], "replacements": [{"find": "teh", "replace": "the"}]}}',
  );
  const { starts, start } = recording();
  const pi = registeredVoice({ mode: "ascii", controller: { start } });
  const ctx = voiceCtx();
  await pi.handlers.get("session_start")!(null, ctx);
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
});

test("the voice editor keeps Pi's working status in its top rule, as Pi's own editor does", async () => {
  withCreds();
  agentDirWith();
  const pi = registeredVoice({ mode: "ascii" });
  const ctx = voiceCtx();
  await pi.handlers.get("session_start")!(null, ctx);
  expect(mountedEditor(ctx.ui).embedWorkingStatus).toBe(true);
});

test("a second session_start reinstates the voice editor while ours is the one installed", async () => {
  withCreds();
  agentDirWith();
  const { starts, start } = recording();
  const pi = registeredVoice({ mode: "ascii", controller: { start } });
  const ctx = voiceCtx();
  await pi.handlers.get("session_start")!(null, ctx);
  expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(1);
  ctx.ui.getEditorComponent.mockReturnValue(
    ctx.ui.setEditorComponent.mock.calls[0]?.[0],
  );
  await pi.handlers.get("session_start")!(null, ctx);
  expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(2);
  // and dictation still goes through the controller afterwards
  await pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
  expect(starts).toHaveLength(1);
});

test("a foreign editor keeps its place, and dictation still reaches the buffer through setEditorText", async () => {
  withCreds();
  agentDirWith();
  const { starts, start } = recording();
  const pi = registeredVoice({ mode: "ascii", controller: { start } });
  const ctx = voiceCtx({ installed: () => ({}) });
  ctx.ui.getEditorText.mockReturnValue("draft");
  await pi.handlers.get("session_start")!(null, ctx);
  expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
  await pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
  starts[0]!.onReady?.();
  starts[0]!.onFinal("hello there");
  expect(ctx.ui.setEditorText).toHaveBeenLastCalledWith("draft hello there");
});

test("an editor another extension installs after ours takes over: voice still starts, and dictation reaches it through setEditorText", async () => {
  withCreds();
  agentDirWith();
  const { starts, start } = recording();
  const pi = registeredVoice({ mode: "ascii", controller: { start } });
  const ctx = voiceCtx();
  ctx.ui.getEditorText.mockReturnValue("draft");
  await pi.handlers.get("session_start")!(null, ctx);
  const ours = mountedEditor(ctx.ui);
  // Pi focuses the newcomer, which leaves ours detached and unfocused
  ctx.ui.setEditorComponent((() => ({})) as never);
  ours.focused = false;
  await pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
  expect(ctx.ui.notify).not.toHaveBeenCalled();
  starts[0]!.onReady?.();
  starts[0]!.onFinal("hello there");
  expect(ctx.ui.setEditorText).toHaveBeenLastCalledWith("draft hello there");
});

test("skyr.json problems are told once in the TUI too, and voice still mounts", async () => {
  withCreds();
  agentDirWith('{"voice": {"language": "english"}}');
  const pi = registeredVoice({ mode: "ascii" });
  const ctx = voiceCtx();
  await pi.handlers.get("session_start")!(null, ctx);
  expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  expect(ctx.ui.notify).toHaveBeenCalledWith(
    'skyr.json: voice.language must be a locale like "en" or "en-US"; using "en"',
    "warning",
  );
  expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(1);
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
  expect(styledRuns(row)[0]?.fg).toEqual(parseColor("#0a141e"));
  // the switch: the same row is rendered from the other theme on the next render
  ctx.ui.theme = theme("#c8beb4");
  starts[0]!.onReady?.();
  const switched = ctx.ui.setStatus.mock.calls.at(-1)?.[1] as string;
  expect(styledRuns(switched)[0]?.fg).toEqual(parseColor("#c8beb4"));
  // and the editor reads the same live theme per frame, so its ghost follows the switch
  const ed = mountedEditor(ctx.ui);
  ed.ghost("theme words");
  const ghostRow = ed.render(60)[1] ?? "";
  expect(styledRuns(ghostRow)).toContainEqual(
    expect.objectContaining({ text: "theme words", fg: parseColor("#c8beb4") }),
  );
});

test.each([
  [{ TERM: "dumb" }, "ascii"],
  [{ TERM: "dumb", NO_COLOR: "1" }, "ascii"],
  [{ TERM: "xterm-256color", NO_COLOR: "1" }, "mono"],
  [{ NO_COLOR: "1", FORCE_COLOR: "1" }, "color"],
  [{ NO_COLOR: "" }, "color"],
  [{}, "color"],
] as const)("a terminal saying %j leaves voice drawing in %s", (env, mode) => {
  expect(voiceMode(env)).toBe(mode);
});

test("during dictation the rule carries voice and the footer stays clear", async () => {
  withCreds();
  agentDirWith();
  const { starts, start } = recording();
  const pi = registeredVoice({ mode: "color", controller: { start } });
  const ctx = voiceCtx();
  await pi.handlers.get("session_start")!(null, ctx);
  const ed = mountedEditor(ctx.ui);
  await pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
  expect(bottomRow(ed)).toContain("starting");
  // the footer stays clear while the rule carries voice
  expect(
    ctx.ui.setStatus.mock.calls.every(([, row]) => row === undefined),
  ).toBe(true);
  starts[0]!.onReady?.();
  starts[0]!.onFinal?.("hello there");
  expect(ed.getText()).toBe("hello there");
});

test("a discard after committed words offers the undo; after none it does not", async () => {
  withCreds();
  agentDirWith();
  const { starts, start } = recording();
  const pi = registeredVoice({ mode: "color", controller: { start } });
  const ctx = voiceCtx();
  await pi.handlers.get("session_start")!(null, ctx);
  const ed = mountedEditor(ctx.ui);
  await pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
  starts[0]!.onReady?.();
  starts[0]!.onFinal?.("hello there");
  await pi.commands.get("voice")!.handler("off", ctx);
  expect(ed.getText()).toBe("");
  expect(bottomRow(ed)).toContain("discarded");
  // with nothing committed, a cancel offers no undo: it would undo the user's own edit
  await pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
  await pi.commands.get("voice")!.handler("off", ctx);
  expect(bottomRow(ed)).toBe("─".repeat(72));
});

const TAIL_MS = 400;

/** The mounted editor's bottom row, as plain text: voice's own render when it carries the rule. */
const bottomRow = (ed: ReturnType<typeof mountedEditor>, width = 72) =>
  stripTerminalSequences(ed.render(width).at(-1) ?? "");

/** A TUI session with our editor mounted and focused, on fake timers. */
async function mounted(keys = keybindings()) {
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
  const ed = mountedEditor(ctx.ui, keys);
  const submitted = vi.fn();
  const escaped = vi.fn();
  ed.onSubmit = submitted;
  ed.onEscape = escaped;
  const toggle = () => pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
  return { ...rec, pi, ctx, ed, submitted, escaped, toggle };
}

describe("keys through the voice editor, with Pi's real bindings", () => {
  test("Enter during dictation stops it and is swallowed, so the half-heard prompt is never sent", async () => {
    const h = await mounted();
    await h.toggle();
    h.starts[0]!.onReady?.();
    h.starts[0]!.onFinal("hello there");
    h.ed.handleInput("\r");
    expect(h.submitted).not.toHaveBeenCalled();
    expect(h.ed.getText()).toBe("hello there");
    expect(bottomRow(h.ed)).toContain("finishing");
    await vi.advanceTimersByTimeAsync(TAIL_MS);
    expect(h.ends[0]).toEqual({ stopped: 1, cancelled: 0 });
    expect(bottomRow(h.ed)).toBe("─".repeat(72));
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
    expect(bottomRow(h.ed)).toContain("discarded");
    // any key ends the undo offer and still reaches the editor
    h.ed.handleInput("a");
    expect(bottomRow(h.ed)).toBe("─".repeat(72));
    expect(h.ed.getText()).toBe("drafta");
  });

  test("ctrl+c discards a dictation like Esc, rather than clearing the editor under it", async () => {
    const h = await mounted();
    await h.toggle();
    h.starts[0]!.onReady?.();
    h.starts[0]!.onFinal("spoken words");
    h.ed.handleInput("\x03");
    expect(h.ends[0]).toEqual({ stopped: 0, cancelled: 1 });
    expect(bottomRow(h.ed)).toContain("discarded");
  });

  test("cancel follows the editor's own Esc binding: rebound, the new key discards and Esc no longer does", async () => {
    const h = await mounted(keybindings({ "app.interrupt": "ctrl+g" }));
    await h.toggle();
    h.starts[0]!.onReady?.();
    h.starts[0]!.onFinal("hello there");
    h.ed.handleInput("\x1b");
    expect(h.ends[0]).toEqual({ stopped: 0, cancelled: 0 });
    h.ed.handleInput("\x07");
    expect(h.ends[0]).toEqual({ stopped: 0, cancelled: 1 });
    expect(bottomRow(h.ed)).toContain("discarded");
  });

  test("any key clears an error line and still reaches the editor", async () => {
    const h = await mounted();
    await h.toggle();
    h.starts[0]!.onError(new VoiceError("connection to Corti lost"));
    expect(bottomRow(h.ed)).toContain("connection to Corti lost");
    h.ed.handleInput("a");
    expect(bottomRow(h.ed)).toBe("─".repeat(72));
    expect(h.ed.getText()).toBe("a");
  });

  test("ctrl+space while a card has the keyboard refuses to start and says how to proceed", async () => {
    const h = await mounted();
    h.ed.focused = false;
    await h.toggle();
    expect(h.starts).toHaveLength(0);
    expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(
      "voice: a card or selector has the keyboard; close it, then press ctrl+space again",
      "warning",
    );
  });

  test("ctrl+space still stops a running dictation after a card takes the keyboard", async () => {
    const h = await mounted();
    await h.toggle();
    h.starts[0]!.onReady?.();
    h.starts[0]!.onFinal("hello there");
    h.ed.focused = false;
    await h.toggle();
    await vi.advanceTimersByTimeAsync(TAIL_MS);
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
    expect(h.ends[0]).toEqual({ stopped: 1, cancelled: 0 });
  });
});

test("session_shutdown, even twice, cancels the dictation once, clears the footer and leaves no timer", async () => {
  const h = await mounted();
  await h.toggle();
  h.starts[0]!.onReady?.();
  // a card hides our editor, so the footer is carrying voice when the session ends
  h.ed.focused = false;
  await vi.advanceTimersByTimeAsync(100);
  expect(h.ctx.ui.setStatus.mock.calls.at(-1)?.[1]).toBeDefined();
  const shutdown = h.pi.handlers.get("session_shutdown")!;
  await shutdown(null, h.ctx);
  await shutdown(null, h.ctx);
  expect(h.ends[0]).toEqual({ stopped: 0, cancelled: 1 });
  expect(h.ctx.ui.setStatus.mock.calls.at(-1)).toEqual([
    VOICE_STATUS_KEY,
    undefined,
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

test("/voice with an argument it does not take is refused, naming the valid forms", async () => {
  withCreds();
  agentDirWith();
  const { starts, start } = recording();
  const pi = registeredVoice({ mode: "ascii", controller: { start } });
  const ctx = voiceCtx();
  await pi.handlers.get("session_start")!(null, ctx);
  await pi.commands.get("voice")!.handler("frobnicate", ctx);
  expect(starts).toHaveLength(0);
  expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  expect(ctx.ui.notify.mock.calls[0]).toEqual([
    'voice: "frobnicate" is not an option; use /voice, /voice on or /voice off',
    "warning",
  ]);
  // "on" and a bare /voice start a dictation, "off" cancels it
  await pi.commands.get("voice")!.handler("on", ctx);
  expect(starts).toHaveLength(1);
  await pi.commands.get("voice")!.handler("off", ctx);
  await pi.commands.get("voice")!.handler("", ctx);
  expect(starts).toHaveLength(2);
  expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
});

test("/voice on while a dictation runs leaves it running", async () => {
  const h = await mounted();
  await h.toggle();
  h.starts[0]!.onReady?.();
  h.starts[0]!.onFinal("hello there");
  await h.pi.commands.get("voice")!.handler("on", h.ctx);
  await vi.advanceTimersByTimeAsync(TAIL_MS);
  expect(h.ends[0]).toEqual({ stopped: 0, cancelled: 0 });
  expect(h.starts).toHaveLength(1);
  expect(bottomRow(h.ed)).toContain("listening");
});

test("a new dictation starts with an empty meter, not the last one's tail", async () => {
  const h = await mounted();
  await h.toggle();
  h.starts[0]!.onReady?.();
  const fresh = bottomRow(h.ed);
  for (let i = 0; i < 4; i++) {
    h.starts[0]!.onLevel?.(-20);
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(bottomRow(h.ed)).toMatch(/[=#]/);
  await h.pi.commands.get("voice")!.handler("off", h.ctx);
  await h.toggle();
  h.starts[1]!.onReady?.();
  expect(bottomRow(h.ed)).toBe(fresh);
});

test("the command and shortcut descriptions say what they do", async () => {
  withCreds();
  agentDirWith();
  const pi = registeredVoice({ mode: "ascii" });
  expect(pi.commands.get("voice")?.description).toBe(
    "Dictate with Corti speech-to-text (ctrl+space) · /voice off cancels",
  );
  expect(pi.shortcuts.get(VOICE_SHORTCUT)?.description).toBe(
    "Start or stop voice dictation",
  );
});

const HEADLESS = (["rpc", "json", "print"] as const).flatMap((mode) =>
  [true, false].map((hasUI) => ({ mode, hasUI })),
);

test.each(HEADLESS)(
  "outside the TUI ($mode, hasUI $hasUI), /voice and ctrl+space never start the microphone",
  async ({ mode, hasUI }) => {
    withCreds();
    agentDirWith();
    const { starts, start } = recording();
    const pi = registeredVoice({ mode: "ascii", controller: { start } });
    const ctx = voiceCtx({ mode, hasUI });
    await pi.handlers.get("session_start")!(null, ctx);
    await pi.commands.get("voice")!.handler("", ctx);
    await pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
    expect(starts).toHaveLength(0);
    expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
  },
);

test("each TUI session_start asks for a token ahead of the first dictation; a headless one does not", async () => {
  withCreds();
  agentDirWith();
  const pi = registeredVoice({ mode: "ascii" });
  const start = pi.handlers.get("session_start")!;
  await start(null, voiceCtx({ mode: "json" }));
  expect(pi.signIns).toEqual([]);
  await start(null, voiceCtx());
  await start(null, voiceCtx());
  expect(pi.signIns).toHaveLength(2);
  expect(pi.signIns[0]).toMatch(/^https:\/\/auth\.test-env\.corti\.app\//);
});

describe("registerSkyr", () => {
  test("without Corti credentials it registers only /voice, to say what is missing", () => {
    const pi = registeredSkyr();
    expect(pi.commands.has("voice")).toBe(true);
    expect([...pi.shortcuts.keys()]).toEqual([]);
  });

  test("with Corti credentials it registers /voice and ctrl+space", () => {
    withCreds();
    const pi = registeredSkyr();
    expect(pi.commands.has("voice")).toBe(true);
    expect([...pi.shortcuts.keys()]).toEqual([VOICE_SHORTCUT]);
  });
});

test("in a real Pi session the shortcut is accepted without a diagnostic, and a reload runs voice's shutdown and start cleanly", async () => {
  withCreds();
  const parent = await parentSession({
    respond: () => fauxAssistantMessage("ok"),
  });
  const errors: string[] = [];
  await parent.session.bindExtensions({
    onError: (e) => errors.push(`${e.event}: ${e.error}`),
  });
  // Pi resolves extension shortcuts against its app bindings (interactive-mode.js:1715)
  const bindings = keybindings().getEffectiveConfig();
  const accepted = () => {
    const runner = parent.session.extensionRunner;
    const shortcuts = runner.getShortcuts(bindings);
    return {
      has: shortcuts.has(VOICE_SHORTCUT),
      diagnostics: runner.getShortcutDiagnostics(),
    };
  };
  expect(accepted()).toEqual({ has: true, diagnostics: [] });
  // reload runs session_shutdown on the old registration, then session_start on the new one,
  // which re-reads skyr.json and says what it found
  writeFileSync(
    join(parent.agentDir, "skyr.json"),
    '{"voice": {"frobnicate": true}}',
  );
  await parent.session.reload();
  expect(parent.notices.filter((n) => n.includes("frobnicate"))).toHaveLength(
    1,
  );
  expect(accepted()).toEqual({ has: true, diagnostics: [] });
  expect(errors).toEqual([]);
});
