/**
 * The running subagents as lines: the widget above the editor and the `/subagents` listing. Lines
 * are sanitized and cut to a hundred columns; the widget fits them to its pane.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitize } from "../tools/render.js";
import { labelOf, progressOf, type RunSnapshot } from "./store.js";

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
