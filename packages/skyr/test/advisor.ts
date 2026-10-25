import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import {
  fauxToolCall,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { type AgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Sends requests to any model but the session's own `faux-1` (the advisor's, in tests) to
 * `advice` and records each one; the rest go to `parent`. By model, since the advisor's
 * transcript also opens on "go".
 */
export function advisorRouter(
  parent: FauxResponseFactory,
  advice: FauxResponseFactory,
): {
  respond: FauxResponseFactory;
  calls: {
    context: TranscriptContext;
    options: SimpleStreamOptions | undefined;
  }[];
} {
  const calls: {
    context: TranscriptContext;
    options: SimpleStreamOptions | undefined;
  }[] = [];
  const respond: FauxResponseFactory = (context, options, state, model) => {
    if (model.id === "faux-1") return parent(context, options, state, model);
    calls.push({ context, options });
    return advice(context, options, state, model);
  };
  return { respond, calls };
}

/** A `skyr.json` that turns the advisor on, on faux-2. */
export const ADVISOR_ON = { advisor: { model: "faux/faux-2" } };

export const advisorCall = (id = "adv") => fauxToolCall("advisor", {}, { id });

/** The session's advisor results, in order. */
export function advisorResults(session: AgentSession) {
  return session.messages.flatMap((m) =>
    m.role === "toolResult" && m.toolName === "advisor" ? [m] : [],
  );
}

/** A tool that answers "echoed", for a call in the transcript with a result after it. */
export const echo = defineTool({
  name: "echo",
  label: "echo",
  description: "Echoes.",
  parameters: Type.Object({ x: Type.Optional(Type.Number()) }),
  async execute() {
    return { content: [{ type: "text", text: "echoed" }], details: {} };
  },
});
