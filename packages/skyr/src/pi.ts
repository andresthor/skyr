/**
 * The host's pi-coding-agent, loaded on demand; skyr's factory awaits it once so the shells
 * can build on Pi's own `bash`. A static value import would make loading skyr evaluate
 * pi-coding-agent, which reads environment variables at module scope; the boundary test
 * forbids it, and this is the one place that imports the package.
 */
export const loadPi = () => import("@earendil-works/pi-coding-agent");

/** What `loadPi` resolves to. */
export type PiModule = Awaited<ReturnType<typeof loadPi>>;
