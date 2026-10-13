/**
 * skyr: tools for Pi. Plain Pi loads the default export; a host that composes its own
 * extension calls `registerSkyr`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagent } from "./subagent/index.js";
import { registerWebFetch } from "./tools/web-fetch.js";
import { registerWebSearch } from "./tools/web-search.js";
import { registerVoice } from "./voice/index.js";

export function registerSkyr(pi: ExtensionAPI): void {
  registerWebFetch(pi);
  registerWebSearch(pi);
  registerVoice(pi);
  registerSubagent(pi);
}

export default function skyr(pi: ExtensionAPI): void {
  registerSkyr(pi);
}
