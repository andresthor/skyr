import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { loadPi } from "../src/pi.js";
import { editRenderers } from "../src/tools/builtin/files.js";
import { grepView } from "../src/tools/builtin/search.js";
import { registerBuiltinRows } from "../src/tools/builtin-rows.js";
import { scratchDir } from "./session.js";
import {
  BUILTIN_TOOLS,
  type BuiltinTool,
  builtinHost,
  CORPUS,
  exportedRows,
  piExport,
  piRenderers,
  piScreen,
  type RowResult,
  realTool,
  resolveChain,
  toolRowHost,
  WIDTHS_SWEEP,
} from "./ui.js";

type Resolver = Parameters<ExtensionAPI["registerToolRenderer"]>[0];

/** skyr's registration against a stand-in for the part of `pi` it uses. */
async function registered(): Promise<Resolver[]> {
  const resolvers: Resolver[] = [];
  await registerBuiltinRows(
    { registerToolRenderer: (r: Resolver) => resolvers.push(r) } as never,
    await loadPi(),
  );
  return resolvers;
}

const setUi = (ui: unknown) =>
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR as string, "skyr.json"),
    JSON.stringify({ ui }),
  );

const plain = (lines: string[]) => lines.map(stripTerminalSequences);

function tree() {
  const cwd = scratchDir("rows");
  mkdirSync(join(cwd, "src"));
  writeFileSync(
    join(cwd, "src/a.ts"),
    "const a = 1;\nconst needle = 2;\nconst b = 3;\n",
  );
  writeFileSync(join(cwd, "src/b.ts"), "needle here\n");
  return cwd;
}

const SEARCH_CASES: [BuiltinTool, Record<string, unknown>][] = [
  ["grep", { pattern: "needle", path: "src" }],
  ["find", { pattern: "*.ts", path: "src" }],
  ["ls", { path: "src" }],
];

describe("grep, find and ls rows", () => {
  test("render through Pi's real component with realistic args and results: running, finished, failed, collapsed, expanded", async () => {
    const cwd = tree();
    for (const [name, args] of SEARCH_CASES) {
      const host = await builtinHost(name, args, await registered());
      expect(plain(host.lines(80))[1]).toMatch(
        new RegExp(`^ • ${name} {1,7}\\S`),
      );
      host.update(await realTool(name, args, cwd));
      const collapsed = plain(host.lines(80));
      expect(collapsed).toHaveLength(2);
      expect(collapsed[1]).toMatch(new RegExp(`^ ✓ ${name} `));
      host.expand(true);
      const expanded = plain(host.lines(80));
      expect(expanded[1]).toBe(collapsed[1]);
      expect(expanded.slice(2).every((l) => l.startsWith("   │ "))).toBe(true);
      expect(expanded.length).toBeGreaterThan(2);
    }
    const failing = await builtinHost(
      "ls",
      { path: "nope" },
      await registered(),
    );
    failing.update(await realTool("ls", { path: "nope" }, cwd));
    expect(plain(failing.lines(80))[1]).toMatch(
      /^ × ls {7}nope +Path not found/,
    );
  });

  test("a grep row counts matches and files, and a nothing-found result says so", async () => {
    const cwd = tree();
    const grep = async (args: Record<string, unknown>) => {
      const host = await builtinHost("grep", args, await registered());
      host.update(await realTool("grep", args, cwd));
      return plain(host.lines(100))[1] ?? "";
    };
    expect(await grep({ pattern: "needle" })).toMatch(/2 matches · 2 files/);
    expect(await grep({ pattern: "needle", path: "src/a.ts" })).toMatch(
      /1 match · 1 file/,
    );
    expect(await grep({ pattern: "zzz" })).toMatch(/no matches/);
    // Context lines have another shape, so any count would be a guess
    expect(await grep({ pattern: "needle", context: 1 })).not.toMatch(/match/);
    expect(await grep({ pattern: "e", limit: 1, glob: "*.ts" })).toMatch(
      /1 match · 1 file · truncated/,
    );
  });

  test("find and ls count entries, say so when empty, and drop a limit notice from the count", async () => {
    const cwd = tree();
    mkdirSync(join(cwd, "empty"));
    const row = async (
      name: BuiltinTool,
      args: Record<string, unknown>,
    ): Promise<string> => {
      const host = await builtinHost(name, args, await registered());
      host.update(await realTool(name, args, cwd));
      return plain(host.lines(100))[1] ?? "";
    };
    expect(await row("find", { pattern: "*.ts" })).toMatch(/2 files/);
    expect(await row("find", { pattern: "*.zz" })).toMatch(/no files/);
    expect(await row("find", { pattern: "*.ts", limit: 1 })).toMatch(
      /1 file · truncated/,
    );
    expect(await row("ls", { path: "src" })).toMatch(/2 entries/);
    expect(await row("ls", { path: "empty" })).toMatch(/empty/);
    expect(await row("ls", { path: "src", limit: 1 })).toMatch(
      /1 entry · truncated/,
    );
  });

  test("an unknown details shape renders Pi's row: header and body, indented by outputPad, no card; an extra unknown key still draws the record", async () => {
    const host = await builtinHost(
      "grep",
      { pattern: "needle" },
      await registered(),
    );
    host.update({
      content: [{ type: "text", text: "src/a.ts:2: const needle = 2;" }],
      details: { matchLimitReached: "lots" },
    });
    const lines = plain(host.lines(80));
    expect(lines.join("\n")).not.toContain("✓");
    expect(lines.join("\n")).toContain("grep");
    expect(lines.join("\n")).toContain("src/a.ts:2: const needle = 2;");
    // outputPad 1 on every drawn line, and no card colour
    for (const line of lines.filter((l) => l !== ""))
      expect(line.startsWith(" ")).toBe(true);
    expect(host.lines(80).join("")).not.toContain("\u001b[48");
    host.update({
      content: [{ type: "text", text: "src/a.ts:2: const needle = 2;" }],
      details: { somethingNew: 1 },
    });
    expect(plain(host.lines(80))[1]).toMatch(/^ ✓ grep/);
  });

  test("the setting is read before registerBuiltinRows returns: false registers no resolver, true registers one", async () => {
    setUi({ builtinRows: false });
    expect(await registered()).toHaveLength(0);
    setUi({ builtinRows: true });
    expect(await registered()).toHaveLength(1);
    setUi(undefined);
    expect(await registered()).toHaveLength(1);
  });

  test("with the setting false Pi's renderers are what the chain resolves, by identity", async () => {
    setUi({ builtinRows: false });
    const base = await piRenderers("grep");
    expect(resolveChain(await registered(), "grep", () => base)).toBe(base);
    setUi(undefined);
  });

  test("a foreign override is returned by identity and never restyled, a copy of Pi's with one function swapped is not recognised, and undefined from next() is returned", async () => {
    const [resolver] = await registered();
    const pi = await piRenderers("grep");
    const foreign: ToolRenderers = {
      ...pi,
      renderCall: () => ({ invalidate() {}, render: () => ["x"] }),
    };
    expect(resolver?.("grep", () => foreign)).toBe(foreign);
    expect(resolver?.("grep", () => undefined)).toBeUndefined();
    expect(resolver?.("grep", () => pi)).not.toBe(pi);
    const other = await piRenderers("read");
    // a tool with no view, whatever its renderers are, and a name every object has
    expect(resolver?.("subagent", () => other)).toBe(other);
    expect(resolver?.("constructor", () => other)).toBe(other);
    for (const tool of BUILTIN_TOOLS) {
      const own = await piRenderers(tool);
      const swapped = {
        ...own,
        renderResult: () => ({ invalidate() {}, render: () => [] }),
      };
      expect(resolver?.(tool, () => swapped)).toBe(swapped);
      expect(resolver?.(tool, () => own)).not.toBe(own);
    }
  });

  test("the resolver calls next() once", async () => {
    const [resolver] = await registered();
    let calls = 0;
    const pi = await piRenderers("find");
    resolver?.("find", () => {
      calls++;
      return pi;
    });
    expect(calls).toBe(1);
  });

  test("rendering the same row three times, with expand and invalidate between, does not throw, for a record and for a fallback", async () => {
    const cwd = tree();
    for (const details of [undefined, { matchLimitReached: "lots" }]) {
      const host = await builtinHost(
        "grep",
        { pattern: "needle" },
        await registered(),
      );
      const result = await realTool("grep", { pattern: "needle" }, cwd);
      host.update({ ...result, details });
      for (let i = 0; i < 3; i++) {
        host.expand(i % 2 === 0);
        host.invalidate();
        expect(() => host.lines(60)).not.toThrow();
      }
    }
  });

  test("a restyled row never crashes Pi's renderer at 20, 40 and 86 columns in every phase, with hostile pattern, path, glob and output", async () => {
    const resolvers = await registered();
    for (const text of CORPUS) {
      for (const [name, args] of [
        ["grep", { pattern: text, path: text, glob: text }],
        ["find", { pattern: text, path: text }],
        ["ls", { path: text }],
      ] as const) {
        const host = await builtinHost(name, args, resolvers);
        const results: RowResult[] = [
          { content: [{ type: "text", text: `${text}\n${text}` }] },
          {
            content: [{ type: "text", text: `${name}: ${text}\n${text}` }],
            isError: true,
            durationMs: 31_000,
          },
          {
            content: [{ type: "text", text }],
            details: { matchLimitReached: 5 },
          },
        ];
        for (const width of [20, 40, 86]) {
          const screen = (h: ReturnType<typeof host.lines>) =>
            piScreen({ invalidate() {}, render: () => h }, width);
          expect(screen(host.lines(width)).crash).toBeUndefined();
          for (const result of results) {
            host.update(result);
            for (const expand of [false, true]) {
              host.expand(expand);
              const lines = host.lines(width);
              for (const line of lines)
                expect(visibleWidth(line)).toBeLessThanOrEqual(width);
              const drawn = screen(lines);
              expect(drawn.firstFrameCrash).toBeUndefined();
              expect(drawn.crash).toBeUndefined();
            }
          }
        }
      }
    }
  });

  test("the view is total over any width from 0 to 200", async () => {
    const host = await builtinHost(
      "grep",
      { pattern: "needle" },
      await registered(),
    );
    host.update({ content: [{ type: "text", text: "a.ts:1: needle" }] });
    for (const width of WIDTHS_SWEEP)
      for (const line of host.lines(width))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  test("an export draws grep and find without a throw, with the running head above the finished record", async () => {
    const cwd = tree();
    const calls = await Promise.all(
      (
        [
          ["grep", { pattern: "needle" }],
          ["find", { pattern: "*.ts" }],
        ] as const
      ).map(async ([name, args]) => ({
        name,
        args: { ...args },
        result: await realTool(name, args, cwd),
      })),
    );
    const html = await piExport(async (pi) => {
      await registerBuiltinRows(pi, await loadPi());
    }, calls);
    const rows = exportedRows(html);
    // call-0 is the grep and call-1 the find; the template draws no others here
    expect(Object.keys(rows)).toEqual(["call-0", "call-1"]);
    for (const row of Object.values(rows)) {
      expect(row.callHtml).toContain("•");
      expect(row.resultHtmlExpanded).toContain("✓");
    }
  });
});

describe("grepView", () => {
  const settled = (text: string, details?: unknown) => ({
    content: [{ type: "text", text }],
    details,
    isError: false,
  });
  const facts = (text: string, details?: unknown, args = {}) =>
    grepView({
      args: { pattern: "x", ...args },
      settled: settled(text, details),
      state: {},
      memo: {},
      expanded: false,
    })?.head.facts.map((f) => f.text);

  test("counts matches and files with the notice stripped, absent with context, absent when the text is not Pi's shape", () => {
    const notice =
      "\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]";
    expect(
      facts(`a.ts:1: x\na.ts:4: x\nb.ts:2: x${notice}`, {
        matchLimitReached: 100,
      }),
    ).toEqual(["3 matches", "2 files", "truncated"]);
    expect(facts("a.ts:1: x", undefined, { context: 2 })).toEqual([]);
    expect(facts("something else entirely")).toEqual([]);
    expect(facts("a.ts:1: x\nstray line")).toEqual([]);
  });

  test("a match line that merely looks like a notice is not stripped when nothing was cut", () => {
    expect(facts("a.ts:1: x\n\n[b]")).toEqual([]);
  });
});

describe("bash rows", () => {
  const text = (value: string): RowResult["content"] => [
    { type: "text", text: value },
  ];
  const row = async (args: Record<string, unknown>) =>
    builtinHost("bash", args, await registered());

  test("a running row shows the last three lines of the output so far, and starts no interval, then a final one keeps them", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const host = await row({ command: "make", timeout: 30 });
    host.start();
    expect(plain(host.lines(80))[1]).toMatch(/^ • bash {5}make +timeout 30s$/);
    host.update({ content: text("one\ntwo\n\nthree\nfour\nfive\n") }, true);
    expect(plain(host.lines(80)).slice(1)).toEqual([
      expect.stringMatching(/^ • bash {5}make/),
      "   │ three",
      "   │ four",
      "   │ five",
    ]);
    expect(vi.getTimerCount()).toBe(0);
    host.update({
      content: text("six\nseven\neight\nnine\n"),
      durationMs: 1200,
    });
    expect(plain(host.lines(80)).slice(1)).toEqual([
      expect.stringMatching(/^ ✓ bash {5}make +1\.2s$/),
      "   │ … 1 more line",
      "   │ seven",
      "   │ eight",
      "   │ nine",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a quiet success settles to one line, with no tail to keep", async () => {
    const cwd = tree();
    const host = await row({ command: "true" });
    host.update(await realTool("bash", { command: "true" }, cwd));
    expect(plain(host.lines(80))).toHaveLength(2);
    expect(plain(host.lines(80))[1]).toMatch(/^ ✓ bash {5}true/);
  });

  test("the tail is sanitized and never wider than the pane", async () => {
    const host = await row({ command: "make" });
    host.update(
      {
        content: text(
          `${CORPUS.slice(6, 14).join("\n")}\n${"x".repeat(300)}\n漢字`,
        ),
      },
      true,
    );
    for (const width of [20, 40, 86]) {
      const lines = host.lines(width);
      expect(lines.length).toBeLessThanOrEqual(5);
      expect(lines.join("")).not.toContain("\u001b[2J");
      expect(lines.join("")).not.toContain("\u001b]");
      for (const line of lines)
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("Pi's partial renderResult never runs, even on the fallback path, so its interval never starts", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const host = await row({ command: "make" });
    host.start();
    host.update({ content: text("so far") }, true);
    host.update({ content: text("so far") }, true);
    expect(vi.getTimerCount()).toBe(0);
    // an unknown shape in the final result: Pi's components draw it
    host.update({
      content: text("out"),
      details: { truncation: "no" },
    });
    expect(plain(host.lines(80)).join("\n")).toContain("out");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("the exit code comes from Pi's own status line, and an output that contains that sentence mid-text is not misread", async () => {
    const cwd = tree();
    const host = await row({ command: "x" });
    host.update(
      await realTool(
        "bash",
        { command: "echo 'Command exited with code 9'; echo more; exit 2" },
        cwd,
      ),
    );
    const lines = plain(host.lines(80));
    expect(lines[1]).toMatch(/^ × bash {5}x +exit 2$/);
    expect(lines[2]).toBe("   │ Command exited with code 9");
    const ok = await row({ command: "x" });
    ok.update(
      await realTool(
        "bash",
        { command: "echo 'Command exited with code 9'" },
        cwd,
      ),
    );
    expect(plain(ok.lines(80))[1]).toMatch(/^ ✓ bash/);
    expect(plain(ok.lines(80))[2]).toBe("   │ Command exited with code 9");
  });

  test("a failed row shows the last three output lines under the count of the rest; expanded shows all", async () => {
    const cwd = tree();
    const host = await row({ command: "seq" });
    host.update(await realTool("bash", { command: "seq 1 8; exit 2" }, cwd));
    expect(plain(host.lines(80)).slice(2)).toEqual([
      "   │ … 5 more lines",
      "   │ 6",
      "   │ 7",
      "   │ 8",
    ]);
    host.expand(true);
    expect(
      plain(host.lines(80))
        .slice(2)
        .map((l) => l.slice(5)),
    ).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  test("a failed rail of 1000 lines hides the same count collapsed and expanded, and keeps the log path in reach", async () => {
    const output = Array.from({ length: 1000 }, (_, i) => `l${i + 1}`).join(
      "\n",
    );
    const host = await row({ command: "seq" });
    host.update({
      content: text(`${output}\n\nCommand exited with code 2`),
      details: { fullOutputPath: "/tmp/full.log" },
      isError: true,
    });
    const collapsed = plain(host.lines(80)).slice(2);
    expect(collapsed).toEqual([
      "   │ … 997 more lines",
      "   │ l998",
      "   │ l999",
      "   │ l1000",
      "   │ log /tmp/full.log",
    ]);
    host.expand(true);
    const expanded = plain(host.lines(80)).slice(2);
    expect(expanded).toHaveLength(400 + 1 + 1);
    expect(expanded.at(-2)).toBe("   │ … 600 more lines");
    expect(expanded.at(-1)).toBe("   │ log /tmp/full.log");
  });

  test("an expanded rail stops at 400 lines and counts the rest", async () => {
    const cwd = tree();
    const host = await row({ command: "seq" });
    host.update(await realTool("bash", { command: "seq 1 900; exit 2" }, cwd));
    host.expand(true);
    const lines = plain(host.lines(80));
    expect(lines).toHaveLength(2 + 400 + 1);
    expect(lines.at(-1)).toBe("   │ … 500 more lines");
  });

  test("aborted, timed out and truncated results draw their own explanation", async () => {
    const cwd = tree();
    const timed = await row({ command: "sleep 5" });
    timed.update(
      await realTool("bash", { command: "sleep 5", timeout: 1 }, cwd),
    );
    expect(plain(timed.lines(80))[1]).toMatch(/× bash.*timed out after 1s/);
    const aborted = await row({ command: "x" });
    aborted.update({
      content: text("partial\n\nCommand aborted"),
      isError: true,
    });
    expect(plain(aborted.lines(80))[1]).toMatch(/^ ■ bash {5}x +aborted$/);
    const big = await row({ command: "seq" });
    big.update(await realTool("bash", { command: "seq 1 5000" }, cwd));
    expect(plain(big.lines(100))[1]).toMatch(/✓ bash.*truncated/);
    big.expand(true);
    const expanded = plain(big.lines(100));
    expect(expanded.some((l) => l.includes("   │ log "))).toBe(true);
    expect(expanded.join("\n")).not.toContain("Showing lines");
  });

  test("a moved job draws as the shells' running record with its id", async () => {
    const host = await row({ command: "pnpm dev" });
    host.update({
      content: text(
        "Still running after 10 s; moved to the background as job 707a40cb",
      ),
      details: {
        job: {
          id: "707a40cb",
          command: "pnpm dev",
          cwd: "/x",
          log: "/x/out.log",
          startedAt: 1,
          status: "running",
        },
        "tengi:task": { source: "x", id: "707a40cb" },
      },
    });
    expect(plain(host.lines(80))[1]).toMatch(
      /^ • bash & +pnpm dev +still running +707a40cb$/,
    );
  });

  test("an unknown details shape draws Pi's row, and a hostile command and output never crash Pi's renderer at 20, 40 and 86 columns", async () => {
    const resolvers = await registered();
    for (const value of CORPUS) {
      const host = await builtinHost(
        "bash",
        { command: value, timeout: 3 },
        resolvers,
      );
      const results: RowResult[] = [
        { content: text(`${value}\n${value}`) },
        {
          content: text(`${value}\n\nCommand exited with code 2`),
          isError: true,
        },
        { content: text(value), details: { truncation: 3 } },
        {
          content: text(value),
          details: { truncation: { truncated: true }, fullOutputPath: value },
        },
      ];
      for (const width of [20, 40, 86]) {
        const screen = (lines: string[]) =>
          piScreen({ invalidate() {}, render: () => lines }, width);
        host.update({ content: text(value) }, true);
        expect(screen(host.lines(width)).crash).toBeUndefined();
        for (const result of results) {
          host.update(result);
          for (const expand of [false, true, false]) {
            host.expand(expand);
            host.invalidate();
            const lines = host.lines(width);
            for (const line of lines)
              expect(visibleWidth(line)).toBeLessThanOrEqual(width);
            const drawn = screen(lines);
            expect(drawn.firstFrameCrash).toBeUndefined();
            expect(drawn.crash).toBeUndefined();
          }
        }
      }
    }
  });
});

const ESC = String.fromCharCode(27);
const BACKGROUND = new RegExp(`${ESC}\\[(?:4[0-8]|10[0-7])`);
const COLOUR = new RegExp(`${ESC}\\[(?:3[0-8]|4[0-8]|9\\d|10[0-7])`);

describe("read, write and edit rows", () => {
  const text = (value: string): RowResult["content"] => [
    { type: "text", text: value },
  ];

  test("a read shows its range and line count, a truncated one says so, and a missing file fails with its reason", async () => {
    const cwd = tree();
    const read = async (args: Record<string, unknown>) => {
      const host = await builtinHost("read", args, await registered());
      host.update(await realTool("read", args, cwd));
      return plain(host.lines(100))[1] ?? "";
    };
    expect(await read({ path: "src/a.ts" })).toMatch(
      /^ ✓ read {5}src\/a\.ts +3 lines$/,
    );
    expect(await read({ path: "src/a.ts", offset: 2, limit: 1 })).toMatch(
      /^ ✓ read {5}src\/a\.ts:2-2 +1 line$/,
    );
    expect(await read({ path: "src/a.ts", offset: 2 })).toMatch(
      /src\/a\.ts:2- +/,
    );
    expect(await read({ path: "nope.ts" })).toMatch(
      /^ × read {5}nope\.ts +ENOENT/,
    );
    writeFileSync(join(cwd, "big.txt"), "line\n".repeat(5000));
    expect(await read({ path: "big.txt" })).toMatch(/2000 lines · truncated/);
  });

  test("an image read says image, and a read of binary-looking text draws sanitized lines", async () => {
    const host = await builtinHost(
      "read",
      { path: "a.png" },
      await registered(),
    );
    host.update({
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ] as never,
    });
    expect(plain(host.lines(80))[1]).toMatch(/^ ✓ read {5}a\.png +image$/);
    const binary = await builtinHost("read", { path: "b" }, await registered());
    binary.update({ content: text("\u0000\u001b[2J\u0007ok\n‮evil\n") });
    binary.expand(true);
    const lines = binary.lines(80);
    expect(lines.join("")).not.toContain("\u001b[2J");
    expect(plain(lines).join("\n")).toContain("ok");
  });

  test("a SKILL.md or AGENTS.md read is a plain record", async () => {
    for (const path of ["skills/x/SKILL.md", "AGENTS.md"]) {
      const host = await builtinHost("read", { path }, await registered());
      host.update({ content: text("# a\nb\n") });
      expect(plain(host.lines(80))[1]).toMatch(
        new RegExp(`^ ✓ read {5}${path.replace(".", "\\.")} +2 lines$`),
      );
    }
  });

  test("a write counts the lines it was given, none while the arguments stream, and its failure has its reason; expanded shows the content", async () => {
    const cwd = tree();
    const args = { path: "src/w.ts", content: "a\nb\nc\n" };
    const host = await builtinHost(
      "write",
      { path: "src/w.ts" },
      await registered(),
    );
    expect(plain(host.lines(80))[1]).toMatch(/^ • write {4}src\/w\.ts$/);
    host.streamArgs(args);
    host.update(await realTool("write", args, cwd));
    expect(plain(host.lines(80))[1]).toMatch(
      /^ ✓ write {4}src\/w\.ts +3 lines$/,
    );
    host.expand(true);
    expect(plain(host.lines(80)).slice(2)).toEqual([
      "   │ a",
      "   │ b",
      "   │ c",
    ]);
    const failed = await builtinHost("write", args, await registered());
    failed.update({
      content: text("write: EACCES: permission denied"),
      isError: true,
    });
    expect(plain(failed.lines(80))[1]).toMatch(
      /^ × write {4}src\/w\.ts +EACCES/,
    );
  });

  test("an expanded write stops at 400 lines and counts the rest", async () => {
    const content = "x\n".repeat(5000);
    const host = await builtinHost(
      "write",
      { path: "w", content },
      await registered(),
    );
    host.update({ content: text("Successfully wrote to w") });
    host.expand(true);
    const lines = plain(host.lines(80));
    expect(lines).toHaveLength(2 + 400 + 1);
    expect(lines.at(-1)).toBe("   │ … 4600 more lines");
  });

  const editArgs = (path: string) => ({
    path,
    edits: [{ oldText: "two", newText: "2" }],
  });
  const fileWith = (body: string) => {
    const path = join(scratchDir("edit"), "a.ts");
    writeFileSync(path, body);
    return path;
  };

  test("a live preview appears under the running head once the arguments are complete, and the settled diff replaces it", async () => {
    const path = fileWith("one\ntwo\nthree\n");
    const host = await builtinHost("edit", editArgs(path), await registered());
    host.streamArgs(editArgs(path));
    expect(plain(host.lines(100))).toHaveLength(2);
    host.argsComplete();
    await vi.waitFor(() =>
      expect(plain(host.lines(100)).length).toBeGreaterThan(2),
    );
    const running = plain(host.lines(100));
    expect(running[1]).toMatch(/^ • edit {5}/);
    expect(running.slice(2).join("\n")).toContain("-2 two");
    expect(running.slice(2).join("\n")).toContain("+2 2");
    host.update(await realTool("edit", editArgs(path), dirname(path)));
    const done = plain(host.lines(100));
    expect(done[1]).toMatch(/^ ✓ edit {5}.*\+1 −1$/);
    expect(done.slice(2).join("\n")).toContain("+2 2");
  });

  test("a new theme re-colours a settled diff, and a repaint under the same theme does not colour it again", async () => {
    vi.stubEnv("TERM", "xterm");
    vi.stubEnv("NO_COLOR", "");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    let theme = "dark";
    const renderDiff = vi.fn((diff: string) => `<${theme}>${diff}`);
    const host = toolRowHost(
      editRenderers(await piRenderers("edit"), renderDiff),
      { path: "a.ts" },
    );
    host.update({
      content: [{ type: "text", text: "ok" }],
      details: { diff: "-1 a\n+1 b" },
    });
    expect(host.lines(80).join("\n")).toContain("<dark>-1 a");
    host.lines(80);
    expect(renderDiff).toHaveBeenCalledTimes(1);
    theme = "light";
    host.invalidate();
    expect(host.lines(80).join("\n")).toContain("<light>-1 a");
  });

  test("a preview error draws nothing under the head", async () => {
    const path = fileWith("one\n");
    const host = await builtinHost("edit", editArgs(path), await registered());
    host.argsComplete();
    // The failing preview emits nothing observable (only invalidate, which the host's no-op ui drops), so 100 ms is the bound.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(plain(host.lines(100))).toHaveLength(2);
  });

  test("the settled row counts +N −M from the diff, collapsed shows six lines and a count, expanded all", async () => {
    const diff = [
      ...Array.from({ length: 4 }, (_, i) => `-${i + 1} old ${i}`),
      ...Array.from({ length: 6 }, (_, i) => `+${i + 1} new ${i}`),
      " 11 same",
      " 12 same",
    ].join("\n");
    const host = await builtinHost(
      "edit",
      { path: "a.ts" },
      await registered(),
    );
    host.update({ content: text("ok"), details: { diff, patch: "" } });
    const collapsed = plain(host.lines(80));
    expect(collapsed[1]).toMatch(/\+6 −4$/);
    expect(collapsed).toHaveLength(2 + 6 + 1);
    expect(collapsed.at(-1)).toBe("   │ … 6 more lines");
    host.expand(true);
    expect(plain(host.lines(80))).toHaveLength(2 + 12);
  });

  test("an edit whose details lack a diff draws Pi's row, and a failed edit its reason", async () => {
    const host = await builtinHost(
      "edit",
      { path: "a.ts" },
      await registered(),
    );
    host.update({
      content: text("Successfully replaced"),
      details: { patch: "x" },
    });
    expect(plain(host.lines(80)).join("\n")).not.toContain("✓");
    const failed = await builtinHost(
      "edit",
      { path: "a.ts" },
      await registered(),
    );
    failed.update({
      content: text("Could not find the text in a.ts"),
      isError: true,
    });
    expect(plain(failed.lines(80))[1]).toMatch(
      /^ × edit {5}a\.ts +Could not find/,
    );
  });

  test("NO_COLOR and TERM=dumb emit no escape from an edit row, and no line of any edit row carries a background", async () => {
    const diff = "-1 a\n+1 b\n 2 c";
    const draw = async () => {
      const host = await builtinHost(
        "edit",
        { path: "a.ts" },
        await registered(),
      );
      host.update({ content: text("ok"), details: { diff } });
      host.expand(true);
      return host.lines(80).join("\n");
    };
    expect(await draw()).not.toMatch(BACKGROUND);
    for (const [name, value] of [
      ["NO_COLOR", "1"],
      ["TERM", "dumb"],
    ] as const) {
      vi.stubEnv(name, value);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const drawn = await draw();
      if (name === "TERM") expect(drawn).not.toContain("\u001b");
      // NO_COLOR keeps bold and drops colour
      else expect(drawn).not.toMatch(COLOUR);
      vi.unstubAllEnvs();
    }
  });

  test("a hostile path, content and diff never crash Pi's renderer at 20, 40 and 86 columns", async () => {
    const resolvers = await registered();
    for (const value of CORPUS) {
      const cases: [BuiltinTool, Record<string, unknown>, RowResult[]][] = [
        [
          "read",
          { path: value, offset: 3, limit: 9 },
          [
            { content: text(`${value}\n${value}`) },
            { content: text(value), details: { truncation: 1 } },
          ],
        ],
        [
          "write",
          { path: value, content: value },
          [{ content: text("Successfully wrote") }],
        ],
        [
          "edit",
          { path: value, edits: [] },
          [
            {
              content: text("ok"),
              details: { diff: `-1 ${value}\n+1 ${value}\n 2 ${value}` },
            },
            { content: text(`edit: ${value}`), isError: true },
          ],
        ],
      ];
      for (const [name, args, results] of cases) {
        const host = await builtinHost(name, args, resolvers);
        for (const width of [20, 40, 86]) {
          for (const result of [{ content: text("") }, ...results]) {
            host.update(result);
            for (const expand of [false, true]) {
              host.expand(expand);
              host.invalidate();
              const lines = host.lines(width);
              for (const line of lines)
                expect(visibleWidth(line)).toBeLessThanOrEqual(width);
              const drawn = piScreen(
                { invalidate() {}, render: () => lines },
                width,
              );
              expect(drawn.firstFrameCrash).toBeUndefined();
              expect(drawn.crash).toBeUndefined();
            }
          }
        }
      }
    }
  });
});

describe("the fallback and the edges of the new rows", () => {
  const text = (value: string): RowResult["content"] => [
    { type: "text", text: value },
  ];

  test("an unknown details shape draws Pi's own row for every tool, without our record", async () => {
    const odd = { truncation: "no", diff: 3, patch: 1, matchLimitReached: "x" };
    const cases: [BuiltinTool, Record<string, unknown>, RegExp][] = [
      ["read", { path: "a.ts" }, /read/],
      ["write", { path: "a.ts", content: "x" }, /write/],
      ["bash", { command: "make" }, /make/],
      ["grep", { pattern: "needle" }, /grep/],
      ["find", { pattern: "*.ts" }, /find/],
      ["ls", { path: "src" }, /ls/],
    ];
    for (const [name, args, header] of cases) {
      const host = await builtinHost(name, args, await registered());
      host.update({
        content: text("OUTPUT"),
        details: name === "write" ? "odd" : odd,
      });
      // Pi's read and write rows keep their output behind ctrl+o
      host.expand(true);
      const lines = plain(host.lines(80));
      expect(lines.join("\n"), name).not.toMatch(/[✓×]/);
      expect(lines.join("\n"), name).toMatch(header);
      // Pi's write row shows the content it was given, not the result
      expect(lines.join("\n"), name).toContain(
        name === "write" ? "x" : "OUTPUT",
      );
    }
    // Pi's edit keeps its own card, background and all, because it is Pi's content
    const edit = await builtinHost(
      "edit",
      { path: "a.ts" },
      await registered(),
    );
    edit.update({ content: text("done"), details: { patch: "x" } });
    expect(plain(edit.lines(80)).join("\n")).not.toContain("✓");
    expect(edit.lines(80).join("")).toContain(`${ESC}[48`);
  });

  test("a thrown bash failure with cut output drops Pi's notice from the rail and says truncated", async () => {
    const host = await builtinHost(
      "bash",
      { command: "seq" },
      await registered(),
    );
    host.update({
      content: text(
        "4001\n4002\n\n[Showing lines 4001-5000 of 5000. Full output: /tmp/x.log]\n\nCommand aborted",
      ),
      isError: true,
    });
    host.expand(true);
    const lines = plain(host.lines(100));
    expect(lines[1]).toMatch(/aborted · truncated$/);
    expect(lines.join("\n")).not.toContain("Showing lines");
    expect(lines.slice(2)).toEqual(["   │ 4001", "   │ 4002"]);
  });

  test("a file tool's head has no subject until its path has streamed in", async () => {
    for (const name of ["read", "write", "edit"] as const) {
      const host = await builtinHost(name, {}, await registered());
      expect(plain(host.lines(80))[1]).toMatch(new RegExp(`^ • ${name} *$`));
      host.streamArgs({ path: "src/a.ts" });
      expect(plain(host.lines(80))[1]).toMatch(/src\/a\.ts$/);
    }
  });

  test("an edit's diff rail stops at 400 lines and counts the rest", async () => {
    const diff = Array.from(
      { length: 900 },
      (_, i) => `+${i + 1} line ${i}`,
    ).join("\n");
    const host = await builtinHost(
      "edit",
      { path: "a.ts" },
      await registered(),
    );
    host.update({ content: text("ok"), details: { diff } });
    host.expand(true);
    const lines = plain(host.lines(80));
    expect(lines).toHaveLength(2 + 400 + 1);
    expect(lines.at(-1)).toBe("   │ … 500 more lines");
  });
});
