/**
 * One interval for everything that redraws on the second, so a hundred running rows cost one
 * timer. Its subscribers are the bar and the footer, which each release their own tick when they
 * stop.
 */

/** One entry per subscription, so the same function twice is two subscriptions. */
const entries = new Set<{
  tick: () => void;
  onThrow?: (cause: unknown) => void;
}>();
let interval: ReturnType<typeof setInterval> | undefined;

/** Clears the interval once nobody is subscribed. */
function idle(): void {
  if (entries.size > 0 || interval === undefined) return;
  clearInterval(interval);
  interval = undefined;
}

function run(): void {
  for (const entry of entries) {
    try {
      entry.tick();
    } catch (cause) {
      entries.delete(entry);
      try {
        entry.onThrow?.(cause);
      } catch {
        // Outside any handler a rethrow would exit Pi, and the failed subscriber is gone
      }
    }
  }
  idle();
}

/**
 * Calls `tick` once a second until the returned stop, which is idempotent. All callers share one
 * interval that runs only while one is subscribed. A throwing tick is dropped, and its cause goes
 * to `onThrow` once; without one the cause is dropped with it, and a throwing `onThrow` cannot
 * take the process down — the interval runs outside any handler.
 */
export function everySecond(
  tick: () => void,
  onThrow?: (cause: unknown) => void,
): () => void {
  const entry = { tick, onThrow };
  entries.add(entry);
  if (interval === undefined) {
    interval = setInterval(run, 1000);
    // Redraws are never worth keeping a finished process alive
    interval.unref();
  }
  return () => {
    entries.delete(entry);
    idle();
  };
}
