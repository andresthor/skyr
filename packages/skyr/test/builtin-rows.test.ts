import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { loadPi } from "../src/pi.js";
import { grepView } from "../src/tools/builtin/search.js";
import { registerBuiltinRows } from "../src/tools/builtin-rows.js";
import { scratchDir } from "./session.js";
import {
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
    // read has no view in this build, whatever the renderers are
    expect(resolver?.("read", () => other)).toBe(other);
    // a tool name that is a property of every object
    expect(resolver?.("constructor", () => other)).toBe(other);
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
