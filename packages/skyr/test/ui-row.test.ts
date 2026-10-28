import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
  durationFact,
  failedRow,
  plainRow,
  type Row,
  toolRenderers,
} from "../src/ui/row.js";
import { htmlRender, piScreen, toolRowHost } from "./ui.js";

interface Args {
  name: string;
}

const HEAD = {
  verb: "probe",
  subject: ["hello"],
  subjectKind: "text",
} as const;

/** A view over what Pi hands a row, as a tool's would be. */
const probe = toolRenderers<Args>(({ args, settled }): Row => {
  if (args.name === "throws") throw new Error("view broke");
  const head = {
    ...HEAD,
    subject: [typeof args.name === "string" ? args.name : ""],
  };
  if (settled?.isError) return failedRow(head, settled, "probe");
  return {
    head: {
      ...head,
      mark: settled ? "done" : "running",
      facts: durationFact(settled),
    },
    rail: settled
      ? {
          lines: (settled.content[0]?.text ?? "").split("\n").slice(1),
          collapsed: 1,
          ink: "muted",
        }
      : undefined,
  };
});

const plain = (lines: string[]) => lines.map(stripTerminalSequences);

describe("toolRenderers", () => {
  test("the call draws a running record, and the same row becomes the finished record when the result arrives, as one line", () => {
    const host = toolRowHost(probe, { name: "hello" });
    host.start();
    expect(plain(host.lines(60))).toEqual(["", " • probe    hello"]);
    host.update({ content: [], durationMs: 900 });
    const done = plain(host.lines(60));
    expect(done).toHaveLength(2);
    expect(done[1]).toMatch(/^ ✓ probe {4}hello +0\.9s$/);
  });

  test("expanding a row never changes its first line", () => {
    const host = toolRowHost(probe, { name: "hello" });
    host.update({
      content: [{ type: "text", text: "head\none\ntwo\nthree" }],
      durationMs: 900,
    });
    const before = host.lines(60);
    expect(plain(before).slice(2)).toEqual(["   │ one", "   │ … 2 more lines"]);
    host.expand(true);
    const after = host.lines(60);
    expect(after[1]).toBe(before[1]);
    expect(plain(after).slice(2)).toEqual([
      "   │ one",
      "   │ two",
      "   │ three",
    ]);
  });

  test("a view that throws draws one fallback line naming the cause, and the next frame draws it again", () => {
    const host = toolRowHost(probe, { name: "throws" });
    host.update({ content: [] });
    const first = plain(host.lines(60));
    expect(first).toEqual(["", "× row failed to draw: view broke"]);
    expect(plain(host.lines(60))).toEqual(first);
  });

  test("a row with no duration shows no time fact", () => {
    const host = toolRowHost(probe, { name: "hello" });
    host.update({ content: [] });
    expect(plain(host.lines(60))[1]).toBe(" ✓ probe    hello");
  });

  test("a partial result keeps the running record", () => {
    const host = toolRowHost(probe, { name: "hello" });
    host.update({ content: [{ type: "text", text: "so far" }] }, true);
    expect(plain(host.lines(60))).toEqual(["", " • probe    hello"]);
  });

  test("an aborted stream's result, with no details and no duration, draws the failure", () => {
    const host = toolRowHost(probe, { name: "hello" });
    host.update({
      content: [{ type: "text", text: "probe: aborted" }],
      isError: true,
    });
    expect(plain(host.lines(60))[1]).toMatch(/^ × probe {4}hello +aborted$/);
  });

  test("streaming arguments, even a missing object, draw a record", () => {
    for (const args of [undefined, null, {}, { name: 3 }, "text"]) {
      const host = toolRowHost(probe, args);
      expect(host.lines(60)).toHaveLength(2);
    }
  });

  test("under HTML export the call shows the running head and the result the finished record", () => {
    const exported = htmlRender(
      probe,
      { name: "hello" },
      { content: [], details: undefined },
    );
    expect(stripTerminalSequences(exported.call ?? "")).toContain("•");
    expect(exported.result?.expanded).toContain("✓");
    expect(exported.result?.expanded).toContain("hello");
  });

  test("a row never crashes Pi's renderer at 20, 40 and 86 columns, in every phase", () => {
    const phases: ((host: ReturnType<typeof toolRowHost>) => void)[] = [
      () => {},
      (host) => host.streamArgs({ name: "x".repeat(300) }),
      (host) => host.start(),
      (host) =>
        host.update({ content: [{ type: "text", text: "so far" }] }, true),
      (host) =>
        host.update({
          content: [{ type: "text", text: `probe: ${"y".repeat(300)}\nmore` }],
          isError: true,
          durationMs: 31_000,
        }),
      (host) => host.expand(true),
    ];
    for (const width of [20, 40, 86]) {
      const host = toolRowHost(probe, { name: "漢字".repeat(40) });
      for (const phase of phases) {
        phase(host);
        const screen = piScreen({ invalidate() {}, render: host.lines }, width);
        expect(screen.firstFrameCrash).toBeUndefined();
        expect(screen.crash).toBeUndefined();
      }
    }
  });
});

describe("a markdown rail", () => {
  const markdown = toolRenderers<Args>(
    (): Row => ({
      head: {
        mark: "done",
        verb: "probe",
        subject: ["x"],
        subjectKind: "text",
        facts: [],
      },
      rail: {
        lines: ["a **bold** word", "", "- one", "- two", "- three"],
        collapsed: 2,
        ink: "markdown",
      },
    }),
  );

  test("is drawn as markdown on the rail, and collapsed counts the text lines it came to", () => {
    const host = toolRowHost(markdown, {});
    host.update({ content: [] });
    const collapsed = host.lines(40);
    // a preview spends its lines on text, not on the blank between blocks
    expect(plain(collapsed).slice(2)).toEqual([
      "   │ a bold word",
      "   │ - one",
      "   │ … 2 more lines",
    ]);
    expect(collapsed.join("")).toContain("\u001b[1m");
    host.expand(true);
    expect(plain(host.lines(40)).slice(2, 5)).toEqual([
      "   │ a bold word",
      "   │ ",
      "   │ - one",
    ]);
  });

  test("is plain text on a rail under NO_COLOR and TERM=dumb, with no colour, link or Unicode", () => {
    const linked = toolRenderers<Args>(
      (): Row => ({
        head: {
          mark: "done",
          verb: "probe",
          subject: ["x"],
          subjectKind: "text",
          facts: [],
        },
        rail: {
          lines: ["a **bold** [link](https://x.test)", "", "- one"],
          collapsed: 5,
          ink: "markdown",
        },
      }),
    );
    for (const [name, value] of [
      ["NO_COLOR", "1"],
      ["TERM", "dumb"],
    ] as const) {
      vi.stubEnv(name, value);
      const host = toolRowHost(linked, {});
      host.update({ content: [] });
      const lines = host.lines(60).slice(2);
      expect(plain(lines).filter((line) => !/[│|] ?$/.test(line))).toEqual([
        expect.stringMatching(
          /^ {3}[│|] a \*\*bold\*\* \[link\]\(https:\/\/x\.test\)$/,
        ),
        expect.stringMatching(/^ {3}[│|] - one$/),
      ]);
      expect(lines.join("")).not.toContain("\u001b[38");
      expect(lines.join("")).not.toContain("\u001b]8");
      vi.unstubAllEnvs();
    }
  });

  test("never draws a line wider than the pane, nor crashes Pi's renderer", () => {
    const host = toolRowHost(markdown, {});
    host.update({ content: [] });
    host.expand(true);
    for (const width of [4, 5, 12, 20]) {
      for (const line of host.lines(width))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(
        piScreen({ invalidate() {}, render: host.lines }, width).crash,
      ).toBe(undefined);
    }
  });
});

describe("failedRow and plainRow", () => {
  const content = [
    {
      type: "text",
      text: "web_fetch: HTTP 404 from x.dev\n\n  more \u001b[2J\nlast",
    },
  ];
  const settled = { content, details: undefined, isError: true };

  test("the reason loses its tool's own prefix, and only that tool's", () => {
    expect(failedRow(HEAD, settled, "web_fetch").head.facts[0]?.text).toBe(
      "HTTP 404 from x.dev",
    );
    expect(failedRow(HEAD, settled, "web_search").head.facts[0]?.text).toBe(
      "web_fetch: HTTP 404 from x.dev",
    );
  });

  test("the rest is the other lines, sanitized, with blank ones dropped", () => {
    expect(failedRow(HEAD, settled, "web_fetch").rail?.lines).toEqual([
      "more",
      "last",
    ]);
  });

  test("no text content gives an empty reason and no rest, and a plain row is done", () => {
    const none = { ...settled, content: [{ type: "image" }] };
    expect(failedRow(HEAD, none, "x")).toMatchObject({
      head: { mark: "failed" },
      rail: { lines: [] },
    });
    expect(plainRow(HEAD, settled, "web_fetch").head).toMatchObject({
      mark: "done",
      facts: [{ text: "HTTP 404 from x.dev", kind: "measure" }],
    });
  });
});
