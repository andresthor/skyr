// The one shared interval that running rows and the bar redraw on.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { everySecond } from "../src/ui/clock.js";

const stops: (() => void)[] = [];
const sub = (tick: () => void) => {
  const stop = everySecond(tick);
  stops.push(stop);
  return stop;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

test("the first subscriber starts one interval and the last unsubscribe clears it", () => {
  expect(vi.getTimerCount()).toBe(0);
  const first = sub(() => {});
  expect(vi.getTimerCount()).toBe(1);
  const second = sub(() => {});
  expect(vi.getTimerCount()).toBe(1);
  first();
  expect(vi.getTimerCount()).toBe(1);
  second();
  expect(vi.getTimerCount()).toBe(0);
});

test("two hundred subscribers still run one timer", () => {
  const tick = vi.fn();
  for (let i = 0; i < 200; i++) sub(tick);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(1_000);
  expect(tick).toHaveBeenCalledTimes(200);
});

test("an unsubscribe is idempotent, and one made inside a tick does not skip the next subscriber", () => {
  const seen: string[] = [];
  let stopFirst = () => {};
  stopFirst = sub(() => {
    seen.push("first");
    stopFirst();
    stopFirst();
  });
  sub(() => seen.push("second"));

  vi.advanceTimersByTime(1_000);
  vi.advanceTimersByTime(1_000);
  expect(seen).toEqual(["first", "second", "second"]);
  // The same function twice is two subscriptions: stopping one leaves the other
  const tick = vi.fn();
  const one = sub(tick);
  sub(tick);
  one();
  one();
  vi.advanceTimersByTime(1_000);
  expect(tick).toHaveBeenCalledTimes(1);
});

test("a throwing subscriber is dropped, its cause reported once, and the others keep ticking", () => {
  const cause = new Error("stale");
  const bad = vi.fn(() => {
    throw cause;
  });
  const reported = vi.fn();
  const good = vi.fn();
  stops.push(everySecond(bad, reported));
  sub(good);

  vi.advanceTimersByTime(3_000);
  expect(bad).toHaveBeenCalledTimes(1);
  expect(good).toHaveBeenCalledTimes(3);
  expect(reported).toHaveBeenCalledTimes(1);
  expect(reported).toHaveBeenCalledWith(cause);
});
