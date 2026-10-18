/**
 * The dictation state machine, driven entirely through the seams `DictationControllerOptions`
 * exposes: a fake session factory, explicit timing and a recorded sink. Timers are fake, so
 * every wait below is exact rather than a race against the wall clock.
 */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  SessionOptions,
  SttConfig,
  SttSession,
} from "../src/voice/client.js";
import type { DictationSink } from "../src/voice/dictation.js";
import {
  DictationController,
  type DictationTiming,
} from "../src/voice/dictation.js";
import { VoiceError } from "../src/voice/errors.js";
import { CREDS } from "./voice.js";

const TIMING: DictationTiming = {
  tailMs: 400,
  flushMs: 900,
  noSpeechMs: 8_000,
  maxMs: 120_000,
  armTimeoutMs: 10_000,
  errorHoldMs: 4_000,
  discardHoldMs: 2_000,
  stallMs: 1_500,
};

const CONFIG: SttConfig = {
  language: "en",
  interims: true,
  punctuation: "automatic",
  keyterms: [],
  replacements: [],
};

/** Chunk levels in dBFS: well above the speech gate, and room noise well below it. */
const SPEECH = -26;
const QUIET = -66;

type SinkEvent =
  | { op: "begin" | "end" | "revert" }
  | { op: "interim" | "final"; arg: string };

class FakeSession implements SttSession {
  stopCalls = 0;
  canceled = false;
  flushed = 0;

  constructor(private readonly stopResult: Promise<void>) {}

  stop = () => {
    this.stopCalls++;
    return this.stopResult;
  };

  cancel = () => {
    this.canceled = true;
  };

  flush = () => {
    this.flushed++;
  };
}

function harness(
  timing: Partial<DictationTiming> = {},
  o: {
    onLevel?: (dbfs: number) => void;
    stopNeverResolves?: boolean;
    sinkOverride?: Partial<DictationSink>;
  } = {},
) {
  const events: SinkEvent[] = [];
  const states: string[] = [];
  const sessions: FakeSession[] = [];
  const options: SessionOptions[] = [];
  let controller: DictationController;
  controller = new DictationController({
    creds: CREDS,
    config: () => CONFIG,
    sink: {
      begin: () => events.push({ op: "begin" }),
      interim: (s) => events.push({ op: "interim", arg: s }),
      final: (s) => events.push({ op: "final", arg: s }),
      end: () => events.push({ op: "end" }),
      revert: () => {
        events.push({ op: "revert" });
        return false;
      },
      ...o.sinkOverride,
    },
    onChange: () => states.push(controller.state),
    onLevel: o.onLevel ?? (() => {}),
    source: () => new PassThrough(),
    start: (opts) => {
      options.push(opts);
      const session = new FakeSession(
        o.stopNeverResolves ? new Promise<void>(() => {}) : Promise.resolve(),
      );
      sessions.push(session);
      return session;
    },
    timing: { ...TIMING, ...timing },
  });
  const opts = () => options.at(-1)!;
  return { controller, events, states, sessions, opts };
}

/** The recorder delivering chunks at `dbfs` for `ms`, one every 500 ms, as an open mic does. */
async function chunks(h: ReturnType<typeof harness>, ms: number, dbfs: number) {
  for (let t = 0; t < ms; t += 500) {
    h.opts().onLevel?.(dbfs);
    await vi.advanceTimersByTimeAsync(500);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("toggle arms, the session's acceptance listens, a stop keeps the words still showing as an interim", async () => {
  const h = harness();
  h.controller.toggle();
  expect(h.controller.state).toBe("arming");
  h.opts().onReady?.();
  expect(h.controller.state).toBe("listening");
  h.opts().onInterim?.("hey there");
  expect(h.events).toContainEqual({ op: "interim", arg: "hey there" });
  h.controller.toggle(); // stop-and-keep
  expect(h.controller.state).toBe("transcribing");
  expect(h.sessions[0]?.canceled).toBe(false);
  await vi.advanceTimersByTimeAsync(TIMING.tailMs);
  expect(h.controller.state).toBe("idle");
  // the interim was still the live segment: held back, then committed at the drain
  expect(h.events).toContainEqual({ op: "final", arg: "hey there" });
  expect(h.events[h.events.length - 1]).toEqual({ op: "end" });
  expect(h.sessions[0]?.stopCalls).toBe(1);
  expect(h.states).not.toContain("error");
});

test("a pause asks Corti for the pending final early; continuous speech never does", async () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  // speech pulses closer together than flushMs: each one re-arms the quiet timer
  for (let i = 0; i < 6; i++) {
    h.opts().onLevel?.(SPEECH);
    await vi.advanceTimersByTimeAsync(TIMING.flushMs - 100);
  }
  expect(h.sessions[0]?.flushed).toBe(0);
  // quiet reaches flushMs: the session is flushed, dictation still listening
  await vi.advanceTimersByTimeAsync(100);
  expect(h.sessions[0]?.flushed).toBe(1);
  expect(h.controller.state).toBe("listening");
  h.controller.cancel();
});

test("a stop after one final commits it once and ends without an error", async () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onFinal?.("kept words");
  h.controller.toggle();
  await vi.advanceTimersByTimeAsync(TIMING.tailMs);
  expect(h.controller.state).toBe("idle");
  expect(h.events.filter((e) => e.op === "final")).toEqual([
    { op: "final", arg: "kept words" },
  ]);
  expect(h.states).not.toContain("error");
});

test("a stop before anything was heard ends quietly: changing your mind is not an error", () => {
  const h = harness();
  h.controller.toggle();
  h.controller.toggle();
  expect(h.controller.state).toBe("idle");
  expect(h.states).not.toContain("error");
  expect(h.sessions[0]?.canceled).toBe(true);
});

test("Enter's stop after acceptance, still before anything was heard, ends quietly too", () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.controller.finish();
  expect(h.controller.state).toBe("idle");
  expect(h.states).not.toContain("error");
});

test("speech heard but nothing transcribed still fails with no words recognised, and the error auto-dismisses", async () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onLevel?.(SPEECH);
  h.controller.toggle();
  await vi.advanceTimersByTimeAsync(TIMING.tailMs);
  expect(h.controller.state).toBe("error");
  expect(h.controller.facts().message).toBe("no words recognised");
  await vi.advanceTimersByTimeAsync(TIMING.errorHoldMs);
  expect(h.controller.state).toBe("idle");
});

test("a failure keeps the words on screen and says so", () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onFinal?.("first sentence");
  h.opts().onInterim?.("and the second");
  h.opts().onError?.(new VoiceError("connection to Corti lost"));
  expect(h.controller.state).toBe("error");
  expect(h.controller.facts().message).toBe(
    "connection to Corti lost · words kept",
  );
  // the interim the user watched appear is committed, not dropped
  expect(h.events).toContainEqual({ op: "final", arg: "and the second" });
});

test("a failure before any words says only what went wrong", () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onError?.(new VoiceError("connection to Corti lost"));
  expect(h.controller.facts().message).toBe("connection to Corti lost");
});

test("the hard cap stops like Enter does, keeping the tail so the last word isn't clipped", async () => {
  const h = harness({ maxMs: 1_000 });
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onLevel?.(SPEECH);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.controller.state).toBe("transcribing");
  // the tail is still recording
  expect(h.sessions[0]?.stopCalls).toBe(0);
  expect(h.controller.facts().micOpen).toBe(true);
  await vi.advanceTimersByTimeAsync(TIMING.tailMs);
  expect(h.sessions[0]?.stopCalls).toBe(1);
});

test("Enter's stop through finish() drains the tail the same way as the toggle", async () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onInterim?.("word");
  h.controller.finish();
  expect(h.controller.state).toBe("transcribing");
  await vi.advanceTimersByTimeAsync(TIMING.tailMs - 1);
  // still mid-tail: the drain has not started
  expect(h.sessions[0]?.stopCalls).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.controller.state).toBe("idle");
  expect(h.events).toContainEqual({ op: "final", arg: "word" });
  expect(h.sessions[0]?.stopCalls).toBe(1);
});

test("Esc after committed words were reverted shows the discarded notice, ended by any key", () => {
  const h = harness({}, { sinkOverride: { revert: () => true } });
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onFinal?.("spoken words");
  h.controller.cancel();
  expect(h.controller.state).toBe("discarded");
  h.controller.dismiss();
  expect(h.controller.state).toBe("idle");
  expect(vi.getTimerCount()).toBe(0);
});

test("the discarded notice holds for its own window, then goes quiet", async () => {
  const h = harness({}, { sinkOverride: { revert: () => true } });
  h.controller.toggle();
  h.opts().onReady?.();
  h.controller.cancel();
  await vi.advanceTimersByTimeAsync(TIMING.discardHoldMs - 1);
  expect(h.controller.state).toBe("discarded");
  await vi.advanceTimersByTimeAsync(1);
  expect(h.controller.state).toBe("idle");
});

test("a toggle from the discarded notice starts a fresh dictation and drops the offer", () => {
  const h = harness({}, { sinkOverride: { revert: () => true } });
  h.controller.toggle();
  h.controller.cancel();
  expect(h.controller.state).toBe("discarded");
  h.controller.toggle();
  expect(h.controller.state).toBe("arming");
  expect(h.sessions).toHaveLength(2);
});

test("Esc cancels on the spot, puts the buffer back, and late session callbacks are dead", () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onFinal?.("spoken stuff");
  h.controller.cancel();
  expect(h.controller.state).toBe("idle");
  expect(h.sessions[0]?.canceled).toBe(true);
  // only the sink end and revert run, then silence
  expect(h.events.slice(-2)).toEqual([{ op: "end" }, { op: "revert" }]);
  const since = h.events.length;
  h.opts().onInterim?.("late words");
  h.opts().onFinal?.("late finals");
  expect(h.events).toHaveLength(since);
});

test("a mic that delivers only digital silence is reported as blocked in privacy settings", async () => {
  const h = harness();
  h.controller.toggle();
  for (let i = 0; i < 24; i++) h.opts().onLevel?.(Number.NEGATIVE_INFINITY);
  expect(h.controller.state).toBe("error");
  expect(h.controller.facts().message).toBe(
    "microphone blocked · allow it in System Settings › Privacy",
  );
  await vi.advanceTimersByTimeAsync(TIMING.errorHoldMs);
  expect(h.controller.state).toBe("idle");
});

test("never hearing speech fails with no speech, counted from when Corti accepted", async () => {
  const h = harness();
  h.controller.toggle();
  await vi.advanceTimersByTimeAsync(TIMING.armTimeoutMs - 1);
  h.opts().onReady?.();
  await vi.advanceTimersByTimeAsync(TIMING.noSpeechMs - 1);
  expect(h.controller.state).toBe("listening");
  await vi.advanceTimersByTimeAsync(1);
  expect(h.controller.state).toBe("error");
  expect(h.controller.facts().message).toBe(
    `no speech in ${TIMING.noSpeechMs / 1000} s`,
  );
  await vi.advanceTimersByTimeAsync(TIMING.errorHoldMs);
  expect(h.controller.state).toBe("idle");
});

test("text arriving while the meter stays under the speech gate keeps the dictation alive", async () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  // a soft voice: every chunk is below the gate, but Corti still hears words
  await chunks(h, 2_000, QUIET);
  h.opts().onInterim?.("soft words");
  await chunks(h, TIMING.noSpeechMs, QUIET);
  expect(h.controller.state).toBe("listening");
  expect(h.states).not.toContain("error");
  expect(h.controller.facts().heardSpeech).toBe(true);
  h.controller.cancel();
});

test("silence while Corti never accepts fails as Corti not answering, never as no speech", async () => {
  const h = harness();
  h.controller.toggle();
  await vi.advanceTimersByTimeAsync(TIMING.armTimeoutMs);
  expect(h.controller.state).toBe("error");
  expect(h.controller.facts().message).toBe(
    `Corti didn't answer in ${TIMING.armTimeoutMs / 1000} s`,
  );
  h.controller.dismiss();
});

test("any keypress clears an error early, the hold timer gone", async () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onError?.(new VoiceError("connection to Corti lost"));
  expect(h.controller.state).toBe("error");
  h.controller.dismiss();
  expect(h.controller.state).toBe("idle");
  expect(vi.getTimerCount()).toBe(0);
});

test("after dispose, no late session callback reaches the sink and no timer is left", () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.controller.dispose();
  expect(h.controller.state).toBe("idle");
  expect(h.sessions[0]?.canceled).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  const since = h.events.length;
  h.opts().onInterim?.("late words");
  h.opts().onReady?.();
  expect(h.events).toHaveLength(since);
  expect(h.controller.state).toBe("idle");
});

test("the mic counts as open from its first chunk until the tail ends, whatever the server is doing", async () => {
  const h = harness();
  h.controller.toggle();
  expect(h.controller.facts().micOpen).toBe(false);
  // audio flows before the server accepts: it is buffered, and the mic is open
  h.opts().onLevel?.(QUIET);
  expect(h.controller.facts().micOpen).toBe(true);
  h.opts().onReady?.();
  h.opts().onLevel?.(SPEECH);
  h.controller.finish();
  // Enter moved the state on, but the tail is still recording
  expect(h.controller.state).toBe("transcribing");
  expect(h.controller.facts().micOpen).toBe(true);
  await vi.advanceTimersByTimeAsync(TIMING.tailMs);
  expect(h.sessions[0]?.stopCalls).toBe(1);
  expect(h.controller.facts().micOpen).toBe(false);
});

test("heardSpeech latches on the first chunk above the speech threshold, and resets per dictation", () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onLevel?.(QUIET);
  expect(h.controller.facts().heardSpeech).toBe(false);
  h.opts().onLevel?.(SPEECH);
  expect(h.controller.facts().heardSpeech).toBe(true);
  h.controller.cancel();
  h.controller.toggle();
  expect(h.controller.facts().heardSpeech).toBe(false);
});

test("listeners get each chunk's level as the session measured it", () => {
  const seen: number[] = [];
  const h = harness({}, { onLevel: (dbfs) => seen.push(dbfs) });
  h.controller.toggle();
  h.opts().onLevel?.(-6);
  expect(seen).toEqual([-6]);
});

test("speech starts above −49.8 dBFS: a chunk at or just under it is not heard, one just over it is", () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onLevel?.(-49.81);
  h.opts().onLevel?.(-49.8);
  expect(h.controller.facts().heardSpeech).toBe(false);
  h.opts().onLevel?.(-49.79);
  expect(h.controller.facts().heardSpeech).toBe(true);
  h.controller.cancel();
});

test("an open mic that stops delivering fails as microphone stopped, keeping what was said", async () => {
  const h = harness({ errorHoldMs: 60_000 });
  h.controller.toggle();
  h.opts().onReady?.();
  // silence keeps arriving as chunks: no stall
  await chunks(h, 4 * TIMING.stallMs, QUIET);
  expect(h.controller.state).toBe("listening");
  h.opts().onFinal?.("said before it died");
  // then nothing at all: the recorder is gone
  await vi.advanceTimersByTimeAsync(TIMING.stallMs);
  expect(h.controller.state).toBe("error");
  expect(h.controller.facts().message).toBe("microphone stopped · words kept");
});

test("a drain that outlasts the stall window is not a dead mic: the mic closed on purpose", async () => {
  const h = harness({}, { stopNeverResolves: true });
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onLevel?.(SPEECH);
  h.opts().onFinal?.("done talking");
  h.controller.finish();
  await vi.advanceTimersByTimeAsync(TIMING.tailMs);
  expect(h.sessions[0]?.stopCalls).toBe(1);
  await vi.advanceTimersByTimeAsync(4 * TIMING.stallMs);
  expect(h.controller.state).toBe("transcribing");
  expect(h.states).not.toContain("error");
});

test("the time left before the cap counts from this dictation's start", async () => {
  const h = harness();
  h.controller.toggle();
  expect(h.controller.facts().capLeftMs).toBe(TIMING.maxMs);
  await vi.advanceTimersByTimeAsync(60);
  expect(h.controller.facts().capLeftMs).toBe(TIMING.maxMs - 60);
  h.controller.cancel();
  h.controller.toggle();
  expect(h.controller.facts().capLeftMs).toBe(TIMING.maxMs);
  h.controller.cancel();
});

test("a chunk that arrives in the same pass as the stall check still counts: no false dead mic", async () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onLevel?.(QUIET);
  // due at the same moment and queued after the stall timer, as a chunk read behind a long block is
  setTimeout(() => h.opts().onLevel?.(QUIET), TIMING.stallMs);
  await vi.advanceTimersByTimeAsync(TIMING.stallMs);
  expect(h.states).not.toContain("error");
  h.controller.cancel();
});

test("a toggle while the last words drain is ignored: it neither restarts nor stops twice", async () => {
  const h = harness({}, { stopNeverResolves: true });
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onFinal?.("still draining");
  h.controller.toggle();
  await vi.advanceTimersByTimeAsync(TIMING.tailMs);
  expect(h.controller.state).toBe("transcribing");
  h.controller.toggle();
  expect(h.controller.state).toBe("transcribing");
  expect(h.sessions).toHaveLength(1);
  expect(h.sessions[0]?.stopCalls).toBe(1);
  expect(h.sessions[0]?.canceled).toBe(false);
});

test("Enter after speech while Corti still connects stops the session rather than dropping it, and late acceptance keeps the words", async () => {
  const h = harness({}, { stopNeverResolves: true });
  h.controller.toggle();
  h.opts().onLevel?.(SPEECH);
  h.controller.finish();
  expect(h.controller.state).toBe("transcribing");
  await vi.advanceTimersByTimeAsync(TIMING.tailMs);
  expect(h.sessions[0]!.stopCalls).toBe(1);
  expect(h.sessions[0]!.canceled).toBe(false);
  h.opts().onReady?.();
  h.opts().onFinal("hello there");
  await vi.advanceTimersByTimeAsync(TIMING.armTimeoutMs);
  expect(h.controller.state).toBe("transcribing");
  expect(h.events).toContainEqual({ op: "final", arg: "hello there" });
});

test("a stop while Corti still connects fails as Corti not answering if it never accepts", async () => {
  const h = harness({}, { stopNeverResolves: true });
  h.controller.toggle();
  h.opts().onLevel?.(SPEECH);
  h.controller.finish();
  await vi.advanceTimersByTimeAsync(TIMING.armTimeoutMs);
  expect(h.controller.state).toBe("error");
  expect(h.controller.facts().message).toBe(
    `Corti didn't answer in ${TIMING.armTimeoutMs / 1000} s`,
  );
});

test("the hard cap stops only a listening dictation: one still connecting is left to its own timeout", async () => {
  const h = harness({ maxMs: 1_000 });
  h.controller.toggle();
  h.opts().onLevel?.(SPEECH);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.controller.state).toBe("arming");
  expect(h.sessions[0]?.stopCalls).toBe(0);
  h.controller.cancel();
});

test("a sink that throws while a failure is reported still leaves the error line up", () => {
  const d = harness(
    {},
    {
      sinkOverride: {
        final: () => {
          throw new Error();
        },
      },
    },
  );
  d.controller.toggle();
  d.opts().onReady?.();
  d.opts().onInterim?.("words");
  d.opts().onError?.(new VoiceError("connection to Corti lost"));
  expect(d.controller.state).toBe("error");
  expect(d.controller.facts().message).toBe(
    "connection to Corti lost · words kept",
  );
  d.controller.dismiss();
  d.controller.toggle();
  expect(d.controller.state).toBe("arming");
});

test("a sink that throws during the drain still ends the dictation, and nothing escapes", async () => {
  const d = harness(
    {},
    {
      sinkOverride: {
        end: () => {
          throw new Error();
        },
      },
    },
  );
  d.controller.toggle();
  d.opts().onReady?.();
  d.opts().onFinal?.("finished words");
  const escaped: unknown[] = [];
  const record = (e: unknown) => escaped.push(e);
  process.on("unhandledRejection", record);
  try {
    d.controller.finish();
    await vi.advanceTimersByTimeAsync(TIMING.tailMs);
  } finally {
    process.off("unhandledRejection", record);
  }
  expect(escaped).toEqual([]);
  expect(d.controller.state).toBe("idle");
  d.controller.toggle();
  expect(d.controller.state).toBe("arming");
});

test("Esc still puts the buffer back when the sink's end throws", () => {
  let reverted = 0;
  const h = harness(
    {},
    {
      sinkOverride: {
        end: () => {
          throw new Error("broken editor");
        },
        revert: () => ++reverted > 0,
      },
    },
  );
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onFinal("spoken words");
  h.controller.cancel();
  expect(reverted).toBe(1);
  expect(h.controller.state).toBe("discarded");
});

test("a begin that throws starts no session and strands nothing", () => {
  const d = harness(
    {},
    {
      sinkOverride: {
        begin: () => {
          throw new Error();
        },
      },
    },
  );
  expect(() => d.controller.toggle()).toThrow();
  expect(d.sessions).toHaveLength(0);
  expect(d.controller.state).toBe("idle");
  expect(() => d.controller.toggle()).toThrow();
  expect(d.sessions).toHaveLength(0);
});
