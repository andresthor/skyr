/**
 * The seam between the dictation core (client/mic/transcript/dictation — which render nothing)
 * and any display. A presenter swallows snapshots of state and produces presentation: the
 * editor's bottom rule while our editor is on screen, and the footer status row only when it
 * is not (another extension owns the editor, or a card hides it).
 */
import {
  renderStatus,
  type VoiceMode,
  type VoicePalette,
  type VoiceSnapshot,
} from "./indicator.js";

/** The status key the presenter claims in pi's footer; unrelated extensions stay unnamed. */
export const VOICE_STATUS_KEY = "voice";

/** The narrowest shape of the host's status surface the presenter needs. */
export interface StatusUI {
  setStatus(key: string, text: string | undefined): void;
}

/** The narrowest shape of the voice editor the presenter needs. */
export interface RuleEditor {
  decor: { rule?: VoiceSnapshot };
  readonly focused: boolean;
}

export interface VoicePresenter {
  /** Called on every state change and every tick with the latest snapshot. */
  update(snapshot: VoiceSnapshot): void;
}

interface VoicePresenterOptions {
  /** Our editor when it is the one installed, else undefined. */
  editor: () => RuleEditor | undefined;
  status: StatusUI;
  /** Reads theme colours afresh per frame, so the footer row follows theme switches. */
  palette: () => VoicePalette;
  mode: VoiceMode;
}

export function voicePresenter({
  editor,
  status,
  palette,
  mode,
}: VoicePresenterOptions): VoicePresenter {
  // null, not undefined: the first update always reaches the footer, clearing anything left there
  let shown: string | undefined | null = null;
  return {
    update(snapshot) {
      const ed = editor();
      const onRule = ed?.focused === true;
      if (ed) ed.decor.rule = onRule ? snapshot : undefined;
      const row = onRule
        ? undefined
        : renderStatus(snapshot, { palette: palette(), mode });
      if (row === shown) return;
      shown = row;
      status.setStatus(VOICE_STATUS_KEY, row);
    },
  };
}
