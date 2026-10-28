// What each provider spent, read from the session files under an agent dir: bounded slices,
// incremental reads, and nothing from a writer's git worktree.
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { createSpend, type SpendProblem } from "../src/chrome/spend.js";
import { scratchDir } from "./session.js";

const isRoot = process.getuid?.() === 0;

/** Noon, `daysAgo` local days before today. */
const noon = (daysAgo: number) => {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - daysAgo,
    12,
  );
};

const assistant = (
  provider: string | undefined,
  cost: number,
  at: Date,
  id?: string,
) =>
  JSON.stringify({
    id,
    type: "message",
    timestamp: at.toISOString(),
    message: { role: "assistant", provider, usage: { cost: { total: cost } } },
  });
const usageEntry = (provider: string, cost: number, at: Date) =>
  JSON.stringify({
    type: "usage",
    kind: "cache_warm",
    provider,
    model: "m",
    timestamp: at.toISOString(),
    usage: { cost: { total: cost } },
  });

/** A sessions root, files written under it by relative path. */
function tree() {
  const root = join(scratchDir("sessions"), "sessions");
  return {
    root,
    write(path: string, lines: string[]) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), `${lines.join("\n")}\n`);
    },
    append(path: string, text: string) {
      appendFileSync(join(root, path), text);
    },
    path: (path: string) => join(root, path),
  };
}

/** A spend over `root` whose scans a test can wait for, and whose callbacks it can read. */
function harness(root: string, deps?: Parameters<typeof createSpend>[2]) {
  const changes: number[] = [];
  const problems: SpendProblem[] = [];
  const spend = createSpend(
    root,
    {
      onChange: () => changes.push(changes.length),
      onProblem: (problem) => problems.push(problem),
    },
    deps,
  );
  return {
    spend,
    changes,
    problems,
    scan: () => spend.refresh(),
    figures: (provider: string, now = new Date()) =>
      spend.figures(provider, now),
  };
}

test("spend sums assistant messages and usage entries by provider and local day", async () => {
  const files = tree();
  files.write("--a--/s1.jsonl", [
    assistant("anthropic", 1, noon(0)),
    usageEntry("anthropic", 0.5, noon(0)),
    assistant("anthropic", 2, noon(3)),
  ]);
  const spend = harness(files.root);
  expect(spend.figures("anthropic")).toBeUndefined();
  await spend.scan();
  expect(spend.figures("anthropic")).toEqual({ day: 1.5, month: 3.5 });
});

test("a provider's figures never include another's", async () => {
  const files = tree();
  files.write("--a--/s1.jsonl", [
    assistant("anthropic", 1, noon(0)),
    assistant("corti", 10, noon(0)),
  ]);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("anthropic")).toEqual({ day: 1, month: 1 });
  expect(spend.figures("corti")).toEqual({ day: 10, month: 10 });
  expect(spend.figures("openai")).toEqual({ day: 0, month: 0 });
});

test("entries with no provider, and tool-result, compaction and branch-summary usage, are not attributed", async () => {
  const files = tree();
  const cost = { usage: { cost: { total: 7 } } };
  files.write("--a--/s1.jsonl", [
    assistant(undefined, 7, noon(0)),
    JSON.stringify({
      type: "message",
      timestamp: noon(0).toISOString(),
      message: { role: "toolResult", provider: "p", ...cost },
    }),
    JSON.stringify({
      type: "compaction",
      timestamp: noon(0).toISOString(),
      ...cost,
    }),
    JSON.stringify({
      type: "branch_summary",
      timestamp: noon(0).toISOString(),
      ...cost,
    }),
    JSON.stringify({ type: "custom_message", details: [{ ...cost }] }),
    assistant("p", 1, noon(0)),
  ]);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 1, month: 1 });
});

test("entries without a finite non-negative cost or a timestamp are skipped", async () => {
  const files = tree();
  files.write("--a--/s1.jsonl", [
    assistant("p", -1, noon(0)),
    assistant("p", Number.NaN, noon(0)),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        provider: "p",
        usage: { cost: { total: 5 } },
      },
    }),
    assistant("p", 2, noon(0)),
  ]);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 2, month: 2 });
});

test("days beyond 30 are left out and the day boundary is local", async () => {
  const files = tree();
  const midnight = (daysAgo: number, hour: number, minute: number) => {
    const now = new Date();
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - daysAgo,
      hour,
      minute,
    );
  };
  files.write("--a--/s1.jsonl", [
    assistant("p", 1, noon(0)),
    assistant("p", 2, noon(29)),
    assistant("p", 4, noon(30)),
    assistant("p", 8, noon(40)),
    // Either side of local midnight, which is a different UTC day in most zones
    assistant("p", 16, midnight(1, 23, 59)),
    assistant("p", 32, midnight(0, 0, 1)),
  ]);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 1 + 32, month: 1 + 2 + 16 + 32 });
  // Seen from tomorrow, the oldest day of the window has left it
  const tomorrow = new Date(noon(-1));
  expect(spend.figures("p", tomorrow)).toEqual({ day: 0, month: 1 + 16 + 32 });
});

test.skipIf(isRoot)("a file older than 31 days is never opened", async () => {
  const files = tree();
  files.write("--a--/old.jsonl", [assistant("p", 1, noon(0))]);
  const old = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(files.path("--a--/old.jsonl"), old, old);
  chmodSync(files.path("--a--/old.jsonl"), 0o000);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.problems).toEqual([]);
  expect(spend.figures("p")).toEqual({ day: 0, month: 0 });
});

test.skipIf(isRoot)("an unchanged file is not read again", async () => {
  const files = tree();
  files.write("--a--/s1.jsonl", [assistant("p", 1, noon(0))]);
  const spend = harness(files.root);
  await spend.scan();
  // chmod leaves mtime and size alone, and a read would now fail
  chmodSync(files.path("--a--/s1.jsonl"), 0o000);
  await spend.scan();
  expect(spend.problems).toEqual([]);
  expect(spend.figures("p")).toEqual({ day: 1, month: 1 });
});

test("a grown file is read from its old offset only", async () => {
  const files = tree();
  // The padding keeps the first 256 bytes the same across the edit below
  const line = (cost: number) =>
    JSON.stringify({
      pad: "x".repeat(300),
      type: "message",
      timestamp: noon(0).toISOString(),
      message: {
        role: "assistant",
        provider: "p",
        usage: { cost: { total: cost } },
      },
    });
  files.write("--a--/s1.jsonl", [line(1), line(2)]);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 3, month: 3 });

  // Rewrite an already counted line in place, then append: only the append may be seen
  const text = `${[line(5), line(2)].join("\n")}\n${line(4)}\n`;
  writeFileSync(files.path("--a--/s1.jsonl"), text);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 7, month: 7 });
});

test("a partial last line waits for its newline", async () => {
  const files = tree();
  const second = assistant("p", 2, noon(0));
  files.write("--a--/s1.jsonl", [assistant("p", 1, noon(0))]);
  files.append("--a--/s1.jsonl", second.slice(0, 40));
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 1, month: 1 });

  files.append("--a--/s1.jsonl", `${second.slice(40)}\n`);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 3, month: 3 });
});

test("a shrunk file, or one rewritten in place, is parsed from the start", async () => {
  const files = tree();
  files.write("--a--/s1.jsonl", [
    assistant("p", 1, noon(0)),
    assistant("p", 2, noon(0)),
  ]);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 3, month: 3 });

  files.write("--a--/s1.jsonl", [assistant("p", 5, noon(0))]);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 5, month: 5 });

  // Longer than before, but another file entirely
  files.write("--a--/s1.jsonl", [
    usageEntry("p", 1, noon(0)),
    usageEntry("p", 1, noon(0)),
    usageEntry("p", 1, noon(0)),
  ]);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 3, month: 3 });
});

test("a malformed line is skipped", async () => {
  const files = tree();
  files.write("--a--/s1.jsonl", [
    '{"cost": broken',
    'not json at all but mentions "cost"',
    assistant("p", 1, noon(0)),
  ]);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 1, month: 1 });
  expect(spend.problems).toEqual([]);
});

test("a file that vanishes mid-scan is skipped", async () => {
  const files = tree();
  files.write("--a--/a.jsonl", [assistant("p", 1, noon(0))]);
  files.write("--a--/b.jsonl", [assistant("p", 2, noon(0))]);
  let ticks = 0;
  const spend = harness(files.root, {
    // Every read of the clock is past the slice, so each file yields first
    clock: () => (ticks += 100),
    yieldNow: async () => {
      rmSync(files.path("--a--/b.jsonl"), { force: true });
      rmSync(files.path("--a--/a.jsonl"), { force: true });
      files.write("--a--/a.jsonl", [assistant("p", 1, noon(0))]);
    },
  });
  await spend.scan();
  expect(spend.problems).toEqual([]);
  expect(spend.figures("p")).toEqual({ day: 1, month: 1 });
});

test.skipIf(isRoot)(
  "an unreadable file is skipped and its cause reported once",
  async () => {
    const files = tree();
    files.write("--a--/ok.jsonl", [assistant("p", 1, noon(0))]);
    for (const name of ["x1", "x2"]) {
      files.write(`--a--/${name}.jsonl`, [assistant("p", 100, noon(0))]);
      chmodSync(files.path(`--a--/${name}.jsonl`), 0o000);
    }
    const spend = harness(files.root);
    await spend.scan();
    expect(spend.problems).toEqual([
      { file: expect.stringMatching(/^--a--.x[12]\.jsonl$/), cause: "EACCES" },
    ]);
    expect(spend.figures("p")).toEqual({ day: 1, month: 1 });
  },
);

test("a directory named worktrees is never entered", async () => {
  const files = tree();
  files.write("--a--/s1.jsonl", [assistant("p", 1, noon(0))]);
  files.write("--a--/s1/worktrees/abc/nested.jsonl", [
    assistant("p", 100, noon(0)),
  ]);
  files.write("--a--/worktrees/loose.jsonl", [assistant("p", 100, noon(0))]);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 1, month: 1 });
});

test("child sessions several levels down are counted, and nothing deeper than the cap", async () => {
  const files = tree();
  files.write("--a--/parent.jsonl", [assistant("p", 1, noon(0))]);
  files.write("--a--/parent/child.jsonl", [assistant("p", 2, noon(0))]);
  files.write("--a--/parent/child/nested.jsonl", [assistant("p", 4, noon(0))]);
  files.write("--a--/parent/child/nested/more.jsonl", [
    assistant("p", 8, noon(0)),
  ]);
  // The deepest directory the walk enters
  files.write("--a--/parent/child/nested/a/deepest.jsonl", [
    assistant("p", 16, noon(0)),
  ]);
  files.write("--a--/parent/child/nested/a/b/too-deep.jsonl", [
    assistant("p", 100, noon(0)),
  ]);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 31, month: 31 });
});

test("a 5 000-file tree is scanned in slices: no stretch of the fake clock between yields exceeds 8 ms plus one unit of work", async () => {
  const files = tree();
  for (let dir = 0; dir < 50; dir++)
    for (let file = 0; file < 100; file++)
      files.write(`--d${dir}--/s${file}.jsonl`, [
        assistant("p", 0.01, noon(0)),
      ]);
  let now = 0;
  const yields: number[] = [];
  const spend = harness(files.root, {
    // One unit of work per read of the clock
    clock: () => (now += 1),
    yieldNow: async () => {
      yields.push(now);
    },
  });
  await spend.scan();
  expect(spend.figures("p")?.day).toBeCloseTo(50, 5);
  expect(yields.length).toBeGreaterThan(100);
  const stretches = yields.map((at, i) => at - (yields[i - 1] ?? 0));
  expect(Math.max(...stretches)).toBeLessThanOrEqual(8 + 4);
}, 60_000);

test("a stop mid-scan publishes nothing, and stop is idempotent", async () => {
  const files = tree();
  files.write("--a--/s1.jsonl", [assistant("p", 1, noon(0))]);
  let ticks = 0;
  const spend = harness(files.root, {
    clock: () => (ticks += 100),
    yieldNow: async () => spend.spend.stop(),
  });
  await spend.scan();
  spend.spend.stop();
  await spend.scan();
  expect(spend.changes).toEqual([]);
  expect(spend.figures("p")).toBeUndefined();
});

test("a refresh during a scan runs one more scan, not two", async () => {
  const files = tree();
  files.write("--a--/s1.jsonl", [assistant("p", 1, noon(0))]);
  let ticks = 0;
  let first = true;
  const spend = harness(files.root, {
    clock: () => (ticks += 100),
    yieldNow: async () => {
      if (!first) return;
      first = false;
      for (let i = 0; i < 3; i++) spend.spend.refresh();
    },
  });
  await spend.scan();
  expect(spend.changes).toHaveLength(2);
});

test("the root being missing is zero, not an error", async () => {
  const spend = harness(join(scratchDir("none"), "absent"));
  await spend.scan();
  expect(spend.problems).toEqual([]);
  expect(spend.figures("p")).toEqual({ day: 0, month: 0 });
});

test("a session forked from another counts the entries it copied once, and its own new ones", async () => {
  const files = tree();
  files.write("--a--/parent.jsonl", [
    assistant("p", 1, noon(0), "e1"),
    assistant("p", 2, noon(0), "e2"),
  ]);
  files.write("--a--/fork.jsonl", [
    assistant("p", 1, noon(0), "e1"),
    assistant("p", 2, noon(0), "e2"),
    assistant("p", 4, noon(0), "e3"),
  ]);
  // A child's entries have ids of their own
  files.write("--a--/parent/child.jsonl", [assistant("p", 8, noon(0), "c1")]);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 15, month: 15 });
});

test("entries that share an id in unrelated files all count", async () => {
  const files = tree();
  files.write("--a--/one.jsonl", [assistant("p", 1, noon(0), "e1")]);
  files.write("--b--/two.jsonl", [assistant("p", 2, noon(1), "e1")]);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 1, month: 3 });
});

test.skipIf(isRoot)(
  "a directory that cannot be listed keeps the figures of the files under it, and is reported",
  async () => {
    const files = tree();
    files.write("--a--/s1.jsonl", [assistant("p", 1, noon(0))]);
    files.write("--a--/s1/child.jsonl", [assistant("p", 2, noon(0))]);
    files.write("--b--/s2.jsonl", [assistant("p", 4, noon(0))]);
    const spend = harness(files.root);
    await spend.scan();
    expect(spend.figures("p")).toEqual({ day: 7, month: 7 });

    chmodSync(files.path("--a--"), 0o000);
    try {
      await spend.scan();
      expect(spend.problems).toEqual([{ file: "--a--", cause: "EACCES" }]);
      expect(spend.figures("p")).toEqual({ day: 7, month: 7 });
    } finally {
      chmodSync(files.path("--a--"), 0o700);
    }

    rmSync(files.path("--a--"), { recursive: true });
    await spend.scan();
    expect(spend.figures("p")).toEqual({ day: 4, month: 4 });
  },
);

test.skipIf(isRoot)(
  "a sessions root that cannot be listed keeps every figure, and is reported as the root",
  async () => {
    const files = tree();
    files.write("--a--/s1.jsonl", [assistant("p", 1, noon(0))]);
    const spend = harness(files.root);
    await spend.scan();

    chmodSync(files.root, 0o000);
    try {
      await spend.scan();
      expect(spend.problems).toEqual([{ file: ".", cause: "EACCES" }]);
      expect(spend.figures("p")).toEqual({ day: 1, month: 1 });
    } finally {
      chmodSync(files.root, 0o700);
    }
  },
);

test.skipIf(isRoot)(
  "a file that fails to read keeps its last figures, and its path is reported",
  async () => {
    const files = tree();
    files.write("--a--/s1.jsonl", [assistant("p", 1, noon(0))]);
    const spend = harness(files.root);
    await spend.scan();

    files.append("--a--/s1.jsonl", `${assistant("p", 2, noon(0))}\n`);
    chmodSync(files.path("--a--/s1.jsonl"), 0o000);
    await spend.scan();
    expect(spend.problems).toEqual([
      { file: "--a--/s1.jsonl", cause: "EACCES" },
    ]);
    expect(spend.figures("p")).toEqual({ day: 1, month: 1 });

    chmodSync(files.path("--a--/s1.jsonl"), 0o600);
    await spend.scan();
    expect(spend.figures("p")).toEqual({ day: 3, month: 3 });
  },
);

test("a line longer than a read chunk is read whole", async () => {
  const files = tree();
  const long = JSON.stringify({ pad: "x".repeat(700_000), note: "cost" });
  files.write("--a--/s1.jsonl", [long, assistant("p", 1, noon(0)), long]);
  const spend = harness(files.root);
  await spend.scan();
  expect(spend.figures("p")).toEqual({ day: 1, month: 1 });
});
