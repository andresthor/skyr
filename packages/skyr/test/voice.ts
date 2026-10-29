/**
 * Fixtures shared by the voice tests: a snapshot builder, editor rows as Pi draws them, a theme
 * to draw them in and a reader for the styles they come out in, Pi's own key bindings,
 * credentials, and a fake Pi that captures what voice registers through narrow local types, so
 * a test that passes the wrong shape fails to compile.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  type Color,
  CURSOR_MARKER,
  indexedColor,
  parseColor,
  renderFakeCursor,
  rgbColor,
  stripTerminalSequences,
  styleText,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { type Mock, onTestFinished, vi } from "vitest";
// biome-ignore lint/style/noRestrictedImports: Pi builds its app bindings with this class but does not export it from its root
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { type BarKeys, createBar } from "../src/chrome/bar.js";
import { createEditorHost } from "../src/chrome/editor-host.js";
import { registerSkyr } from "../src/index.js";
import type { Tier } from "../src/ui/caps.js";
import type { Paint, ThemeLike } from "../src/ui/palette.js";
import { loaderIndicator } from "../src/ui/spinner.js";
import type { SttCredentials } from "../src/voice/credentials.js";
import {
  createVoiceEditorClass,
  type VoiceEditorOptions,
} from "../src/voice/editor.js";
import { type VoiceDeps, wireVoice } from "../src/voice/index.js";
import type { VoiceKeys, VoiceSnapshot } from "../src/voice/indicator.js";
import { scratchDir } from "./session.js";
import { fakeWorking } from "./working.js";

/** A real Pi editor, focused, with voice's subclass on top. */
export function realEditor(options: Partial<VoiceEditorOptions> = {}) {
  const VoiceEditor = createVoiceEditorClass(CustomEditor, {
    keyHook: () => false,
    paint: testPaint(),
    ...options,
  });
  const ed = new VoiceEditor(
    { terminal: { rows: 40 }, requestRender: () => {} } as never,
    { borderColor: (s: string) => s, selectList: {} } as never,
    keybindings(),
  );
  ed.focused = true;
  return ed;
}

/** The cursor cell a focused Pi editor draws at the end of a line. */
export const CURSOR_CELL = CURSOR_MARKER + renderFakeCursor(" ");

export const CREDS: SttCredentials = {
  environment: "test-env",
  tenant: "test-tenant",
  clientId: "test-id",
  clientSecret: "test-secret",
};

/** The hint names Pi's default bindings give, as the editor passes them to the rule. */
export const HINT_KEYS: VoiceKeys = {
  submit: "enter",
  cancel: "escape",
  undo: "ctrl+-",
};

/** Pi's default app key bindings, as interactive mode hands them to the editor with no keybindings.json. */
export function keybindings(
  user?: ConstructorParameters<typeof KeybindingsManager>[0],
): KeybindingsManager {
  return new KeybindingsManager(user);
}

/** A spoken phrase in dBFS: syllables between the gate and a −20 dBFS peak, newest first. */
const PHRASE = [-30, -22, -40, -26, -45, -20, -35, -28];

/** A listening snapshot with speech on the meter, overridden by `s`. */
export const snap = (s: Partial<VoiceSnapshot> = {}): VoiceSnapshot => ({
  state: "listening",
  stateMs: 0,
  sinceStartMs: 2_000,
  capLeftMs: 120_000,
  micOpen: true,
  heardSpeech: true,
  noSpeechLeftMs: 6_000,
  bars: PHRASE,
  message: "",
  ...s,
});

/**
 * The text rows of a Pi editor `width` columns wide, without its rules: each line padded to
 * the width, and the fake-cursor cell at the end of the cursor's line when focused.
 */
export function editorRows(
  text: string,
  width: number,
  { cursorLine = 0, focused = true, paddingX = 0 } = {},
): string[] {
  const pad = " ".repeat(paddingX);
  return text.split("\n").map((line, i) => {
    const cursor = focused && i === cursorLine;
    const used = paddingX + line.length + (cursor ? 1 : 0);
    return `${pad}${line}${cursor ? CURSOR_CELL : ""}${" ".repeat(Math.max(0, width - used))}`;
  });
}

const CORTI_ENV = {
  CORTI_ENVIRONMENT: "environment",
  CORTI_TENANT_NAME: "tenant",
  CORTI_CLIENT_ID: "clientId",
  CORTI_CLIENT_SECRET: "clientSecret",
} as const;

/** Sets the CORTI_* variables for this test only; test/setup.ts scrubs them otherwise. */
export function withCreds(creds: SttCredentials = CREDS): SttCredentials {
  for (const [name, field] of Object.entries(CORTI_ENV)) {
    const before = process.env[name];
    process.env[name] = creds[field];
    onTestFinished(() => {
      // assigning undefined to process.env stores the string "undefined"
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
  return creds;
}

/** An agent dir for this test, optionally holding `skyr.json`: voice reads it per session. */
export function agentDirWith(skyrJson?: string): string {
  const dir = scratchDir("agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  onTestFinished(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
  });
  if (skyrJson !== undefined) writeFileSync(join(dir, "skyr.json"), skyrJson);
  return dir;
}

/** The editor class voice installs, as its factory builds it. */
type VoiceEditor = InstanceType<ReturnType<typeof createVoiceEditorClass>>;

/** Only what these tests pass into the editor factory; Pi's own TUI and theme are far wider. */
type EditorFactory = (
  tui: { requestRender(): void; terminal: { rows: number } },
  theme: { borderColor(s: string): string; selectList: object },
  keys: KeybindingsManager,
) => VoiceEditor;

/** Corti's dark token colours: what a test draws in unless it names its own. */
const CORTI_DARK = {
  accent: parseColor("#B8F818"),
  text: parseColor("#d4d4d4"),
  muted: parseColor("#808080"),
  dim: parseColor("#666666"),
  error: parseColor("#cc6666"),
  warning: parseColor("#d7af5f"),
  success: parseColor("#8cb369"),
  toolTitle: parseColor("#d4d4d4"),
  selectedBg: parseColor("#2a2d3a"),
};

/**
 * A theme as voice reads Pi's: the Corti dark colours on a dark background, in truecolour, unless
 * overridden. It styles with pi-tui's `styleText`, as Pi's Theme does for a colour value.
 */
export function testTheme(
  o: {
    colors?: Partial<ThemeLike["colors"]>;
    appearance?: ThemeLike["appearance"];
    colorMode?: TerminalColorMode;
  } = {},
): ThemeLike {
  const colorMode = o.colorMode ?? "truecolor";
  return {
    colors: { ...CORTI_DARK, ...o.colors },
    appearance: o.appearance ?? "dark",
    style: (text, style) => styleText(text, style, colorMode),
  };
}

/** What voice draws with: `theme` on a terminal that shows `mode`. */
export const testPaint = (
  mode: Tier = "color",
  theme: ThemeLike = testTheme(),
): Paint => ({ theme, mode });

/** A stretch of rendered text and the SGR state a terminal draws it in. */
export interface StyledRun {
  text: string;
  fg?: Color;
  bold: boolean;
  dim: boolean;
  italic: boolean;
}

const PLAIN = { bold: false, dim: false, italic: false };

/**
 * `row` as a terminal shows it: its text in runs of one SGR state, in order, whatever bytes set
 * that state. Other sequences (cursor markers) carry no text and are dropped; an SGR code
 * outside fg, bold, faint and italic throws, so a new attribute can't pass unseen.
 */
export function styledRuns(row: string): StyledRun[] {
  const runs: StyledRun[] = [];
  let state: Omit<StyledRun, "text"> = PLAIN;
  const push = (raw: string) => {
    const text = stripTerminalSequences(raw);
    if (!text) return;
    const last = runs.at(-1);
    const same =
      last &&
      last.bold === state.bold &&
      last.dim === state.dim &&
      last.italic === state.italic &&
      JSON.stringify(last.fg) === JSON.stringify(state.fg);
    if (same) last.text += text;
    else runs.push({ text, ...state });
  };
  let at = 0;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences are what this reads
  for (const m of row.matchAll(/\x1b\[([\d;]*)m/g)) {
    push(row.slice(at, m.index));
    at = m.index + m[0].length;
    const p = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      const code = p[i];
      if (code === 0) state = PLAIN;
      else if (code === 1) state = { ...state, bold: true };
      else if (code === 2) state = { ...state, dim: true };
      else if (code === 3) state = { ...state, italic: true };
      else if (code === 22) state = { ...state, bold: false, dim: false };
      else if (code === 23) state = { ...state, italic: false };
      else if (code === 39) state = { ...state, fg: undefined };
      else if (code === 38 && p[i + 1] === 2) {
        state = {
          ...state,
          fg: rgbColor(p[i + 2] ?? 0, p[i + 3] ?? 0, p[i + 4] ?? 0),
        };
        i += 4;
      } else if (code === 38 && p[i + 1] === 5) {
        state = { ...state, fg: indexedColor(p[i + 2] ?? 0) };
        i += 2;
      } else
        throw new Error(
          `unexpected SGR code ${code} in ${JSON.stringify(row)}`,
        );
    }
  }
  push(row.slice(at));
  return runs;
}

/** The UI surface voice uses, recorded. `theme` is mutable so a test can switch it as /theme does. */
interface VoiceUi {
  notify: Mock<(message: string, type?: "info" | "warning" | "error") => void>;
  setStatus: Mock<(key: string, text: string | undefined) => void>;
  setEditorComponent: Mock<(factory: EditorFactory | undefined) => void>;
  getEditorComponent: Mock<() => unknown>;
  getEditorText: Mock<() => string>;
  setEditorText: Mock<(text: string) => void>;
  theme: ThemeLike;
}

interface VoiceCtx {
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  ui: VoiceUi;
}

/** A context in `mode`; TUI and RPC have a UI, json and print none, unless `hasUI` says otherwise. */
export function voiceCtx(
  o: {
    mode?: VoiceCtx["mode"];
    hasUI?: boolean;
    theme?: ThemeLike;
    installed?: unknown;
  } = {},
): VoiceCtx {
  const mode = o.mode ?? "tui";
  // like Pi, the component getter answers with whatever was installed last
  let installed = o.installed;
  // like Pi's, the theme handle is one live view: a switch reaches whoever holds it
  let theme = o.theme ?? testTheme();
  const live: ThemeLike = {
    get colors() {
      return theme.colors;
    },
    get appearance() {
      return theme.appearance;
    },
    style: (text, style) => theme.style(text, style),
  };
  return {
    mode,
    hasUI: o.hasUI ?? (mode === "tui" || mode === "rpc"),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setEditorComponent: vi.fn((factory) => {
        installed = factory;
      }),
      getEditorComponent: vi.fn(() => installed),
      getEditorText: vi.fn(() => ""),
      setEditorText: vi.fn(),
      get theme() {
        return live;
      },
      set theme(next) {
        theme = next;
      },
    },
  };
}

/** Builds the editor the last `setEditorComponent` installed, focused, with Pi's real bindings. */
export function mountedEditor(ui: VoiceUi, keys = keybindings()): VoiceEditor {
  const factory = ui.setEditorComponent.mock.calls.at(-1)?.[0];
  if (!factory) throw new Error("voice installed no editor");
  const ed = factory(
    { requestRender: () => {}, terminal: { rows: 40 } },
    { borderColor: (s) => s, selectList: {} },
    keys,
  );
  ed.focused = true;
  return ed;
}

type Command = {
  description: string;
  handler: (args: string, ctx: VoiceCtx) => Promise<void>;
};
type Shortcut = {
  description: string;
  handler: (ctx: VoiceCtx) => Promise<void>;
};
type Handler = (event: unknown, ctx: VoiceCtx) => Promise<void> | void;

/** Only what voice registers: a narrow shape keeps these tests free of Pi's generics. */
interface Captured {
  commands: Map<string, Command>;
  shortcuts: Map<string, Shortcut>;
  handlers: Map<string, Handler>;
}

/** A fake Pi that records registrations; `pi` is what a registrar is handed. */
function fakePi(): { pi: ExtensionAPI; captured: Captured } {
  const captured: Captured = {
    commands: new Map(),
    shortcuts: new Map(),
    handlers: new Map(),
  };
  const pi = {
    registerCommand: (name: string, spec: Command) =>
      captured.commands.set(name, spec),
    registerShortcut: (keys: string, spec: Shortcut) =>
      captured.shortcuts.set(keys, spec),
    on: (event: string, fn: Handler) => captured.handlers.set(event, fn),
    // registerSkyr also registers the web tools and subagent; these tests read only voice's part
    registerTool: () => {},
    registerMessageRenderer: () => {},
    registerToolRenderer: () => {},
  };
  return { pi: pi as unknown as ExtensionAPI, captured };
}

/** A session with no messages: the host replays nothing into the editor's history. */
const noEntries = { buildContextEntries: () => [] };

/**
 * Voice registered through `wireVoice`, the entry that takes the seams replacing Corti and the
 * microphone. `signIns` lists the token requests voice made; each is answered 503, so no token
 * is cached from one test to the next.
 */
export function registeredVoice(
  o: VoiceDeps & { bar?: BarKeys } = {},
): Captured & { signIns: string[] } {
  const { pi, captured } = fakePi();
  const signIns: string[] = [];
  const signIn = (async (url: string) => {
    signIns.push(url);
    return new Response("unavailable", { status: 503 });
  }) as unknown as typeof fetch;
  const host = createEditorHost({
    working: fakeWorking(),
    bar: o.bar ?? createBar(),
    mode: o.mode,
    ownFrames: () => loaderIndicator(testPaint(o.mode)).frames ?? [],
  });
  wireVoice(pi, host, { fetch: signIn, ...o });
  // Pi runs the chrome's mount and then voice's handler, each awaited; one fake handler composes them
  const voiceStart = captured.handlers.get("session_start");
  captured.handlers.set("session_start", async (e, ctx) => {
    if (ctx.mode === "tui" && ctx.hasUI)
      await host.mount(
        { ui: ctx.ui, sessionManager: noEntries, isIdle: () => true } as never,
        (e as { reason?: "startup" } | null)?.reason ?? "startup",
      );
    await voiceStart?.(e, ctx);
  });
  return { ...captured, signIns };
}

/** Everything skyr registers, through the entry a host calls. */
export function registeredSkyr(): Captured {
  const { pi, captured } = fakePi();
  registerSkyr(pi);
  return captured;
}
