/**
 * Corti `/transcribe` streaming client. Zero dependencies: Node 22's global
 * `fetch` and `WebSocket` (auth rides in the query string, so no headers are needed).
 * `@corti/sdk` is deliberately not used: its socket reconnects on the server's
 * normal 1006 close after `ended`.
 * Contract: https://docs.corti.ai/api-reference/transcribe
 */
import type { Readable } from "node:stream";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { errnoOf } from "../errno.js";
import { oneLine, stripInvisible } from "../ui/text.js";
import type { SttCredentials } from "./credentials.js";
import { micFailed, VoiceError } from "./errors.js";
import { pcmDbfs, SAMPLE_RATE_HZ } from "./mic.js";

const PCM = `audio/pcm; rate=${SAMPLE_RATE_HZ}; channels=1; bits=16; endian=little; encoding=sint`;
/** Corti's recommended 250 ms chunk of s16le mono, two bytes a sample; the hard cap is 64 000 B. */
const CHUNK_BYTES = (SAMPLE_RATE_HZ / 1000) * 250 * 2;
/** Past this after `end` the caller keeps the last interim; flushing on quiet usually has the final in already. */
const END_TIMEOUT_MS = 2_500;
/** How much of a foreign reason, Corti's or a throw's, an error line carries. */
const REASON_CHARS = 40;

/** A frame field read as Corti documents it, or undefined; frames are untrusted input. */
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Corti's two punctuation modes: inferred from the audio, or only where the speaker says it. */
type Punctuation = "automatic" | "spoken";

/** A rewrite Corti applies to the transcript; `find` matches case-insensitively. */
export interface Replacement {
  find: string;
  replace: string;
}

/** How Corti writes each kind of value; a field left out keeps Corti's default. */
export type Formatting = Partial<
  Record<
    | "dates"
    | "times"
    | "numbers"
    | "measurements"
    | "numericRanges"
    | "ordinals",
    string
  >
>;

/** What a Corti session is configured with: the settings the skyr.json voice section carries. */
export interface SttConfig {
  /** Corti primaryLanguage. */
  language: string;
  /** Interims drive the ghost text; off only when a locale mishandles them. */
  interims: boolean;
  /** The two modes are exclusive server-side; exactly one is sent. */
  punctuation: Punctuation;
  /** Sent as given; voice/config.ts merges the built-ins in. */
  keyterms: readonly string[];
  replacements: readonly Replacement[];
  formatting: Formatting;
}

export interface SessionOptions extends SttConfig {
  creds: SttCredentials;
  source: () => Readable;
  /** Server accepted the config; audio is flowing. */
  onReady: () => void;
  onInterim: (segment: string) => void;
  onFinal: (segment: string) => void;
  /** Each captured chunk's level in dBFS, −Infinity for digital silence, roughly every 64 ms. */
  onLevel: (dbfs: number) => void;
  onError: (err: VoiceError) => void;
}

export interface SttSession {
  /** Stop capture and drain the remaining finals through `onFinal`; resolves once the session is closed. */
  stop(): Promise<void>;
  /** Drop everything now. No more callbacks fire. */
  cancel(): void;
  /** Ask for the pending segment's final now (about 1 s) instead of at the next pause or `end`. */
  flush(): void;
}

let cached: { key: string; token: string; exp: number } | undefined;

/** Sign-in deadline: shorter than the controller's arm window, so a dead auth is
 * named for what it is before the whole session gives up.
 * @internal
 */
export const TOKEN_TIMEOUT_MS = 8_000;
/** A token this close to expiry is not worth starting a session on. */
const TOKEN_MARGIN_S = 60;

/** Sign-in could not reach auth: ENOTFOUND is usually a mistyped environment, so name the fix. */
function signInUnreachable(error: unknown): VoiceError {
  const code = errnoOf(error);
  if (code === "ENOTFOUND")
    return new VoiceError(
      "can't reach Corti (ENOTFOUND) · check CORTI_ENVIRONMENT",
    );
  return new VoiceError(
    code ? `can't reach Corti (${code})` : "can't reach Corti",
  );
}

/** Seam for tests: global fetch offline. */
export interface TokenDeps {
  fetch?: typeof fetch;
}

/**
 * A Keycloak sign-in token for the tenant. One token per environment, tenant and client id is
 * cached, reused until `TOKEN_MARGIN_S` before its expiry. Throws `VoiceError` only: auth
 * unreachable, the sign-in deadline passing, credentials refused, unknown tenant, or a
 * failed or unreadable answer.
 * @internal
 */
export async function getSttToken(
  creds: SttCredentials,
  { fetch: doFetch = fetch }: TokenDeps = {},
): Promise<string> {
  const key = `${creds.environment}\0${creds.tenant}\0${creds.clientId}`;
  if (cached?.key === key && Date.now() < cached.exp) return cached.token;
  const url = `https://auth.${creds.environment}.corti.app/realms/${encodeURIComponent(creds.tenant)}/protocol/openid-connect/token`;
  const deadline = new AbortController();
  // a timer, not AbortSignal.timeout: one clock for voice's deadlines; cleared in finally, so
  // the body read stays inside it
  const timer = setTimeout(() => deadline.abort(), TOKEN_TIMEOUT_MS);
  timer.unref();
  try {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          scope: "openid transcribe",
        }),
        signal: deadline.signal,
      });
    } catch (error) {
      throw deadline.signal.aborted
        ? new VoiceError(
            `Corti sign-in didn't answer in ${TOKEN_TIMEOUT_MS / 1000} s`,
          )
        : signInUnreachable(error);
    }
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw new VoiceError(
        "Corti refused the client · check CORTI_CLIENT_ID and CORTI_CLIENT_SECRET",
      );
    // Keycloak answers an unknown realm with 404, so a tenant typo reads as one
    if (res.status === 404)
      throw new VoiceError("unknown Corti tenant · check CORTI_TENANT_NAME");
    if (!res.ok)
      throw new VoiceError(`Corti sign-in failed (HTTP ${res.status})`);
    const body: unknown = await res.json().catch(() => undefined);
    const { access_token: token, expires_in: expiresIn } =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {};
    if (typeof token !== "string" || typeof expiresIn !== "number")
      throw new VoiceError("Corti sign-in sent an unreadable answer");
    // a token only has to be valid at connect time
    cached = {
      key,
      token,
      exp: Date.now() + (expiresIn - TOKEN_MARGIN_S) * 1000,
    };
    return token;
  } finally {
    clearTimeout(timer);
  }
}

/** A transcript frame's data, or undefined when it is not shaped as Corti documents it. */
function transcriptData(
  data: unknown,
): { text: string; start: number; isFinal: boolean } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.text !== "string") return undefined;
  return {
    text: d.text,
    start: typeof d.start === "number" ? d.start : 0,
    isFinal: d.isFinal === true,
  };
}

/** Seams for tests: Node's global fetch and WebSocket by default. */
export interface SessionDeps extends TokenDeps {
  WebSocket?: typeof WebSocket;
}

/** Token fetch is the slowest step of arming; do it early when voice is likely. */
export function prewarmToken(creds: SttCredentials, deps?: TokenDeps): void {
  // a failed prewarm is retried, and reported, by the session's own sign-in
  getSttToken(creds, deps).catch(() => {});
}

/**
 * Opens the mic and a Corti session. Never throws, and no callback in `o` runs before this
 * returns. Every failure arrives as `onError` and nowhere else; after `cancel()` none does.
 * After Corti accepted, `stop()` drains the remaining finals without reporting failures, and
 * its promise resolves even after one. A `stop()` before acceptance waits for it, reporting a
 * failure meanwhile, and never resolves if Corti neither accepts nor closes: the caller bounds
 * that wait.
 */
export function startSession(
  o: SessionOptions,
  deps: SessionDeps = {},
): SttSession {
  const Socket = deps.WebSocket ?? WebSocket;
  let ws: WebSocket | undefined;
  let audio: Readable | undefined;
  let pending = Buffer.alloc(0);
  let accepted = false;
  let stopping = false;
  let ended = false;
  let closed = false;
  let resolveStop!: () => void;
  const done = new Promise<void>((r) => (resolveStop = r));
  // Interims are cumulative within a segment and replace each other; finals are per segment
  // and append. The server re-sends the last interim right after its final, so a re-sent
  // interim — one that does not start past the last final — is dropped.
  let lastFinalStart = Number.NEGATIVE_INFINITY;

  const teardown = () => {
    if (closed) return;
    closed = true;
    audio?.destroy();
    // close() without a code never throws, per the WHATWG spec Node's WebSocket implements
    ws?.close();
    resolveStop();
  };
  const fail = (err: VoiceError) => {
    if (closed) return;
    // torn down first, so a listener that throws below still leaves no socket or mic running
    teardown();
    // a stop drains finals Corti already has; before it accepted, there are none to stand on
    if (!stopping || !accepted) o.onError(err);
  };
  // socket and stream events run outside Pi's handlers, where a throw is an uncaughtException and Pi exits
  const guard =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      try {
        fn(...a);
      } catch (error: unknown) {
        const cause =
          error instanceof Error ? oneLine(error.message, REASON_CHARS) : "";
        try {
          fail(new VoiceError(`internal error${cause ? `: ${cause}` : ""}`));
        } catch {
          // onError itself threw: the session is already torn down, and a throw here would exit Pi
        }
      }
    };
  /** Sends what the recorder left and `end`, then waits for "ended" no longer than END_TIMEOUT_MS. */
  const sendEnd = (sock: WebSocket) => {
    // audio held until a late acceptance can be seconds long: frames stay under Corti's cap
    for (let at = 0; at < pending.length; at += CHUNK_BYTES)
      sock.send(pending.subarray(at, at + CHUNK_BYTES));
    pending = Buffer.alloc(0);
    sock.send(JSON.stringify({ type: "end" }));
    setTimeout(teardown, END_TIMEOUT_MS).unref();
  };
  const pump = () => {
    while (
      accepted &&
      !stopping &&
      pending.length >= CHUNK_BYTES &&
      ws?.readyState === Socket.OPEN
    ) {
      ws.send(pending.subarray(0, CHUNK_BYTES));
      pending = pending.subarray(CHUNK_BYTES);
    }
  };

  // capture starts before the socket so the ~500 ms recorder spawn overlaps auth and connect
  try {
    audio = o.source();
  } catch (e) {
    queueMicrotask(
      guard(() => fail(e instanceof VoiceError ? e : micFailed())),
    );
    return { stop: () => done, cancel: () => {}, flush: () => {} };
  }
  audio.on(
    "error",
    guard((e: unknown) => fail(e instanceof VoiceError ? e : micFailed())),
  );
  audio.on(
    "data",
    guard((d: Buffer) => {
      if (closed || stopping) return;
      o.onLevel(pcmDbfs(d));
      pending = Buffer.concat([pending, d]);
      pump();
    }),
  );

  getSttToken(o.creds, deps)
    .then((token) => {
      if (closed) return;
      const q = new URLSearchParams({
        "tenant-name": o.creds.tenant,
        token: `Bearer ${token}`,
      });
      const sock: WebSocket = new Socket(
        `wss://api.${o.creds.environment}.corti.app/audio-bridge/v2/transcribe?${q}`,
      );
      ws = sock;
      sock.binaryType = "arraybuffer";
      sock.onopen = () =>
        sock.send(
          JSON.stringify({
            type: "config",
            configuration: {
              primaryLanguage: o.language,
              interimResults: o.interims,
              // spokenPunctuation silently wins if both are set, so encode exactly one
              ...(o.punctuation === "spoken"
                ? { spokenPunctuation: true, automaticPunctuation: false }
                : { automaticPunctuation: true }),
              audioFormat: PCM,
              ...(o.keyterms.length
                ? { keyterms: { terms: o.keyterms.map((term) => ({ term })) } }
                : {}),
              ...(o.replacements.length
                ? { replacements: o.replacements }
                : {}),
              ...(Object.keys(o.formatting).length
                ? { formatting: o.formatting }
                : {}),
            },
          }),
        );
      ws.onmessage = guard((ev: MessageEvent) => {
        if (closed || typeof ev.data !== "string") return;
        let frame: unknown;
        try {
          frame = JSON.parse(ev.data);
        } catch {
          return; // a frame that is not JSON is not protocol
        }
        if (typeof frame !== "object" || frame === null) return;
        const m = frame as Record<string, unknown>;
        if (m.type === "CONFIG_ACCEPTED") {
          accepted = true;
          o.onReady();
          if (stopping) sendEnd(sock);
          else pump();
        } else if (typeof m.type === "string" && m.type.startsWith("CONFIG_")) {
          // after CONFIG_DENIED the server holds the socket open until its 10 s timeout
          const reason = str(m.reason);
          fail(
            new VoiceError(
              `Corti refused the settings · check skyr.json voice${reason ? `: ${oneLine(reason, REASON_CHARS)}` : ""}`,
            ),
          );
        } else if (m.type === "transcript") {
          const data = transcriptData(m.data);
          if (!data) return;
          // server text reaches the screen and the prompt: whole terminal sequences and invisibles go here
          const text = stripInvisible(stripTerminalSequences(data.text)).trim();
          if (data.isFinal) {
            lastFinalStart = data.start;
            if (text) o.onFinal(text);
          } else if (data.start > lastFinalStart) {
            o.onInterim(text);
          }
        } else if (m.type === "error") {
          const e = m.error;
          // Corti documents the reason as `error.details`
          const details =
            typeof e === "object" && e !== null
              ? str((e as Record<string, unknown>).details)
              : undefined;
          const reason = details ?? str(m.reason) ?? str(e);
          fail(
            new VoiceError(
              `Corti error${reason ? `: ${oneLine(reason, REASON_CHARS)}` : ""}`,
            ),
          );
        } else if (m.type === "ended") {
          ended = true;
          teardown();
        }
      });
      // the server drops TCP (1006) right after "ended"; that close is success
      ws.onclose = guard(() =>
        ended || (stopping && accepted)
          ? teardown()
          : fail(new VoiceError("connection to Corti lost")),
      );
      // every error is followed by close, which reports it
      ws.onerror = () => {};
    })
    .catch(
      guard((e: unknown) =>
        fail(e instanceof VoiceError ? e : signInUnreachable(e)),
      ),
    );

  return {
    stop() {
      if (stopping || closed) return done;
      stopping = true;
      audio?.destroy();
      // before acceptance the audio waits for it, bounded by the controller's arm deadline
      if (!accepted) return done;
      if (ws?.readyState === Socket.OPEN) sendEnd(ws);
      else teardown();
      return done;
    },
    cancel() {
      stopping = true;
      teardown();
    },
    flush() {
      if (!accepted || stopping || closed || ws?.readyState !== Socket.OPEN)
        return;
      if (pending.length) ws.send(pending);
      pending = Buffer.alloc(0);
      ws.send(JSON.stringify({ type: "flush" }));
    },
  };
}
