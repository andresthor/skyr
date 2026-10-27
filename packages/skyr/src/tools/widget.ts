/**
 * A live widget above the editor: Pi mounts it once per appearance, and it repaints itself so a
 * clock in its lines moves.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const MAX_LINES = 10;

/**
 * Shows `lines` under `key` while they are defined, from the next change `subscribe` reports;
 * they are read again on every render, each second, and only fitted to the pane and capped, so
 * they must be cheap and already sanitized. Returns the stop, which also clears the widget.
 */
export function liveWidget(
  // The whole ctx: its `ui` getter throws once the session is replaced, which dead-stops a set
  ctx: Pick<ExtensionContext, "ui">,
  key: string,
  o: {
    subscribe(listener: () => void): () => void;
    lines(): string[] | undefined;
    /** The command that lists every entry, named on the row that stands for those past the cap. */
    lists: string;
  },
): () => void {
  const rows = (width: number) => {
    const lines = o.lines() ?? [];
    // Past the cap, the last row counts what it leaves out.
    const capped =
      lines.length > MAX_LINES
        ? [
            ...lines.slice(0, MAX_LINES - 1),
            `… +${lines.length - MAX_LINES + 1} more · ${o.lists} lists all`,
          ]
        : lines;
    // Pi stops the TUI on a row wider than the pane; the pad matches Pi's own string widgets.
    return capped.map((row) => ` ${truncateToWidth(row, width - 2)}`);
  };

  // Set only as the widget appears and goes: Pi re-inserts a key on every set, which would
  // swap it with other widgets. A host that never mounts it (tengi, RPC) ticks nothing.
  let mounted = false;
  let repaint: (() => void) | undefined;
  const widget = (tui: { requestRender(): void }) => {
    repaint = () => tui.requestRender();
    const tick = setInterval(repaint, 1000);
    tick.unref();
    return {
      render: rows,
      invalidate() {},
      dispose() {
        clearInterval(tick);
        repaint = undefined;
        mounted = false;
      },
    };
  };
  const off = o.subscribe(() => {
    // A reload or session replacement leaves ctx stale; Pi reports a throw from a handler,
    // but a change can arrive outside any, so the widget dead-stops instead.
    try {
      const live = o.lines() !== undefined;
      if (live && !mounted) {
        ctx.ui.setWidget(key, widget);
        mounted = true;
      } else if (!live && mounted) {
        mounted = false;
        ctx.ui.setWidget(key, undefined);
      } else repaint?.();
    } catch {
      off();
    }
  });
  return () => {
    off();
    try {
      ctx.ui.setWidget(key, undefined);
    } catch {
      // A stale ctx: its widget went with the session
    }
  };
}
