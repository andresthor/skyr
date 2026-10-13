/**
 * The seam between the dictation core (client/mic/transcript/dictation — which render nothing)
 * and any display. A presenter swallows snapshots of state and produces presentation; v1 is the
 * compact one-row footer status (`setStatus`), and a widget variant would implement the same
 * interface without touching the core, the config or this file's callers.
 */
import type { VoiceState } from "./dictation.js";
import { renderStatus, type VoicePalette } from "./indicator.js";

/** The status key the presenter claims in pi's footer; unrelated extensions stay unnamed. */
export const VOICE_STATUS_KEY = "voice";

/** The narrowest shape of the host's status surface the presenter needs. */
export interface StatusUI {
  setStatus(key: string, text: string | undefined): void;
}

export interface VoiceSnapshot {
  state: VoiceState;
  /** Smoothed 0..1 level; 0 until the microphone has delivered. */
  level: number;
  /** The current error line; empty otherwise. */
  message: string;
  /** ms since the state began — the arming pulse and the transcribing drain run on it. */
  t: number;
}

export interface VoicePresenter {
  /** Called on every state change and every tick with the latest snapshot. */
  update(snapshot: VoiceSnapshot): void;
}

export interface StatusPresenterOptions {
  /** TERM=dumb and friends: the plain `[mic]` / `x voice` forms, no blocks, no colour. */
  ascii?: boolean;
  /** Reads theme colours afresh per frame, so the row follows theme switches. */
  palette?: () => VoicePalette;
}

/** v1: driving pi's footer status line with one compact row. */
export function statusPresenter(
  ui: StatusUI,
  { ascii = false, palette }: StatusPresenterOptions = {},
): VoicePresenter {
  const bars: number[] = [];
  return {
    update({ state, level, message, t }) {
      bars.unshift(level);
      // the shift register feeds `levels`, which renderStatus reads newest-first
      if (bars.length > 6) bars.length = 6;
      ui.setStatus(
        VOICE_STATUS_KEY,
        renderStatus({
          state,
          level,
          levels: bars,
          t,
          message,
          theme: palette?.(),
          ascii,
        }),
      );
    },
  };
}
