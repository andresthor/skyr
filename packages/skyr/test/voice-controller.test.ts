/**
 * The dictation state machine, driven entirely through the seams `DictationControllerOptions`
 * exposes: a fake session factory, injected timing and a recorded sink. Keybindings-forwarded
 * stops (Enter) and cancel (Esc) are the module's mapping of `finish`/`cancel`.
 */
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import type { SessionOptions, SttSession } from "../src/voice/client.js";
import type { SttCredentials } from "../src/voice/credentials.js";
import {
  DictationController,
  type DictationTiming,
  levelFromRms,
  SPEECH_DBFS,
} from "../src/voice/dictation.js";

const CREDS: SttCredentials = {
  environment: "dev",
  tenant: "tenant",
  clientId: "id",
  clientSecret: "secret",
};

/** Short waits a test can await; the hard cap stays far off. */
const TIMING: Partial<DictationTiming> = {
  tailMs: 5,
  flushMs: 5,
  noSpeechMs: 250,
  armTimeoutMs: 250,
  maxMs: 10_000,
  errorHoldMs: 20,
};

type SinkEvent =
  | { op: "begin" | "end" | "revert" }
  | { op: "interim" | "final"; arg: string };

class FakeSession implements SttSession {
  stopCalls = 0;
  canceled = false;
  flushed = 0;

  stop = vi.fn(() => {
    this.stopCalls++;
    return Promise.resolve("everything");
  });

  cancel = () => {
    this.canceled = true;
  };

  flush = () => {
    this.flushed++;
  };
}

function harness(
  timing: Partial<DictationTiming> = TIMING,
  onLevel?: (rms: number) => void,
) {
  const events: SinkEvent[] = [];
  const states: string[] = [];
  const sessions: FakeSession[] = [];
  const options: SessionOptions[] = [];
  let controller: DictationController;
  controller = new DictationController({
    creds: CREDS,
    sink: {
      begin: () => events.push({ op: "begin" }),
      interim: (s) => events.push({ op: "interim", arg: s }),
      final: (s) => events.push({ op: "final", arg: s }),
      end: () => events.push({ op: "end" }),
      revert: () => events.push({ op: "revert" }),
    },
    onChange: () => states.push(controller.state),
    onLevel,
    source: () => new PassThrough(),
    start: (o) => {
      options.push(o);
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    timing,
  });
  const opts = () => options.at(-1)!;
  return { controller, events, states, sessions, opts };
}

test("toggle arms, the session's acceptance listens, a stop keeps what was heard", async () => {
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
  await vi.waitFor(() => expect(h.controller.state).toBe("idle"));
  // the interim was still the live segment: held back, then committed at the drain
  expect(h.events).toContainEqual({ op: "final", arg: "hey there" });
  expect(h.events[h.events.length - 1]).toEqual({ op: "end" });
  expect(h.sessions[0]?.stopCalls).toBe(1);
});

test("flushMs of quiet asks the session for the pending final early; ongoing speech keeps postponing it", async () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  // close together speech pulses: each one re-arms the quiet timer, so nothing flushes
  for (let i = 0; i < 6; i++) {
    h.opts().onLevel?.(0.05);
    await new Promise((r) => setTimeout(r, (TIMING.flushMs ?? 5) - 2));
  }
  expect(h.sessions[0]?.flushed).toBe(0);
  // quiet past flushMs: the session is flushed, dictation still listening
  await vi.waitFor(() => expect(h.sessions[0]?.flushed).toBe(1));
  expect(h.controller.state).toBe("listening");
  h.controller.cancel();
});

test("a stop while nothing was committed commits the pending interim instead of losing it", async () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onFinal?.("kept words");
  h.controller.toggle();
  await vi.waitFor(() => expect(h.controller.state).toBe("idle"));
  expect(h.events).toContainEqual({ op: "final", arg: "kept words" });
  // finals were committed, so the drain ends quietly rather than failing
  expect(h.events.filter((e) => e.op === "final")).toHaveLength(1);
  expect(h.controller.state).toBe("idle");
});

test("stopping after zero finals fails with nothing heard, and the error auto-dismisses", async () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.controller.toggle();
  await vi.waitFor(() => expect(h.controller.state).toBe("error"), {
    interval: 5,
  });
  expect(h.controller.message).toBe("nothing heard");
  expect(h.events).toContainEqual({ op: "end" }); // the provisional text goes, finals stay
  await vi.waitFor(() => expect(h.controller.state).toBe("idle"));
});

test("Enter's stop through finish() drains the tail the same way as the toggle", async () => {
  const h = harness({ ...TIMING, tailMs: 50 });
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onInterim?.("word");
  h.controller.finish();
  expect(h.controller.state).toBe("transcribing");
  // still mid-tail: the drain has not resolved yet
  expect(h.sessions[0]?.stopCalls).toBe(0);
  await vi.waitFor(() => expect(h.controller.state).toBe("idle"), {
    timeout: 1000,
  });
  expect(h.events).toContainEqual({ op: "final", arg: "word" });
  expect(h.sessions[0]?.stopCalls).toBe(1);
});

test("Esc cancels on the spot, puts the buffer back, and late session callbacks are dead", async () => {
  const h = harness({ ...TIMING, tailMs: 50 });
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

test("silence from a blocked microphone surfaces as the mic error after ~24 zero chunks", async () => {
  const h = harness();
  h.controller.toggle();
  for (let i = 0; i < 24; i++) h.opts().onLevel?.(0);
  expect(h.controller.state).toBe("error");
  expect(h.controller.message).toBe(
    "microphone blocked · System Settings › Privacy",
  );
  await vi.waitFor(() => expect(h.controller.state).toBe("idle"));
});

test("never hearing speech at all fails with nothing heard", async () => {
  const h = harness({ ...TIMING, noSpeechMs: 30, armTimeoutMs: 5_000 });
  h.controller.toggle();
  await vi.waitFor(() => expect(h.controller.state).toBe("error"), {
    timeout: 1000,
  });
  expect(h.controller.message).toBe("nothing heard");
  h.controller.dismiss();
  expect(h.controller.state).toBe("idle");
});

test("a session that never accepts fails with didn't answer", async () => {
  const h = harness({ ...TIMING, armTimeoutMs: 30, noSpeechMs: 10_000 });
  h.controller.toggle();
  await vi.waitFor(() => expect(h.controller.state).toBe("error"), {
    timeout: 1000,
  });
  expect(h.controller.message).toBe("Corti didn't answer");
});

test("any keypress clears an error early, the hold timer gone", async () => {
  const h = harness();
  h.controller.toggle();
  h.controller.cancel();
  // no audio, no finals: the immediate stop fails with nothing heard again
  h.controller.toggle();
  await vi.waitFor(() => expect(h.controller.state).toBe("error"), {
    timeout: 1000,
  });
  h.controller.dismiss();
  expect(h.controller.state).toBe("idle");
  // and now a key-less wait stays idle: the hold timer was cleared
  await new Promise((r) => setTimeout(r, TIMING.errorHoldMs ?? 20));
  expect(h.controller.state).toBe("idle");
});

test("session_shutdown detaches everything: callbacks are dead and state goes idle", async () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.controller.dispose();
  expect(h.controller.state).toBe("idle");
  expect(h.sessions[0]?.canceled).toBe(true);
  const since = h.events.length;
  h.opts().onInterim?.("late words");
  h.opts().onReady?.();
  expect(h.events).toHaveLength(since);
  expect(h.controller.state).toBe("idle");
});

test("the mic counts as open from its first chunk until the tail ends, whatever the server is doing", async () => {
  const h = harness({ ...TIMING, tailMs: 30 });
  h.controller.toggle();
  expect(h.controller.micOpen).toBe(false);
  expect(h.controller.accepted).toBe(false);
  // audio flows before the server accepts: it is buffered, and the mic is open
  h.opts().onLevel?.(0.001);
  expect(h.controller.micOpen).toBe(true);
  expect(h.controller.accepted).toBe(false);
  h.opts().onReady?.();
  expect(h.controller.accepted).toBe(true);
  h.controller.finish();
  // Enter moved the state on, but the tail is still recording
  expect(h.controller.state).toBe("transcribing");
  expect(h.controller.micOpen).toBe(true);
  await vi.waitFor(() => expect(h.sessions[0]?.stopCalls).toBe(1));
  expect(h.controller.micOpen).toBe(false);
});

test("heardSpeech latches on the first chunk above the speech threshold, and resets per dictation", () => {
  const h = harness();
  h.controller.toggle();
  h.opts().onReady?.();
  h.opts().onLevel?.(0.0005);
  expect(h.controller.heardSpeech).toBe(false);
  h.opts().onLevel?.(0.05);
  expect(h.controller.heardSpeech).toBe(true);
  h.controller.cancel();
  h.controller.toggle();
  expect(h.controller.heardSpeech).toBe(false);
});

test("listeners get each chunk's raw RMS, and SPEECH_DBFS is where the level curve crosses speech", () => {
  const seen: number[] = [];
  const h = harness(TIMING, (rms) => seen.push(rms));
  h.controller.toggle();
  h.opts().onLevel?.(0.5);
  expect(seen).toEqual([0.5]);
  const rmsAtGate = 10 ** (SPEECH_DBFS / 20);
  expect(levelFromRms(rmsAtGate)).toBeCloseTo(0.15, 6);
  expect(SPEECH_DBFS).toBeCloseTo(-49.8, 1);
});
