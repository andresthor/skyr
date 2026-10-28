// The frames skyr gives Pi's working loader, and (as the situations arrive) the ones its own
// working line draws.
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import type { Tier } from "../src/ui/caps.js";
import { loaderIndicator } from "../src/ui/spinner.js";
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
