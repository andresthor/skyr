/**
 * Numbers as the user reads them; what a model reads is formatted where it is written.
 * `positiveOrZero` is the exception: the guard for counts and costs read from a session.
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `value` when it is a finite number above zero, else 0: a usage count or cost that an old session may hold badly. */
export const positiveOrZero = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Whole seconds as `41s`, `2m14s` or `1h04m`: the one form past ten seconds. */
function clock(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${pad2(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h${pad2(minutes % 60)}m`;
}

/** `1 turn`, `3 turns`; pass `many` when the plural is not the noun plus `s`. */
export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** A finished span: `0.1s`-`9.9s`, `41s`, `2m14s`, `1h04m`; zero for negative or non-finite input. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  const tenths = Math.round(ms / 100) / 10;
  return tenths < 10 ? `${tenths.toFixed(1)}s` : clock(Math.round(ms / 1000));
}

/** A running span in whole seconds so the digits do not flicker: `16s`, `1m04s`, `1h04m`. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  return clock(Math.floor(ms / 1000));
}

/** A count without a unit: `850`, `61k`, `412k`, `1M`, `1.2M`; one decimal only in millions, never `1000k`. */
export function formatCount(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  // The cut-over is where thousands would round up to 1000k
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
}

/** `850 tok`, `61k tok`, `1M tok`: a count with its unit, by the same rule. */
export const formatTokens = (n: number): string => `${formatCount(n)} tok`;

/** Money: `$1.82` below $100, whole dollars from $100 (`$102`); `$0.00` for negative or non-finite input. */
export function formatCost(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "$0.00";
  const cents = Math.round(n * 100);
  return cents < 10_000 ? `$${(cents / 100).toFixed(2)}` : `$${Math.round(n)}`;
}
