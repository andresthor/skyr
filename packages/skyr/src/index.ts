/**
 * skyr: tools for Pi. Plain Pi loads the default export; a host that composes its own
 * extension calls `registerSkyr`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "./advisor/index.js";
import { registerAskUser } from "./ask-user/index.js";
import { registerChrome } from "./chrome/index.js";
import { reportSkyrFile } from "./config.js";
import { loadPi } from "./pi.js";
import { registerShells } from "./shells/index.js";
import { identify } from "./shells/job.js";
import { registerSubagent } from "./subagent/index.js";
import { registerBuiltinRows } from "./tools/builtin-rows.js";
import { registerWebFetch } from "./tools/web-fetch.js";
import { registerWebSearch } from "./tools/web-search.js";
import { registerVoice } from "./voice/index.js";

/**
 * Registers every skyr tool. The synchronous registrations come first. The promise settles once
 * the shells' `session_start` handler is in place; a session that starts before then keeps Pi's
 * own `bash`, and skyr serves it from the next session start.
 */
export async function registerSkyr(pi: ExtensionAPI): Promise<void> {
  reportSkyrFile(pi);
  const chrome = registerChrome(pi);
  registerWebFetch(pi);
  registerWebSearch(pi);
  registerVoice(pi, chrome.editor);
  registerSubagent(pi, chrome.bar);
  registerAskUser(pi);
  registerAdvisor(pi);
  const piModule = await loadPi();
  await registerBuiltinRows(pi, piModule);
  // Read in the factory, so the shells' `session_start` registers `bash` before its first await.
  // A ps that does not answer leaves Pi unidentified, so the shells step aside
  const self = (await identify(process.pid).catch(() => undefined))?.token;
  registerShells(pi, piModule, self, chrome.bar);
}

export default async function skyr(pi: ExtensionAPI): Promise<void> {
  await registerSkyr(pi);
}
