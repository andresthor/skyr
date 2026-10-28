/**
 * One interval for everything that redraws on the second, so a hundred running rows cost one
 * timer.
 */

/** One entry per subscription, so the same function twice is two subscriptions. */
const entries = new Set<{ tick: () => void }>();
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
    } catch {
      // One row's failing redraw must not stop the others
      entries.delete(entry);
    }
  }
  idle();
}

/**
 * Calls `tick` once a second until the returned stop, which is idempotent. All callers share one
 * interval that runs only while one is subscribed; a throwing tick is dropped.
 */
export function everySecond(tick: () => void): () => void {
  const entry = { tick };
  entries.add(entry);
  interval ??= setInterval(run, 1000);
  return () => {
    entries.delete(entry);
    idle();
  };
}
