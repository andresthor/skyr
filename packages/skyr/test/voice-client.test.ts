/**
 * The Corti streaming client, driven only through the seams `SessionOptions` exposes: a fake
 * `fetch` (token + cache) and a fake `WebSocket` (config, transcripts, closes). Real network
 * and real auth stay out of the test. The token cache is module state, so every test's
 * credentials get a fresh env\0tenant\0clientId key.
 */
import { PassThrough } from "node:stream";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  getSttToken,
  type SessionOptions,
  type SttSession,
  startSession,
} from "../src/voice/client.js";
import type { SttCredentials } from "../src/voice/credentials.js";
import { VoiceError } from "../src/voice/errors.js";
import { CREDS } from "./voice.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

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

/** Starts a session with every fake injected; the socket exists after two microtask ticks. */
async function drive(o: Partial<SessionOptions> = {}): Promise<Drive> {
  const before = sockets().length;
  const source = new PassThrough();
  const onError = vi.fn();
  const final = vi.fn();
  const interim = vi.fn();
  const session = startSession({
    creds: creds(),
    source: () => source,
    onInterim: interim,
    onFinal: final,
    onError,
    fetch: tokenFetch([], "tok", 3600),
    WebSocket: SocketMaker,
    ...o,
  } as SessionOptions);
  onTestFinished(() => void source.destroy());
  await tick();
  await tick();
  const sock = sockets()[before]!;
  return { session, source, onError, final, interim, sock };
}

const writePcm = (source: PassThrough, bytes: number) =>
  source.write(Buffer.alloc(bytes, 4));

test("getSttToken caches per env\\0tenant\\0clientId, with the 60 s margin", async () => {
  const a: number[] = [];
  const b: number[] = [];
  const c = { ...CREDS, clientId: "c-a" };
  const d = { ...CREDS, clientId: "c-b" };
  expect(await getSttToken(c, tokenFetch(a, "t-a", 3600))).toBe("t-a");
  expect(await getSttToken(c, tokenFetch(a, "t-a", 3600))).toBe("t-a");
  expect(await getSttToken(d, tokenFetch(b, "t-b", 3600))).toBe("t-b");
  // same token twice per identity, fresh per identity
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
  // expires_in at the margin leaves nothing to live on: a dying token is refetched
  const e: number[] = [];
  const f = { ...CREDS, clientId: "c-e" };
  await getSttToken(f, tokenFetch(e, "t-e", 60));
  await getSttToken(f, tokenFetch(e, "t-e", 60));
  expect(e).toHaveLength(2);
});

/** A fetch that answers every request with `status`. */
const answering = (status: number) =>
  (async () => new Response("no", { status })) as unknown as typeof fetch;

test.each([400, 401, 403])(
  "a sign-in refused with %i reads as rejected credentials",
  async (status) => {
    await expect(getSttToken(creds(), answering(status))).rejects.toThrow(
      "credentials rejected",
    );
  },
);

test("a failing sign-in server reads as Corti unavailable, never as rejected credentials", async () => {
  await expect(getSttToken(creds(), answering(500))).rejects.toThrow(
    "Corti auth unavailable (500)",
  );
});

test("a sign-in request that never gets an answer reads as can't reach Corti", async () => {
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await expect(getSttToken(creds(), offline)).rejects.toThrow(
    "can't reach Corti",
  );
});

test("CONFIG_ACCEPTED opens the pump at the 8,000 B chunk boundary, with the config per the union", async () => {
  const h = await drive({
    language: "da",
    interims: true,
    punctuation: "spoken",
    keyterms: ["keyterm k"],
    replacements: [{ find: "teh", replace: "the" }],
  });
  writePcm(h.source, 12_000); // accepted only after the pump discharges
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  expect(await vi.waitFor(() => h.sock.audio())).toHaveLength(1); // 8,000 out of 12,000
  writePcm(h.source, 4_000);
  await vi.waitFor(() => expect(h.sock.audio()).toHaveLength(2)); // 16,000 total = two chunks
  const config = h.sock.control()[0]!.configuration as Record<string, unknown>;
  expect(config.primaryLanguage).toBe("da");
  expect(config.interimResults).toBe(true);
  // the union picks one: spoken ⇒ spokenPunctuation true, automaticPunctuation false
  expect(config.spokenPunctuation).toBe(true);
  expect(config.automaticPunctuation).toBe(false);
  expect(config.keyterms).toEqual({ terms: [{ term: "keyterm k" }] });
  expect(config.replacements).toEqual([{ find: "teh", replace: "the" }]);
  expect(config.audioFormat).toContain("rate=16000");
});

test("the default punctuation union is automatic, no spoken key, and no keyterms section when empty", async () => {
  const h = await drive({ language: undefined, interims: undefined });
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  const config = h.sock.control()[0]!.configuration as Record<string, unknown>;
  expect(config.primaryLanguage).toBe("en");
  expect(config.interimResults).toBe(true);
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
      kind: "config",
      message: "Corti rejected the session",
    }),
  );
  expect(h.source.destroyed).toBe(true);
  expect(h.sock.readyState).toBe(3);
  // the server's own close afterwards is not a second failure
  h.sock.onclose?.();
  expect(h.onError).toHaveBeenCalledTimes(1);
});

test("transcripts route finals and interims", async () => {
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

test("ended and then a 1006 close is success: the committed text resolves", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.server({
    type: "transcript",
    data: { text: "one last word", start: 0, isFinal: true },
  });
  h.sock.server({ type: "ended" });
  await expect(h.session.stop()).resolves.toBe("one last word");
  expect(h.onError).not.toHaveBeenCalled();
  // the server's own 1006 drop after `ended` is the success path's tail; teardown stays idempotent
  h.sock.onclose?.();
});

test("a stop sends the pending bytes plus end; a server 1006 after `ended` resolves the drain", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  writePcm(h.source, 5_000);
  const stop = h.session.stop();
  expect(h.sock.audio().at(-1)?.length).toBe(5_000);
  expect(h.sock.control().at(-1)).toEqual({ type: "end" });
  h.sock.server({ type: "ended" });
  h.sock.onclose?.();
  await expect(stop).resolves.toBe("");
});

test("a premature close is a network failure", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.readyState = 3;
  h.sock.onclose?.();
  await vi.waitFor(() =>
    expect(h.onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "network", message: "connection lost" }),
    ),
  );
  await expect(h.session.stop()).resolves.toBe("");
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
  await expect(h.session.stop()).resolves.toBe("boom");
});

test("a recorder that fails to start, reported to an onError that throws, never escapes to Pi", async () => {
  const escaped: unknown[] = [];
  const record = (e: unknown) => escaped.push(e);
  process.on("uncaughtException", record);
  onTestFinished(() => void process.off("uncaughtException", record));
  const session = startSession({
    creds: creds(),
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
  await tick();
  expect(escaped).toEqual([]);
  await expect(session.stop()).resolves.toBe("");
});

test("a sign-in answer without a usable token fails as unreadable, never as a socket with no token", async () => {
  for (const body of ["{}", '{"access_token":7}', "not json"])
    await expect(
      getSttToken(
        creds(),
        (async () => new Response(body)) as unknown as typeof fetch,
      ),
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
  await expect(stop).resolves.toBe("hello there");
});

test("a Corti error frame ends the session with an error", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.server({ type: "error", error: "boom" });
  expect(h.onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Corti transcription error" }),
  );
  expect(h.sock.readyState).toBe(3);
});

test("a failure while a stop drains is not reported: the stop resolves with what was committed", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.server({
    type: "transcript",
    data: { text: "kept words", start: 0, isFinal: true },
  });
  const stop = h.session.stop();
  h.sock.server({ type: "error" });
  await expect(stop).resolves.toBe("kept words");
  expect(h.onError).not.toHaveBeenCalled();
});

test("a close while a stop drains resolves the committed text, with no error", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.server({
    type: "transcript",
    data: { text: "kept words", start: 0, isFinal: true },
  });
  const stop = h.session.stop();
  h.sock.onclose?.();
  await expect(stop).resolves.toBe("kept words");
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

test("when Corti never sends ended, a stop still resolves with the committed text after the end timeout", async () => {
  const h = await drive();
  h.sock.onopen?.();
  h.sock.server({ type: "CONFIG_ACCEPTED" });
  h.sock.server({
    type: "transcript",
    data: { text: "kept words", start: 0, isFinal: true },
  });
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  let resolved: string | undefined;
  void h.session.stop().then((text) => {
    resolved = text;
  });
  await vi.advanceTimersByTimeAsync(2_499);
  expect(resolved).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(resolved).toBe("kept words");
  expect(h.onError).not.toHaveBeenCalled();
});

test("a flush before Corti accepts the config sends nothing", async () => {
  const h = await drive();
  h.sock.onopen?.();
  writePcm(h.source, 5_000);
  await vi.waitFor(() => expect(h.source.readableLength).toBe(0));
  h.session.flush?.();
  expect(h.sock.audio()).toEqual([]);
  expect(h.sock.control().map((c) => c.type)).toEqual(["config"]);
  h.session.cancel();
});

test("a recorder that fails with its own reason reports that reason", async () => {
  const onError = vi.fn();
  startSession({
    creds: creds(),
    source: () => {
      throw new VoiceError("recorder", "needs sox · brew install sox");
    },
    onInterim: () => {},
    onFinal: () => {},
    onError,
    fetch: tokenFetch([], "tok", 3600),
    WebSocket: SocketMaker,
  });
  await tick();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "needs sox · brew install sox" }),
  );
});
