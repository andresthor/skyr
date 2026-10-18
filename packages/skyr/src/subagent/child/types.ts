/** Plain-data contract of one child run: the same spec and events flow to either runner. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type AssistantMessage = Extract<
  AgentSession["messages"][number],
  { role: "assistant" }
>;

/** Fields Pi's session totals count; the optional token splits are left out. */
export type Usage = AssistantMessage["usage"];

export type { AssistantMessage };

type ThinkingLevel = AgentSession["thinkingLevel"];

/** Everything a child needs, as plain data, so a subprocess runner can take the same spec. */
export interface ChildSpec {
  id: string;
  cwd: string;
  /** `provider/id` or a `pi --model` pattern; a `:level` suffix overrides `thinkingLevel`. */
  model: string;
  thinkingLevel: ThinkingLevel | undefined;
  /** Already validated: Pi silently drops a name it does not know. */
  tools: string[];
  /** Appended to Pi's system prompt when non-empty; Pi keeps its tool list and guidelines. */
  systemPrompt: string;
  task: string;
  /** Whether the child may read the project's `.pi/` settings and prompts. */
  trusted: boolean;
  /** Labels the run for a delivery header when a crashed parent's answer is recovered. */
  description: string;
  agent?: string;
  /** Absent: the child is not saved, as for a parent run under `--no-session`. */
  session?: { dir: string; parent: string } | { resume: string };
}

/** `usage` is the child's running total, not the turn's own. */
export type ChildEvent =
  | { type: "tool"; name: string }
  | { type: "turn"; usage: Usage }
  | { type: "stalled"; stalled: boolean };

export interface ChildResult {
  status: "done" | "failed" | "aborted";
  /** Undefined when the child stopped without writing text. */
  text: string | undefined;
  error: string | undefined;
  usage: Usage;
  sessionFile: string | undefined;
}

/** The whole lifecycle behind one Runner seam: `run` throws only when nothing was spent. */
export interface Runner {
  run(
    spec: ChildSpec,
    signal: AbortSignal,
    onEvent: (event: ChildEvent) => void,
  ): Promise<ChildResult>;
}
