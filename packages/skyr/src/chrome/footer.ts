/**
 * Pi's footer, replaced: mounted once per terminal session, facts computed when events fire, so
 * a frame touches no session and no ctx.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { canDraw, tierOf } from "../ui/caps.js";
import { guard } from "../ui/guard.js";
import { describeCause, oneLine } from "../ui/text.js";
import { readUiSettings } from "../ui-config.js";
import { type FooterFacts, footerLines, statusesLine } from "./footer-view.js";

export interface Footer {
  /**
   * Replaces Pi's footer in the terminal UI unless `ui.footer` is false; a no-op elsewhere. A
   * `start` that `stop` or a later `start` overtakes while it reads the settings installs nothing.
   * Call it after `stop`: a footer still mounted is not released here, only by Pi disposing it.
   */
  start(ctx: ExtensionContext): Promise<void>;
  /** Recomputes the facts from `ctx`, which is not kept; a no-op while nothing is mounted. */
  refresh(ctx: ExtensionContext): void;
  /** Lets go of everything the footer holds; never calls Pi's UI, and is idempotent. */
  stop(): void;
}

type FooterUi = Pick<ExtensionUIContext, "setFooter" | "notify">;

/** One mounting of the footer: what Pi's factory call handed over. */
interface Mounted {
  readonly tui: { requestRender(): void };
  offBranch?: () => void;
}

/** The directory as Pi's footer writes it: under the home directory, `~` for the prefix. */
function homeRelative(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const inside = relative(resolve(home), resolve(cwd));
  if (inside === "") return "~";
  const outside =
    inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  return outside ? cwd : `~${sep}${inside}`;
}

/** The facts `ctx` holds, as plain values. */
function factsOf(ctx: ExtensionContext): Omit<FooterFacts, "branch"> {
  const name = ctx.sessionManager.getSessionName();
  return {
    cwd: oneLine(homeRelative(ctx.sessionManager.getCwd()), 400),
    ...(name ? { sessionName: oneLine(name, 200) } : {}),
  };
}

export function createFooter(): Footer {
  let ui: FooterUi | undefined;
  let mounted: Mounted | undefined;
  let facts: FooterFacts | undefined;
  let reported = false;
  // Counts the starts and stops, so a start that was overtaken can tell
  let current = 0;

  /**
   * Gives the slot back to Pi's footer and tells the user once. Only for a footer still mounted:
   * after Pi disposed it, the slot may hold the next session's.
   */
  const fail = (cause: unknown) => {
    const here = mounted;
    if (!here || reported) return;
    reported = true;
    const target = ui;
    queueMicrotask(() => {
      if (mounted !== here) return;
      try {
        target?.setFooter(undefined);
      } catch {
        // The session that holds the slot may be gone
      }
      try {
        target?.notify(
          `skyr: the footer stopped drawing after an error (${oneLine(describeCause(cause), 120)}); Pi's footer is back until /reload`,
          "warning",
        );
      } catch {
        // The session that would show it may be gone
      }
    });
  };

  const teardown = () => {
    mounted?.offBranch?.();
    mounted = undefined;
    ui = undefined;
    facts = undefined;
  };

  return {
    async start(ctx) {
      if (!canDraw(ctx)) return;
      const generation = ++current;
      const target = ctx.ui;
      const settings = await readUiSettings();
      // `ctx` is only safe to read while its session is the current one
      if (generation !== current) return;
      if (settings.problems.length > 0)
        target.notify(settings.problems.join("\n"), "warning");
      if (!settings.footer) return;
      reported = false;
      ui = target;
      facts = factsOf(ctx);
      target.setFooter((tui, theme, data) => {
        const here: Mounted = { tui };
        mounted = here;
        // Pi calls this outside any handler, and an empty footer hides its own
        try {
          const readBranch = () => {
            if (facts)
              facts = { ...facts, branch: data.getGitBranch() ?? undefined };
          };
          readBranch();
          here.offBranch = data.onBranchChange(() => {
            try {
              readBranch();
              tui.requestRender();
            } catch (cause) {
              fail(cause);
            }
          });
          let statusKey = "";
          let status = "";
          let cached:
            | { width: number; facts: FooterFacts; lines: string[] }
            | undefined;
          return {
            render: guard((width) => {
              if (!facts) return [];
              // Pi sets statuses without telling the extension, so each frame compares them
              const key = [...data.getExtensionStatuses()]
                .map(([name, text]) => `${name}\0${text}`)
                .join("\n");
              if (key !== statusKey) {
                statusKey = key;
                status = statusesLine(
                  data.getExtensionStatuses(),
                  tierOf(process.env),
                );
                cached = undefined;
              }
              if (cached?.width !== width || cached.facts !== facts)
                cached = {
                  width,
                  facts,
                  lines: footerLines(
                    facts,
                    status,
                    { theme, mode: tierOf(process.env) },
                    width,
                  ),
                };
              return cached.lines;
            }, fail),
            invalidate() {
              cached = undefined;
            },
            dispose() {
              here.offBranch?.();
              if (mounted !== here) return;
              mounted = undefined;
              facts = undefined;
            },
          };
        } catch (cause) {
          fail(cause);
          return { render: () => [], invalidate() {}, dispose: teardown };
        }
      });
    },
    refresh(ctx) {
      if (!mounted) return;
      try {
        if (facts) facts = { ...facts, ...factsOf(ctx) };
        mounted.tui.requestRender();
      } catch (cause) {
        fail(cause);
      }
    },
    stop() {
      current += 1;
      teardown();
    },
  };
}
