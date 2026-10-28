/**
 * Pi's footer, replaced: mounted once per terminal session, facts computed when events fire, so
 * a frame touches no session and no ctx.
 */
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  ExtensionContext,
  ExtensionUIContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { loadPi } from "../pi.js";
import { canDraw, tierOf } from "../ui/caps.js";
import { everySecond } from "../ui/clock.js";
import { formatClock, positiveOrZero } from "../ui/format.js";
import { failureLatch, guard } from "../ui/guard.js";
import { oneLine } from "../ui/text.js";
import { readUiSettings } from "../ui-config.js";
import {
  type ContextFacts,
  type FooterFacts,
  footerLines,
  statusesLine,
  type TokenFacts,
} from "./footer-view.js";
import { createSpend, type Spend } from "./spend.js";

export interface Footer {
  /**
   * Replaces Pi's footer in the terminal UI unless `ui.footer` is false; a no-op elsewhere. A
   * `start` that `stop` or a later `start` overtakes while it reads the settings installs nothing.
   * Call it after `stop`: a footer still mounted is not released here, only by Pi disposing it.
   */
  start(ctx: ExtensionContext): Promise<void>;
  /** Recomputes the facts from `ctx`, which is not kept; a no-op while nothing is mounted. */
  refresh(ctx: ExtensionContext): void;
  /**
   * `refresh` once the message that is ending has been saved, which a `message_end` handler runs
   * before: a later extension's handler that awaits can delay the save past this, and the next
   * `tool_execution_start` or `turn_end` then catches up. Does nothing if the session ended
   * meanwhile, so the `ctx` is never read stale.
   */
  refreshSoon(ctx: ExtensionContext): void;
  /** `refresh`, and a new look at what the session files say each provider spent. */
  settled(ctx: ExtensionContext): void;
  /** Lets go of everything the footer holds; never calls Pi's UI, and is idempotent. */
  stop(): void;
}

type FooterUi = Pick<ExtensionUIContext, "setFooter" | "notify">;

/** One mounting of the footer: what Pi's factory call handed over. */
interface Mounted {
  readonly tui: { requestRender(): void };
  offBranch?: () => void;
  offClock?: () => void;
  spend?: Spend;
}

/** The profile an agent dir belongs to: the name of its parent, without the dot of `~/.pi`. */
function profileOf(agentDir: string): string {
  return basename(dirname(resolve(agentDir))).replace(/^\./, "");
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

/** A usage record's cost, or 0 when it is not a finite, non-negative number. */
function costOf(usage: unknown): number {
  if (typeof usage !== "object" || usage === null || !("cost" in usage))
    return 0;
  const { cost } = usage;
  if (typeof cost !== "object" || cost === null || !("total" in cost)) return 0;
  return positiveOrZero(cost.total);
}

/**
 * The cost of runs delivered into a session as a custom message whose details list objects with
 * a usage, which Pi leaves out of its total. Read by shape, so chrome names no feature.
 */
function deliveredCost(details: unknown): number {
  if (!Array.isArray(details)) return 0;
  let total = 0;
  for (const run of details)
    if (typeof run === "object" && run !== null && "usage" in run)
      total += costOf(run.usage);
  return total;
}

/** The part of Pi's usage record the footer reads; an old session may hold bad numbers in it. */
interface UsageShape {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What every entry of the session added up to, abandoned branches included, as Pi's footer sums it. */
function totalsOf(entries: readonly SessionEntry[]): {
  cost: number;
  tokens: TokenFacts;
} {
  let cost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cacheHit: number | undefined;
  const add = (usage: UsageShape) => {
    cost += costOf(usage);
    input += positiveOrZero(usage.input);
    output += positiveOrZero(usage.output);
    cacheRead += positiveOrZero(usage.cacheRead);
    cacheWrite += positiveOrZero(usage.cacheWrite);
  };
  for (const entry of entries) {
    if (entry.type === "usage") add(entry.usage);
    else if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant") {
        add(message.usage);
        const { usage } = message;
        const prompt =
          positiveOrZero(usage.input) +
          positiveOrZero(usage.cacheRead) +
          positiveOrZero(usage.cacheWrite);
        cacheHit =
          prompt > 0
            ? (positiveOrZero(usage.cacheRead) / prompt) * 100
            : undefined;
      } else if (message.role === "toolResult" && message.usage)
        add(message.usage);
    } else if (
      (entry.type === "branch_summary" || entry.type === "compaction") &&
      entry.usage
    )
      add(entry.usage);
    // Delivered runs carry a cost only: their tokens were spent by another session
    else if (entry.type === "custom_message")
      cost += deliveredCost(entry.details);
  }
  return { cost, tokens: { input, output, cacheRead, cacheWrite, cacheHit } };
}

/** What a pass over the session found, valid while its key holds. */
interface Counted {
  readonly key: string;
  readonly cost: number;
  readonly tokens: TokenFacts;
  readonly turns: number;
  readonly context: ContextFacts | undefined;
}

export function createFooter(): Footer {
  let ui: FooterUi | undefined;
  let mounted: Mounted | undefined;
  let facts: FooterFacts | undefined;
  // What `facts` is made of: the session's, written on events, and the footer's own
  let held:
    | (Omit<FooterFacts, "branch" | "profile" | "clock" | "spend"> & {
        provider?: string;
      })
    | undefined;
  let branch: string | undefined;
  let profile: string | undefined;
  let clock: string | undefined;
  let counted: Counted | undefined;
  const latch = failureLatch();
  let spendReported = false;
  // Counts the starts and stops, so a start that was overtaken can tell
  let current = 0;

  /**
   * Gives the slot back to Pi's footer and tells the user once. Only for a footer still mounted:
   * after Pi disposed it, the slot may hold the next session's.
   */
  const fail = (cause: unknown) => {
    const here = mounted;
    if (!here) return;
    const target = ui;
    latch.trip(cause, (reason) => {
      if (mounted !== here) return;
      try {
        target?.setFooter(undefined);
      } catch {
        // The session that holds the slot may be gone
      }
      target?.notify(
        `skyr: the footer stopped drawing after an error (${reason}); Pi's footer is back until /reload`,
        "warning",
      );
    });
  };

  const publish = () => {
    if (!held) {
      facts = undefined;
      return;
    }
    const { provider, ...rest } = held;
    const figures =
      provider === undefined
        ? undefined
        : mounted?.spend?.figures(provider, new Date());
    facts = {
      ...rest,
      branch,
      profile,
      clock,
      ...(provider !== undefined && figures
        ? { spend: { provider: oneLine(provider, 60), ...figures } }
        : {}),
    };
  };

  const release = (here: Mounted) => {
    here.offBranch?.();
    here.offClock?.();
    here.spend?.stop();
  };

  const teardown = () => {
    if (mounted) release(mounted);
    mounted = undefined;
    ui = undefined;
    held = undefined;
    facts = undefined;
    counted = undefined;
  };

  /**
   * The facts `ctx` holds, as plain values. The passes over the session run only when its leaf
   * or the model moved: every append moves the leaf, so the key is as fine as the data.
   */
  const factsOf = (ctx: ExtensionContext): NonNullable<typeof held> => {
    const manager = ctx.sessionManager;
    const model = ctx.model;
    const key = [
      manager.getSessionId(),
      manager.getLeafId(),
      model?.provider,
      model?.id,
    ].join("\0");
    if (counted?.key !== key) {
      const usage = ctx.getContextUsage();
      counted = {
        key,
        ...totalsOf(manager.getEntries()),
        turns: manager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "message" && entry.message.role === "user",
          ).length,
        context: usage && {
          tokens: usage.tokens,
          percent: usage.percent,
          window: usage.contextWindow,
        },
      };
    }
    const name = manager.getSessionName();
    return {
      cwd: oneLine(homeRelative(manager.getCwd()), 400),
      ...(name ? { sessionName: oneLine(name, 200) } : {}),
      context: counted.context,
      turns: counted.turns,
      cost: counted.cost,
      tokens: counted.tokens,
      ...(model
        ? { model: oneLine(model.id, 80), provider: model.provider }
        : {}),
      ...(model?.reasoning && ctx.thinkingLevel
        ? { thinking: ctx.thinkingLevel }
        : {}),
    };
  };

  const refresh = (ctx: ExtensionContext) => {
    if (!mounted) return;
    try {
      held = factsOf(ctx);
      publish();
      mounted.tui.requestRender();
    } catch (cause) {
      fail(cause);
    }
  };

  return {
    async start(ctx) {
      if (!canDraw(ctx)) return;
      const generation = ++current;
      const target = ctx.ui;
      const [settings, { getAgentDir }] = await Promise.all([
        readUiSettings(),
        loadPi(),
      ]);
      // `ctx` is only safe to read while its session is the current one
      if (generation !== current) return;
      if (settings.problems.length > 0)
        target.notify(settings.problems.join("\n"), "warning");
      if (!settings.footer) return;
      latch.reset();
      spendReported = false;
      ui = target;
      counted = undefined;
      held = factsOf(ctx);
      profile = oneLine(profileOf(getAgentDir()), 120);
      branch = undefined;
      clock = undefined;
      publish();
      target.setFooter((tui, theme, data) => {
        const here: Mounted = { tui };
        mounted = here;
        // Pi calls this outside any handler, and an empty footer hides its own
        try {
          const readBranch = () => {
            branch = oneLine(data.getGitBranch() ?? "", 120) || undefined;
            publish();
          };
          readBranch();
          /** Whether the minute changed. */
          const tick = (): boolean => {
            const next = formatClock(new Date());
            if (next === clock) return false;
            clock = next;
            publish();
            return true;
          };
          tick();
          // Publishing on each new minute also moves today's spend figure when the day turned between scans
          here.offClock = everySecond(() => {
            if (tick()) tui.requestRender();
          }, fail);
          here.spend = createSpend(join(getAgentDir(), "sessions"), {
            onChange() {
              try {
                publish();
                tui.requestRender();
              } catch (cause) {
                fail(cause);
              }
            },
            onProblem({ file, cause }) {
              if (spendReported) return;
              spendReported = true;
              try {
                target.notify(
                  `skyr: spend could not read ${file === "." ? "the sessions folder" : oneLine(file, 80)} (${oneLine(cause, 60)}); its last figures stay until it reads again. Check its permissions`,
                  "warning",
                );
              } catch {
                // The session that would show it may be gone
              }
            },
          });
          void here.spend.refresh();
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
              release(here);
              if (mounted !== here) return;
              mounted = undefined;
              held = undefined;
              facts = undefined;
            },
          };
        } catch (cause) {
          fail(cause);
          return { render: () => [], invalidate() {}, dispose: teardown };
        }
      });
    },
    settled(ctx) {
      refresh(ctx);
      void mounted?.spend?.refresh();
    },
    refreshSoon(ctx) {
      if (!mounted) return;
      const generation = current;
      // Pi saves the message right after the handlers return, so the next macrotask sees it
      setImmediate(() => {
        if (generation === current) refresh(ctx);
      });
    },
    refresh,
    stop() {
      current += 1;
      teardown();
    },
  };
}
