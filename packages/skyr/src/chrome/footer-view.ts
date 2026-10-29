/**
 * The footer as lines: pure, handed its facts and the pane, drawing nothing wider than the pane.
 * A line that does not fit gives up its groups one step at a time, in the order its ladder lists.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { glyphsOf } from "../ui/caps.js";
import { fitToWidth } from "../ui/fit.js";
import { formatCost, formatCount } from "../ui/format.js";
import { type Paint, styled } from "../ui/palette.js";
import { sanitize, sanitizeStyled } from "../ui/text.js";

/** The context window's use; `tokens` and `percent` are null while unknown, as after a compaction. */
export interface ContextFacts {
  readonly tokens: number | null;
  readonly percent: number | null;
  readonly window: number;
}

/** Token totals over every entry of the session, and the latest response's cache hit rate in percent. */
export interface TokenFacts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheHit?: number;
}

/** What one provider's calls cost: the provider, today and over the last 30 days. */
interface SpendFacts {
  readonly provider: string;
  readonly day: number;
  readonly month: number;
}

/** What the footer shows, every string already sanitized by its source. */
export interface FooterFacts {
  readonly cwd: string;
  readonly branch?: string;
  readonly sessionName?: string;
  readonly context?: ContextFacts;
  readonly tokens: TokenFacts;
  readonly spend?: SpendFacts;
  readonly turns: number;
  readonly cost: number;
  readonly model?: string;
  /** Present only for a model that reasons. */
  readonly thinking?: string;
  /** The agent dir's profile, such as `experimental`. */
  readonly profile?: string;
  /** Local `HH:MM`. */
  readonly clock?: string;
}

type Ink = keyof Paint["theme"]["colors"];

/**
 * The first drawing of a line that fits `room`, as `steps` take groups away in order; the last
 * drawing when none fits, for the caller to cut.
 */
function degrade<S>(
  start: S,
  steps: readonly ((state: S) => S)[],
  draw: (state: S) => string,
  room: number,
): string {
  let state = start;
  let line = draw(state);
  for (const step of steps) {
    if (visibleWidth(line) <= room) break;
    state = step(state);
    line = draw(state);
  }
  return line;
}

interface Where {
  tokens: boolean;
  name: boolean;
  label: boolean;
  month: boolean;
  spend: boolean;
  branch: boolean;
}

const WHERE_STEPS: readonly ((state: Where) => Where)[] = [
  (state) => ({ ...state, tokens: false }),
  (state) => ({ ...state, name: false }),
  (state) => ({ ...state, label: false }),
  (state) => ({ ...state, month: false }),
  (state) => ({ ...state, spend: false }),
  (state) => ({ ...state, branch: false }),
];

interface Head {
  clock: boolean;
  profile: boolean;
  claude: boolean;
  turns: "turns" | "t" | false;
  coarse: boolean;
  tokens: boolean;
  meter: boolean;
  thinking: boolean;
  model: boolean;
  cost: boolean;
}

const HEAD_STEPS: readonly ((state: Head) => Head)[] = [
  (state) => ({ ...state, clock: false }),
  (state) => ({ ...state, profile: false }),
  (state) => ({ ...state, claude: false }),
  (state) => ({ ...state, turns: "t" }),
  (state) => ({ ...state, turns: false }),
  (state) => ({ ...state, coarse: false }),
  (state) => ({ ...state, tokens: false }),
  (state) => ({ ...state, meter: false }),
  (state) => ({ ...state, thinking: false }),
  (state) => ({ ...state, model: false }),
  (state) => ({ ...state, cost: false }),
];

const FINE_CELLS = 6;
const COARSE_CELLS = 4;
const SINGLE_CELLS = 8;
/** The fine cells measure this much of the window; a window no bigger than twice it is one bar. */
const WORKING_ZONE = 256_000;
/** The widest a provider's name is drawn. */
const LABEL_COLS = 16;
const WARN_AT = 70;
const ERROR_AT = 90;

/**
 * A window up to twice the working zone is one bar; a bigger one gets fine cells over the working
 * zone and coarse cells over the rest, so a long session keeps moving the bar. Each count only
 * grows with `used`.
 */
function meterCells(
  used: number,
  window: number,
): { fine: [on: number, of: number]; coarse?: [on: number, of: number] } {
  const cells = (fraction: number, of: number): [number, number] => [
    Math.min(of, Math.max(0, Math.round(fraction * of))),
    of,
  ];
  if (window <= WORKING_ZONE * 2)
    return { fine: cells(used / window, SINGLE_CELLS) };
  return {
    fine: cells(used / WORKING_ZONE, FINE_CELLS),
    coarse: cells(
      (used - WORKING_ZONE) / (window - WORKING_ZONE),
      COARSE_CELLS,
    ),
  };
}

/**
 * The extension statuses on one line, sorted by key with `localeCompare` as Pi's footer lists
 * them; colour stays in the `color` tier, and every other sequence goes in all of them. "" when
 * there are none.
 */
export function statusesLine(
  statuses: ReadonlyMap<string, string>,
  mode: Paint["mode"],
): string {
  const clean = mode === "color" ? sanitizeStyled : sanitize;
  return [...statuses]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => clean(text).trim())
    .filter((text) => text !== "")
    .join(" ");
}

/**
 * The footer's lines for a pane of `width` columns: the context, cost and model, the line of
 * where the session is, then the statuses line when `statuses` has any. Each is padded by one
 * column and fits the pane.
 * ```
 *  41% ▪▪▪▪▫▫ ▫▫▫▫ 412k/1M · 12 turns $1.82 · claude-sonnet-5-5 high
 *  ~/projects/skyr (feat-auth-refactor) · my session · ↑412k ↓38k R1.2M W96k CH94% · anthropic Σ $4.12·day  $102·mo
 * ```
 */
export function footerLines(
  facts: FooterFacts,
  statuses: string,
  paint: Paint,
  width: number,
): string[] {
  const { colors } = paint.theme;
  const glyphs = glyphsOf(paint.mode);
  const ink = (text: string, fg: Ink, bold = false) =>
    styled(paint, text, { fg: colors[fg], bold });
  const room = width - 1;
  const row = (line: string) =>
    room <= 0 ? "" : ` ${fitToWidth(line, room, glyphs.ellipsis)}`;
  const joined = (groups: readonly string[]) =>
    groups.filter((group) => group !== "").join(ink(glyphs.sep, "dim"));

  const context = (show: Head): string => {
    const usage = facts.context;
    if (!usage) return "";
    const percent = usage.percent;
    const level =
      percent === null ? 0 : percent > ERROR_AT ? 2 : percent > WARN_AT ? 1 : 0;
    const tone: Ink = level === 2 ? "error" : level === 1 ? "warning" : "text";
    // Colour alone does not carry the alarm: bold stays in mono, and `!` past the error mark
    const gauge = (text: string, fg: Ink) => ink(text, fg, level > 0);
    const label =
      percent === null
        ? "?"
        : `${Math.round(percent)}%${level === 2 && paint.mode !== "color" ? "!" : ""}`;
    const parts = [gauge(label, tone)];
    // Pi's getContextUsage never returns a zero window (pinned agent-session.js); a later
    // runtime that does gets no meter or ratio rather than a division by zero
    if (show.meter && usage.window > 0) {
      const { fine, coarse } = meterCells(usage.tokens ?? 0, usage.window);
      const bar = ([on, of]: [number, number]) =>
        gauge(glyphs.meter.on.repeat(on), tone) +
        ink(glyphs.meter.off.repeat(of - on), "dim");
      parts.push(
        [bar(fine), ...(coarse && show.coarse ? [bar(coarse)] : [])].join(" "),
      );
    }
    if (show.tokens && usage.window > 0)
      parts.push(
        ink(
          `${usage.tokens === null ? "?" : formatCount(usage.tokens)}/${formatCount(usage.window)}`,
          "muted",
        ),
      );
    return parts.join(" ");
  };

  const tally = (show: Head): string =>
    [
      show.turns
        ? ink(`${facts.turns}${show.turns === "t" ? "t" : " turns"}`, "text")
        : "",
      show.cost ? ink(formatCost(facts.cost), "text") : "",
    ]
      .filter((part) => part !== "")
      .join(" ");

  const model = (show: Head): string => {
    if (!show.model || !facts.model) return "";
    const id = show.claude ? facts.model : facts.model.replace(/^claude-/, "");
    return [
      ink(id, "text"),
      ...(show.thinking && facts.thinking
        ? [ink(facts.thinking, "muted")]
        : []),
    ].join(" ");
  };

  const session = (show: Head): string =>
    [
      show.profile && facts.profile ? ink(facts.profile, "accent") : "",
      show.clock && facts.clock ? ink(facts.clock, "muted") : "",
    ]
      .filter((part) => part !== "")
      .join(" ");

  const head = degrade<Head>(
    {
      clock: true,
      profile: true,
      claude: true,
      turns: "turns",
      coarse: true,
      tokens: true,
      meter: true,
      thinking: true,
      model: true,
      cost: true,
    },
    HEAD_STEPS,
    (show) => joined([context(show), tally(show), model(show), session(show)]),
    room,
  );

  /** `↑412k ↓38k R1.2M W96k CH94%`: the parts Pi's footer shows, from the same totals. */
  const totals = (): string => {
    const { input, output, cacheRead, cacheWrite, cacheHit } = facts.tokens;
    const parts = [
      input > 0 && `${glyphs.flow.up}${formatCount(input)}`,
      output > 0 && `${glyphs.flow.down}${formatCount(output)}`,
      cacheRead > 0 && `R${formatCount(cacheRead)}`,
      cacheWrite > 0 && `W${formatCount(cacheWrite)}`,
      (cacheRead > 0 || cacheWrite > 0) &&
        cacheHit !== undefined &&
        `CH${Math.round(cacheHit)}%`,
    ].filter((part): part is string => part !== false);
    return ink(parts.join(" "), "muted");
  };

  /** `anthropic Σ $4.12·day  $102·mo`: one provider's spend, never a total across providers. */
  const spend = (show: Where): string => {
    if (!facts.spend) return "";
    const dot = glyphs.sep.trim();
    const text = [
      ...(show.label
        ? [fitToWidth(facts.spend.provider, LABEL_COLS, glyphs.ellipsis)]
        : []),
      glyphs.sum,
      `${formatCost(facts.spend.day)}${dot}day`,
    ].join(" ");
    return ink(
      show.month ? `${text}  ${formatCost(facts.spend.month)}${dot}mo` : text,
      "muted",
    );
  };

  const where = degrade<Where>(
    {
      tokens: true,
      name: true,
      label: true,
      month: true,
      spend: true,
      branch: true,
    },
    WHERE_STEPS,
    (show) => {
      const parts = [ink(facts.cwd, "muted")];
      if (show.branch && facts.branch)
        parts.push(ink(`(${facts.branch})`, "accent"));
      const place = parts.join(" ");
      return joined([
        show.name && facts.sessionName
          ? `${place} ${ink(glyphs.sep.trim(), "dim")} ${ink(facts.sessionName, "muted")}`
          : place,
        show.tokens ? totals() : "",
        show.spend ? spend(show) : "",
      ]);
    },
    room,
  );
  return [row(head), row(where), ...(statuses === "" ? [] : [row(statuses)])];
}
