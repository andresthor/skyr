/**
 * Voice on screen: the controller's facts plus a smoothed level meter, on our editor's bottom
 * rule while it can carry them, and on the footer status row when it cannot (another extension
 * owns the editor, a card hides it, or its rule drawing failed).
 */

import type { Tier } from "../ui/caps.js";
import type { ThemeLike } from "../ui/palette.js";
import type { DictationFacts } from "./dictation.js";
import type { VoiceEditorLike } from "./editor.js";
import {
  createLevelHistory,
  renderStatus,
  type VoiceSnapshot,
} from "./indicator.js";

const TICK_MS = 50;
const VOICE_STATUS_KEY = "skyr.voice";

interface StatusUI {
  setStatus(key: string, text: string | undefined): void;
  /** Pi's live theme handle: read per row, so the row follows theme switches. */
  readonly theme: ThemeLike;
}

interface VoiceDisplayOptions {
  facts: () => DictationFacts;
  /** Our editor while it is the one installed, else undefined. */
  editor: () => Pick<VoiceEditorLike, "showRule" | "animating"> | undefined;
  mode: Tier;
  repaint: () => void;
}

interface VoiceDisplay {
  /** A mic chunk's level in dBFS; the meter takes it in on the next tick. */
  level(dbfs: number): void;
  /** Empties the meter, so a dictation starting now does not show the last one's tail. */
  clearMeter(): void;
  /** Shows the current facts now, and starts or stops the tick to match. */
  refresh(): void;
  /** Shows voice in this session's footer, in its theme, from now on, and refreshes. */
  start(status: StatusUI): void;
  /**
   * Stops the tick and shows the facts once more, then lets go of the footer; with the
   * controller idle, that clears the rule and the footer. Repeating it does nothing.
   */
  stop(): void;
}

/**
 * Keeps voice on screen while it can still change. A tick advances the meter and refreshes,
 * running only while the controller is not idle (a dictation, or its error or discarded notice)
 * or the editor still has drying spans.
 * Every refresh asks for a repaint, footer or not. The footer is written only when its row
 * changes, except that the first row after `start()` always reaches it, clearing anything left
 * there; between `stop()` and the next `start()`, nothing reaches it or the rule.
 */
export function createVoiceDisplay({
  facts,
  editor,
  mode,
  repaint,
}: VoiceDisplayOptions): VoiceDisplay {
  const history = createLevelHistory();
  // newest first: what the meter shows between ticks
  let bars: number[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let status: StatusUI | undefined;
  // null, not undefined: the first row after start always reaches the footer
  let shown: string | undefined | null = null;

  const present = (f: DictationFacts) => {
    if (!status) return;
    const snapshot: VoiceSnapshot = { ...f, bars };
    // the editor owns its rule: it says whether it can carry voice, and the footer takes over
    // exactly when it can't
    const onRule = editor()?.showRule(snapshot) ?? false;
    const row = onRule
      ? undefined
      : renderStatus(snapshot, { paint: { theme: status.theme, mode } });
    if (row === shown) return;
    shown = row;
    status.setStatus(VOICE_STATUS_KEY, row);
  };
  const refresh = () => {
    const f = facts();
    present(f);
    if (f.state !== "idle" || editor()?.animating) startTimer();
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

  return {
    level: (dbfs) => history.push(dbfs),
    clearMeter() {
      history.reset();
      bars = [];
    },
    refresh,
    start(s) {
      status = s;
      shown = null;
      refresh();
    },
    stop() {
      stopTimer();
      present(facts());
      status = undefined;
    },
  };
}
