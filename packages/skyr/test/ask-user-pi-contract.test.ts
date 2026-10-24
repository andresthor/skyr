// Pi behaviour the ask_user design rests on. A failure here after a Pi upgrade means the design
// changes, not the test.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createEventBus,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { parentSession, sections, toolsSeen } from "./session.js";

const ok = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
});

test("a declaration prepareLoadout hides leaves the prompt with its snippet and guidelines, yet a call the model makes anyway still runs", async () => {
  let ran = 0;
  const hidden = defineTool({
    name: "hidden",
    label: "hidden",
    description: "A tool its own loadout hides.",
    promptSnippet: "hidden-snippet-text",
    promptGuidelines: ["hidden-guideline-text"],
    parameters: Type.Object({}),
    prepareLoadout: () => ({ hiddenDeclarations: ["hidden"] }),
    async execute() {
      ran++;
      return ok("ran");
    },
  });
  const { requests, session } = await parentSession({
    respond: (context) =>
      context.messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage("done")
        : fauxAssistantMessage([fauxToolCall("hidden", {}, { id: "h" })]),
    customTools: [hidden],
  });
  await session.prompt("go");

  const first = requests[0]!;
  expect(toolsSeen(first)).not.toContain("hidden");
  const prompt = Object.values(sections(first)).join("\n");
  expect(prompt).not.toContain("hidden-snippet-text");
  expect(prompt).not.toContain("hidden-guideline-text");
  expect(ran).toBe(1);
});

test("a model-only tool is active on registration but never callable from another tool", async () => {
  const modelOnly = defineTool({
    name: "model_only",
    label: "model_only",
    description: "Reached by the model alone.",
    parameters: Type.Object({}),
    exposure: "model-only",
    async execute() {
      return ok("ran");
    },
  });
  const { session } = await parentSession({
    respond: () => fauxAssistantMessage("done"),
    customTools: [modelOnly],
  });
  expect(session.getActiveToolNames()).toContain("model_only");
  expect(session.getCallableToolNames()).not.toContain("model_only");
});

test("Editor.setText(getText()) leaves a paste marker with nothing behind it; getExpandedText() taken first keeps the pasted lines", () => {
  const editor = new Editor(
    { terminal: { rows: 40 }, requestRender: () => {} } as never,
    { borderColor: (s: string) => s, selectList: {} } as never,
  );
  const pasted = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  editor.handleInput("!");
  expect(editor.getText()).toBe("[paste #1 +40 lines]!");
  const expanded = editor.getExpandedText();
  expect(expanded).toBe(`${pasted}!`);

  editor.setText(editor.getText());
  expect(editor.getExpandedText()).toBe("[paste #1 +40 lines]!");
  editor.setText(expanded);
  expect(editor.getExpandedText()).toBe(`${pasted}!`);
});

test("prepareLoadout runs again before the next request, so a flag set after registration reaches the model on the next turn", async () => {
  let hide = false;
  const flip = defineTool({
    name: "flip",
    label: "flip",
    description: "Hides itself once called.",
    parameters: Type.Object({}),
    prepareLoadout: () => (hide ? { hiddenDeclarations: ["flip"] } : undefined),
    async execute() {
      hide = true;
      return ok("flipped");
    },
  });
  const { requests, session } = await parentSession({
    respond: (context) =>
      context.messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage("done")
        : fauxAssistantMessage([fauxToolCall("flip", {}, { id: "f" })]),
    customTools: [flip],
  });
  await session.prompt("go");
  expect(requests).toHaveLength(2);
  expect(toolsSeen(requests[0]!)).toContain("flip");
  expect(toolsSeen(requests[1]!)).not.toContain("flip");

  // the run path: a flag changed between prompts reaches the next prompt's first request
  hide = false;
  await session.prompt("again");
  expect(toolsSeen(requests[2]!)).toContain("flip");
});

test("a reply emitted from inside a bus handler lands before the querying emit returns", () => {
  const bus = createEventBus();
  bus.on("ask?", (q) => bus.emit("ask", { echo: q }));
  let heard: unknown;
  bus.on("ask", (r) => {
    heard = r;
  });
  bus.emit("ask?", 7);
  expect(heard).toEqual({ echo: 7 });
});

test("a prepareLoadout that throws leaves its declaration offered to the model", async () => {
  const loud = defineTool({
    name: "loud",
    label: "loud",
    description: "Its loadout hook throws.",
    parameters: Type.Object({}),
    prepareLoadout: () => {
      throw new Error("loadout failed");
    },
    async execute() {
      return ok("ran");
    },
  });
  const { requests, session } = await parentSession({
    respond: () => fauxAssistantMessage("done"),
    customTools: [loud],
  });
  await session.prompt("go");
  expect(toolsSeen(requests[0]!)).toContain("loud");
});

test("a reload drops an extension's bus subscription, while a subscription made on the bus itself still answers", async () => {
  const bus = createEventBus();
  const heard: string[] = [];
  const probe = (pi: ExtensionAPI) => {
    pi.events.on("ping", () => heard.push("extension"));
  };
  bus.on("ping", () => heard.push("host"));
  const { session } = await parentSession({
    respond: () => fauxAssistantMessage("done"),
    extensions: [probe],
    eventBus: bus,
  });
  bus.emit("ping", undefined);
  expect(heard.sort()).toEqual(["extension", "host"]);

  heard.length = 0;
  await session.reload();
  bus.emit("ping", undefined);
  // the factory re-ran on reload, so the new load's listener answers once, the old one never
  expect(heard.sort()).toEqual(["extension", "host"]);
});
