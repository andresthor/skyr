/** Turns Corti's transcript stream into finals plus one live interim, dropping stale re-sends. */

interface TranscriptMessage {
  text: string;
  start: number;
  isFinal: boolean;
}

type TranscriptUpdate =
  | { kind: "final"; segment: string }
  | { kind: "interim"; segment: string }
  | { kind: "stale" };

/**
 * Interims are cumulative within a segment and replace each other; finals are
 * per segment and append. The server re-sends the last interim right after its
 * final, so an interim that does not start past the last final is dropped.
 */
export class TranscriptAssembler {
  private lastFinalStart = Number.NEGATIVE_INFINITY;

  accept(m: TranscriptMessage): TranscriptUpdate {
    const text = m.text.trim();
    if (m.isFinal) {
      this.lastFinalStart = m.start;
      if (!text) return { kind: "stale" };
      return { kind: "final", segment: text };
    }
    if (m.start <= this.lastFinalStart) return { kind: "stale" };
    return { kind: "interim", segment: text };
  }
}
