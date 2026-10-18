/** Voice failures, each with one short line fit for the indicator. Never a stack trace in the TUI. */

export class VoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceError";
  }
}
