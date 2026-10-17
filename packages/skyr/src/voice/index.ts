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
  paletteFromTheme,
  TICK_MS,
} from "./indicator.js";
import {
  statusPresenter,
  type VoicePresenter,
  type VoiceSnapshot,
} from "./presenter.js";

export const VOICE_SHORTCUT = "ctrl+space";

export interface VoiceOptions {
  /** TERM=dumb and friends; read from the environment when not given. */
  ascii?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the live Corti session and microphone. */
  controller?: Partial<
    Pick<DictationControllerOptions, "start" | "source" | "timing">
  >;
}

interface Tui {
  requestRender(): void;
}

/** corti-code's glyph rule (lib/env.ts): ASCII on TERM=dumb and NO_COLOR, unless FORCE_COLOR forces colour on. */
function asciiMode(): boolean {
  const env = process.env;
  const forcedOn =
    env.FORCE_COLOR !== undefined &&
    env.FORCE_COLOR !== "0" &&
    env.FORCE_COLOR !== "false";
  return (
    env.TERM === "dumb" ||
    (env.NO_COLOR !== undefined && env.NO_COLOR !== "" && !forcedOn)
  );
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
  const ascii = opts.ascii ?? asciiMode();
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
  let levels: number[] = [];

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

  const firmWet = () =>
    !!editor?.decor.firm && Date.now() - editor.decor.firm.at < DRY_MS;
  const pushPresenter = () =>
    presenter?.update({
      state: controller.state,
      level: levels[0] ?? 0,
      message: controller.message,
      t: Date.now() - controller.stateSince,
    } satisfies VoiceSnapshot);
  const tick = () => {
    if (controller.state === "idle" && !firmWet()) {
      if (editor) editor.decor.firm = null;
      stopTimer();
    }
    levels = history.sample(TICK_MS);
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
    onLevel: (level) => history.push(level),
    onChange: () => {
      if (controller.state === "arming") {
        history.reset();
        levels = [];
      }
      if (controller.state !== "idle" || firmWet()) startTimer();
      pushPresenter();
      repaint();
    },
    ...opts.controller,
  };
  applyConfig(VOICE_DEFAULTS);
  const controller = new DictationController(controllerOptions);

  const keyHook = (data: string, keys: KeybindingsManager): boolean => {
    if (controller.state === "error") {
      controller.dismiss();
      return false;
    }
    if (!controller.active) return false;
    if (keys.matches(data, "tui.select.cancel")) {
      controller.cancel();
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
      const ed = new (createVoiceEditorClass(CustomEditor))(
        t,
        theme,
        keybindings,
      );
      ed.keyHook = keyHook;
      // read per frame: /theme must reach the ghost/firm colours without a remount
      ed.palette = () => paletteFromTheme(ctxRef?.ui.theme);
      ed.decor.ascii = ascii;
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
      if (args.trim() === "off") controller.cancel();
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
    presenter = statusPresenter(ctx.ui, {
      ascii,
      // re-read per frame: /theme reaches the status row without a remount
      palette: () => paletteFromTheme(ctxRef?.ui.theme),
    });
    pushPresenter();
    // the token request is the slowest step of arming; a cached one makes ctrl+space feel instant
    prewarmToken(creds);
  });

  pi.on("session_shutdown", () => {
    controller.dispose();
    stopTimer();
    presenter?.update({
      state: "idle",
      level: 0,
      message: "",
      t: 0,
    });
    presenter = undefined;
  });
}
