/**
 * What the main agent is doing, from Pi's events: the run in progress and the tools executing
 * now. The working line reads it on every frame; nothing here draws or keeps time.
 */
import { fitToWidth } from "../ui/fit.js";
import { sanitize } from "../ui/text.js";

/** The argument that says what a tool is working on; a tool not listed shows its bare name. */
const SUBJECT_OF: Readonly<Record<string, string>> = {
  bash: "command",
  read: "path",
  edit: "path",
  write: "path",
  ls: "path",
  grep: "pattern",
  find: "pattern",
  web_fetch: "url",
  web_search: "query",
};

/** Columns kept of an action; the line cuts it again to its width, ellipsis and all. */
const ACTION_COLS = 300;

interface WorkingState {
  /** The `agent_start` of the run in progress; undefined between runs and before this load saw one. */
  readonly since: number | undefined;
  /** Names of the main agent's tools executing now; calls made by another tool are not counted. */
  readonly tools: readonly string[];
  /** The tool started last that still runs, as one safe line (`bash pnpm lint`); undefined when none runs. */
  readonly action: string | undefined;
}

export interface Working {
  state(): WorkingState;
}

interface Running {
  readonly name: string;
  readonly action: string;
}

function actionOf(name: string, args: unknown): string {
  const key = SUBJECT_OF[name];
  const subject =
    key && typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)[key]
      : undefined;
  return fitToWidth(
    sanitize(typeof subject === "string" ? `${name} ${subject}` : name).trim(),
    ACTION_COLS,
    "",
  );
}

export function createWorking(): Working & {
  agentStart(): void;
  toolStart(id: string, name: string, args: unknown): void;
  toolEnd(id: string): void;
  /** Forgets the run and its tools: a run's end, or a session's start or end. */
  clear(): void;
} {
  let since: number | undefined;
  // Insertion order is start order, so the last entry is the latest start
  const running = new Map<string, Running>();
  return {
    state() {
      const calls = [...running.values()];
      return {
        since,
        tools: calls.map((call) => call.name),
        action: calls.at(-1)?.action,
      };
    },
    agentStart() {
      since = Date.now();
      running.clear();
    },
    toolStart(id, name, args) {
      running.set(id, { name, action: actionOf(name, args) });
    },
    toolEnd(id) {
      running.delete(id);
    },
    clear() {
      since = undefined;
      running.clear();
    },
  };
}
