/**
 * Fixtures shared by the voice tests: a snapshot builder, editor rows as Pi draws them, Pi's
 * own key bindings, credentials, and a fake Pi that captures what voice registers through
 * narrow local types, so a test that passes the wrong shape fails to compile.
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
  renderFakeCursor,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { type Mock, onTestFinished, vi } from "vitest";
// Pi builds its app bindings with this class but does not export it from its root
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { registerSkyr } from "../src/index.js";
import type { SttCredentials } from "../src/voice/credentials.js";
import { createVoiceEditorClass } from "../src/voice/editor.js";
import { registerVoice, type VoiceOptions } from "../src/voice/index.js";
import {
  meterUnit,
  type VoiceKeys,
  type VoiceSnapshot,
} from "../src/voice/indicator.js";
import { scratchDir } from "./session.js";

/** A real Pi editor, focused, with voice's subclass on top. */
export function realEditor() {
  const VoiceEditor = createVoiceEditorClass(CustomEditor);
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
export function keybindings(): KeybindingsManager {
  return new KeybindingsManager();
}

const atDb = (db: number) => meterUnit(10 ** (db / 20));
/** A spoken phrase: syllables between the gate and a −20 dBFS peak, newest first. */
const PHRASE = [-30, -22, -40, -26, -45, -20, -35, -28].map(atDb);

/** A listening snapshot with speech on the meter, overridden by `s`. */
export const snap = (s: Partial<VoiceSnapshot> = {}): VoiceSnapshot => ({
  state: "listening",
  stateMs: 0,
  sinceStartMs: 2_000,
  capLeftMs: 120_000,
  micOpen: true,
  accepted: true,
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

export interface ThemeStub {
  colors: Record<string, Color>;
  getColorMode(): TerminalColorMode;
}

/** The UI surface voice uses, recorded. `theme` is mutable so a test can switch it as /theme does. */
interface VoiceUi {
  notify: Mock<(message: string, type?: "info" | "warning" | "error") => void>;
  setStatus: Mock<(key: string, text: string | undefined) => void>;
  setEditorComponent: Mock<(factory: EditorFactory | undefined) => void>;
  getEditorComponent: Mock<() => unknown>;
  getEditorText: Mock<() => string>;
  setEditorText: Mock<(text: string) => void>;
  theme?: ThemeStub;
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
    theme?: ThemeStub;
    installed?: unknown;
  } = {},
): VoiceCtx {
  const mode = o.mode ?? "tui";
  return {
    mode,
    hasUI: o.hasUI ?? (mode === "tui" || mode === "rpc"),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setEditorComponent: vi.fn(),
      getEditorComponent: vi.fn(() => o.installed),
      getEditorText: vi.fn(() => ""),
      setEditorText: vi.fn(),
      theme: o.theme,
    },
  };
}

/** Builds the editor the last `setEditorComponent` installed, focused, with Pi's real bindings. */
export function mountedEditor(ui: VoiceUi): VoiceEditor {
  const factory = ui.setEditorComponent.mock.calls.at(-1)?.[0];
  if (!factory) throw new Error("voice installed no editor");
  const ed = factory(
    { requestRender: () => {}, terminal: { rows: 40 } },
    { borderColor: (s) => s, selectList: {} },
    keybindings(),
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
  };
  return { pi: pi as unknown as ExtensionAPI, captured };
}

/**
 * Voice registered directly: the seams that replace Corti and the microphone are reachable
 * only through `registerVoice`, not through `registerSkyr`. `signIns` lists the token requests
 * voice made; each is answered 503, so no token is cached from one test to the next.
 */
export function registeredVoice(
  o: VoiceOptions = {},
): Captured & { signIns: string[] } {
  const { pi, captured } = fakePi();
  const signIns: string[] = [];
  const signIn = (async (url: string) => {
    signIns.push(url);
    return new Response("unavailable", { status: 503 });
  }) as unknown as typeof fetch;
  registerVoice(pi, { fetch: signIn, ...o });
  return { ...captured, signIns };
}

/** Everything skyr registers, through the entry a host calls. */
export function registeredSkyr(): Captured {
  const { pi, captured } = fakePi();
  registerSkyr(pi);
  return captured;
}
