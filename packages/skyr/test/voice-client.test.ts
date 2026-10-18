/**
 * The Corti streaming client, driven only through the seams `SessionOptions` exposes: a fake
 * `fetch` (token + cache) and a fake `WebSocket` (config, transcripts, closes). Real network
 * and real auth stay out of the test. The token cache is module state, so `creds()` gives each
 * session an identity no earlier test has cached. Timers are fake, and a wait settles the
 * promises in flight rather than letting wall-clock time pass.
 */
import { PassThrough } from "node:stream";
import {
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import {
  getSttToken,
  type SessionOptions,
  type SttConfig,
  type SttSession,
  startSession,
  TOKEN_TIMEOUT_MS,
} from "../src/voice/client.js";
import type { SttCredentials } from "../src/voice/credentials.js";
import { DEFAULT_TIMING } from "../src/voice/dictation.js";
import { VoiceError } from "../src/voice/errors.js";
import { CREDS } from "./voice.js";

/** Settles pending promise chains: queued from a continuation, a nextTick runs only once the microtask queue is empty. */
const settled = () => new Promise<void>((r) => process.nextTick(r));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

class FakeSocket {
  /** Node's global WebSocket exposes these as statics; startSession reads `Socket.OPEN`. */
  static OPEN = 1;

  static instances: FakeSocket[] = [];

  url: string;
  binaryType = "";
  readyState = FakeSocket.OPEN;
  sent: (string | Buffer)[] = [];
  onopen?: () => void;
  onmessage?: (ev: { data: unknown }) => void;
  onclose?: () => void;
  onerror?: () => void;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string | Buffer) {
    this.sent.push(data);
  }

  /** Node's `close()` changes readyState only; the test drives the close event itself. */
  close() {
    this.readyState = 3;
  }

  /** Drives the client as the server would: a text frame of JSON. */
  server(data: unknown) {
    this.onmessage?.({
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
  }

  /** The whole audio the client sent, in order. */
  audio(): Buffer[] {
    return this.sent.filter((d): d is Buffer => typeof d !== "string");
  }

  control(): Record<string, unknown>[] {
    return this.sent
      .filter((d) => typeof d === "string")
      .map((d) => JSON.parse(String(d)) as Record<string, unknown>);
  }
}
const sockets = () => FakeSocket.instances;
const SocketMaker = FakeSocket as unknown as typeof WebSocket;

/** English, interims on, automatic punctuation and no vocabulary: what a test's session asks Corti for. */
const CONFIG: SttConfig = {
  language: "en",
  interims: true,
  punctuation: "automatic",
  keyterms: [],
  replacements: [],
};

let salt = 0;
/** A fresh identity per call, so the module's token cache never carries over between tests. */
const creds = (): SttCredentials => ({ ...CREDS, clientId: `id${++salt}` });

/** A fetch that always yields the wanted token; counted so cache tests can watch it. */
function tokenFetch(
  times: number[],
  token: string,
  expiresIn: number,
): typeof fetch {
  return (async () => {
    times.push(Date.now());
    return new Response(
      JSON.stringify({ access_token: token, expires_in: expiresIn }),
    );
  }) as unknown as typeof fetch;
}

interface Drive {
  session: SttSession;
  source: PassThrough;
  onError: ReturnType<typeof vi.fn>;
  final: ReturnType<typeof vi.fn>;
  interim: ReturnType<typeof vi.fn>;
  sock: FakeSocket;
}

/** Starts a session with every fake injected; the socket exists once the sign-in has settled. */
async function drive(o: Partial<SessionOptions> = {}): Promise<Drive> {
  const before = sockets().length;
  const source = new PassThrough();
  const onError = vi.fn();
  const final = vi.fn();
  const interim = vi.fn();
  const session = startSession({
    ...CONFIG,
    creds: creds(),
    onReady: () => {},
    onLevel: () => {},
    source: () => source,
    onInterim: interim,
    onFinal: final,
    onError,
    fetch: tokenFetch([], "tok", 3600),
    WebSocket: SocketMaker,
    ...o,
  });
  onTestFinished(() => void source.destroy());
  await settled();
  const sock = sockets()[before]!;
  return { session, source, onError, final, interim, sock };
}

const writePcm = (source: PassThrough, bytes: number) =>
  source.write(Buffer.alloc(bytes, 4));

test("one token serves an identity until a minute before expiry", async () => {
  const a: number[] = [];
  const c = { ...CREDS, clientId: "c-a" };
  expect(await getSttToken(c, { fetch: tokenFetch(a, "t-a", 3600) })).toBe(
    "t-a",
  );
  expect(await getSttToken(c, { fetch: tokenFetch(a, "t-a", 3600) })).toBe(
    "t-a",
  );
  expect(a).toHaveLength(1);
  // expires_in at the margin leaves nothing to live on: a dying token is refetched
  const e: number[] = [];
  const f = { ...CREDS, clientId: "c-e" };
  await getSttToken(f, { fetch: tokenFetch(e, "t-e", 60) });
  await getSttToken(f, { fetch: tokenFetch(e, "t-e", 60) });
  expect(e).toHaveLength(2);
});

test("another identity gets its own token", async () => {
  const a: number[] = [];
  const b: number[] = [];
  const c = { ...CREDS, clientId: "c-a" };
  const d = { ...CREDS, clientId: "c-b" };
  expect(await getSttToken(c, { fetch: tokenFetch(a, "t-a", 3600) })).toBe(
    "t-a",
  );
  expect(await getSttToken(d, { fetch: tokenFetch(b, "t-b", 3600) })).toBe(
    "t-b",
  );
  // one fetch per identity, never shared
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
});

/** A fetch that answers every request with `status`. */
const answering = (status: number) =>
  (async () => new Response("no", { status })) as unknown as typeof fetch;

test.each([400, 401, 403])(
  "a sign-in refused with %i names the client credentials and their fix",
  async (status) => {
    await expect(
      getSttToken(creds(), { fetch: answering(status) }),
    ).rejects.toThrow(
      "Corti refused the client · check CORTI_CLIENT_ID and CORTI_CLIENT_SECRET",
    );
  },
);

test("a 404 at sign-in is an unknown tenant, not an outage", async () => {
  await expect(getSttToken(creds(), { fetch: answering(404) })).rejects.toThrow(
    "unknown Corti tenant · check CORTI_TENANT_NAME",
  );
});

test("any other sign-in status is named with its HTTP code", async () => {
  await expect(getSttToken(creds(), { fetch: answering(500) })).rejects.toThrow(
    "Corti sign-in failed (HTTP 500)",
  );
});

test("a sign-in request that never gets an answer reads as can't reach Corti", async () => {
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await expect(getSttToken(creds(), { fetch: offline })).rejects.toThrow(
    "can't reach Corti",
  );
});

test("DNS naming the sign-in host as unknown points at a mistyped environment", async () => {
  const offline = (async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(
        new Error("getaddrinfo ENOTFOUND auth.eux.corti.app"),
        {
          code: "ENOTFOUND",
        },
      ),
    });
  }) as unknown as typeof fetch;
  await expect(getSttToken(creds(), { fetch: offline })).rejects.toThrow(
    "can't reach Corti (ENOTFOUND) · check CORTI_ENVIRONMENT",
  );
});

test("a plain recorder failure reads as microphone unavailable", async () => {
  const onError = vi.fn();
  startSession({
    ...CONFIG,
    creds: creds(),
    onReady: () => {},
    onLevel: () => {},
    source: () => {
      throw new Error("spawn went wrong");
    },
    onInterim: () => {},
    onFinal: () => {},
    onError,
    fetch: tokenFetch([], "tok", 3600),
    WebSocket: SocketMaker,
  });
  await settled();
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "microphone unavailable" }),
  );
});

test("no audio leaves before Corti accepts the config; after, it goes in 8,000 B chunks", async () => {
  const h = await drive();
  writePcm(h.source, 12_000); // held by the client until the pump can discharge it
  h.sock.onopen?.();
  expect(h.sock.audio()).toEqual([]);
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  // 8,000 out of 12,000; the rest waits for a whole chunk
  expect(h.sock.audio().map((f) => f.length)).toEqual([8_000]);
  writePcm(h.source, 4_000);
  expect(h.sock.audio().map((f) => f.length)).toEqual([8_000, 8_000]);
  h.session.cancel();
});

test("the voice settings reach Corti's config with exactly one punctuation mode", async () => {
  const h = await drive({
    language: "da",
    interims: true,
    punctuation: "spoken",
    keyterms: ["keyterm k"],
    replacements: [{ find: "teh", replace: "the" }],
  });
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  const config = h.sock.control()[0]!.configuration as Record<string, unknown>;
  expect(config.primaryLanguage).toBe("da");
  expect(config.interimResults).toBe(true);
  // the union picks one: spoken ⇒ spokenPunctuation true, automaticPunctuation false
  expect(config.spokenPunctuation).toBe(true);
  expect(config.automaticPunctuation).toBe(false);
  expect(config.keyterms).toEqual({ terms: [{ term: "keyterm k" }] });
  expect(config.replacements).toEqual([{ find: "teh", replace: "the" }]);
  expect(config.audioFormat).toContain("rate=16000");
  h.session.cancel();
});

test("interims off is sent as off, automatic punctuation as its one flag, and an empty vocabulary not at all", async () => {
  const h = await drive({ interims: false });
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  const config = h.sock.control()[0]!.configuration as Record<string, unknown>;
  expect(config.primaryLanguage).toBe("en");
  expect(config.interimResults).toBe(false);
  expect(config.automaticPunctuation).toBe(true);
  expect(config.spokenPunctuation).toBeUndefined();
  expect(config.keyterms).toBeUndefined();
  expect(config.replacements).toBeUndefined();
  h.session.cancel();
});

test("other CONFIG_* frames are a config failure: the mic and socket close, and the error is told once", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_DENIED", reason: "tenant not found" });
  expect(h.onError).toHaveBeenCalledWith(
    expect.objectContaining({
      message:
        "Corti refused the settings · check skyr.json voice: tenant not found",
    }),
  );
  expect(h.source.destroyed).toBe(true);
  expect(h.sock.readyState).toBe(3);
  // the server's own close afterwards is not a second failure
  h.sock.onclose?.();
  expect(h.onError).toHaveBeenCalledTimes(1);
});

test("an interim shows as provisional text and its final commits it", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.server({
    type: "transcript",
    data: { text: "hello there", start: 0, isFinal: false },
  });
  expect(h.interim).toHaveBeenCalledWith("hello there");
  h.sock.server({
    type: "transcript",
    data: { text: "hello there", start: 0, isFinal: true },
  });
  expect(h.final).toHaveBeenCalledWith("hello there");
  h.session.cancel();
});

test("terminal sequences and invisible characters in server text never reach the editor", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.server({
    type: "transcript",
    data: {
      text: "clear\x1b[2J the \x1b]52;c;aGk=\x07screen\u202e now",
      start: 0,
      isFinal: true,
    },
  });
  expect(h.final).toHaveBeenCalledWith("clear the screen now");
  h.session.cancel();
});

test("ended and then a 1006 close is success: the final is delivered and the stop resolves", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.server({
    type: "transcript",
    data: { text: "one last word", start: 0, isFinal: true },
  });
  h.sock.server({ type: "ended" });
  await expect(h.session.stop()).resolves.toBeUndefined();
  expect(h.final.mock.calls).toEqual([["one last word"]]);
  expect(h.onError).not.toHaveBeenCalled();
  // the server's own 1006 drop after `ended` is the success path's tail; teardown stays idempotent
  h.sock.onclose?.();
});

test("a stop sends the last partial chunk before `end`, so the final word reaches Corti", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  writePcm(h.source, 5_000);
  const stop = h.session.stop();
  expect(h.sock.audio().at(-1)?.length).toBe(5_000);
  expect(h.sock.control().at(-1)).toEqual({ type: "end" });
  h.sock.server({ type: "ended" });
  h.sock.onclose?.();
  await expect(stop).resolves.toBeUndefined();
});

test("a stop before Corti accepts holds the audio, then sends it and `end` once Corti does", async () => {
  const h = await drive();
  h.sock.onopen?.();
  writePcm(h.source, 5_000);
  const stop = h.session.stop();
  expect(h.sock.audio()).toEqual([]);
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  expect(h.sock.audio().at(-1)?.length).toBe(5_000);
  expect(h.sock.control().at(-1)).toEqual({ type: "end" });
  h.sock.server({ type: "ended" });
  h.sock.onclose?.();
  await expect(stop).resolves.toBeUndefined();
});

test("audio held through a long wait for acceptance still leaves in frames under Corti's cap", async () => {
  const h = await drive();
  h.sock.onopen?.();
  writePcm(h.source, 70_000); // over two seconds, past Corti's 64,000 B frame cap
  void h.session.stop();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  const frames = h.sock.audio();
  expect(frames.every((f) => f.length <= 8_000)).toBe(true);
  expect(frames.reduce((n, f) => n + f.length, 0)).toBe(70_000);
  h.session.cancel();
});

test("a stop before Corti accepts still reports the session failing, since nothing reached Corti", async () => {
  const h = await drive();
  h.sock.onopen?.();
  void h.session.stop();
  h.sock.onclose?.();
  expect(h.onError).toHaveBeenCalledTimes(1);
});

test("a premature close is a network failure", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.readyState = 3;
  h.sock.onclose?.();
  expect(h.onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "connection to Corti lost" }),
  );
  await expect(h.session.stop()).resolves.toBeUndefined();
});

test("frames not shaped as Corti documents them are ignored, and the session carries on", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  for (const frame of [
    "null",
    "[]",
    "7",
    { type: 1 },
    { type: "transcript" },
    { type: "transcript", data: { text: 5, start: 0, isFinal: true } },
  ])
    expect(() => h.sock.server(frame)).not.toThrow();
  h.sock.server({
    type: "transcript",
    data: { text: "still here", start: 0, isFinal: true },
  });
  expect(h.final).toHaveBeenCalledWith("still here");
  expect(h.onError).not.toHaveBeenCalled();
  h.session.cancel();
});

test("a listener that throws ends the session with an error instead of escaping to Pi", async () => {
  const h = await drive({
    onFinal: () => {
      throw new Error("editor broke");
    },
  });
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  expect(() =>
    h.sock.server({
      type: "transcript",
      data: { text: "boom", start: 0, isFinal: true },
    }),
  ).not.toThrow();
  expect(h.onError).toHaveBeenCalledTimes(1);
  expect(h.onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "internal error" }),
  );
});

test("a listener and onError that both throw still tear the session down, and stop resolves", async () => {
  const h = await drive({
    onFinal: () => {
      throw new Error("editor broke");
    },
    onError: () => {
      throw new Error("controller broke");
    },
  });
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  expect(() =>
    h.sock.server({
      type: "transcript",
      data: { text: "boom", start: 0, isFinal: true },
    }),
  ).not.toThrow();
  expect(h.sock.readyState).toBe(3);
  expect(h.source.destroyed).toBe(true);
  await expect(h.session.stop()).resolves.toBeUndefined();
});

test("a recorder that fails to start, reported to an onError that throws, never escapes to Pi", async () => {
  const escaped: unknown[] = [];
  const record = (e: unknown) => escaped.push(e);
  process.on("uncaughtException", record);
  onTestFinished(() => void process.off("uncaughtException", record));
  const session = startSession({
    ...CONFIG,
    creds: creds(),
    onReady: () => {},
    onLevel: () => {},
    source: () => {
      throw new Error("spawn failed");
    },
    onInterim: () => {},
    onFinal: () => {},
    onError: () => {
      throw new Error("controller broke");
    },
    fetch: tokenFetch([], "tok", 3600),
    WebSocket: SocketMaker,
  });
  await settled();
  expect(escaped).toEqual([]);
  await expect(session.stop()).resolves.toBeUndefined();
});

test("a sign-in answer without a usable token fails as unreadable, never as a socket with no token", async () => {
  for (const body of ["{}", '{"access_token":7}', "not json"])
    await expect(
      getSttToken(creds(), {
        fetch: (async () => new Response(body)) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Corti sign-in sent an unreadable answer");
});

test("the interim Corti re-sends after a final is dropped, so a stop never commits the words twice", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  const transcript = (text: string, start: number, isFinal: boolean) =>
    h.sock.server({ type: "transcript", data: { text, start, isFinal } });
  transcript("hello there", 0, false);
  transcript("hello there", 0, true);
  transcript("hello there", 0, false);
  expect(h.interim).toHaveBeenCalledTimes(1);
  // the next segment starts past the final, so its interim still shows
  transcript("and more", 1.2, false);
  expect(h.interim).toHaveBeenLastCalledWith("and more");
  expect(h.interim).toHaveBeenCalledTimes(2);
  const stop = h.session.stop();
  h.sock.server({ type: "ended" });
  await expect(stop).resolves.toBeUndefined();
  expect(h.final.mock.calls).toEqual([["hello there"]]);
});

test("a Corti error frame ends the session with an error", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.server({ type: "error", error: "boom" });
  expect(h.onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Corti error: boom" }),
  );
  expect(h.sock.readyState).toBe(3);
});

test("a failure while a stop drains is not reported: the stop resolves and the finals stand", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.server({
    type: "transcript",
    data: { text: "kept words", start: 0, isFinal: true },
  });
  const stop = h.session.stop();
  h.sock.server({ type: "error" });
  await expect(stop).resolves.toBeUndefined();
  expect(h.final.mock.calls).toEqual([["kept words"]]);
  expect(h.onError).not.toHaveBeenCalled();
});

test("a close while a stop drains resolves the stop, with the finals kept and no error", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.server({
    type: "transcript",
    data: { text: "kept words", start: 0, isFinal: true },
  });
  const stop = h.session.stop();
  h.sock.onclose?.();
  await expect(stop).resolves.toBeUndefined();
  expect(h.final.mock.calls).toEqual([["kept words"]]);
  expect(h.onError).not.toHaveBeenCalled();
});

test("after cancel no callback fires, whatever the server still sends", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.session.cancel();
  h.sock.server({
    type: "transcript",
    data: { text: "late interim", start: 0, isFinal: false },
  });
  h.sock.server({
    type: "transcript",
    data: { text: "late final", start: 0, isFinal: true },
  });
  h.sock.server({ type: "error" });
  h.sock.onclose?.();
  expect(h.interim).not.toHaveBeenCalled();
  expect(h.final).not.toHaveBeenCalled();
  expect(h.onError).not.toHaveBeenCalled();
});

test("when Corti never sends ended, a stop still resolves after the end timeout, the finals kept", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.server({
    type: "transcript",
    data: { text: "kept words", start: 0, isFinal: true },
  });
  let resolved = false;
  void h.session.stop().then(() => {
    resolved = true;
  });
  await vi.advanceTimersByTimeAsync(2_499);
  expect(resolved).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(resolved).toBe(true);
  expect(h.final.mock.calls).toEqual([["kept words"]]);
  expect(h.onError).not.toHaveBeenCalled();
});

test("a flush before Corti accepts the config sends nothing", async () => {
  const onLevel = vi.fn();
  const h = await drive({ onLevel });
  h.sock.onopen?.();
  writePcm(h.source, 5_000);
  // the chunk reached the client: it is buffered, waiting for Corti's answer
  expect(onLevel).toHaveBeenCalledTimes(1);
  h.session.flush();
  expect(h.sock.audio()).toEqual([]);
  expect(h.sock.control().map((c) => c.type)).toEqual(["config"]);
  h.session.cancel();
});

test("each recorder chunk's level reaches onLevel in dBFS", async () => {
  const onLevel = vi.fn();
  const h = await drive({ onLevel });
  // every sample is 0x0404: an RMS of 1,028 against 32,768 full scale
  writePcm(h.source, 5_000);
  expect(onLevel).toHaveBeenCalledWith(expect.closeTo(-30.07, 2));
  h.session.cancel();
});

test("a recorder that fails with its own reason reports that reason", async () => {
  const onError = vi.fn();
  startSession({
    ...CONFIG,
    creds: creds(),
    onReady: () => {},
    onLevel: () => {},
    source: () => {
      throw new VoiceError("sox not found · brew install sox");
    },
    onInterim: () => {},
    onFinal: () => {},
    onError,
    fetch: tokenFetch([], "tok", 3600),
    WebSocket: SocketMaker,
  });
  await settled();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "sox not found · brew install sox" }),
  );
});

test("a hung sign-in times out by name after 8 s", async () => {
  // as fetch does, a hung request rejects with its signal's reason once that aborts
  const hung: typeof fetch = (_url, init) =>
    new Promise<never>((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason),
      ),
    );
  let failure: unknown;
  getSttToken(creds(), { fetch: hung }).catch((error: unknown) => {
    failure = error;
  });
  await vi.advanceTimersByTimeAsync(7_999);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(failure).toEqual(
    expect.objectContaining({
      message: "Corti sign-in didn't answer in 8 s",
    }),
  );
});

test("the sign-in deadline is shorter than the arm window, so a dead auth is named first", () => {
  expect(TOKEN_TIMEOUT_MS).toBeLessThan(DEFAULT_TIMING.armTimeoutMs);
});
