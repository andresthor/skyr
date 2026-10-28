// The frames skyr gives Pi's working loader, and the ones its own working line draws for each
// situation.
import {
  indexedColor,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import type { Tier } from "../src/ui/caps.js";
import {
  frameAt,
  loaderIndicator,
  type Situation,
  shimmer,
  situationOf,
  variantFor,
} from "../src/ui/spinner.js";
import { styledRuns, testPaint, testTheme } from "./voice.js";

const plain = (frames: string[] | undefined) =>
  (frames ?? []).map(stripTerminalSequences);

test("Pi's loader is given the star pulse at 80 ms ticks, each frame held three ticks", () => {
  const { frames, intervalMs } = loaderIndicator(testPaint());
  expect(intervalMs).toBe(80);
  expect(plain(frames).join("")).toBe("···✧✧✧✦✦✦✦✦✦✧✧✧···");
  const accent = testPaint().theme.colors.accent;
  expect(frames?.map((f) => styledRuns(f)[0]?.fg)).toEqual(
    frames?.map(() => accent),
  );
});

test("the ascii tier gives Pi the line", () => {
  const { frames, intervalMs } = loaderIndicator(testPaint("ascii"));
  expect(intervalMs).toBe(80);
  expect(frames).toEqual(["-", "\\", "|", "/"]);
});

test("mono frames carry no colour", () => {
  const { frames } = loaderIndicator(testPaint("mono"));
  expect(frames?.every((f) => styledRuns(f).every((r) => !r.fg))).toBe(true);
});

test.each<Tier>(["color", "mono", "ascii"])(
  "every frame Pi is given is one column wide and there are at least two (%s)",
  (tier) => {
    const { frames = [] } = loaderIndicator(testPaint(tier));
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.map(visibleWidth).every((w) => w === 1)).toBe(true);
  },
);

/** The frames a variant plays in one cycle, one per interval. */
const cycle = (situation: Situation, tier: Tier = "color") => {
  const { frames, intervalMs } = variantFor(situation, tier);
  return { frames: frames.join(""), intervalMs };
};

test("thinking is the soft star pulse, · ✧ ✦ ✦ ✧ ·, a frame per 240 ms", () => {
  expect(cycle("thinking")).toEqual({ frames: "·✧✦✦✧·", intervalMs: 240 });
});

test("a running tool is the line, - \\ | /, a frame per 80 ms", () => {
  expect(cycle("tool")).toEqual({ frames: "-\\|/", intervalMs: 80 });
});

test("waiting on subagents is sand, a frame per 80 ms", () => {
  expect(cycle("subagents")).toEqual({
    frames: "⠁⠂⠄⡀⡈⡐⡠⣀⣁⣂⣄⣌⣔⣤⣥⣦⣮⣶⣷⣿⡿⠿⢟⠟⡛⠛⠫⢋⠋⠍⡉⠉⠑⠡⢁",
    intervalMs: 80,
  });
});

test("retry, compaction and branch summary are the star sparkle, ✶ ✸ ✹ ✺ ✹ ✷, a frame per 160 ms", () => {
  expect(cycle("retry")).toEqual({ frames: "✶✸✹✺✹✷", intervalMs: 160 });
});

const SITUATIONS: Situation[] = ["thinking", "tool", "subagents", "retry"];

test("the ascii tier draws the line in every situation", () => {
  for (const situation of SITUATIONS)
    expect(cycle(situation, "ascii")).toEqual({
      frames: "-\\|/",
      intervalMs: 80,
    });
});

test("every interval is a whole number of Pi's 80 ms ticks", () => {
  for (const situation of SITUATIONS)
    for (const tier of ["color", "mono", "ascii"] as const)
      expect(variantFor(situation, tier).intervalMs % 80).toBe(0);
});

test("a frame boundary sits mid-tick: a tick 39 ms early or late shows the same frame", () => {
  for (const situation of SITUATIONS) {
    const variant = variantFor(situation, "color");
    for (let tick = 1; tick < 120; tick++)
      for (const drift of [-39, -20, 20, 39])
        expect(frameAt(variant, tick * 80 + drift)).toBe(
          frameAt(variant, tick * 80),
        );
  }
});

test("no tool running is thinking; only subagent calls is waiting on subagents; any other tool is a tool; a non-working indicator is retry", () => {
  expect(situationOf("working", [])).toBe("thinking");
  expect(situationOf("working", ["subagent", "subagent"])).toBe("subagents");
  expect(situationOf("working", ["subagent", "bash"])).toBe("tool");
  expect(situationOf("working", ["read"])).toBe("tool");
  for (const kind of ["retry", "compaction", "branchSummary"] as const)
    expect(situationOf(kind, ["bash"])).toBe("retry");
});

/** The foreground of each column of `shimmer`'s output, by column. */
const colours = (out: string) =>
  styledRuns(out).flatMap((run) =>
    Array.from(run.text, () => ({
      fg: JSON.stringify(run.fg),
      bold: run.bold,
    })),
  );

const SHIMMERED = "abcdefghijkl";

test("the shimmer changes only colour: text and width stay the same from frame to frame", () => {
  const paint = testPaint();
  for (const text of [SHIMMERED, "漢字かな🙂 é", "", "a"])
    for (let tick = 0; tick < 40; tick++) {
      const out = shimmer(text, tick * 80, paint);
      expect(stripTerminalSequences(out)).toBe(text);
      expect(visibleWidth(out)).toBe(visibleWidth(text));
      expect(styledRuns(out).length).toBeLessThanOrEqual(5);
    }
});

test("the bright window moves one column per 80 ms tick", () => {
  const paint = testPaint();
  const base = JSON.stringify(paint.theme.colors.muted);
  const lit = (sinceMs: number) =>
    colours(shimmer(SHIMMERED, sinceMs, paint)).flatMap(({ fg }, column) =>
      fg === base ? [] : [column],
    );
  // Head at column -3 is out of view; it enters at 0 and trails two columns behind
  expect(lit(0)).toEqual([]);
  expect(lit(3 * 80)).toEqual([0]);
  expect(lit(4 * 80)).toEqual([0, 1]);
  expect(lit(5 * 80)).toEqual([0, 1, 2]);
  expect(lit(6 * 80)).toEqual([1, 2, 3]);
  expect(lit(10 * 80)).toEqual([5, 6, 7]);
  // It leaves past the end and the cycle starts again
  expect(lit(15 * 80)).toEqual([10, 11]);
  expect(lit(18 * 80)).toEqual([]);
  expect(lit(21 * 80)).toEqual([0]);
});

test("mono and ascii draw the text without a shimmer", () => {
  const ascii = shimmer(SHIMMERED, 400, testPaint("ascii"));
  expect(ascii).toBe(SHIMMERED);
  const mono = shimmer(SHIMMERED, 400, testPaint("mono"));
  expect(stripTerminalSequences(mono)).toBe(SHIMMERED);
  expect(styledRuns(mono).every((run) => !run.fg && !run.bold)).toBe(true);
  expect(shimmer(SHIMMERED, 800, testPaint("mono"))).toBe(mono);
});

test("an indexed theme shimmers in bold instead of a colour mix", () => {
  const paint = testPaint(
    "color",
    testTheme({ colors: { muted: indexedColor(8), text: indexedColor(15) } }),
  );
  const out = shimmer(SHIMMERED, 6 * 80, paint);
  const cols = colours(out);
  expect(cols.flatMap(({ bold }, column) => (bold ? [column] : []))).toEqual([
    1, 2, 3,
  ]);
  expect(new Set(cols.map(({ fg }) => fg)).size).toBe(1);
});
