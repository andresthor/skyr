/** The child's only extension: Pi's built-ins plus skyr's own web tools; nothing else loads. */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { registerWebFetch } from "../../tools/web-fetch.js";
import { registerWebSearch } from "../../tools/web-search.js";

export const registerChildTools: ExtensionFactory = (pi) => {
  registerWebSearch(pi);
  registerWebFetch(pi);
};
