import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

/**
 * The first key bound to `id`, spelled as Pi spells a key (`option` for `alt` on macOS); empty
 * when unbound. Not Pi's `keyText`: that reads the global bindings instead of `keys`, names
 * every bound key, and lives in pi-coding-agent, which a render path cannot load synchronously.
 */
export function keyName(
  keys: Pick<KeybindingsManager, "getKeys">,
  id: Parameters<KeybindingsManager["getKeys"]>[0],
): string {
  return keyLabel(keys.getKeys(id)[0] ?? "");
}

/** A key as Pi spells it in hints: `option` for `alt` on macOS. */
export function keyLabel(key: string): string {
  return process.platform === "darwin"
    ? key.replace(/\balt\b/g, "option")
    : key;
}
