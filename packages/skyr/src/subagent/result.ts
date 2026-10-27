/**
 * What the model reads about a child: its answer cut to a cap, the header of a delivered answer,
 * the result of a background start, and the id tag `continue` takes.
 */
import { loadPi } from "../pi.js";
import { clip, tokens } from "../tools/render.js";
import { spill } from "../tools/spill.js";
import type { ChildResult } from "./runner.js";
import { count, labelOf, type RunSnapshot } from "./store.js";

const MAX_ANSWER_BYTES = 10_000;

/** What a finished child hands back, for a tool result or a delivered message. */
export interface LaneOutcome {
  text: string;
  details: RunSnapshot;
  usage?: ChildResult["usage"];
  isError: boolean;
}

export const idTag = (id: string) => `(id ${id.slice(0, 8)})`;

/**
 * The child's answer, or a sentence saying why there is none, with the reason alone as `error`.
 * An answer past the cap is cut, and the whole of it saved to the returned `spillFile`.
 * `stoppedBy` follows "was stopped", as in `" by the user"`.
 */
export async function answer(
  label: string,
  id: string,
  result: ChildResult,
  {
    recovered,
    stoppedBy = "",
  }: { recovered?: boolean; stoppedBy?: string } = {},
): Promise<{ text: string; spillFile?: string; error?: string }> {
  const marker = recovered ? " (recovered after a restart)" : "";
  if (result.status === "aborted")
    return {
      text: `subagent: ${label} was stopped${stoppedBy} before it answered${marker}`,
      error: `stopped${stoppedBy}`,
    };
  if (result.status === "failed") {
    const cause = result.error ?? "no error message";
    return {
      text: `subagent: ${label} failed${marker}: ${cause}`,
      error: clip(cause),
    };
  }
  if (!result.text)
    return {
      text: `subagent: ${label} ended without an answer${marker}`,
      error: "ended without an answer",
    };
  const { truncateHead, DEFAULT_MAX_LINES } = await loadPi();
  const cut = truncateHead(result.text, {
    maxBytes: MAX_ANSWER_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!cut.truncated) return { text: result.text };
  try {
    const spillFile = await spill(id, result.text);
    return {
      text: `${cut.content}\n\n[Truncated: the full answer is in ${spillFile}]`,
      spillFile,
    };
  } catch {
    // ENOSPC or an unwritable temp dir must not cost the model the capped answer it paid for.
    return {
      text: `${cut.content}\n\n[Truncated: the full answer could not be saved to disk; tell the user]`,
    };
  }
}

/** The model's one-line header for a delivered answer, then the answer. */
export function delivery(outcome: LaneOutcome): string {
  const run = outcome.details;
  return `[background subagent ${labelOf(run)} ${idTag(run.id)}: ${run.status}, ${count(run.turns, "turn")}, ${count(run.toolCalls, "tool")}, ${tokens(run.tokens)}]\n\n${outcome.text}`;
}

export const startedText = (run: RunSnapshot) =>
  `subagent: started ${labelOf(run)} in the background ${idTag(run.id)}; its answer arrives as a message when it finishes`;
