// The frames skyr gives Pi's working loader, and the ones its own working line draws for each
// situation.
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import type { Tier } from "../src/ui/caps.js";
import {
  frameAt,
  loaderIndicator,
  type Situation,
  situationOf,
  variantFor,
} from "../src/ui/spinner.js";
import { styledRuns, testPaint } from "./voice.js";

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
