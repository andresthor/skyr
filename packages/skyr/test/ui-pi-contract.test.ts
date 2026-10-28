// Pi behaviour the ui layout rests on. A failure here after a Pi upgrade means the design
// changes, not the test.
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  rgbColor,
  stripTerminalSequences,
  styleText,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  htmlRender,
  messageHost,
  piScreen,
  realIndicator,
  scrollScreen,
  toolRowHost,
} from "./ui.js";

test("Pi measures a tab as three columns", () => {
  expect(visibleWidth("\t")).toBe(3);
  expect(visibleWidth("a\tb")).toBe(5);
});

test("a bare ✔ is one column and ✔ with VS16 is two", () => {
  const check = String.fromCodePoint(0x2714);
  expect(visibleWidth(check)).toBe(1);
  expect(visibleWidth(`${check}${String.fromCodePoint(0xfe0f)}`)).toBe(2);
});

test("Pi's truncateToWidth puts a reset before its ellipsis, which ends a surrounding background", () => {
  const styled = styleText(
    "hello world",
    { bg: rgbColor(40, 40, 60) },
    "truecolor",
  );
  expect(truncateToWidth(styled, 6, "…")).toContain("\u001b[0m…");
});

test("Pi's regular renderer throws on an over-wide line from the second frame, and the first frame does not", () => {
  const overWide = { invalidate() {}, render: () => ["x".repeat(30)] };
  const screen = piScreen(overWide, 10);
  expect(screen.firstFrameCrash).toBeUndefined();
  expect(screen.crash?.message).toMatch(/exceeds terminal width/);
});

const KINDS = ["working", "retry", "compaction", "branchSummary"] as const;

test("a status indicator's border text is its spinner, a space, then its message, for all four kinds and for frames that carry colour", () => {
  const coloured = {
    frames: ["a", "b"].map((frame) =>
      styleText(frame, { fg: rgbColor(184, 248, 24) }, "truecolor"),
    ),
  };
  for (const kind of KINDS)
    for (const indicator of [undefined, coloured]) {
      const made = realIndicator(kind, "Doing a thing", { indicator });
      const border = made.renderInBorder(200);
      expect(border.startsWith(`${made.renderSpinnerInBorder(200)} `)).toBe(
        true,
      );
      expect(stripTerminalSequences(border).endsWith(" Doing a thing")).toBe(
        true,
      );
    }
});

test("an indicator given frames draws them verbatim, and one built without options ticks every 80 ms", () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const wrap = (text: string) => `<${text}>`;
  const given = realIndicator("working", "Working", {
    indicator: { frames: ["a", "b"], intervalMs: 200 },
    color: wrap,
  });
  expect(given.renderSpinnerInBorder(20)).toBe("a");
  vi.advanceTimersByTime(200);
  expect(given.renderSpinnerInBorder(20)).toBe("b");

  const requestRender = vi.fn();
  realIndicator("working", "Working", { requestRender });
  const built = requestRender.mock.calls.length;
  vi.advanceTimersByTime(79);
  expect(requestRender).toHaveBeenCalledTimes(built);
  vi.advanceTimersByTime(1);
  expect(requestRender).toHaveBeenCalledTimes(built + 1);
});

test("setting an indicator's frames restarts it at frame 0", () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const made = realIndicator("working", "Working", {
    indicator: { frames: ["a", "b", "c"], intervalMs: 100 },
  });
  vi.advanceTimersByTime(200);
  expect(made.renderSpinnerInBorder(20)).toBe("c");
  made.setIndicator({ frames: ["x", "y"], intervalMs: 100 });
  expect(made.renderSpinnerInBorder(20)).toBe("x");
});

test("an indicator with one frame starts no timer", () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  realIndicator("working", "Working", { indicator: { frames: ["*"] } });
  expect(vi.getTimerCount()).toBe(0);
});

const lineOf = (text: () => string): Component => ({
  invalidate() {},
  render: () => [text()],
});

/** A self-framed definition whose renderers record the context Pi hands them. */
function probeDefinition(
  call: (context: Record<string, unknown>) => Component,
  result: (context: Record<string, unknown>) => Component = () =>
    lineOf(() => "RESULT"),
) {
  const seen: { call: Record<string, unknown>[]; result: unknown[] } = {
    call: [],
    result: [],
  };
  const definition: ToolRenderers = {
    renderShell: "self",
    renderCall: (_args, _theme, context) => {
      seen.call.push(context as never);
      return call(context as never);
    },
    renderResult: (res, options, _theme, context) => {
      seen.result.push({ res, options, context });
      return result(context as never);
    },
  };
  return { definition, seen };
}

test("a \"self\" tool row is a blank line, then the call component's lines, then the result component's", () => {
  const { definition } = probeDefinition(() => lineOf(() => "CALL"));
  const host = toolRowHost(definition, {});
  expect(host.lines(40)).toEqual(["", "CALL"]);
  host.update({ content: [] });
  expect(host.lines(40)).toEqual(["", "CALL", "RESULT"]);
});

test("components a renderer returns are drawn after both renderers ran, so a call component sees what renderResult stored in context.state in the same update", () => {
  const { definition } = probeDefinition(
    (context) =>
      lineOf(() => String((context.state as { stored?: string }).stored)),
    (context) => {
      (context.state as { stored?: string }).stored = "settled";
      return { invalidate() {}, render: () => [] };
    },
  );
  const host = toolRowHost(definition, {});
  expect(host.lines(40)).toEqual(["", "undefined"]);
  host.update({ content: [] });
  expect(host.lines(40)).toEqual(["", "settled"]);
});

test("a result with no details and no duration reaches the renderers when a stream aborts", () => {
  const { definition, seen } = probeDefinition(() => lineOf(() => "CALL"));
  const host = toolRowHost(definition, {});
  host.update({ content: [{ type: "text", text: "aborted" }], isError: true });
  const last = seen.result.at(-1) as {
    res: { details: unknown };
    context: { isError: boolean; durationMs: number | undefined };
  };
  expect(last.res.details).toBeUndefined();
  expect(last.context).toMatchObject({ isError: true, durationMs: undefined });
});

test("durationMs reaches the renderers only on the final result", () => {
  const { definition, seen } = probeDefinition(() => lineOf(() => "CALL"));
  const host = toolRowHost(definition, {});
  host.update({ content: [], durationMs: 900 }, true);
  const partial = seen.result.at(-1) as { context: { durationMs?: number } };
  expect(partial.context.durationMs).toBeUndefined();
  host.update({ content: [], durationMs: 900 });
  const final = seen.result.at(-1) as { context: { durationMs?: number } };
  expect(final.context.durationMs).toBe(900);
});

test("HTML export draws the call with isPartial true and no duration, then the result on its own, with state shared", () => {
  const { definition, seen } = probeDefinition(
    (context) =>
      lineOf(() => String((context.state as { stored?: string }).stored)),
    (context) => {
      (context.state as { stored?: string }).stored = "settled";
      return lineOf(() => "RESULT");
    },
  );
  const exported = htmlRender(definition, {}, { content: [] });
  expect(seen.call[0]).toMatchObject({
    isPartial: true,
    durationMs: undefined,
    executionStarted: true,
    argsComplete: true,
  });
  // The call was drawn before the result existed
  expect(stripTerminalSequences(exported.call ?? "")).toContain("undefined");
  expect(exported.result?.expanded).toContain("RESULT");
  const result = seen.result[0] as { context: { state: object } };
  expect(result.context.state).toBe(seen.call[0]?.state);
});

test("Pi's regular renderer clears the scrollback when a line above the viewport changes, and not when a line inside it does", () => {
  const CLEAR_SCROLLBACK = "\u001b[3J";
  const screen = scrollScreen(10);
  const tall = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  screen.show(tall);
  expect(screen.show(tall.map((l, i) => (i === 0 ? "changed" : l)))).toContain(
    CLEAR_SCROLLBACK,
  );
  const settled = tall.map((l, i) => (i === 0 ? "changed" : l));
  const inside = settled.map((l, i) => (i === 29 ? "tail" : l));
  const written = screen.show(inside);
  expect(written).toContain("tail");
  expect(written).not.toContain(CLEAR_SCROLLBACK);
});

test("a renderer that throws is replaced by Pi's plain text, and a component whose render throws is not caught", () => {
  const thrower = probeDefinition(() => {
    throw new Error("renderer");
  });
  expect(
    stripTerminalSequences(
      toolRowHost(thrower.definition, {}).lines(40).join("\n"),
    ),
  ).toContain("probe");
  const late = probeDefinition(() => ({
    invalidate() {},
    render() {
      throw new Error("component");
    },
  }));
  const host = toolRowHost(late.definition, {});
  expect(() => host.lines(40)).toThrow("component");
});

const MESSAGE = {
  customType: "probe",
  content: [{ type: "text", text: "the **model's** text" }],
};

test("a message renderer that returns undefined or throws is replaced by Pi's purple box with the model's text", () => {
  const dropped = messageHost(() => undefined, MESSAGE);
  const thrown = messageHost(() => {
    throw new Error("renderer");
  }, MESSAGE);
  for (const host of [dropped, thrown]) {
    const text = host.lines(60).map(stripTerminalSequences).join("\n");
    expect(text).toContain("[probe]");
    expect(text).toContain("the model's text");
  }
});

test("a message component is rebuilt on expand and on invalidate", () => {
  const renderer = vi.fn((_message: unknown, options: { expanded: boolean }) =>
    lineOf(() => (options.expanded ? "EXPANDED" : "COLLAPSED")),
  );
  const host = messageHost(renderer as never, MESSAGE);
  expect(renderer).toHaveBeenCalledTimes(1);
  host.expand(true);
  expect(renderer).toHaveBeenCalledTimes(2);
  expect(host.lines(40)).toContain("EXPANDED");
  host.expand(true);
  expect(renderer).toHaveBeenCalledTimes(2);
  host.invalidate();
  expect(renderer).toHaveBeenCalledTimes(3);
});

test("a Spacer(1) precedes the renderer's component", () => {
  const host = messageHost(() => lineOf(() => "RECORD"), MESSAGE);
  expect(host.lines(40)).toEqual(["", "RECORD"]);
});
