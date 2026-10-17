/**
 * Voice dictation into the input editor with Corti speech-to-text.
 *
 * Without STT credentials only `/voice` exists, to say so in one line. With them:
 * `ctrl+space` or `/voice` toggles listening, Esc cancels and restores the editor,
 * Enter stops-without-sending. Quiet never ends a dictation. Text is never auto-sent.
 *
 * All display wiring goes through `presenter.ts`; the core modules render nothing.
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
  VOICE_DEFAULTS,
  type VoiceConfig,
} from "./config.js";
import { resolveSttCredentials } from "./credentials.js";
import {
  DEFAULT_TIMING,
  DictationController,
  type DictationControllerOptions,
} from "./dictation.js";
import {
  createVoiceEditorClass,
  editorSink,
  type VoiceEditorLike,
} from "./editor.js";
import {
  createLevelHistory,
  DRY_MS,
  meterUnit,
  paletteFromTheme,
  TICK_MS,
  type VoiceMode,
  type VoiceSnapshot,
} from "./indicator.js";
import { type VoicePresenter, voicePresenter } from "./presenter.js";

export const VOICE_SHORTCUT = "ctrl+space";

/** How long before the hard cap the rule counts the time left. */
const CAP_WARN_MS = 15_000;
/** How long the rule offers the undo after Esc reverted committed words. */
const DISCARD_NOTICE_MS = 2000;

export interface VoiceOptions {
  /** What the terminal can show; read from the environment when not given. */
  mode?: VoiceMode;
  env?: NodeJS.ProcessEnv;
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

/** Read at load and again per `session_start`; `getAgentDir()` is env-true per call. */
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
  editor: VoiceEditorLike | undefined,
): string | undefined {
  if (active) return undefined;
  if (!editor || editor.focused) return undefined;
  return "can't start voice · a card or selector has the keyboard — close it, then try again";
}

export function registerVoice(pi: ExtensionAPI, opts: VoiceOptions = {}): void {
  const mode = opts.mode ?? voiceMode(opts.env ?? process.env);
  const creds = resolveSttCredentials(opts.env ?? process.env);

  if (!creds) {
    pi.registerCommand("voice", {
      description: "Dictate with Corti speech-to-text",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        ctx.ui.notify(
          "Voice needs Corti speech credentials (CORTI_CLIENT_ID and friends).",
          "info",
        );
      },
    });
    return;
  }

  let tui: Tui | undefined;
  let editor: VoiceEditorLike | undefined;
  let ctxRef: ExtensionContext | undefined;
  let presenter: VoicePresenter | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const history = createLevelHistory();
  let bars: number[] = [];
  let startedAt = 0;
  let discardedUntil = 0;
  const maxMs = opts.controller?.timing?.maxMs ?? DEFAULT_TIMING.maxMs;

  // read before any session_start resolves, so /voice works even straight after reload — silent:
  // problems have no UI before a context exists, and session_start is the earliest honest surface
  void readVoiceConfig().then(
    ({ config }) => applyConfig(config),
    () => {},
  );
  const applyConfig = (config: VoiceConfig) => {
    controllerOptions.language = config.language;
    controllerOptions.interims = config.interims;
    controllerOptions.punctuation = config.punctuation;
    const vocabulary = mergeVocabulary(config);
    controllerOptions.keyterms = vocabulary.keyterms;
    controllerOptions.replacements = vocabulary.replacements;
  };

  const repaint = () => tui?.requestRender();
  const sink = editorSink(
    () => editor,
    {
      get: () => ctxRef?.ui.getEditorText() ?? "",
      set: (t) => ctxRef?.ui.setEditorText(t),
    },
    repaint,
  );

  const drying = () =>
    !!editor?.decor.drying.some((s) => Date.now() - s.at < DRY_MS);
  const discarded = () =>
    controller.state === "idle" && Date.now() < discardedUntil;
  const snapshot = (): VoiceSnapshot => {
    const now = Date.now();
    const sinceStart = now - startedAt;
    const capLeft = maxMs - sinceStart;
    return {
      state: controller.state,
      t: now - controller.stateSince,
      sinceStart,
      micOpen: controller.micOpen,
      accepted: controller.accepted,
      heardSpeech: controller.heardSpeech,
      bars,
      message: controller.message,
      discarded: discarded(),
      capLeftMs:
        controller.state === "listening" && capLeft <= CAP_WARN_MS
          ? Math.max(0, capLeft)
          : undefined,
    };
  };
  const pushPresenter = () => presenter?.update(snapshot());
  const tick = () => {
    if (controller.state === "idle" && !drying() && !discarded()) {
      if (editor) editor.decor.drying = [];
      stopTimer();
    }
    // committed bars only: the live one restarts every bar and beats against the mic's chunk rate
    bars = history.sample(TICK_MS).slice(1);
    pushPresenter();
    repaint();
  };
  const startTimer = () => {
    timer ??= setInterval(tick, TICK_MS);
    timer.unref?.();
  };
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const controllerOptions: DictationControllerOptions = {
    creds,
    sink,
    onLevel: (rms) => history.push(meterUnit(rms)),
    onChange: () => {
      if (controller.state === "arming") {
        history.reset();
        bars = [];
        startedAt = Date.now();
        // a new dictation ends the previous undo offer: the undo now belongs to newer text
        discardedUntil = 0;
      }
      if (controller.state !== "idle" || drying()) startTimer();
      pushPresenter();
      repaint();
    },
    ...opts.controller,
  };
  applyConfig(VOICE_DEFAULTS);
  const controller = new DictationController(controllerOptions);

  /** Esc and `/voice off`: a reverted buffer means committed words went, so offer the undo. */
  const cancel = () => {
    const before = editor?.getText();
    controller.cancel();
    if (editor && editor.getText() !== before) {
      discardedUntil = Date.now() + DISCARD_NOTICE_MS;
      startTimer();
      pushPresenter();
      repaint();
    }
  };

  const keyHook = (data: string, keys: KeybindingsManager): boolean => {
    // after any edit one undo would remove that edit, not the dictation, so the offer ends here
    if (discardedUntil) {
      discardedUntil = 0;
      pushPresenter();
      repaint();
    }
    if (controller.state === "error") {
      controller.dismiss();
      return false;
    }
    if (!controller.active) return false;
    if (keys.matches(data, "tui.select.cancel")) {
      cancel();
      return true;
    }
    if (keys.matches(data, "tui.input.submit")) {
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
    ctxRef = ctx;
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
    editorFactory = (t, theme, keybindings) => {
      // Pi copies padding and autocomplete into a custom editor, but not this constructor-only flag;
      // without it the working spinner leaves the top rule for a separate row
      const ed = new (createVoiceEditorClass(CustomEditor))(
        t,
        theme,
        keybindings,
        { embedWorkingStatus: true },
      );
      ed.keyHook = keyHook;
      // read per frame: /theme must reach the ghost and drying colours without a remount
      ed.palette = () => paletteFromTheme(ctxRef?.ui.theme);
      ed.decor.mode = mode;
      editor = ed;
      tui = t as unknown as Tui;
      return ed;
    };
    ctx.ui.setEditorComponent(editorFactory);
  };

  pi.registerCommand("voice", {
    description:
      "Dictate with Corti speech-to-text (ctrl+space) · /voice off cancels",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim() === "off") cancel();
      else toggle(ctx);
    },
  });

  pi.registerShortcut(VOICE_SHORTCUT, {
    description: "Voice dictation",
    handler: async (ctx: ExtensionContext) => toggle(ctx),
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    controller.dispose();
    stopTimer();
    editor = undefined;
    presenter = undefined;
    const { config, problems } = await readVoiceConfig();
    applyConfig(config);
    // once per session; a malformed section degrades to defaults, never breaks the start
    if (problems.length)
      ctx.ui.notify(`skyr: ${problems.join(" · ")}`, "warning");
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    await mount(ctx);
    presenter = voicePresenter({
      editor: () => editor,
      status: ctx.ui,
      // re-read per frame: /theme reaches the footer row without a remount
      palette: () => paletteFromTheme(ctxRef?.ui.theme),
      mode,
    });
    pushPresenter();
    // the token request is the slowest step of arming; a cached one makes ctrl+space feel instant
    prewarmToken(creds);
  });

  pi.on("session_shutdown", () => {
    controller.dispose();
    stopTimer();
    discardedUntil = 0;
    presenter?.update(snapshot());
    presenter = undefined;
  });
}
