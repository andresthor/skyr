/**
 * Subagents as lines. Running ones for the widget above the editor and the `/subagents` listing,
 * sanitized and cut to a hundred columns, which the widget fits to its pane; an ended one for a
 * delivered answer, sanitized and left for its row to cut.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  type Segment,
  sanitize,
  secondsText,
  tokens,
} from "../tools/render.js";
import { count, labelOf, progressOf, type RunSnapshot } from "./store.js";

const WIDGET_WIDTH = 100;

/** One line per running child, `<mark> <label> · <progress> · <elapsed> · <id>`; undefined when none. */
export function widgetLines(
  runs: readonly RunSnapshot[],
  now: number,
): string[] | undefined {
  if (runs.length === 0) return undefined;
  return runs.map((run) => {
    const mark =
      run.status === "queued"
        ? "○ queued"
        : run.background
          ? "↗ running"
          : "● running";
    const progress = progressOf(run);
    const line = `${mark} ${labelOf(run)}${progress ? ` · ${progress}` : ""} · ${Math.round((now - run.startedAt) / 1000)}s · ${run.id.slice(0, 8)}`;
    return truncateToWidth(sanitize(line), WIDGET_WIDTH);
  });
}

/** An ended run's mark: ■ stopped, ✓ answered, ✗ anything else that gave no answer. */
function markOf(run: RunSnapshot): Segment {
  if (run.status === "aborted") return ["muted", "■"];
  return run.status === "done" && run.error === undefined
    ? ["success", "✓"]
    : ["error", "✗"];
}

/**
 * One ended run, `<mark> <label> · <error> · <turns> · <tools> · <tokens> · <time> · <id>`. A
 * recovered run has no counters or start time, so it says so in their place.
 */
export function laneLine(run: RunSnapshot): Segment[] {
  const recovered = run.recovered || run.startedAt === 0;
  const cells = [
    labelOf(run),
    run.error,
    ...(recovered
      ? ["recovered after a restart"]
      : [count(run.turns, "turn"), count(run.toolCalls, "tool")]),
    tokens(run.tokens),
    !recovered &&
      run.endedAt !== undefined &&
      secondsText(run.endedAt - run.startedAt),
    run.id.slice(0, 8),
  ];
  return [
    markOf(run),
    ["text", ` ${sanitize(cells.filter(Boolean).join(" · "))}`],
  ];
}
