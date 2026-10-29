// What the main agent is doing, as skyr's chrome learns it from Pi's events.

import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CORPUS } from "./ui.js";
import { chromeOnFakePi } from "./working.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("agent_start records the start and agent_end clears it", () => {
  const { working, emit } = chromeOnFakePi();
  vi.setSystemTime(5_000);
  expect(working.state().since).toBeUndefined();
  emit("agent_start");
  expect(working.state().since).toBe(5_000);
  emit("agent_end");
  expect(working.state().since).toBeUndefined();
});

test("a tool runs from its start event to its end event; one called by another tool is ignored", () => {
  const { working, emit, start } = chromeOnFakePi();
  emit("agent_start");
  start("a", "bash", { command: "ls" });
  start("b", "read", { path: "x" }, "a");
  expect(working.state().tools).toEqual(["bash"]);
  emit("tool_execution_end", { toolCallId: "b" });
  expect(working.state().tools).toEqual(["bash"]);
  emit("tool_execution_end", { toolCallId: "a" });
  expect(working.state().tools).toEqual([]);
});

test("a session start or end forgets the last run", () => {
  const { working, emit, start } = chromeOnFakePi();
  for (const event of ["session_start", "session_shutdown"]) {
    emit("agent_start");
    start("a", "bash", { command: "ls" });
    emit(event);
    expect(working.state()).toEqual({
      since: undefined,
      tools: [],
      action: undefined,
    });
  }
});

test("the action names the tool and what it works on, and a tool without a known subject shows its name", () => {
  const { working, emit, start } = chromeOnFakePi();
  const actionOf = (name: string, args: unknown) => {
    start("call", name, args);
    const action = working.state().action;
    emit("tool_execution_end", { toolCallId: "call" });
    return action;
  };
  expect(actionOf("bash", { command: "pnpm lint src/auth" })).toBe(
    "bash pnpm lint src/auth",
  );
  expect(actionOf("read", { path: "src/a.ts" })).toBe("read src/a.ts");
  expect(actionOf("grep", { pattern: "TODO", path: "src" })).toBe("grep TODO");
  expect(actionOf("web_fetch", { url: "https://x.test" })).toBe(
    "web_fetch https://x.test",
  );
  expect(actionOf("subagent", { tasks: [{ prompt: "do it" }] })).toBe(
    "subagent",
  );
  expect(actionOf("bash", { command: 7 })).toBe("bash");
  expect(actionOf("bash", null)).toBe("bash");
});

test("with parallel calls the latest started that still runs names the action, and none running leaves none", () => {
  const { working, emit, start } = chromeOnFakePi();
  expect(working.state().action).toBeUndefined();
  start("a", "bash", { command: "sleep 9" });
  start("b", "read", { path: "x.ts" });
  expect(working.state().action).toBe("read x.ts");
  emit("tool_execution_end", { toolCallId: "b" });
  expect(working.state().action).toBe("bash sleep 9");
  emit("tool_execution_end", { toolCallId: "a" });
  expect(working.state().action).toBeUndefined();
});

test("an action is one safe line however hostile the model's arguments", () => {
  const { working, start } = chromeOnFakePi();
  for (const hostile of CORPUS) {
    start("a", "bash", { command: `${hostile}\n--rm -rf` });
    const action = working.state().action ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the property under test
    expect(action).not.toMatch(/[\u0000-\u001f\u007f‮​]/);
    expect(visibleWidth(action)).toBeLessThanOrEqual(300);
  }
});

test("a long action is cut by column without splitting an emoji or adding an ellipsis", () => {
  const { working, start } = chromeOnFakePi();
  for (const command of [
    `${"a".repeat(79)}\u{1F642}\u{1F642}`,
    `${"a".repeat(299)}\u{1F642}`,
    "a".repeat(400),
  ]) {
    start("a", "bash", { command });
    const action = working.state().action ?? "";
    expect(action).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(action).not.toContain("…");
    expect(visibleWidth(action)).toBeLessThanOrEqual(300);
  }
});
