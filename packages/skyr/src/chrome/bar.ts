/**
 * The bar above the editor: what runs besides the main agent. Mounted once per terminal session
 * and empty at rest; domains push rows through sources, so nothing here knows a subagent or a
 * shell.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Mark, tierOf } from "../ui/caps.js";
import { everySecond } from "../ui/clock.js";
import { guard } from "../ui/guard.js";
import { oneLine } from "../ui/text.js";
import { barLines, type FailedRow } from "./bar-view.js";

const WIDGET_KEY = "skyr.bar";

export type BarTab = "agents" | "shells";

/** A bar row's facts; every string already sanitized by its source. */
export interface BarRow {
  readonly id: string;
  readonly mark: Mark;
  readonly label: string;
  /** Draws " &" after the label. */
  readonly background: boolean;
  /** What the row is doing: an agent's latest tool, "stalled", "behind <label>"; a shell's "lingering". */
  readonly now?: string;
  /** Why a failed row failed: "429 rate limited", "exit 1". */
  readonly why?: string;
  /** Epoch ms. */
  readonly startedAt: number;
}

export interface BarSource {
  readonly tab: BarTab;
  /** The live rows, oldest first; read at every render, so cheap. */
  rows(): readonly BarRow[];
  /**
   * Calls `changed` after every change to rows() and `failed` once for each row that ended
   * failed, which has left rows() by then. Returns the unsubscribe.
   */
  subscribe(changed: () => void, failed: (row: BarRow) => void): () => void;
}

export interface BarHandle {
  /** Adds a source; returns its detach, which is idempotent. */
  attach(source: BarSource): () => void;
}

export interface Bar extends BarHandle {
  /** Mounts the bar once under "skyr.bar"; `notify` reports a render failure once. */
  start(ui: Pick<ExtensionUIContext, "setWidget" | "notify">): void;
  /** Stops repainting and forgets failures; never calls Pi's UI, and is idempotent. */
  stop(): void;
}

/** `String(value)` throws for an object without a prototype. */
function describe(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "unknown error";
  }
}

export function createBar(): Bar {
  const sources = new Set<BarSource>();
  let ui: Pick<ExtensionUIContext, "setWidget" | "notify"> | undefined;
  let reported = false;
  let failed: FailedRow[] = [];
  let mounted:
    | { tui: { requestRender(): void }; offClock?: () => void }
    | undefined;
  // Set by the first error in drawing or repainting; the bar draws nothing until a new session.
  let broken = false;

  const rowsOf = (tab: BarTab) =>
    [...sources].filter((s) => s.tab === tab).flatMap((s) => s.rows());

  /** Stops the bar for good this session and tells the user once. */
  const trip = (cause: unknown) => {
    broken = true;
    mounted?.offClock?.();
    if (mounted) mounted.offClock = undefined;
    if (reported) return;
    reported = true;
    const message = cause instanceof Error ? cause.message : describe(cause);
    queueMicrotask(() => {
      try {
        ui?.notify(
          `skyr: the bar stopped drawing after an error (${oneLine(message, 120)}); /reload brings it back`,
          "warning",
        );
      } catch {
        // The session that would show it may be gone
      }
    });
  };

  /** Ticks while a row runs, so its clock moves; not at all when nothing has mounted the bar. */
  const syncClock = () => {
    const here = mounted;
    if (!here || broken) return;
    const running = [...sources].some((s) => s.rows().length > 0);
    if (running && !here.offClock)
      here.offClock = everySecond(() => here.tui.requestRender(), trip);
    else if (!running && here.offClock) {
      here.offClock();
      here.offClock = undefined;
    }
  };

  // A source calls this from its store, where a throw would reach the code that changed the store.
  const changed = () => {
    if (broken) return;
    try {
      syncClock();
      mounted?.tui.requestRender();
    } catch (cause) {
      trip(cause);
    }
  };

  return {
    attach(source) {
      sources.add(source);
      const off = source.subscribe(changed, (row) => {
        failed.push({ row, seen: false });
        changed();
      });
      return () => {
        if (!sources.delete(source)) return;
        off();
        changed();
      };
    },
    start(target) {
      ui = target;
      reported = false;
      broken = false;
      target.setWidget(WIDGET_KEY, (tui, theme) => {
        // A throw is reported once, and an empty component keeps Pi's widget row valid
        try {
          const here: NonNullable<typeof mounted> = { tui };
          mounted = here;
          syncClock();
          return {
            render: guard(
              (width) =>
                broken
                  ? []
                  : barLines(
                      {
                        agents: rowsOf("agents"),
                        shells: rowsOf("shells"),
                        failed,
                      },
                      { theme, mode: tierOf(process.env) },
                      width,
                      Date.now(),
                    ),
              trip,
            ),
            invalidate() {},
            dispose() {
              here.offClock?.();
              if (mounted === here) mounted = undefined;
            },
          };
        } catch (cause) {
          trip(cause);
          return { render: () => [], invalidate() {}, dispose() {} };
        }
      });
    },
    stop() {
      mounted?.offClock?.();
      mounted = undefined;
      failed = [];
    },
  };
}
