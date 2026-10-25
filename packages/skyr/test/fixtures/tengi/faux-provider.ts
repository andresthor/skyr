// Scripted model for tengi-smoke (provider `wbfaux`). The last user message `@<script> <json>`
// picks a reply, anything else a quick one; a tool result always ends the turn.
import {
  type Api,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type JsonObject,
  type SimpleStreamOptions,
  type StreamFunction,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "wbfaux";
const MODEL = {
  id: "scripted",
  name: "Scripted",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
};

// What JSON.parse returns for an object is a JSON object
const isJsonObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function lastUserText(context: TranscriptContext): string {
  const content = [...context.messages]
    .reverse()
    .find((m) => m.role === "user")?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
}

/** `@<script>` or `@<script> <json>`; malformed JSON throws, so a typo cannot run a wrong script. */
function parseDirective(
  text: string,
): { script: string; args: JsonObject } | undefined {
  const m = /^@(\S+)(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!m?.[1]) return undefined;
  const args: unknown = m[2] === undefined ? {} : JSON.parse(m[2]);
  if (!isJsonObject(args)) throw new Error(`@${m[1]} needs a JSON object`);
  return { script: m[1], args };
}

/** The tools declared to the model: what system messages added and did not later remove. */
function declaredToolNames(context: TranscriptContext): string[] {
  const names = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
  }
  return [...names];
}

function script(context: TranscriptContext) {
  if (context.messages.at(-1)?.role === "toolResult")
    return fauxAssistantMessage("The command finished.");
  const directive = parseDirective(lastUserText(context));
  switch (directive?.script) {
    case "tools":
      return fauxAssistantMessage(
        `declared tools: ${declaredToolNames(context).join(",")}`,
      );
    case "tool": {
      const { name, args } = directive.args;
      if (typeof name !== "string" || !isJsonObject(args))
        throw new Error("@tool needs a string name and object args");
      return fauxAssistantMessage([fauxToolCall(name, args)], {
        stopReason: "toolUse",
      });
    }
    default:
      return fauxAssistantMessage("quick reply");
  }
}

const core = createFauxCore({
  api: PROVIDER,
  provider: PROVIDER,
  models: [MODEL],
});

// The faux queue shifts one step per call, so refill it before every call
const streamSimple: StreamFunction<Api, SimpleStreamOptions> = (
  model,
  context,
  options,
) => {
  core.setResponses([script]);
  return core.streamSimple(model, context, options);
};

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    name: "Scripted faux",
    baseUrl: "http://localhost:0",
    apiKey: PROVIDER,
    api: PROVIDER,
    models: [MODEL],
    streamSimple,
  });
}
