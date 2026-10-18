/**
 * A failure worded for the voice line, which the client tells apart from foreign throws. Each
 * throw site words its own, by one convention: lower case, ` · ` between what happened and the
 * fix, a code in parentheses where it helps, durations derived from the constant the caller
 * owns, and server text or a foreign throw's message only as one clean clipped line. Never a
 * stack trace.
 */
export class VoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceError";
  }
}

/** A recorder failure with no more detail to name. */
export const micFailed = () => new VoiceError("microphone unavailable");
