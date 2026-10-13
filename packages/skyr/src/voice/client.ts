/**
 * Corti `/transcribe` streaming client. Zero dependencies: Node 22's global
 * `fetch` and `WebSocket` (auth rides in the query string, so no headers are needed).
 * `@corti/sdk` is deliberately not used: its socket reconnects on the server's
 * normal 1006 close after `ended`.
 */
import type { Readable } from "node:stream";
import type { SttCredentials } from "./credentials.js";
import { VoiceError } from "./errors.js";
import { pcmRms } from "./mic.js";
import { TranscriptAssembler } from "./transcript.js";

const PCM =
  "audio/pcm; rate=16000; channels=1; bits=16; endian=little; encoding=sint";
/** 250 ms at 16 kHz s16le, Corti's recommended chunk; the hard cap is 64 000 B. */
const CHUNK = 8000;
/** Past this after `end` the caller keeps the last interim; flushing on quiet usually has the final in already. */
const END_TIMEOUT_MS = 2500;

export interface SessionOptions {
  creds: SttCredentials;
  source: () => Readable;
  /** Corti primaryLanguage; "en" server-side default when omitted. */
  language?: string;
  /** Interims drive the ghost text; off only when a locale mishandles them. */
  interims?: boolean;
  /** The two punctuation modes are exclusive server-side; exactly one is sent. */
  punctuation?: "automatic" | "spoken";
  /** User + built-in vocabulary, pre-merged (voice/config.ts mergeVocabulary). */
  keyterms?: readonly string[];
  replacements?: readonly { find: string; replace: string }[];
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
  /** Stop capture, drain the remaining finals, resolve with everything committed. */
  stop(): Promise<string>;
  /** Drop everything now. No more callbacks fire. */
  cancel(): void;
  /** Ask for the pending segment's final now (about 1 s) instead of at the next pause or `end`. */
  flush?(): void;
}

let cached: { key: string; token: string; exp: number } | undefined;

export async function getSttToken(
  creds: SttCredentials,
  doFetch: typeof fetch = fetch,
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
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new VoiceError("network", "can't reach Corti");
  }
  if (res.status === 400 || res.status === 401 || res.status === 403)
    throw new VoiceError("auth", "credentials rejected");
  if (!res.ok)
    throw new VoiceError("network", `Corti auth unavailable (${res.status})`);
  const body = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  // a token only has to be valid at connect time; the margin keeps a session from starting on a dying one
  cached = {
    key,
    token: body.access_token,
    exp: Date.now() + (body.expires_in - 60) * 1000,
  };
  return body.access_token;
}

/** Token fetch is the slowest step of arming; do it early when voice is likely. */
export function prewarmToken(creds: SttCredentials): void {
  getSttToken(creds).catch(() => {});
}

export function startSession(o: SessionOptions): SttSession {
  const Socket = o.WebSocket ?? WebSocket;
  const transcript = new TranscriptAssembler();
  let ws: WebSocket | undefined;
  let audio: Readable | undefined;
  let pending = Buffer.alloc(0);
  let accepted = false;
  let stopping = false;
  let ended = false;
  let closed = false;
  let resolveStop!: (text: string) => void;
  const done = new Promise<string>((r) => (resolveStop = r));

  const teardown = () => {
    if (closed) return;
    closed = true;
    audio?.destroy();
    try {
      ws?.close();
    } catch {}
    resolveStop(transcript.committed);
  };
  const fail = (err: VoiceError) => {
    if (closed) return;
    if (!stopping) o.onError(err);
    teardown();
  };
  const pump = () => {
    while (
      accepted &&
      !stopping &&
      pending.length >= CHUNK &&
      ws?.readyState === Socket.OPEN
    ) {
      ws.send(pending.subarray(0, CHUNK));
      pending = pending.subarray(CHUNK);
    }
  };

  // capture starts before the socket so the ~500 ms recorder spawn overlaps auth and connect
  try {
    audio = o.source();
  } catch (e) {
    queueMicrotask(() =>
      fail(
        e instanceof VoiceError
          ? e
          : new VoiceError("mic", "no microphone found"),
      ),
    );
    return { stop: () => done, cancel: () => {} };
  }
  audio.on("error", (e) =>
    fail(
      e instanceof VoiceError
        ? e
        : new VoiceError("mic", "no microphone found"),
    ),
  );
  audio.on("data", (d: Buffer) => {
    if (closed || stopping) return;
    o.onLevel?.(pcmRms(d));
    pending = Buffer.concat([pending, d]);
    pump();
  });

  getSttToken(o.creds, o.fetch).then(
    (token) => {
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
      ws.onmessage = (ev) => {
        if (closed || typeof ev.data !== "string") return;
        let m: {
          type?: string;
          reason?: string;
          data?: { text?: string; start?: number; isFinal?: boolean };
        };
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.type === "CONFIG_ACCEPTED") {
          accepted = true;
          o.onReady?.();
          pump();
        } else if (m.type?.startsWith("CONFIG_")) {
          // after CONFIG_DENIED the server holds the socket open until its 10 s timeout
          fail(new VoiceError("config", "Corti rejected the session"));
        } else if (m.type === "transcript" && m.data) {
          const u = transcript.accept({
            text: m.data.text ?? "",
            start: m.data.start ?? 0,
            isFinal: m.data.isFinal === true,
          });
          if (u.kind === "final") o.onFinal(u.segment);
          else if (u.kind === "interim") o.onInterim(u.segment);
        } else if (m.type === "error") {
          fail(new VoiceError("network", "Corti transcription error"));
        } else if (m.type === "ended") {
          ended = true;
          teardown();
        }
      };
      // the server drops TCP (1006) right after "ended"; that close is success
      ws.onclose = () =>
        ended || stopping
          ? teardown()
          : fail(new VoiceError("network", "connection lost"));
      ws.onerror = () => {};
    },
    (e) =>
      fail(
        e instanceof VoiceError
          ? e
          : new VoiceError("network", "can't reach Corti"),
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
