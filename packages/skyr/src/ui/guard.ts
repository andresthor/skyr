import { fitToWidth } from "./fit.js";

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
