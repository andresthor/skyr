/**
 * skyr: tools for Pi. Plain Pi loads the default export; a host that composes its own
 * extension calls `registerSkyr`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "./advisor/index.js";
import { registerAskUser } from "./ask-user/index.js";
import { reportSkyrFile } from "./config.js";
import { registerSubagent } from "./subagent/index.js";
import { registerWebFetch } from "./tools/web-fetch.js";
import { registerWebSearch } from "./tools/web-search.js";
import { registerVoice } from "./voice/index.js";

export function registerSkyr(pi: ExtensionAPI): void {
  reportSkyrFile(pi);
  registerWebFetch(pi);
  registerWebSearch(pi);
  registerVoice(pi);
  registerSubagent(pi);
  registerAskUser(pi);
  registerAdvisor(pi);
}

export default function skyr(pi: ExtensionAPI): void {
  registerSkyr(pi);
}
