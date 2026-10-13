/** Voice failures, each with one short line fit for the indicator. Never a stack trace in the TUI. */

export type VoiceErrorKind = "recorder" | "mic" | "auth" | "network" | "config";

export class VoiceError extends Error {
  constructor(
    readonly kind: VoiceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "VoiceError";
  }
}

/** Maps anything thrown by fetch, the socket or the recorder onto one short line. */
export function voiceErrorLine(err: unknown): string {
  if (err instanceof VoiceError) return err.message;
  const e = err as { code?: string; message?: string } | undefined;
  if (e?.code === "ENOENT") return "needs sox · brew install sox";
  return "connection lost";
}
