import { expect, test } from "vitest";
import { routeOf } from "../src/shells/index.js";

const route = (call: object, limit: number) =>
  routeOf({ toolCallId: "c1", timeout: undefined, ...call }, limit);

test.each([
  ["a nested call", { toolCallId: "a/1" }, 120_000, "plain"],
  ["a timeout under the limit", { timeout: 30 }, 120_000, "plain"],
  ["a timeout equal to the limit", { timeout: 120 }, 120_000, "plain"],
  ["a zero timeout, which Pi rejects itself", { timeout: 0 }, 120_000, "plain"],
  ["a timeout over the limit", { timeout: 121 }, 120_000, "move"],
  ["no timeout", {}, 120_000, "move"],
  ["background and no timeout", { background: true }, 120_000, "start"],
  [
    "background and a short timeout",
    { timeout: 30, background: true },
    120_000,
    "start",
  ],
  ["a 1 s timeout against a 500 ms limit", { timeout: 1 }, 500, "move"],
  ["a 0.5 s timeout against a 500 ms limit", { timeout: 0.5 }, 500, "plain"],
] as const)("%s routes as %s", (_name, call, limit, want) => {
  expect(route(call, limit)).toBe(want);
});

test("a nested background call throws, and says what to do instead", () => {
  expect(() => route({ toolCallId: "a/1", background: true }, 120_000)).toThrow(
    "bash: background is not available inside another tool's call; run the command without background, or call bash directly.",
  );
  expect(route({ toolCallId: "a/1", background: false }, 120_000)).toBe(
    "plain",
  );
});
