/**
 * Numbers as the user reads them. Display only: what a model reads is formatted where it is
 * written.
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Whole seconds as `41s`, `2m14s` or `1h04m`: the one form past ten seconds. */
function clock(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${pad2(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h${pad2(minutes % 60)}m`;
}

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
