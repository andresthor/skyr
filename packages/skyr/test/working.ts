// The working state as Pi's events build it, for tests that draw from it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trackWorking } from "../src/chrome/working.js";

type Handler = (event: unknown, ctx: unknown) => void;

/** `trackWorking` on a fake Pi that keeps its handlers, so a test fires the events Pi would. */
export function chromeOnFakePi() {
  const handlers = new Map<string, Handler>();
  const pi = { on: (event: string, fn: Handler) => handlers.set(event, fn) };
  const working = trackWorking(pi as unknown as ExtensionAPI);
  const emit = (event: string, payload: object = {}) =>
    handlers.get(event)?.(payload, { mode: "print" });
  const start = (id: string, name: string, args: unknown, parent?: string) =>
    emit("tool_execution_start", {
      toolCallId: id,
      toolName: name,
      args,
      parentToolCallId: parent,
    });
  return { working, emit, start };
}

/** The state of a run in progress, driven by the events `trackWorking` listens to. */
export function fakeWorking() {
  const { working, emit, start } = chromeOnFakePi();
  return {
    ...working,
    agentStart: () => emit("agent_start"),
    toolStart: (id: string, name: string, args: unknown) =>
      start(id, name, args),
    toolEnd: (id: string) => emit("tool_execution_end", { toolCallId: id }),
  };
}
