/**
 * Voice dictation into the input editor with Corti speech-to-text.
 *
 * Without STT credentials only `/voice` exists, to say so in one line. With them:
 * `ctrl+space` or `/voice` toggles listening, Esc cancels and restores the editor,
 * Enter stops-without-sending. Quiet never ends a dictation. Text is never auto-sent.
 *
 * The editor owns its decoration (ghost, drying spans, the bottom rule); `display.ts` keeps
 * voice on screen and routes what the editor cannot carry — a hidden editor, a foreign editor,
 * a failed rule — to the footer. The core modules render nothing.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { readSkyrSection } from "../config.js";
import { loadPi } from "../pi.js";
import { type Tier, tierOf } from "../ui/caps.js";
import type { Paint } from "../ui/palette.js";
import { quoted } from "../ui/text.js";
import { prewarmToken } from "./client.js";
import { parseVoiceSection } from "./config.js";
import { credentialsNotice, resolveSttCredentials } from "./credentials.js";
import { DictationController, type DictationDeps } from "./dictation.js";
import { createVoiceDisplay } from "./display.js";
import {
  BINDINGS,
  createVoiceEditorClass,
  editorSink,
  type VoiceEditorLike,
} from "./editor.js";

const VOICE_SHORTCUT = "ctrl+space";

/** Seams for tests; each defaults to the real thing. */
export interface VoiceDeps {
  /** What the terminal can show; read from the environment when not given. */
  mode?: Tier;
  /** The fetch the session_start token prewarm uses instead of the global one. */
  fetch?: typeof fetch;
  /** Replaces the live Corti session, the microphone and the controller's timing. */
  controller?: DictationDeps;
}

interface Tui {
  requestRender(): void;
}

/**
 * Why ctrl+space cannot start dictating right now, or undefined to proceed. Dictating into
 * a hidden editor (an approval card or selector has the keyboard) would surprise.
 */
function startRefusal(
  active: boolean,
  editor: { focused: boolean } | undefined,
): string | undefined {
  if (active) return undefined;
  if (!editor || editor.focused) return undefined;
  return `voice: a card or selector has the keyboard; close it, then press ${VOICE_SHORTCUT} again`;
}

type EditorFactory = Parameters<ExtensionUIContext["setEditorComponent"]>[0];

/**
 * Reads the STT credentials once, here: without them only `/voice` exists, to say so; with them
 * `/voice`, ctrl+space and the session_start, session_shutdown and ui_prompt_start handlers.
 * Registering starts nothing: the display starts with a TUI session, the mic with a dictation.
 */
export function registerVoice(pi: ExtensionAPI): void {
  wireVoice(pi);
}

/**
 * `registerVoice` with its test seams.
 * @internal
 */
export function wireVoice(pi: ExtensionAPI, deps: VoiceDeps = {}): void {
  const mode = deps.mode ?? tierOf(process.env);
  const resolved = resolveSttCredentials();

  if (!("creds" in resolved)) {
    const notice = credentialsNotice(resolved);
    pi.registerCommand("voice", {
      description:
        "Dictate with Corti speech-to-text (needs CORTI_* credentials)",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        // "info" only reaches the transient status line, so a registration problem is a warning
        ctx.ui.notify(notice, "warning");
      },
    });
    return;
  }
  const creds = resolved.creds;

  // The live TUI instance, handed over at mount so a repaint can be asked for; gone when the
  // session is, so a stale session never paints.
  let tui: Tui | undefined;
  // The mounted voice editor, set once Pi calls the factory; read it through ours().
  let editor: VoiceEditorLike | undefined;
  // Kept by reference, so a later mount and ours() can recognise it.
  let editorFactory: EditorFactory | undefined;
  // The session context of the last mount or toggle, for reading the buffer outside a callback;
  // no dictation starts without one (toggle sets it), so reads never race a session.
  let ctxRef: ExtensionContext | undefined;
  // What the next dictation configures Corti with: skyr.json as the last session_start read it.
  let config = parseVoiceSection(undefined).config;

  const repaint = () => tui?.requestRender();
  // Ours only while Pi still has our factory installed: an extension may replace it at any time.
  const ours = () =>
    editorFactory && ctxRef?.ui.getEditorComponent() === editorFactory
      ? editor
      : undefined;
  const sink = editorSink(
    ours,
    {
      get: () => ctxRef?.ui.getEditorText() ?? "",
      set: (t) => ctxRef?.ui.setEditorText(t),
    },
    repaint,
    // the user sent or edited the text under a foreign editor: stop rather than write past them
    () => controller.finish(),
  );

  const display = createVoiceDisplay({
    facts: () => controller.facts(),
    editor: ours,
    mode,
    repaint,
  });

  const controller = new DictationController(
    {
      creds,
      config: () => config,
      sink,
      onLevel: (dbfs) => display.level(dbfs),
      onChange: () => display.refresh(),
    },
    deps.controller,
  );

  // Esc and `/voice off`: the controller puts the buffer back and shows the undo notice itself
  const cancel = () => controller.cancel();

  const keyHook = (data: string, keys: KeybindingsManager): boolean => {
    // any key ends the undo offer: an edit after it would undo that edit, not the revert
    if (controller.state === "error" || controller.state === "discarded") {
      controller.dismiss();
      return false;
    }
    if (!controller.active) return false;
    if (
      keys.matches(data, BINDINGS.cancel) ||
      keys.matches(data, BINDINGS.clear)
    ) {
      cancel();
      return true;
    }
    if (keys.matches(data, BINDINGS.submit)) {
      // Enter ends dictation; the next Enter sends
      controller.finish();
      return true;
    }
    return false;
  };

  const toggle = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const refusal = startRefusal(controller.active, ours());
    if (refusal) {
      ctx.ui.notify(refusal, "warning");
      return;
    }
    // the buffer comes from this ctx while the dictation runs
    ctxRef = ctx;
    if (!controller.active) display.clearMeter();
    controller.toggle();
  };

  const mount = async (ctx: ExtensionContext) => {
    ctxRef = ctx;
    const installed = ctx.ui.getEditorComponent();
    // a foreign editor wins, existing fallback via setEditorText unchanged; ours or none gets (re)installed
    if (installed && installed !== editorFactory) return;
    const { CustomEditor } = await loadPi();
    // Pi's theme handle is its global theme proxy, never replaced, so /theme reaches the editor
    const paint: Paint = { theme: ctx.ui.theme, mode };
    // one class per session mount, not per editor: the hook and paint live for the session's life
    const VoiceEditor = createVoiceEditorClass(CustomEditor, {
      keyHook,
      paint,
    });
    editorFactory = (t, theme, keybindings) => {
      // Pi copies padding and autocomplete into a custom editor, but not this constructor-only flag;
      // without it the working spinner leaves the top rule for a separate row
      const ed = new VoiceEditor(t, theme, keybindings, {
        embedWorkingStatus: true,
      });
      editor = ed;
      tui = t;
      return ed;
    };
    ctx.ui.setEditorComponent(editorFactory);
  };

  pi.registerCommand("voice", {
    description: `Dictate with Corti speech-to-text (${VOICE_SHORTCUT}) · /voice off cancels`,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = args.trim();
      if (arg === "off") cancel();
      // "on" only ever starts; a bare /voice toggles like the shortcut
      else if (arg === "on") {
        if (!controller.active) toggle(ctx);
      } else if (arg === "") toggle(ctx);
      else
        ctx.ui.notify(
          `voice: ${quoted(arg, 20)} is not an option; use /voice, /voice on or /voice off`,
          "warning",
        );
    },
  });

  pi.registerShortcut(VOICE_SHORTCUT, {
    description: "Start or stop voice dictation",
    handler: async (ctx: ExtensionContext) => toggle(ctx),
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    controller.dispose();
    // a no-op after the session_shutdown Pi sends first; it matters only if one never came
    display.stop();
    // the last session's handles go
    editor = undefined;
    ctxRef = undefined;
    tui = undefined;
    const read = parseVoiceSection(await readSkyrSection("voice"));
    config = read.config;
    // once per session; a malformed section degrades to defaults, never breaks the start
    if (read.problems.length)
      ctx.ui.notify(read.problems.join("\n"), "warning");
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    await mount(ctx);
    display.start(ctx.ui);
    // a cached token makes ctrl+space feel instant
    prewarmToken(creds, { fetch: deps.fetch });
  });

  pi.on("session_shutdown", () => {
    controller.dispose();
    display.stop();
  });

  // A dialog hides the editor; a running dictation would keep listening and land its words in the
  // draft when the dialog closes
  pi.on("ui_prompt_start", () => controller.finish());
}
