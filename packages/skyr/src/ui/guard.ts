import { fitToWidth } from "./fit.js";
import { describeCause, oneLine } from "./text.js";

/**
 * For a component Pi renders outside any handler, where a throw exits Pi: lines clamped to
 * `width`, `[]` for a width of 0 or less, and after the first throw `[]` for good, with the cause
 * handed once to `onThrow`, which must not throw.
 */
export function guard(
  render: (width: number) => string[],
  onThrow: (cause: unknown) => void,
): (width: number) => string[] {
  let failed = false;
  return (width) => {
    if (failed || width <= 0) return [];
    try {
      return render(width).map((line) => fitToWidth(line, width, ""));
    } catch (cause) {
      failed = true;
      onThrow(cause);
      return [];
    }
  };
}

/**
 * A surface that stopped drawing tells the user once: the first `trip` queues `report` with the
 * cause described on one line, and later trips do nothing until `reset`. The report runs outside
 * the failing call, and a throw from it is dropped, since the session that would show it may be
 * gone.
 */
export function failureLatch(): {
  trip(cause: unknown, report: (reason: string) => void): void;
  reset(): void;
} {
  let spent = false;
  return {
    trip(cause, report) {
      if (spent) return;
      spent = true;
      const reason = oneLine(describeCause(cause), 120);
      queueMicrotask(() => {
        try {
          report(reason);
        } catch {
          // The session that would show it may be gone
        }
      });
    },
    reset() {
      spent = false;
    },
  };
}
