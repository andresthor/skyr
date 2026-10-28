import { afterEach, expect, test } from "vitest";
import { keyLabel, keyName } from "../src/ui/hint.js";

const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
});

const on = (name: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { value: name });

test("a key is spelled as Pi spells it: option for alt on macOS only", () => {
  on("darwin");
  expect(keyLabel("alt+a")).toBe("option+a");
  expect(keyLabel("ctrl+alt+s")).toBe("ctrl+option+s");
  expect(keyLabel("ctrl+a")).toBe("ctrl+a");
  on("linux");
  expect(keyLabel("alt+a")).toBe("alt+a");
});

test("a binding's name is its first key, spelled the same way, and empty when unbound", () => {
  on("darwin");
  const keys = {
    getKeys: (id: string) => (id === "x" ? ["alt+x", "ctrl+x"] : []),
  };
  expect(keyName(keys as never, "x" as never)).toBe("option+x");
  expect(keyName(keys as never, "y" as never)).toBe("");
});
