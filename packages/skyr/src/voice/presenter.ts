/**
 * The seam between the dictation core (client/mic/transcript/dictation — which render nothing)
 * and any display. A presenter swallows snapshots of state and produces presentation: the
 * editor's bottom rule while our editor is on screen, and the footer status row only when it
 * is not (another extension owns the editor, or a card hides it).
 */
import { renderStatus, type VoiceSnapshot } from "./indicator.js";
import type { Paint } from "./palette.js";

/** The status key the presenter claims in pi's footer; unrelated extensions stay unnamed. */
export const VOICE_STATUS_KEY = "voice";

/** The narrowest shape of the host's status surface the presenter needs. */
interface StatusUI {
  setStatus(key: string, text: string | undefined): void;
}

/** The narrowest shape of the voice editor the presenter needs. */
export interface RuleEditor {
  decor: { rule?: VoiceSnapshot; ruleFailed?: boolean };
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
  /** The footer's colours, read afresh per update, so the row follows theme switches. */
  paint: () => Paint;
}

export function voicePresenter({
  editor,
  status,
  paint,
}: VoicePresenterOptions): VoicePresenter {
  // null, not undefined: the first update always reaches the footer, clearing anything left there
  let shown: string | undefined | null = null;
  return {
    update(snapshot) {
      const ed = editor();
      // a rule that failed to draw would leave voice invisible, so the footer takes over
      const onRule = ed?.focused === true && !ed.decor.ruleFailed;
      if (ed) ed.decor.rule = onRule ? snapshot : undefined;
      const row = onRule
        ? undefined
        : renderStatus(snapshot, { paint: paint() });
      if (row === shown) return;
      shown = row;
      status.setStatus(VOICE_STATUS_KEY, row);
    },
  };
}
