// Scripted model for tengi-smoke: provider `wbfaux`, model `scripted`, loaded by tengi with
// `--extension`. The last user message `@<script> <json>` picks a reply; anything else gets a
// quick one. A tool result always gets closing text, so a tool turn never loops.
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
  name: "Scripted (faux)",
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
  const user = [...context.messages].reverse().find((m) => m.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return user.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

/** `@<script>` or `@<script> <json>`; malformed JSON reads as `{}`. */
function parseDirective(
  text: string,
): { script: string; args: JsonObject } | undefined {
  const m = /^@(\S+)(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!m?.[1]) return undefined;
  let args: unknown = {};
  try {
    args = m[2] === undefined ? {} : JSON.parse(m[2]);
  } catch {
    args = {};
  }
  return { script: m[1], args: isJsonObject(args) ? args : {} };
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

let calls = 0;

function script(context: TranscriptContext) {
  calls++;
  if (context.messages.at(-1)?.role === "toolResult")
    return fauxAssistantMessage("The command finished.");
  const directive = parseDirective(lastUserText(context));
  const id = `call-${calls}`;
  switch (directive?.script) {
    case "tools":
      return fauxAssistantMessage(
        `declared tools: ${declaredToolNames(context).join(",")}`,
      );
    case "bash": {
      const command = directive.args.command;
      return fauxAssistantMessage(
        [
          fauxToolCall(
            "bash",
            { command: typeof command === "string" ? command : "true" },
            { id },
          ),
        ],
        { stopReason: "toolUse" },
      );
    }
    case "tool": {
      const { name, args } = directive.args;
      return fauxAssistantMessage(
        [
          fauxToolCall(
            typeof name === "string" ? name : "unknown",
            isJsonObject(args) ? args : {},
            { id },
          ),
        ],
        { stopReason: "toolUse" },
      );
    }
    default:
      return fauxAssistantMessage(`quick reply (call ${calls})`);
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
