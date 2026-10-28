// A fresh worktree writer whose run throws: the note follows what git finds in the worktree.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { call, parentSession, results, router, textOf } from "./session.js";

const mode = vi.hoisted(
  (): { writes: boolean; waitForStop: boolean; enter: () => void } => ({
    writes: false,
    waitForStop: false,
    enter: () => undefined,
  }),
);

// A runner that throws, as a proc child that died without reporting does.
vi.mock("../src/subagent/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/subagent/runner.js")>();
  return {
    ...actual,
    runnerFor: () => ({
      run: async (
        spec: { cwd: string },
        signal: AbortSignal,
      ): Promise<never> => {
        mode.enter();
        if (mode.writes) writeFileSync(join(spec.cwd, "note.txt"), "x");
        if (mode.waitForStop)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        throw new Error("the subagent child died without reporting");
      },
    }),
  };
});

async function outcome(o: {
  writes: boolean;
  stop?: boolean;
  refuseWorktree?: boolean;
}) {
  mode.writes = o.writes;
  mode.waitForStop = o.stop === true;
  const entered = new Promise<void>((resolve) => {
    mode.enter = resolve;
  });
  const parent = await parentSession({
    git: true,
    respond: router([call({ prompt: "w", tools: ["write"] })], () => {
      throw new Error("the runner is stubbed");
    }),
  });
  if (o.refuseWorktree) {
    // Rejects the branch ref `git worktree add -b` creates, so no worktree comes of it.
    const hooks = join(parent.cwd, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, "reference-transaction");
    writeFileSync(hook, '#!/bin/sh\n[ "$1" = prepared ] && exit 1\nexit 0\n');
    chmodSync(hook, 0o755);
  }
  const run = parent.session.prompt("go");
  if (o.stop) {
    await entered;
    await parent.session.abort();
  }
  await run;
  return textOf(results(parent.session).get("w")!);
}

test("a worktree writer that died after writing is not called empty", async () => {
  const text = await outcome({ writes: true });
  expect(text).toContain("died without reporting");
  expect(text).toContain("may hold uncommitted writes");
  expect(text).not.toContain("it is empty");
});

test("a worktree writer that died before writing anything is called empty", async () => {
  const text = await outcome({ writes: false });
  expect(text).toContain("it is empty");
});

test("a stop that follows a started run's writes gets the merge recipe and does not say it never started", async () => {
  const text = await outcome({ writes: true, stop: true });
  expect(text).toContain("was stopped by the user before it answered");
  expect(text).toContain("To merge them: git -C ");
  expect(text).not.toContain("Nothing is there to merge");
});

test("a worktree git refused to create is not called empty or written to", async () => {
  mode.waitForStop = false;
  const text = await outcome({ writes: false, refuseWorktree: true });
  expect(text).toContain("git could not create worktree");
  expect(text).not.toContain("it is empty");
  expect(text).not.toContain("uncommitted writes");
});
