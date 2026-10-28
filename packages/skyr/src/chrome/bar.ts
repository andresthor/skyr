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
import { barLines, type FailedRow, tabFits } from "./bar-view.js";

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
  readonly turns?: number;
  readonly tools?: number;
  /** Epoch ms. */
  readonly startedAt: number;
  /** Epoch ms; present on a row that has ended. */
  readonly endedAt?: number;
}

type SlotTarget =
  | { readonly id: string }
  /** `reason` says why no live row is there; `running` lists the slots that are live. */
  | { readonly reason: string; readonly running: string };

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
  /**
   * Opens the bar on `tab` and marks that tab's failures seen, and returns undefined. When the
   * terminal has no room to list the tab (or the bar stopped drawing) nothing changes, and the
   * tab's unseen failures come back, now forgotten, for the caller to list in a notice.
   */
  open(tab: BarTab): readonly BarRow[] | undefined;
  /**
   * What a stop target means on `tab`: a slot number (`1`; shells also take `$1`) names the live row in
   * that slot, and is never an id prefix. Undefined when `text` is not a slot, so an id.
   */
  slotTarget(tab: BarTab, text: string): SlotTarget | undefined;
}

export interface Bar extends BarHandle {
  /** Mounts the bar once under "skyr.bar"; `notify` reports a render failure once. */
  start(ui: Pick<ExtensionUIContext, "setWidget" | "notify">): void;
  /** Stops repainting and forgets what the user saw and chose; never calls Pi's UI, and is idempotent. */
  stop(): void;
  /** Opens the bar on the tab it was last on, or closes it. Synchronous, so two quick presses end closed. */
  toggle(): void;
  /** Opens the bar on the tab it is not on. */
  nextTab(): void;
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
  let isOpen = false;
  let tab: BarTab = "agents";
  // Per tab, the smallest free number from 1: stable while a row is listed, freed when it leaves.
  const slots: Record<BarTab, Map<string, number>> = {
    agents: new Map(),
    shells: new Map(),
  };
  let mounted:
    | {
        tui: {
          requestRender(): void;
          terminal: { rows: number; columns: number };
        };
        offClock?: () => void;
      }
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

  const listed = (of: BarTab) => failed.filter((f) => f.tab === of);

  const assignSlots = () => {
    for (const of of ["agents", "shells"] as const) {
      const ids = [...rowsOf(of), ...listed(of).map((f) => f.row)].map(
        (row) => row.id,
      );
      const taken = slots[of];
      for (const id of [...taken.keys()])
        if (!ids.includes(id)) taken.delete(id);
      for (const id of ids)
        if (!taken.has(id)) {
          const used = new Set(taken.values());
          let n = 1;
          while (used.has(n)) n += 1;
          taken.set(id, n);
        }
    }
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
      assignSlots();
      syncClock();
      mounted?.tui.requestRender();
    } catch (cause) {
      trip(cause);
    }
  };

  /** Whether the tab is listed at the terminal's size now. */
  const fits = () => {
    const terminal = mounted?.tui.terminal;
    return (
      !broken &&
      terminal !== undefined &&
      tabFits(terminal.rows, terminal.columns)
    );
  };

  /** Opens on `on` if the terminal has room to list it; nothing changes otherwise. */
  const show = (on: BarTab): boolean => {
    if (!fits()) return false;
    isOpen = true;
    tab = on;
    failed = failed.map((f) => (f.tab === on ? { ...f, seen: true } : f));
    changed();
    return true;
  };

  return {
    attach(source) {
      sources.add(source);
      const off = source.subscribe(changed, (row) => {
        failed.push({
          row,
          tab: source.tab,
          seen: isOpen && tab === source.tab && fits(),
        });
        changed();
      });
      changed();
      return () => {
        if (!sources.delete(source)) return;
        off();
        changed();
      };
    },
    open(on) {
      if (show(on)) return undefined;
      const unseen = failed.filter((f) => f.tab === on && !f.seen);
      failed = failed.filter((f) => !unseen.includes(f));
      return unseen.map((f) => f.row);
    },
    slotTarget(of, text) {
      const slot = (of === "shells" ? /^\$?(\d{1,3})$/ : /^(\d{1,3})$/).exec(
        text,
      );
      if (!slot) return undefined;
      const live = rowsOf(of);
      const numbered = (row: BarRow) => slots[of].get(row.id);
      const hit = live.find((row) => numbered(row) === Number(slot[1]));
      if (hit) return { id: hit.id };
      const ended = listed(of).some((f) => numbered(f.row) === Number(slot[1]));
      const prefix = of === "shells" ? "$" : "";
      return {
        reason: ended
          ? `${prefix}${slot[1]} has ended`
          : `nothing is in slot ${prefix}${slot[1]}`,
        running: live
          .map((row) => `${prefix}${numbered(row)} ${row.label}`)
          .join(", "),
      };
    },
    toggle() {
      if (!isOpen) {
        show(tab);
        return;
      }
      isOpen = false;
      failed = failed.filter((f) => !f.seen);
      changed();
    },
    nextTab() {
      show(tab === "agents" ? "shells" : "agents");
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
                        open: isOpen,
                        tab,
                        agents: rowsOf("agents"),
                        shells: rowsOf("shells"),
                        failed,
                        slots,
                      },
                      { theme, mode: tierOf(process.env) },
                      width,
                      tui.terminal.rows,
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
      isOpen = false;
      tab = "agents";
      slots.agents.clear();
      slots.shells.clear();
    },
  };
}
