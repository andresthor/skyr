/**
 * The dictation state machine, free of any TUI:
 *
 *   idle ─toggle→ arming ─CONFIG_ACCEPTED→ listening ─toggle / enter→ transcribing ─finals drained→ idle
 *                     └─────────────── toggle / enter ───────────────↗
 *
 *   arming, listening       ─toggle / enter before any speech or text→ idle, quietly
 *   arming … transcribing   ─Esc→ the buffer put back ─committed words reverted→ discarded
 *   arming … transcribing   ─any failure→ error
 *   error, discarded        ─hold expired or any key→ idle; toggle starts afresh
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
import { VOICE_DEFAULTS } from "./config.js";
import type { SttCredentials } from "./credentials.js";
import {
  micBlocked,
  micStopped,
  noAnswer,
  noSpeech,
  noWords,
  type VoiceError,
  wordsKept,
} from "./errors.js";
import { dbfs, FULL_SCALE, micSource } from "./mic.js";

export type VoiceState =
  | "idle"
  | "arming"
  | "listening"
  | "transcribing"
  | "error"
  | "discarded";

export interface DictationSink {
  /** A dictation is starting; remember whatever is needed to undo it. */
  begin(): void;
  /** Provisional text of the current segment, replacing the previous interim. */
  interim(segment: string): void;
  /** A finished segment: commit it into the buffer at the cursor. */
  final(segment: string): void;
  /** Dictation over; drop any provisional text. */
  end(): void;
  /** Esc: put the buffer back the way `begin()` found it. True when the buffer changed. */
  revert(): boolean;
}

export interface DictationTiming {
  /** Keep capturing after a manual stop so the last word is not clipped. */
  tailMs: number;
  /** Ask for the segment's final after this much quiet, so a stop has little left to drain. */
  flushMs: number;
  /** Give up with no speech and no words this long after Corti accepts the session. */
  noSpeechMs: number;
  /** Hard cap on one dictation; stops and keeps, as if toggled. */
  maxMs: number;
  /** Give up if the server has not accepted the session by then. */
  armTimeoutMs: number;
  /** How long an error line stays up. */
  errorHoldMs: number;
  /** How long the discarded notice offers its undo. */
  discardHoldMs: number;
  /** Fail when an open mic delivers nothing for this long: silence still arrives as chunks, a dead mic doesn't. */
  stallMs: number;
}

/**
 * The controller's timing for every field the caller's `timing` leaves out.
 * @internal
 */
export const DEFAULT_TIMING: DictationTiming = {
  tailMs: 400,
  flushMs: 900,
  noSpeechMs: 8_000,
  maxMs: 120_000,
  armTimeoutMs: 10_000,
  errorHoldMs: 4_000,
  discardHoldMs: 2_000,
  stallMs: 1_500,
};

/**
 * A chunk louder than this is speech, about −49.8 dBFS; room noise sits below it. Written as its
 * derivation, 0.15 on a 0.6-power curve at 2,500/32,768 RMS, so the gate is exact.
 */
export const SPEECH_DBFS =
  20 * Math.log10((2500 / FULL_SCALE) * 0.15 ** (1 / 0.6));
/** ~1.5 s of chunks that are exactly zero: macOS hands a mic-denied process silence, not an error. */
const ZERO_CHUNKS_BLOCKED = 24;

type Timer = ReturnType<typeof setTimeout>;

/** One dictation, from `start` until it ends. The next `start` replaces it; nothing resets it. */
interface Dictation {
  readonly session: SttSession;
  readonly startedAt: number;
  /** Waiting for the recorder's first chunk, then open until the tail after a stop ends. */
  mic: "waiting" | "open" | "closed";
  /** When the server took the session; until then audio is only buffered. */
  acceptedAt: number | undefined;
  /** Someone spoke: a chunk above SPEECH_DBFS, or any text from Corti. */
  heard: boolean;
  finals: number;
  /** The live segment's interim, until its final arrives. */
  interim: string;
  /** Exactly-zero chunks in a row; -Infinity once any other chunk arrived. */
  zeroChunks: number;
  lastChunkAt: number;
  /** Every timer this dictation set, cleared together when it ends. */
  readonly timers: Set<Timer>;
  flush?: Timer;
  stall?: Timer;
}

/** The mic is feeding a dictation that a stop or a failure can still end. */
const capturing = (s: VoiceState) => s === "arming" || s === "listening";
/** Words the user watched appear, which a stop or a failure keeps. */
const kept = (d: Dictation) => d.finals > 0 || d.interim !== "";

export interface DictationControllerOptions {
  creds: SttCredentials;
  sink: DictationSink;
  /** Fires when the state changes or a final lands. micOpen and heardSpeech move
   * without it, reaching the screen on the display's own tick instead. */
  onChange: () => void;
  /** Each chunk's raw RMS, 0..1 of full scale. */
  onLevel?: (rms: number) => void;
  source?: () => Readable;
  timing?: Partial<DictationTiming>;
  start?: (o: SessionOptions) => SttSession;
}

/** What the displays need to know at one moment, read off one clock and one dictation. */
export interface DictationFacts {
  state: VoiceState;
  /** ms since the current state began: the finishing ellipsis steps on it. */
  stateMs: number;
  /** ms since this dictation started; 0 while none is running. */
  sinceStartMs: number;
  /** ms before the hard cap stops a running dictation, as the controller enforces it. */
  capLeftMs: number;
  /** The recorder is delivering audio: from its first chunk until the stop that ends the tail. */
  micOpen: boolean;
  /** This dictation has heard someone: a chunk above SPEECH_DBFS, or any text from Corti. */
  heardSpeech: boolean;
  /** ms before silence fails this dictation; undefined until the server accepts, which starts the window. */
  noSpeechLeftMs: number | undefined;
  /** The error line while `state` is "error". */
  message: string;
}

export class DictationController {
  /** What each `start` configures Corti with; registerVoice sets it from skyr.json per session. */
  config: SttConfig = VOICE_DEFAULTS;
  /** The state machine's current state; written only through `setState`. */
  private curState: VoiceState = "idle";
  /** When the current state began, for the indicator's state-relative animation. */
  private stateSince = 0;
  /** The error line while the state is "error". */
  private message = "";

  private readonly timing: DictationTiming;
  /** The running dictation; undefined from the moment it ends. A callback holding another is stale. */
  private d: Dictation | undefined;
  /** Ends the notice currently up, error or discarded. */
  private hold: Timer | undefined;

  constructor(private readonly o: DictationControllerOptions) {
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
  }

  get state(): VoiceState {
    return this.curState;
  }

  /** A dictation is running: arming, listening or transcribing. */
  get active(): boolean {
    return this.d !== undefined;
  }

  /** One consistent read of every fact the displays need: one clock, one dictation. */
  facts(): DictationFacts {
    const now = Date.now();
    const sinceStartMs = this.d ? now - this.d.startedAt : 0;
    return {
      state: this.curState,
      stateMs: now - this.stateSince,
      sinceStartMs,
      capLeftMs: this.timing.maxMs - sinceStartMs,
      micOpen: this.d?.mic === "open",
      heardSpeech: this.d?.heard ?? false,
      noSpeechLeftMs:
        this.d?.acceptedAt === undefined
          ? undefined
          : this.timing.noSpeechMs - (now - this.d.acceptedAt),
      message: this.message,
    };
  }

  /** The trigger: start when idle or a notice is up, stop-and-keep when capturing, ignored while draining. */
  toggle(): void {
    if (
      this.curState === "idle" ||
      this.curState === "error" ||
      this.curState === "discarded"
    )
      this.start();
    else if (capturing(this.curState)) this.finish();
  }

  /** Stop and keep: capture a short tail, then drain the finals. */
  finish(): void {
    const d = this.d;
    if (!d || !capturing(this.curState)) return;
    // nothing said and nothing shown: changing your mind is not an error
    if (!d.heard) {
      d.session.cancel();
      this.end(d);
      this.setState("idle");
      // guarded like the drain: this runs from the key hook, whose caller crashes Pi
      // on a throw rather than reporting it — idle is up, nothing is stranded
      try {
        this.o.sink.end();
      } catch {}
      return;
    }
    if (d.flush) this.cancelTimer(d, d.flush);
    this.setState("transcribing");
    this.later(d, this.timing.tailMs, () => {
      d.mic = "closed";
      d.session.stop().then(() => {
        if (d !== this.d) return;
        if (!kept(d)) return this.fail(d, noWords());
        // settled before the sink runs, and a sink throw has nowhere to go
        // but an unhandled rejection: the promise chain ends here
        this.end(d);
        this.setState("idle");
        // guarded one by one: idle is up, and this promise chain has no caller left to
        // report a throw to — escaping here would be an unhandled rejection
        try {
          // a segment whose final never came is still better kept than lost
          if (d.interim) this.o.sink.final(d.interim);
        } catch {}
        try {
          this.o.sink.end();
        } catch {}
      });
    });
  }

  /** Esc: stop everything and put the editor back the way `begin()` found it. */
  cancel(): void {
    const d = this.d;
    if (!d) return;
    d.session.cancel();
    this.end(d);
    // guarded one by one: the key hook's caller crashes Pi on a throw, and a broken end
    // must not stop the buffer going back
    try {
      this.o.sink.end();
    } catch {}
    let reverted = false;
    try {
      // true means committed words went; their undo offer is the notice for that
      reverted = this.o.sink.revert();
    } catch {}
    if (reverted) this.held("discarded", this.timing.discardHoldMs);
    else this.setState("idle");
  }

  /** Any keypress clears an error line or the discarded notice early. */
  dismiss(): void {
    if (this.curState !== "error" && this.curState !== "discarded") return;
    this.clearHold();
    this.setState("idle");
  }

  /** session_shutdown: no callbacks, no timers, nothing on screen. */
  dispose(): void {
    const d = this.d;
    if (d) {
      d.session.cancel();
      this.end(d);
    }
    this.clearHold();
    this.curState = "idle";
  }

  private start(): void {
    this.clearHold();
    // first, before anything exists that a throw would strand
    this.o.sink.begin();
    // the session never calls back before it returns, so its callbacks can close over `d`
    const d: Dictation = {
      session: (this.o.start ?? startSession)({
        creds: this.o.creds,
        source: this.o.source ?? micSource,
        ...this.config,
        onReady: () => {
          if (d !== this.d) return;
          d.acceptedAt = Date.now();
          // after an early stop the session drains instead; acceptance only lets its audio go
          if (this.curState !== "arming") return;
          this.setState("listening");
          // from acceptance, not start: silence while Corti connects is Corti's delay, not the user's
          this.later(d, this.timing.noSpeechMs, () => {
            if (capturing(this.curState) && !d.heard)
              this.fail(d, noSpeech(this.timing.noSpeechMs));
          });
        },
        onInterim: (segment) => {
          if (d !== this.d) return;
          d.heard = true;
          d.interim = segment;
          this.o.sink.interim(segment);
        },
        onFinal: (segment) => {
          if (d !== this.d) return;
          d.heard = true;
          d.interim = "";
          d.finals++;
          this.o.sink.final(segment);
          this.o.onChange();
        },
        onLevel: (rms) => this.level(d, rms),
        onError: (err) => this.fail(d, err),
      }),
      startedAt: Date.now(),
      mic: "waiting",
      acceptedAt: undefined,
      heard: false,
      finals: 0,
      interim: "",
      zeroChunks: 0,
      lastChunkAt: 0,
      timers: new Set(),
    };
    this.d = d;
    this.setState("arming");
    this.later(d, this.timing.armTimeoutMs, () => {
      if (d.acceptedAt === undefined)
        this.fail(d, noAnswer(this.timing.armTimeoutMs));
    });
    this.later(d, this.timing.maxMs, () => {
      if (this.curState === "listening") this.finish();
    });
  }

  /** One chunk from d's recorder: the meter, the stall and blocked-mic checks, the early flush. */
  private level(d: Dictation, rms: number): void {
    if (d !== this.d) return;
    this.o.onLevel?.(rms);
    if (d.mic === "waiting") d.mic = "open";
    d.lastChunkAt = Date.now();
    if (!capturing(this.curState)) return;
    const { stallMs, flushMs } = this.timing;
    if (d.stall) this.cancelTimer(d, d.stall);
    d.stall = this.later(d, stallMs, () =>
      // after a long block the timer can run before queued chunks are read; one turn lets them land
      setImmediate(() => {
        if (capturing(this.curState) && Date.now() - d.lastChunkAt >= stallMs)
          this.fail(d, micStopped());
      }),
    );
    if (rms === 0) {
      if (++d.zeroChunks >= ZERO_CHUNKS_BLOCKED && !d.heard)
        this.fail(d, micBlocked());
      return;
    }
    d.zeroChunks = Number.NEGATIVE_INFINITY;
    if (dbfs(rms) <= SPEECH_DBFS) return;
    d.heard = true;
    if (this.curState !== "listening") return;
    if (d.flush) this.cancelTimer(d, d.flush);
    d.flush = this.later(d, flushMs, () => {
      if (this.curState === "listening") d.session.flush?.();
    });
  }

  /** d failed: words already shown stay, and the error line says so. */
  private fail(d: Dictation, err: VoiceError): void {
    if (d !== this.d) return;
    d.session.cancel();
    this.end(d);
    // settled before the sink runs: a broken editor must not strand a live dictation,
    // and a throw here would exit Pi, because fail is also called from timers
    this.message = kept(d) ? wordsKept(err.message) : err.message;
    this.held("error", this.timing.errorHoldMs);
    // guarded one by one: the error line is already up, and a throw here would
    // exit Pi, because fail is also called from timers
    try {
      if (d.interim) this.o.sink.final(d.interim);
    } catch {}
    try {
      this.o.sink.end();
    } catch {}
  }

  /** From here on, no timer of d's fires and no callback of d's has any effect. */
  private end(d: Dictation): void {
    for (const t of d.timers) clearTimeout(t);
    d.timers.clear();
    this.d = undefined;
  }

  private setState(s: VoiceState): void {
    this.curState = s;
    this.stateSince = Date.now();
    this.o.onChange();
  }

  /** A timer that dies with d: `end(d)` clears it, so `fn` runs only while d is running. */
  private later(d: Dictation, ms: number, fn: () => void): Timer {
    const t = setTimeout(() => {
      d.timers.delete(t);
      fn();
    }, ms);
    d.timers.add(t);
    return t;
  }

  private cancelTimer(d: Dictation, t: Timer): void {
    clearTimeout(t);
    d.timers.delete(t);
  }

  /** Shows notice `s` for `holdMs`, then idle; dismiss() or a toggle ends it early. */
  private held(s: "error" | "discarded", holdMs: number): void {
    this.setState(s);
    this.hold = setTimeout(() => {
      this.hold = undefined;
      this.setState("idle");
    }, holdMs);
  }

  private clearHold(): void {
    if (this.hold) clearTimeout(this.hold);
    this.hold = undefined;
  }
}
