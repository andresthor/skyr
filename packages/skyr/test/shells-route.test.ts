import { expect, test } from "vitest";
import { routeOf } from "../src/shells/index.js";

const LIMIT = 120_000;

test.each([
  ["a nested call", { toolCallId: "call/1", timeout: undefined }, "plain"],
  [
    "a nested call with a long timeout",
    { toolCallId: "a/b", timeout: 500 },
    "plain",
  ],
  ["a timeout under the limit", { toolCallId: "c1", timeout: 30 }, "plain"],
  ["a timeout equal to the limit", { toolCallId: "c1", timeout: 120 }, "plain"],
  [
    "a zero timeout, which Pi rejects itself",
    { toolCallId: "c1", timeout: 0 },
    "plain",
  ],
  [
    "a negative timeout, which Pi rejects itself",
    { toolCallId: "c1", timeout: -1 },
    "plain",
  ],
  ["a timeout over the limit", { toolCallId: "c1", timeout: 121 }, "move"],
  ["no timeout", { toolCallId: "c1", timeout: undefined }, "move"],
] as const)("%s routes as %s", (_name, call, route) => {
  expect(routeOf(call, LIMIT)).toBe(route);
});

test("a background call starts at once, with or without a timeout, whatever the limit", () => {
  for (const timeout of [undefined, 30, 500])
    expect(
      routeOf({ toolCallId: "c1", timeout, background: true }, LIMIT),
    ).toBe("start");
});

test("a nested background call throws, and says what to do instead", () => {
  expect(() =>
    routeOf({ toolCallId: "a/1", timeout: undefined, background: true }, LIMIT),
  ).toThrow(
    "bash: background is not available inside another tool's call; run the command without background, or call bash directly.",
  );
  expect(
    routeOf(
      { toolCallId: "a/1", timeout: undefined, background: false },
      LIMIT,
    ),
  ).toBe("plain");
});

test("the limit that decides is the one it is given, for a timeout and for none alike", () => {
  expect(routeOf({ toolCallId: "c1", timeout: 1 }, 500)).toBe("move");
  expect(routeOf({ toolCallId: "c1", timeout: 0.5 }, 500)).toBe("plain");
});
