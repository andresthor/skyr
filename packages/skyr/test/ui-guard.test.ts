import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { failureLatch, guard } from "../src/ui/guard.js";

test("a render that throws yields no lines and is reported once, not once per frame", () => {
  const cause = new Error("boom");
  const onThrow = vi.fn();
  const render = vi.fn(() => {
    throw cause;
  });
  const drawn = guard(render, onThrow);

  expect(drawn(80)).toEqual([]);
  expect(drawn(80)).toEqual([]);
  expect(drawn(40)).toEqual([]);
  expect(onThrow).toHaveBeenCalledTimes(1);
  expect(onThrow).toHaveBeenCalledWith(cause);
  // After the first throw the render is not tried again
  expect(render).toHaveBeenCalledTimes(1);
});

test("a line wider than the width is cut to it", () => {
  const drawn = guard(
    () => ["short", "漢字".repeat(30), "x".repeat(50)],
    vi.fn(),
  );

  const lines = drawn(20);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe("short");
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
});

test("width zero renders nothing", () => {
  const render = vi.fn(() => ["x"]);
  const drawn = guard(render, vi.fn());

  expect(drawn(0)).toEqual([]);
  expect(drawn(-3)).toEqual([]);
  expect(render).not.toHaveBeenCalled();
  expect(drawn(5)).toEqual(["x"]);
});

test("a render that throws a value with no prototype is reported without escaping", async () => {
  const cause = Object.create(null);
  const report = vi.fn();
  const latch = failureLatch();
  const drawn = guard(
    () => {
      throw cause;
    },
    (c) => latch.trip(c, report),
  );

  expect(() => drawn(80)).not.toThrow();
  await Promise.resolve();
  expect(report).toHaveBeenCalledWith("unknown error");
});

test("a failure latch reports once until it is reset", async () => {
  const report = vi.fn();
  const latch = failureLatch();

  latch.trip(new Error("first"), report);
  latch.trip(new Error("second"), report);
  await Promise.resolve();
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith("first");

  latch.reset();
  latch.trip(new Error("third"), report);
  await Promise.resolve();
  expect(report).toHaveBeenCalledTimes(2);
});

test("a report that throws does not escape the latch", async () => {
  const latch = failureLatch();

  latch.trip(new Error("x"), () => {
    throw new Error("session gone");
  });

  await expect(Promise.resolve()).resolves.toBeUndefined();
});
