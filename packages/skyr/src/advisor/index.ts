/**
 * `advisor`: the main model asks a stronger model to review the session so far. Off until
 * `skyr.json` names a model; the session goes to that model as a quoted transcript and its
 * advice comes back as the tool result, with the review's usage on it.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readSkyrSection } from "../config.js";
import { loadPi } from "../pi.js";
import {
  elapsed,
  errorRow,
  firstLine,
  tokens,
  took,
  toolRow,
} from "../tools/render.js";
import { oneLine, quoted, sanitize, stripInvisible } from "../ui/text.js";
import { type AdvisorModel, parseAdvisorSection } from "./config.js";
import { adviceTokens, advisorContext } from "./dialogue.js";

type Model = Parameters<ModelRegistry["streamSimple"]>[0];
type Reply = Awaited<
  ReturnType<ReturnType<ModelRegistry["streamSimple"]>["result"]>
>;

// An HTML export hands `renderResult` only `content` and `details`, so the row reads its
// figures here rather than from `usage`.
interface AdvisorDetails {
  model: string;
  /** Every token the review used, cached input included: `usage.totalTokens`. */
  tokens: number;
}

const ERROR_CHARS = 200;

// A thrown call persists `details: {}`, and a restored session may hold an older shape.
function isAdvice(details: unknown): details is AdvisorDetails {
  return (
    typeof details === "object" &&
    details !== null &&
    "model" in details &&
    typeof details.model === "string" &&
    "tokens" in details &&
    typeof details.tokens === "number"
  );
}

const GUIDELINES = [
  "Call advisor before substantive work (writing, editing, committing to an interpretation or building on an assumption), after any orientation you need first. Call it again when you believe the task is done, once the deliverable is durable (file written, change committed). Also call it when stuck, when errors recur, or before changing approach. Skip it on short reactive tasks where the next step follows from the output you just read.",
  "Call advisor on its own, in a message with no other tool calls: a call made beside it may still be running while the advisor reads the session.",
  "Give the advisor's advice serious weight. Depart from it only when a step fails empirically or you hold direct evidence against a specific claim; a passing self-test is not such evidence.",
  "When your evidence and the advisor's advice disagree, do not silently pick one. Write down what you found and what the advisor said, then call advisor again.",
  "Advice from advisor never authorises an irreversible action the user did not ask for.",
];

/**
 * What the agent gets back from the review: the advice, cleaned of invisible characters, or a
 * tool error naming why there is none. Returned, not thrown: a thrown result drops the usage.
 */
function adviceResult(reply: Reply, spec: string) {
  const { usage } = reply;
  const details: AdvisorDetails = { model: spec, tokens: usage.totalTokens };
  const failed = (text: string) => ({
    content: [{ type: "text" as const, text }],
    details,
    usage,
    isError: true,
  });
  if (reply.stopReason === "error")
    return failed(
      `advisor: ${spec} failed: ${oneLine(reply.errorMessage ?? "no error message", ERROR_CHARS)}. No review was received; continue on your own judgement and tell the user the advisor was unavailable`,
    );
  if (reply.stopReason === "aborted")
    return failed(
      "advisor: the review was interrupted before it finished, so there is no advice; do not call advisor again unless the user asks",
    );
  const advice = stripInvisible(
    reply.content
      .flatMap((c) => (c.type === "text" && c.text.trim() ? [c.text] : []))
      .join("\n\n")
      .trim(),
  );
  if (!advice)
    return failed(
      reply.stopReason === "length"
        ? `advisor: ${spec} used its whole output limit on reasoning and wrote no advice; continue without the review`
        : `advisor: ${spec} returned no advice (stop reason: ${reply.stopReason}); continue without the review`,
    );
  const text =
    reply.stopReason === "length"
      ? `${advice}\n\n[advice cut off at the output limit]`
      : advice;
  return { content: [{ type: "text" as const, text }], details, usage };
}

export function registerAdvisor(pi: ExtensionAPI): void {
  let advisor: AdvisorModel | undefined;
  let credentialsReported = false;

  /** The configured advisor model, or why there is none. */
  function resolve(
    ctx: ExtensionContext,
  ):
    | { model: Model; spec: string }
    | { missing: "unset" }
    | { missing: "unknown" | "credentials"; spec: string } {
    if (!advisor) return { missing: "unset" };
    const spec = `${advisor.provider}/${advisor.id}`;
    const model = ctx.modelRegistry.find(advisor.provider, advisor.id);
    if (!model) return { missing: "unknown", spec };
    if (!ctx.modelRegistry.hasConfiguredAuth(model))
      return { missing: "credentials", spec };
    return { model, spec };
  }

  // Not session_start: removing a tool there drops MCP tools still connecting; and only on
  // change, since a changed set costs a cache miss.
  function sync(ctx: ExtensionContext): void {
    const resolved = resolve(ctx);
    if (
      "missing" in resolved &&
      resolved.missing === "credentials" &&
      !credentialsReported
    ) {
      credentialsReported = true;
      ctx.ui.notify(
        `skyr.json: advisor.model ${quoted(resolved.spec, 80)} has no credentials; advisor off until it has`,
        "warning",
      );
    }
    const wanted = "model" in resolved;
    const active = pi.getActiveTools();
    if (wanted === active.includes("advisor")) return;
    pi.setActiveTools(
      wanted ? [...active, "advisor"] : active.filter((t) => t !== "advisor"),
    );
  }

  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description:
      "Ask a stronger reviewer model for a second opinion on your work. Takes no arguments: the session so far is forwarded as a transcript, with the user's messages, your messages, your tool calls and their results, and your latest reasoning. Returns the reviewer's advice as text.",
    promptSnippet: "Get a stronger model's review of the work so far",
    promptGuidelines: GUIDELINES,
    annotations: { readOnlyHint: true, openWorldHint: true },
    parameters: Type.Object({}),
    exposure: "model-only",
    defaultActive: false,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const resolved = resolve(ctx);
      if ("missing" in resolved) {
        const cause =
          resolved.missing === "unset"
            ? "skyr.json: advisor.model is unset"
            : resolved.missing === "unknown"
              ? `${resolved.spec} is not a known model`
              : `${resolved.spec} has no credentials`;
        throw new Error(
          `advisor: no usable advisor model (${cause}); continue without the review`,
        );
      }
      const { model, spec } = resolved;
      const context = advisorContext(
        ctx.sessionManager.buildSessionProjection().messages,
        ctx.getSystemPrompt(),
        model,
        await loadPi(),
      );
      if ("needed" in context)
        throw new Error(
          `advisor: the session does not fit ${spec}'s context window even after cutting (about ${context.needed} tokens, ${context.available} available); continue without the review`,
        );
      const reply = await ctx.modelRegistry
        .streamSimple(model, context, {
          reasoning: "high",
          maxTokens: adviceTokens(model),
          sessionId: `${ctx.sessionManager.getSessionId()}:advisor`,
          signal,
        })
        .result();
      return adviceResult(reply, spec);
    },
    renderCall(_args, theme, context) {
      return toolRow(theme, [
        ["toolTitle", "advisor", true],
        ...elapsed(context),
      ]);
    },
    renderResult(result, options, theme, context) {
      if (context.isError)
        return errorRow(theme, result.content, took(context));
      const d = result.details;
      if (!isAdvice(d))
        return toolRow(theme, [
          ["muted", firstLine(result.content)],
          ...took(context),
        ]);
      const row = toolRow(theme, [
        ["success", "✓ advice"],
        ["muted", ` · ${d.model} · ${tokens(d.tokens)}`],
        ...took(context),
      ]);
      if (!options.expanded) return row;
      const advice = result.content
        .flatMap((c) => (c.type === "text" ? [c.text] : []))
        .join("\n");
      const box = new Container();
      box.addChild(row);
      box.addChild(new Text(advice.split("\n").map(sanitize).join("\n"), 0, 0));
      return box;
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const section = parseAdvisorSection(await readSkyrSection("advisor"));
    advisor = section.model;
    credentialsReported = false;
    const problems = [...section.problems];
    const resolved = resolve(ctx);
    if ("missing" in resolved && resolved.missing === "unknown")
      problems.push(
        `skyr.json: advisor.model ${quoted(resolved.spec, 80)} is not a known model; advisor off`,
      );
    if (problems.length > 0) ctx.ui.notify(problems.join("\n"), "warning");
  });

  pi.on("before_agent_start", (_event, ctx) => sync(ctx));
}
