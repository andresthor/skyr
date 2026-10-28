/**
 * The errno of a failed call ("ENOENT", …), or undefined when it has none. Looks down the cause
 * chain too: undici wraps the real error (DNS, TLS) at a depth that varies by Node version, and
 * groups some of them in `errors`.
 */
export function errnoOf(error: unknown): string | undefined {
  for (let e: unknown = error, hops = 0; hops < 4; hops++) {
    if (typeof e !== "object" || e === null) return undefined;
    if ("code" in e && typeof e.code === "string") return e.code;
    const wrapped = e as { cause?: unknown; errors?: unknown[] };
    e = wrapped.cause ?? wrapped.errors?.[0];
  }
  return undefined;
}
