/**
 * The one module that words voice's failures, in two shapes: `VoiceError` constructors the
 * inner layers throw (their lines reach the rule and the footer), and notice builders for
 * the chat lines. Convention: lower case, ` · ` between what happened and the fix, a code
 * in parentheses where it helps, durations derived from the constant the caller owns, and
 * server text only as one clean clipped line. Never a stack trace or a foreign message.
 */
import { basename } from "node:path";
import { clip, errnoOf, oneLine } from "../tools/render.js";
import type { CredentialResult, SttCredentials } from "./credentials.js";

export class VoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceError";
  }
}

/** sox and ffmpeg are both accepted recorders; the hint names the one without a fallback. */
export const soxMissing = () =>
  new VoiceError("sox not found · brew install sox");

/** The recorder binary exists but could not run, EACCES most often. */
export const recorderSpawnFailed = (cmd: string, error: unknown) =>
  new VoiceError(`can't start ${basename(cmd)} (${errnoOf(error)})`);

/** The recorder ran and exited on its own before the stop; code null means a signal killed it. */
export const recorderExited = (cmd: string, code: number | null) =>
  new VoiceError(`microphone unavailable (${basename(cmd)} exited ${code})`);

/** A recorder failure with no more detail to name. */
export const micFailed = () => new VoiceError("microphone unavailable");

/** Sign-in could not reach auth: ENOTFOUND is usually a mistyped environment, so name the fix. */
export function signInUnreachable(error: unknown): VoiceError {
  const code = errnoIn(error);
  if (code === "ENOTFOUND")
    return new VoiceError(
      "can't reach Corti (ENOTFOUND) · check CORTI_ENVIRONMENT",
    );
  return new VoiceError(
    code ? `can't reach Corti (${code})` : "can't reach Corti",
  );
}

/** The sign-in deadline passed; `ms` is the one this call used. */
export const signInNoAnswer = (ms: number) =>
  new VoiceError(`Corti sign-in didn't answer in ${ms / 1000} s`);

/** A 200 answer whose body had no usable token. */
export const signInUnreadable = () =>
  new VoiceError("Corti sign-in sent an unreadable answer");

/** Keycloak refused the client id and secret pair. */
export const credentialsRefused = () =>
  new VoiceError(
    "Corti refused the client · check CORTI_CLIENT_ID and CORTI_CLIENT_SECRET",
  );

/** Keycloak answers an unknown realm with 404, so a tenant typo reads as one. */
export const unknownTenant = () =>
  new VoiceError("unknown Corti tenant · check CORTI_TENANT_NAME");

/** Any other sign-in status; 400-class is the credentials and 404 the tenant. */
export const signInFailed = (status: number) =>
  new VoiceError(`Corti sign-in failed (HTTP ${status})`);

/** The refused settings come from the user's own skyr.json; the server's reason is the fix. */
export const settingsRefused = (reason?: string) =>
  new VoiceError(
    `Corti refused the settings · check skyr.json voice${reason ? `: ${oneLine(reason, 40)}` : ""}`,
  );

/** A Corti error frame; its reason, when the server words one, is the next step. */
export const cortiError = (reason?: string) =>
  new VoiceError(`Corti error${reason ? `: ${oneLine(reason, 40)}` : ""}`);

/** The socket closed before `end`: nothing more arrives, whatever the network problem was. */
export const connectionLost = () => new VoiceError("connection to Corti lost");

/** The last-ditch line when one of our own listeners threw behind the guard. */
export const internalError = () => new VoiceError("internal error");

/** The arm window expired without the session being accepted; `ms` is the controller's. */
export const noAnswer = (ms: number) =>
  new VoiceError(`Corti didn't answer in ${ms / 1000} s`);

/** No chunk above the speech gate and no words from start to the end of the window. */
export const noSpeech = (ms: number) =>
  new VoiceError(`no speech in ${ms / 1000} s`);

/** Speech was heard and Corti still returned no words to keep. */
export const noWords = () => new VoiceError("no words recognised");

/** An open microphone stopped delivering. */
export const micStopped = () => new VoiceError("microphone stopped");

/** macOS hands a mic-denied process silence, not an error. */
export const micBlocked = () =>
  new VoiceError("microphone blocked · allow it in System Settings › Privacy");

/** The chat notice when the shortcut cannot start: a card or selector holds the keyboard. */
export const startBlocked = (shortcut: string) =>
  `voice: a card or selector has the keyboard; close it, then press ${shortcut} again`;

/** What each checkable variable must look like, for the notice that names an invalid one. */
const CRED_FORMS: Record<string, string> = {
  CORTI_ENVIRONMENT: 'letters, digits or "-"',
  CORTI_TENANT_NAME: 'letters, digits, "_", "." or "-"',
};

/** The stub's one line, naming only the variable that kept voice from registering. */
export function credentialsNotice(
  from: Exclude<CredentialResult, { creds: SttCredentials }>,
): string {
  if ("missing" in from) {
    const names = from.missing;
    const listed =
      names.length < 2
        ? (names[0] ?? "")
        : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    return `voice: set ${listed} to dictate`;
  }
  return `voice: ${from.invalid} must be ${CRED_FORMS[from.invalid]}; voice is off`;
}

/** Echoed user input into a notice: clipped, then quoted so control characters read as text. */
const quotedArg = (arg: string) => JSON.stringify(clip(arg, 20));

/** The chat notice when /voice gets an argument it does not take. */
export const unknownVoiceArg = (arg: string) =>
  `voice: ${quotedArg(arg)} is not an option; use /voice, /voice on or /voice off`;

/**
 * The errno inside a fetch failure. undici wraps the real error (DNS, TLS) in its cause
 * chain at a depth that varies by Node version, and groups some of them in `errors`.
 */
function errnoIn(error: unknown): string | undefined {
  for (let e: unknown = error, hops = 0; hops < 4; hops++) {
    if (typeof e !== "object" || e === null) return undefined;
    if ("code" in e && typeof e.code === "string") return e.code;
    const wrapped = e as { cause?: unknown; errors?: unknown[] };
    e = wrapped.cause ?? wrapped.errors?.[0];
  }
  return undefined;
}
