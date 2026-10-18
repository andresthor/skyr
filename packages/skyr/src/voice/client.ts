/**
 * Corti `/transcribe` streaming client. Zero dependencies: Node 22's global
 * `fetch` and `WebSocket` (auth rides in the query string, so no headers are needed).
 * `@corti/sdk` is deliberately not used: its socket reconnects on the server's
 * normal 1006 close after `ended`.
 */
import type { Readable } from "node:stream";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { stripInvisible } from "../tools/render.js";
import type { SttCredentials } from "./credentials.js";
import {
  connectionLost,
  cortiError,
  credentialsRefused,
  internalError,
  micFailed,
  settingsRefused,
  signInFailed,
  signInNoAnswer,
  signInUnreachable,
  signInUnreadable,
  unknownTenant,
  VoiceError,
} from "./errors.js";
import { pcmRms, SAMPLE_RATE_HZ } from "./mic.js";

const PCM = `audio/pcm; rate=${SAMPLE_RATE_HZ}; channels=1; bits=16; endian=little; encoding=sint`;
/** 250 ms at 16 kHz s16le, Corti's recommended chunk; the hard cap is 64 000 B. */
const CHUNK_BYTES = 8_000;
/** Past this after `end` the caller keeps the last interim; flushing on quiet usually has the final in already. */
const END_TIMEOUT_MS = 2_500;

/** A frame field read as Corti documents it, or undefined; frames are untrusted input. */
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Corti's two punctuation modes: inferred from the audio, or only where the speaker says it. */
export type Punctuation = "automatic" | "spoken";

/** A rewrite Corti applies to the transcript; `find` matches case-insensitively. */
export interface Replacement {
  find: string;
  replace: string;
}

/** What a Corti session is configured with: the settings the skyr.json voice section carries. */
export interface SttConfig {
  /** Corti primaryLanguage. */
  language: string;
  /** Interims drive the ghost text; off only when a locale mishandles them. */
  interims: boolean;
  /** The two modes are exclusive server-side; exactly one is sent. */
  punctuation: Punctuation;
  /** Sent as given; voice/config.ts mergeVocabulary adds the built-ins. */
  keyterms: readonly string[];
  replacements: readonly Replacement[];
}

/** A field left out takes Corti's default: "en", interims on, automatic punctuation, no vocabulary. */
export interface SessionOptions extends Partial<SttConfig> {
  creds: SttCredentials;
  source: () => Readable;
  /** Server accepted the config; audio is flowing. */
  onReady?: () => void;
  onInterim: (segment: string) => void;
  onFinal: (segment: string) => void;
  /** RMS 0..1 of each captured chunk, roughly every 64 ms. */
  onLevel?: (rms: number) => void;
  onError: (err: VoiceError) => void;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
}

export interface SttSession {
  /** Stop capture and drain the remaining finals through `onFinal`; resolves once the session is closed. */
  stop(): Promise<void>;
  /** Drop everything now. No more callbacks fire. */
  cancel(): void;
  /** Ask for the pending segment's final now (about 1 s) instead of at the next pause or `end`. */
  flush?(): void;
}

let cached: { key: string; token: string; exp: number } | undefined;

/** Sign-in deadline: shorter than the controller's 10 s arm window, so a dead auth is
 * named for what it is before the whole session gives up. */
export const TOKEN_TIMEOUT_MS = 8_000;
/** A token this close to expiry is not worth starting a session on. */
const TOKEN_MARGIN_S = 60;

/** Seam for tests: global fetch offline, and a deadline a test can shorten. */
export interface TokenDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export async function getSttToken(
  creds: SttCredentials,
  { fetch: doFetch = fetch, timeoutMs = TOKEN_TIMEOUT_MS }: TokenDeps = {},
): Promise<string> {
  const key = `${creds.environment}\0${creds.tenant}\0${creds.clientId}`;
  if (cached?.key === key && Date.now() < cached.exp) return cached.token;
  const url = `https://auth.${creds.environment}.corti.app/realms/${encodeURIComponent(creds.tenant)}/protocol/openid-connect/token`;
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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // AbortSignal.timeout rejects as a TimeoutError; every other failure is a reachability one
    throw error instanceof Error && error.name === "TimeoutError"
      ? signInNoAnswer(timeoutMs)
      : signInUnreachable(error);
  }
  if (res.status === 400 || res.status === 401 || res.status === 403)
    throw credentialsRefused();
  if (res.status === 404) throw unknownTenant();
  if (!res.ok) throw signInFailed(res.status);
  const body: unknown = await res.json().catch(() => undefined);
  const { access_token: token, expires_in: expiresIn } =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  if (typeof token !== "string" || typeof expiresIn !== "number")
    throw signInUnreadable();
  // a token only has to be valid at connect time; the margin keeps a session from starting on a dying one
  cached = {
    key,
    token,
    exp: Date.now() + (expiresIn - TOKEN_MARGIN_S) * 1000,
  };
  return token;
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

/** Token fetch is the slowest step of arming; do it early when voice is likely. */
export function prewarmToken(creds: SttCredentials, deps?: TokenDeps): void {
  // a failed prewarm is retried, and reported, by the session's own sign-in
  getSttToken(creds, deps).catch(() => {});
}

/** Opens the mic and a Corti session. No callback in `o` runs before this returns. */
export function startSession(o: SessionOptions): SttSession {
  const Socket = o.WebSocket ?? WebSocket;
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
    if (!stopping) o.onError(err);
  };
  // socket and stream events run outside Pi's handlers, where a throw is an uncaughtException and Pi exits
  const guard =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      try {
        fn(...a);
      } catch {
        try {
          fail(internalError());
        } catch {} // onError itself threw: the session is already torn down, and a throw here would exit Pi
      }
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
    return { stop: () => done, cancel: () => {} };
  }
  audio.on(
    "error",
    guard((e: unknown) => fail(e instanceof VoiceError ? e : micFailed())),
  );
  audio.on(
    "data",
    guard((d: Buffer) => {
      if (closed || stopping) return;
      o.onLevel?.(pcmRms(d));
      pending = Buffer.concat([pending, d]);
      pump();
    }),
  );

  getSttToken(o.creds, { fetch: o.fetch })
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
              primaryLanguage: o.language ?? "en",
              interimResults: o.interims !== false,
              // spokenPunctuation silently wins if both are set, so encode exactly one
              ...(o.punctuation === "spoken"
                ? { spokenPunctuation: true, automaticPunctuation: false }
                : { automaticPunctuation: true }),
              audioFormat: PCM,
              ...(o.keyterms?.length
                ? { keyterms: { terms: o.keyterms.map((term) => ({ term })) } }
                : {}),
              ...(o.replacements?.length
                ? { replacements: o.replacements }
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
          o.onReady?.();
          pump();
        } else if (typeof m.type === "string" && m.type.startsWith("CONFIG_")) {
          // after CONFIG_DENIED the server holds the socket open until its 10 s timeout
          fail(settingsRefused(str(m.reason)));
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
          fail(cortiError(str(m.reason) ?? str(m.error)));
        } else if (m.type === "ended") {
          ended = true;
          teardown();
        }
      });
      // the server drops TCP (1006) right after "ended"; that close is success
      ws.onclose = guard(() =>
        ended || stopping ? teardown() : fail(connectionLost()),
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
      if (accepted && ws?.readyState === Socket.OPEN) {
        if (pending.length) ws.send(pending);
        pending = Buffer.alloc(0);
        ws.send(JSON.stringify({ type: "end" }));
        setTimeout(teardown, END_TIMEOUT_MS).unref();
      } else teardown();
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
