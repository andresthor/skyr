/**
 * The dictation state machine, free of any TUI:
 *
 *   idle ─toggle→ arming ─CONFIG_ACCEPTED→ listening ─toggle / enter→ transcribing ─finals drained→ idle
 *                   ├─ toggle / enter before any speech or text → idle (quietly)
 *                   └──────────── any failure ───────────→ error ─(hold)→ idle
 *
 * Quiet never stops a dictation: people pause to think. It only asks the server for
 * the pending final early, so a stop has little left to wait for.
 *
 * Text goes to a `DictationSink` (the editor); levels go to the indicator's history.
 */
import type { Readable } from "node:stream";
import {
  type SessionOptions,
  type SttConfig,
  type SttSession,
  startSession,
} from "./client.js";
import type { SttCredentials } from "./credentials.js";
import { VoiceError } from "./errors.js";
import { dbfs, micSource } from "./mic.js";

export type VoiceState =
  | "idle"
  | "arming"
  | "listening"
  | "transcribing"
  | "error";

export interface DictationSink {
  /** A dictation is starting; remember whatever is needed to undo it. */
  begin(): void;
  /** Provisional text of the current segment, replacing the previous interim. */
  interim(segment: string): void;
  /** A finished segment: commit it into the buffer at the cursor. */
  final(segment: string): void;
  /** Dictation over; drop any provisional text. */
  end(): void;
  /** Esc: put the buffer back the way `begin()` found it. */
  revert(): void;
}

export interface DictationTiming {
  /** Keep capturing after a manual stop so the last word is not clipped. */
  tailMs: number;
  /** Ask for the segment's final after this much quiet, so a stop has little left to drain. */
  flushMs: number;
  /** Give up with "nothing heard" when no speech arrives this long after start. */
  noSpeechMs: number;
  /** Hard cap on one dictation; stops and keeps, as if toggled. */
  maxMs: number;
  /** Give up if the server has not accepted the session by then. */
  armTimeoutMs: number;
  /** How long an error line stays up. */
  errorHoldMs: number;
  /** Fail when an open mic delivers nothing for this long: silence still arrives as chunks, a dead mic doesn't. */
  stallMs: number;
}

const DEFAULT_TIMING: DictationTiming = {
  tailMs: 400,
  flushMs: 900,
  noSpeechMs: 8000,
  maxMs: 120_000,
  armTimeoutMs: 10_000,
  errorHoldMs: 4000,
  stallMs: 1500,
};

/**
 * A chunk louder than this is speech, about −49.8 dBFS; room noise sits below it. Written as its
 * derivation, 0.15 on a 0.6-power curve with full scale at 2,500/32,768 RMS, so the gate is exact.
 */
export const SPEECH_DBFS = 20 * Math.log10((2500 / 32768) * 0.15 ** (1 / 0.6));
/** ~1.5 s of chunks that are exactly zero: macOS hands a mic-denied process silence, not an error. */
const ZERO_CHUNKS_BLOCKED = 24;

/** The Corti config, resolved from the skyr.json voice section by registerVoice, is read at every
 * `start`, so the owning object may be updated between sessions. */
export interface DictationControllerOptions extends Partial<SttConfig> {
  creds: SttCredentials;
  sink: DictationSink;
  onChange: () => void;
  /** Each chunk's raw RMS, 0..1 of full scale. */
  onLevel?: (rms: number) => void;
  source?: () => Readable;
  timing?: Partial<DictationTiming>;
  start?: (o: SessionOptions) => SttSession;
}

export class DictationController {
  state: VoiceState = "idle";
  /** When the current state began, for the indicator's state-relative animation. */
  stateSince = 0;
  /** When the current dictation started: its advisories and its hard cap count from here. */
  private startedAt = 0;
  message = "";

  private session: SttSession | undefined;
  private readonly timing: DictationTiming;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private quietStartTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private lastChunkAt = 0;
  private heard = false;
  private mic: "waiting" | "open" | "closed" = "closed";
  private sessionAccepted = false;
  private zeroChunks = 0;
  private pendingInterim = "";
  private finals = 0;
  private generation = 0;

  constructor(private readonly o: DictationControllerOptions) {
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
  }

  /** The recorder is delivering audio: from its first chunk until the stop that ends the tail. */
  get micOpen(): boolean {
    return this.mic === "open" && this.active;
  }

  /** The server took the session; before that, audio is only buffered. */
  get accepted(): boolean {
    return this.sessionAccepted;
  }

  /** ms since this dictation started. */
  get sinceStartMs(): number {
    return Date.now() - this.startedAt;
  }

  /** ms before the hard cap stops this dictation, as the controller enforces it. */
  get capLeftMs(): number {
    return this.timing.maxMs - this.sinceStartMs;
  }

  /** This dictation has heard someone: a chunk above SPEECH_DBFS, or any text from Corti. */
  get heardSpeech(): boolean {
    return this.heard;
  }

  get active(): boolean {
    return (
      this.state === "arming" ||
      this.state === "listening" ||
      this.state === "transcribing"
    );
  }

  /** The trigger: start when idle, stop-and-keep when capturing, ignored while draining. */
  toggle(): void {
    if (this.state === "idle" || this.state === "error") this.start();
    else if (this.state === "arming" || this.state === "listening")
      this.finish();
  }

  private start(): void {
    this.clearTimers();
    const gen = ++this.generation;
    this.startedAt = Date.now();
    this.heard = false;
    this.mic = "waiting";
    this.sessionAccepted = false;
    this.zeroChunks = 0;
    this.pendingInterim = "";
    this.finals = 0;
    this.o.sink.begin();
    this.setState("arming");
    const live = () => gen === this.generation;
    this.later(this.timing.armTimeoutMs, () => {
      if (live() && this.state === "arming")
        this.fail(new VoiceError("Corti didn't answer"));
    });
    this.quietStartTimer = this.later(this.timing.noSpeechMs, () => {
      if (
        live() &&
        !this.heard &&
        (this.state === "arming" || this.state === "listening")
      )
        this.fail(new VoiceError("nothing heard"));
    });
    this.later(
      this.timing.maxMs,
      () => live() && this.state === "listening" && this.finish(),
    );
    this.session = (this.o.start ?? startSession)({
      creds: this.o.creds,
      source: this.o.source ?? micSource,
      language: this.o.language,
      interims: this.o.interims,
      punctuation: this.o.punctuation,
      keyterms: this.o.keyterms,
      replacements: this.o.replacements,
      onReady: () => {
        if (!live() || this.state !== "arming") return;
        this.sessionAccepted = true;
        this.setState("listening");
      },
      onInterim: (segment) => {
        if (!live()) return;
        this.speechHeard();
        this.pendingInterim = segment;
        this.o.sink.interim(segment);
      },
      onFinal: (segment) => {
        if (!live()) return;
        this.speechHeard();
        this.pendingInterim = "";
        this.finals++;
        this.o.sink.final(segment);
        this.o.onChange();
      },
      onLevel: (rms) => live() && this.level(rms),
      onError: (err) => live() && this.fail(err),
    });
  }

  /** Stop and keep: capture a short tail, then drain the finals. */
  finish(): void {
    if (this.state !== "arming" && this.state !== "listening") return;
    // nothing said and nothing shown: changing your mind is not an error
    if (!this.heard) {
      this.session?.cancel();
      this.done();
      return;
    }
    const gen = this.generation;
    const session = this.session;
    const wasArming = this.state === "arming";
    if (this.flushTimer) this.cancelTimer(this.flushTimer);
    this.setState("transcribing");
    this.later(wasArming ? 0 : this.timing.tailMs, () => {
      if (gen !== this.generation || !session) return;
      this.mic = "closed";
      session.stop().then(() => {
        if (gen !== this.generation || this.state !== "transcribing") return;
        // a segment whose final never came is still better kept than lost
        if (this.pendingInterim) this.o.sink.final(this.pendingInterim);
        else if (this.finals === 0)
          return this.fail(new VoiceError("nothing heard"));
        this.done();
      });
    });
  }

  /** Esc: stop everything and restore the editor. */
  cancel(): void {
    if (!this.active) return;
    this.generation++;
    this.session?.cancel();
    this.session = undefined;
    this.clearTimers();
    this.o.sink.end();
    this.o.sink.revert();
    this.setState("idle");
  }

  /** Any keypress clears an error line early. */
  dismiss(): void {
    if (this.state !== "error") return;
    this.clearTimers();
    this.setState("idle");
  }

  /** session_shutdown: no callbacks, no timers, nothing on screen. */
  dispose(): void {
    this.generation++;
    this.session?.cancel();
    this.session = undefined;
    this.clearTimers();
    this.state = "idle";
  }

  private done(): void {
    this.generation++;
    this.session = undefined;
    this.clearTimers();
    this.o.sink.end();
    this.setState("idle");
  }

  private fail(err: VoiceError): void {
    this.generation++;
    this.session?.cancel();
    this.session = undefined;
    this.clearTimers();
    // words the user watched appear are kept, as a stop would keep them, and the line says so
    const kept = this.finals > 0 || this.pendingInterim !== "";
    if (this.pendingInterim) this.o.sink.final(this.pendingInterim);
    this.o.sink.end();
    this.message = kept ? `${err.message} · words kept` : err.message;
    this.setState("error");
    const gen = this.generation;
    this.later(this.timing.errorHoldMs, () => {
      if (gen === this.generation && this.state === "error")
        this.setState("idle");
    });
  }

  private level(rms: number): void {
    this.o.onLevel?.(rms);
    if (this.mic === "waiting") this.mic = "open";
    this.lastChunkAt = Date.now();
    if (this.state !== "listening" && this.state !== "arming") return;
    if (this.stallTimer) this.cancelTimer(this.stallTimer);
    const capturing = this.generation;
    this.stallTimer = this.later(this.timing.stallMs, () =>
      // after a long block the timer can run before queued chunks are read; one turn lets them land
      setImmediate(() => {
        if (
          capturing === this.generation &&
          (this.state === "listening" || this.state === "arming") &&
          Date.now() - this.lastChunkAt >= this.timing.stallMs
        )
          this.fail(new VoiceError("microphone stopped"));
      }),
    );
    if (rms === 0) {
      if (++this.zeroChunks >= ZERO_CHUNKS_BLOCKED && !this.heard) {
        this.fail(
          new VoiceError("microphone blocked · System Settings › Privacy"),
        );
      }
      return;
    }
    this.zeroChunks = -Infinity;
    if (dbfs(rms) <= SPEECH_DBFS) return;
    this.speechHeard();
    if (this.state === "listening") {
      const gen = this.generation;
      if (this.flushTimer) this.cancelTimer(this.flushTimer);
      this.flushTimer = this.later(this.timing.flushMs, () => {
        if (gen === this.generation && this.state === "listening")
          this.session?.flush?.();
      });
    }
  }

  /** A loud chunk and a transcript are the same evidence: nothing-heard can no longer fire. */
  private speechHeard(): void {
    this.heard = true;
    if (this.quietStartTimer) this.cancelTimer(this.quietStartTimer);
    this.quietStartTimer = undefined;
  }

  private setState(s: VoiceState): void {
    this.state = s;
    this.stateSince = Date.now();
    this.o.onChange();
  }

  private later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private cancelTimer(t: ReturnType<typeof setTimeout>): void {
    clearTimeout(t);
    this.timers.delete(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.quietStartTimer = undefined;
    this.flushTimer = undefined;
    this.stallTimer = undefined;
  }
}
