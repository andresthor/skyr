/**
 * Voice dictation into the input editor with Corti speech-to-text.
 *
 * Without STT credentials only `/voice` exists, to say so in one line. With them:
 * `ctrl+space` or `/voice` toggles listening, Esc cancels and restores the editor,
 * Enter stops-without-sending. Quiet never ends a dictation. Text is never auto-sent.
 *
 * The editor owns its decoration (ghost, drying spans, the bottom rule); `presenter.ts`
 * routes what it cannot carry — a hidden editor, a foreign editor, a failed rule — to the
 * footer. The core modules render nothing.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { readSkyrFile } from "../config.js";
import { loadPi } from "../pi.js";
import { prewarmToken } from "./client.js";
import {
  mergeVocabulary,
  parseVoiceSection,
  type VoiceConfig,
} from "./config.js";
import { resolveSttCredentials } from "./credentials.js";
import {
  DictationController,
  type DictationControllerOptions,
} from "./dictation.js";
import {
  BINDINGS,
  createVoiceEditorClass,
  editorSink,
  type VoiceEditorLike,
} from "./editor.js";
import { credentialsNotice, startBlocked, unknownVoiceArg } from "./errors.js";
import {
  createLevelHistory,
  meterUnit,
  TICK_MS,
  type VoiceSnapshot,
} from "./indicator.js";
import { paintFor, type VoiceMode } from "./palette.js";
import { type VoicePresenter, voicePresenter } from "./presenter.js";

export const VOICE_SHORTCUT = "ctrl+space";

export interface VoiceOptions {
  /** What the terminal can show; read from the environment when not given. */
  mode?: VoiceMode;
  /** Test seam: the fetch the session_start token prewarm uses instead of the global one. */
  fetch?: typeof fetch;
  /** Test seam: replaces the live Corti session and microphone. */
  controller?: Partial<
    Pick<DictationControllerOptions, "start" | "source" | "timing">
  >;
}

interface Tui {
  requestRender(): void;
}

/** TERM=dumb gets ASCII; NO_COLOR forbids colour, not glyphs or italics, unless FORCE_COLOR overrides it. */
export function voiceMode(env: NodeJS.ProcessEnv): VoiceMode {
  if (env.TERM === "dumb") return "ascii";
  const forcedOn =
    env.FORCE_COLOR !== undefined &&
    env.FORCE_COLOR !== "0" &&
    env.FORCE_COLOR !== "false";
  return env.NO_COLOR !== undefined && env.NO_COLOR !== "" && !forcedOn
    ? "mono"
    : "color";
}

/** Read per `session_start`; `getAgentDir()` is env-true per call. */
async function readVoiceConfig(): Promise<{
  config: VoiceConfig;
  problems: string[];
}> {
  const { getAgentDir } = await loadPi();
  const { data, problems } = readSkyrFile(getAgentDir());
  const { config, problems: section } = parseVoiceSection(data.voice);
  return { config, problems: [...problems, ...section] };
}

/**
 * Why ctrl+space cannot start dictating right now, or undefined to proceed. Dictating into
 * a hidden editor (an approval card or selector has the keyboard) would surprise.
 */
export function startRefusal(
  active: boolean,
  editor: { focused: boolean } | undefined,
): string | undefined {
  if (active) return undefined;
  if (!editor || editor.focused) return undefined;
  return startBlocked(VOICE_SHORTCUT);
}

export function registerVoice(pi: ExtensionAPI, opts: VoiceOptions = {}): void {
  const mode = opts.mode ?? voiceMode(process.env);
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
  // The mounted voice editor, set once Pi calls the factory; undefined until then, or when
  // another extension owns the input.
  let editor: VoiceEditorLike | undefined;
  // The session context of the last mount or toggle, for reading the buffer and theme outside a
  // callback; no dictation starts without one (toggle sets it), so reads never race a session.
  let ctxRef: ExtensionContext | undefined;
  // This session's presenter, built on session_start once the theme is known; gone after.
  let presenter: VoicePresenter | undefined;
  // The repaint tick, running only while voice can still move: a live dictation, or drying spans.
  let timer: ReturnType<typeof setInterval> | undefined;
  // Mic levels in at the chunk rate, smoothed bars out on the tick; reset when a dictation starts.
  const history = createLevelHistory();
  // The last sampled bars, newest first — what the meter shows between ticks.
  let bars: number[] = [];

  const repaint = () => tui?.requestRender();
  const sink = editorSink(
    () => editor,
    {
      get: () => ctxRef?.ui.getEditorText() ?? "",
      set: (t) => ctxRef?.ui.setEditorText(t),
    },
    repaint,
  );

  const snapshot = (): VoiceSnapshot => ({
    ...controller.facts(),
    bars,
  });
  // Every route to the screen in one place: present the snapshot, decide the tick, repaint.
  const refresh = () => {
    presenter?.update(snapshot());
    if (controller.state !== "idle" || editor?.animating) startTimer();
    else stopTimer();
    repaint();
  };
  const tick = () => {
    bars = history.sample(TICK_MS);
    refresh();
  };
  const startTimer = () => {
    timer ??= setInterval(tick, TICK_MS);
    timer.unref?.();
  };
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const controller = new DictationController({
    creds,
    sink,
    onLevel: (rms) => history.push(meterUnit(rms)),
    onChange: () => refresh(),
    ...opts.controller,
  });

  // Esc and `/voice off`: the controller puts the buffer back and shows the undo notice itself
  const cancel = () => controller.cancel();

  const keyHook = (data: string, keys: KeybindingsManager): boolean => {
    // any key ends the undo offer: an edit after it would undo that edit, not the revert
    if (controller.state === "error" || controller.state === "discarded") {
      controller.dismiss();
      return false;
    }
    if (!controller.active) return false;
    if (keys.matches(data, BINDINGS.cancel)) {
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
    const refusal = startRefusal(controller.active, editor);
    if (refusal) {
      ctx.ui.notify(refusal, "warning");
      return;
    }
    // the buffer and the theme come from this ctx while the dictation runs
    ctxRef = ctx;
    if (!controller.active) {
      // a dictation starting now begins with an empty meter, not the last one's tail
      history.reset();
      bars = [];
    }
    controller.toggle();
  };

  type EditorFactory = Parameters<ExtensionUIContext["setEditorComponent"]>[0];
  /** Once created, kept by reference: session_start later distinguishes ours from a foreign one. */
  let editorFactory: EditorFactory | undefined;
  const mount = async (ctx: ExtensionContext) => {
    ctxRef = ctx;
    const installed = ctx.ui.getEditorComponent();
    // a foreign editor wins, existing fallback via setEditorText unchanged; ours or none gets (re)installed
    if (installed && installed !== editorFactory) return;
    const { CustomEditor } = await loadPi();
    // one class per session mount, not per editor: the hook and paint live for the session's life
    const VoiceEditor = createVoiceEditorClass(CustomEditor, {
      keyHook,
      paint: () => paintFor(ctxRef?.ui.theme, mode),
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
      // "on" is the explicit spelling of a bare /voice: both go through toggle
      else if (arg === "" || arg === "on") toggle(ctx);
      else ctx.ui.notify(unknownVoiceArg(arg), "warning");
    },
  });

  pi.registerShortcut(VOICE_SHORTCUT, {
    description: "Start or stop voice dictation",
    handler: async (ctx: ExtensionContext) => toggle(ctx),
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    controller.dispose();
    stopTimer();
    // every piece of session state starts over: only the controller and its config carry over
    editor = undefined;
    presenter = undefined;
    ctxRef = undefined;
    tui = undefined;
    const { config, problems } = await readVoiceConfig();
    controller.config = { ...config, ...mergeVocabulary(config) };
    // once per session; a malformed section degrades to defaults, never breaks the start
    if (problems.length) ctx.ui.notify(problems.join("\n"), "warning");
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    await mount(ctx);
    presenter = voicePresenter({
      editor: () => editor,
      status: ctx.ui,
      paint: () => paintFor(ctxRef?.ui.theme, mode),
    });
    refresh();
    // a cached token makes ctrl+space feel instant
    prewarmToken(creds, { fetch: opts.fetch });
  });

  pi.on("session_shutdown", () => {
    controller.dispose();
    stopTimer();
    presenter?.update(snapshot());
    presenter = undefined;
  });
}
