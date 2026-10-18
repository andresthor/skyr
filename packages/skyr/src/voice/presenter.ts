/**
 * The seam between the dictation core (client, mic, dictation — none of which render) and the
 * display. A presenter swallows snapshots of state and produces presentation: the editor's own
 * bottom rule while our editor can carry it, and the footer status row when it cannot (another
 * extension owns the editor, a card hides it, or its rule drawing failed).
 */
import { renderStatus, type VoiceSnapshot } from "./indicator.js";
import type { Paint } from "./palette.js";

/** The status key the presenter claims in pi's footer; unrelated extensions stay unnamed. */
export const VOICE_STATUS_KEY = "skyr.voice";

/** The narrowest shape of the host's status surface the presenter needs. */
interface StatusUI {
  setStatus(key: string, text: string | undefined): void;
}

/** The narrowest shape of the voice editor the presenter needs. */
export interface RuleEditor {
  showRule(s: VoiceSnapshot | undefined): boolean;
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
      // the editor owns its rule: it says whether it can carry voice, and the footer takes over
      // exactly when it can't
      const onRule = editor()?.showRule(snapshot) ?? false;
      const row = onRule
        ? undefined
        : renderStatus(snapshot, { paint: paint() });
      if (row === shown) return;
      shown = row;
      status.setStatus(VOICE_STATUS_KEY, row);
    },
  };
}
