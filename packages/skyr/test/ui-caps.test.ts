import { expect, test } from "vitest";
import { canDraw, glyphsOf, tierOf } from "../src/ui/caps.js";

test.each([
  [{ TERM: "dumb" }],
  [{ TERM: "dumb", NO_COLOR: "1" }],
  [{ TERM: "dumb", FORCE_COLOR: "1" }],
  [{ TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "1" }],
] as const)(
  "TERM=dumb is ascii whatever NO_COLOR and FORCE_COLOR say: %j",
  (env) => {
    expect(tierOf(env)).toBe("ascii");
  },
);

test.each([
  [{ TERM: "xterm-256color", NO_COLOR: "1" }, "mono"],
  [{ NO_COLOR: "1", FORCE_COLOR: "0" }, "mono"],
  [{ NO_COLOR: "1", FORCE_COLOR: "false" }, "mono"],
  [{ NO_COLOR: "1", FORCE_COLOR: "1" }, "color"],
  [{ NO_COLOR: "1", FORCE_COLOR: "true" }, "color"],
  [{ NO_COLOR: "" }, "color"],
  [{}, "color"],
] as const)(
  "NO_COLOR without FORCE_COLOR is mono; FORCE_COLOR other than 0 or false restores colour: %j is %s",
  (env, tier) => {
    expect(tierOf(env)).toBe(tier);
  },
);

test("the glyph table: unicode in colour and mono, ASCII under TERM=dumb", () => {
  const unicode = {
    ellipsis: "…",
    mark: {
      queued: "□",
      running: "•",
      failed: "×",
      done: "✓",
      stopped: "■",
      mixed: "!",
    },
    now: "›",
    from: "←",
    to: "→",
    rail: "│",
    branch: { mid: "├", last: "└" },
    sep: " · ",
  };
  expect(glyphsOf("color")).toEqual(unicode);
  expect(glyphsOf("mono")).toEqual(unicode);
  expect(glyphsOf("ascii")).toEqual({
    ellipsis: "...",
    mark: {
      queued: "o",
      running: "*",
      failed: "x",
      done: "+",
      stopped: "#",
      mixed: "!",
    },
    now: ">",
    from: "<-",
    to: "->",
    rail: "|",
    branch: { mid: "|", last: "`" },
    sep: " - ",
  });
});

test("only the terminal UI can draw: rpc has a UI for dialogs and ignores components", () => {
  expect(canDraw({ mode: "tui" })).toBe(true);
  for (const mode of ["rpc", "json", "print"] as const)
    expect(canDraw({ mode })).toBe(false);
});
