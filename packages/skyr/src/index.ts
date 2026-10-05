/**
 * skyr: tools for Pi. Plain Pi loads the default export; a host that composes its own
 * extension calls `registerSkyr`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerSkyr(_pi: ExtensionAPI): void {}

export default function skyr(pi: ExtensionAPI): void {
  registerSkyr(pi);
}
