/**
 * The bar above the editor: what runs besides the main agent. Mounted once per terminal session
 * and empty at rest; domains push rows through sources, so nothing here knows a subagent or a
 * shell.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Mark, tierOf } from "../ui/caps.js";
import { everySecond } from "../ui/clock.js";
import { failureLatch, guard } from "../ui/guard.js";
import {
  barLines,
  type FailedRow,
  noticeLines,
  tabBody,
  tabRows,
  windowSize,
  windowStart,
} from "./bar-view.js";

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

/** What an editor's keys do to the bar. */
export interface BarKeys {
  /** The bar is open on a tab it has room to list: the only time ↑↓ and Esc are the bar's. */
  listing(): boolean;
  /**
   * Moves the focused row of the open tab by one, clamped at both ends. From no focus, ↓ focuses
   * the first row and ↑ the last. Returns whether the focus changed; when it did not, the key
   * was not the bar's to take.
   */
  move(by: 1 | -1): boolean;
  /** Closes the bar and forgets every focus and the failures seen. */
  close(): void;
}

export interface Bar extends BarHandle, BarKeys {
  /** Mounts the bar once under "skyr.bar"; `notify` reports a render failure once. */
  start(ui: Pick<ExtensionUIContext, "setWidget" | "notify">): void;
  /** Stops repainting and forgets what the user saw and chose; never calls Pi's UI, and is idempotent. */
  stop(): void;
  /**
   * Opens the bar on the tab it was last on, or closes it. Synchronous, so two quick presses end
   * closed. Where the terminal has no room to list the tab, returns its rows as notice text for
   * the caller to show (the tab's unseen failures are forgotten, as in `open`).
   */
  toggle(): string | undefined;
  /** Opens the bar on the tab it is not on; returns notice text as `toggle` does. */
  nextTab(): string | undefined;
}

export function createBar(): Bar {
  const sources = new Set<BarSource>();
  let ui: Pick<ExtensionUIContext, "setWidget" | "notify"> | undefined;
  const latch = failureLatch();
  let failed: FailedRow[] = [];
  let isOpen = false;
  let tab: BarTab = "agents";
  // Per tab, the highlighted row; the index is where it last was, for when its row leaves
  const focus: Record<BarTab, { id: string; index: number } | undefined> = {
    agents: undefined,
    shells: undefined,
  };
  // Per tab, where the window of rows starts; the highlight moves it only when it leaves the window
  const top: Record<BarTab, number> = { agents: 0, shells: 0 };
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
        /** The width the bar last drew at: the one the drawing decided on. */
        width?: number;
        offClock?: () => void;
      }
    | undefined;
  // Set by the first error in drawing or repainting; the bar draws nothing until a new session,
  // but slots and focus keep their books so a stop by slot still finds its row.
  let broken = false;

  const rowsOf = (tab: BarTab) =>
    [...sources].filter((s) => s.tab === tab).flatMap((s) => s.rows());

  /** Stops the bar for good this session and tells the user once. */
  const trip = (cause: unknown) => {
    broken = true;
    mounted?.offClock?.();
    if (mounted) mounted.offClock = undefined;
    latch.trip(cause, (reason) =>
      ui?.notify(
        `skyr: the bar stopped drawing after an error (${reason}); /reload brings it back`,
        "warning",
      ),
    );
  };

  const failedOn = (of: BarTab) => failed.filter((f) => f.tab === of);

  const rowsListed = (of: BarTab) =>
    tabRows({ agents: rowsOf("agents"), shells: rowsOf("shells"), failed }, of);

  /** The focus follows its row; a row that left hands it to whatever now sits at its place. */
  const reconcileFocus = () => {
    for (const of of ["agents", "shells"] as const) {
      const held = focus[of];
      const rows = rowsListed(of);
      if (held) {
        const index = rows.findIndex((row) => row.id === held.id);
        if (index >= 0) focus[of] = { id: held.id, index };
        else {
          const at = Math.min(held.index, rows.length - 1);
          const next = rows[at];
          focus[of] = next && { id: next.id, index: at };
        }
      }
      scrollTo(of, focus[of]?.index ?? -1, rows.length);
    }
  };

  const assignSlots = () => {
    for (const of of ["agents", "shells"] as const) {
      const ids = [...rowsOf(of), ...failedOn(of).map((f) => f.row)].map(
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
    try {
      assignSlots();
      reconcileFocus();
      if (broken) return;
      syncClock();
      mounted?.tui.requestRender();
    } catch (cause) {
      trip(cause);
    }
  };

  /** The lines an open tab may draw below its header at the terminal's size now; undefined when it has no room. */
  const bodyNow = () => {
    const terminal = mounted?.tui.terminal;
    return broken || !terminal
      ? undefined
      : tabBody(terminal.rows, mounted?.width ?? terminal.columns);
  };
  const fits = () => bodyNow() !== undefined;

  /** Brings the window of `of` to show its highlight; the bar's own answer to where rows start. */
  const scrollTo = (of: BarTab, index: number, count: number) => {
    const body = bodyNow();
    if (body === undefined) return;
    top[of] = windowStart(top[of], index, windowSize(count, body), count);
  };

  /** Rows of `on` for a notice, forgetting its unseen failures, which the notice has now told. */
  const noticeFor = (on: BarTab): string | undefined => {
    if (broken || !mounted) return undefined;
    const unseen = failedOn(on).filter((f) => !f.seen);
    failed = failed.filter((f) => !unseen.includes(f));
    const rows = tabRows(
      { agents: rowsOf("agents"), shells: rowsOf("shells"), failed: unseen },
      on,
    );
    return [
      ...noticeLines(rows, on, slots[on]),
      ...(rows.length === 0 ? [`${on}: none running`] : []),
    ].join("\n");
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

  const close = () => {
    isOpen = false;
    focus.agents = undefined;
    focus.shells = undefined;
    top.agents = 0;
    top.shells = 0;
    failed = failed.filter((f) => !f.seen);
    changed();
  };

  return {
    listing: () => isOpen && fits(),
    move(by) {
      if (!isOpen || !fits()) return false;
      const rows = rowsListed(tab);
      const held = focus[tab];
      const at = held ? rows.findIndex((row) => row.id === held.id) : -1;
      const index =
        at < 0
          ? by === 1
            ? 0
            : rows.length - 1
          : Math.min(Math.max(at + by, 0), rows.length - 1);
      const row = rows[index];
      if (!row || row.id === held?.id) return false;
      focus[tab] = { id: row.id, index };
      scrollTo(tab, index, rows.length);
      changed();
      return true;
    },
    close,
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
      const ended = failedOn(of).some(
        (f) => numbered(f.row) === Number(slot[1]),
      );
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
      if (isOpen) {
        close();
        return undefined;
      }
      return show(tab) ? undefined : noticeFor(tab);
    },
    nextTab() {
      const next = tab === "agents" ? "shells" : "agents";
      return show(next) ? undefined : noticeFor(next);
    },
    start(target) {
      ui = target;
      latch.reset();
      broken = false;
      target.setWidget(WIDGET_KEY, (tui, theme) => {
        // A throw is reported once, and an empty component keeps Pi's widget row valid
        try {
          const here: NonNullable<typeof mounted> = { tui };
          mounted = here;
          syncClock();
          return {
            render: guard((width) => {
              here.width = width;
              return broken
                ? []
                : barLines(
                    {
                      open: isOpen,
                      tab,
                      agents: rowsOf("agents"),
                      shells: rowsOf("shells"),
                      failed,
                      slots,
                      focused: focus[tab]?.id,
                      top: top[tab],
                    },
                    { theme, mode: tierOf(process.env) },
                    width,
                    tui.terminal.rows,
                    Date.now(),
                  );
            }, trip),
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
      focus.agents = undefined;
      focus.shells = undefined;
      top.agents = 0;
      top.shells = 0;
      slots.agents.clear();
      slots.shells.clear();
    },
  };
}
