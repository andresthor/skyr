// Worktree creation for bare writers: isolation parallel, in-tree writes keep queueing.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import {
  addWorktree,
  planWorktree,
  worktreeState,
} from "../src/subagent/worktree.js";
import {
  agentFile,
  call,
  gitRepo,
  hold,
  type Parent,
  parentSession,
  results,
  scratchDir,
  taskOf,
  textOf,
} from "./session.js";

const SCOUT = {
  "scout.md": agentFile("Finds things", "model: faux-2\n"),
};

/** Result texts of subagent calls, keyed by their task (each call's tool-call id). */
const texts = (parent: Parent) =>
  new Map(
    [...results(parent.session).entries()].map(([id, m]) => [id, textOf(m)]),
  );

/** The child id in a background start's `(id …)`. */
const idTag = (text: string) => /\(id ([0-9a-f]{8})\)/.exec(text)?.[1];

/** One parent turn that runs `calls`, then answers done; children route by task. */
function turnRunner(
  child: FauxResponseFactory,
  calls: ReturnType<typeof call>[],
): FauxResponseFactory {
  let n = 0;
  return (context, ...rest) => {
    if (taskOf(context) !== "go") return child(context, ...rest);
    n += 1;
    return n === 1 ? fauxAssistantMessage(calls) : fauxAssistantMessage("done");
  };
}

/** A routed child that holds its response for the given tasks. */
const heldChild =
  (holds: Map<string, ReturnType<typeof hold>>): FauxResponseFactory =>
  (context, ...rest) => {
    const h = holds.get(taskOf(context));
    return h ? h.step(context, ...rest) : fauxAssistantMessage("ok");
  };

test("two bare writers in one turn run in their own worktrees without queueing", async () => {
  const holds = new Map(["w1", "w2"].map((t) => [t, hold()]));
  const parent = await parentSession({
    git: true,
    userAgents: SCOUT,
    respond: turnRunner(heldChild(holds), [
      call({ prompt: "w1", tools: ["edit"] }),
      call({ prompt: "w2", tools: ["edit"] }),
    ]),
  });

  const done = parent.session.prompt("go");
  // Concurrent start: neither queued, no writer relationship between the two trees.
  await Promise.all([...holds.values()].map((h) => h.entered));
  expect(parent.widgets.at(-1)?.some((l) => l.startsWith("○ queued"))).toBe(
    false,
  );

  for (const h of holds.values()) h.release();
  await done;
  await parent.session.waitForIdle();

  const w1 = texts(parent).get("w1")!;
  const w2 = texts(parent).get("w2")!;
  expect(w1).toMatch(
    /Wrote in worktree \S+ on branch skyr\/[^\s(]+ \(from [0-9a-f]{8}/,
  );
  expect(w2).toMatch(
    /Wrote in worktree \S+ on branch skyr\/[^\s(]+ \(from [0-9a-f]{8}/,
  );
  const branch = (t: string) => /on branch (skyr\/[^\s(]+)/.exec(t)![1];
  expect(branch(w1)).not.toBe(branch(w2));
  // Each run reserved its own worktree in the parent repo, and the parent tree is untouched.
  const list = execFileSync("git", ["-C", parent.cwd, "worktree", "list"], {
    encoding: "utf8",
  });
  expect(list.match(/\/worktrees\//g)?.length).toBe(2);
  expect(readFileSync(join(parent.cwd, "seed.txt"), "utf8")).toBe("seed\n");
});

test("a bare writer in a non-repo falls back in-tree, queues, and says so", async () => {
  const holds = new Map(["intree", "bare"].map((t) => [t, hold()]));
  const parent = await parentSession({
    // A plain temp cwd: not a git repo.
    respond: turnRunner(heldChild(holds), [
      call({ prompt: "intree", tools: ["edit"], cwd: "." }),
      call({ prompt: "bare", tools: ["edit"] }),
    ]),
  });

  const done = parent.session.prompt("go");
  await holds.get("intree")!.entered;
  // Both writers share the parent's tree, so the bare one queues behind the in-tree writer.
  await vi.waitFor(() =>
    expect(
      parent.widgets
        .at(-1)
        ?.some((l) => l.startsWith("○ queued") && l.includes("behind")),
    ).toBe(true),
  );
  for (const h of holds.values()) h.release();
  await done;
  await parent.session.waitForIdle();

  const bareText = texts(parent).get("bare")!;
  expect(bareText).toMatch(/git is unusable here/);
  expect(bareText).toContain("writing in-tree");
  expect(bareText).not.toContain("Wrote in worktree");
});

test("a bare reader keeps the parent's tree and gets no worktree note", async () => {
  const holds = new Map([["look", hold()]]);
  const parent = await parentSession({
    git: true,
    userAgents: SCOUT,
    respond: turnRunner(heldChild(holds), [call({ prompt: "look" })]),
  });

  const done = parent.session.prompt("go");
  await holds.get("look")!.entered;
  holds.get("look")!.release();
  await done;
  await parent.session.waitForIdle();

  const text = texts(parent).get("look")!;
  expect(text).not.toContain("Wrote in worktree");
  expect(text).not.toContain("writing in-tree");
  const list = execFileSync("git", ["-C", parent.cwd, "worktree", "list"], {
    encoding: "utf8",
  });
  expect(list.includes("/worktrees/")).toBe(false);
});

test("an aborted bare writer leaves its worktree on disk; nothing deletes it", async () => {
  const holds = new Map([["w", hold()]]);
  const parent = await parentSession({
    git: true,
    userAgents: SCOUT,
    respond: turnRunner(heldChild(holds), [
      call({ prompt: "w", tools: ["edit"], background: true }),
    ]),
  });

  await parent.session.prompt("go");
  await holds.get("w")!.entered;
  const tag = idTag(texts(parent).get("w")!);
  expect(tag).toBeDefined();
  await parent.session.prompt(`/subagents stop ${tag}`);
  await parent.session.waitForIdle();
  await vi.waitFor(() => expect(parent.widgets.at(-1)).toBeUndefined());

  // The worktree survives the aborted run: the plan's own refusal, nothing deletes it.
  const list = execFileSync("git", ["-C", parent.cwd, "worktree", "list"], {
    encoding: "utf8",
  });
  expect(list.includes("/worktrees/")).toBe(true);
});

/** Esc on a fresh bare writer that first writes `note.txt` (or nothing), then stops mid-run. */
async function stoppedWriterText(writes: boolean): Promise<string> {
  const held = hold();
  const parent = await parentSession({
    git: true,
    respond: turnRunner(
      (context, ...rest) =>
        writes && !context.messages.some((m) => m.role === "toolResult")
          ? fauxAssistantMessage([
              fauxToolCall("write", { path: "note.txt", content: "x" }),
            ])
          : held.step(context, ...rest),
      [call({ prompt: "w", tools: ["write"] })],
    ),
  });

  const run = parent.session.prompt("go");
  await held.entered;
  await parent.session.abort();
  await run;
  return texts(parent).get("w")!;
}

test("a stopped fresh writer that left a file gets the merge recipe", async () => {
  const text = await stoppedWriterText(true);
  expect(text).toContain("was stopped by the user before it answered");
  expect(text).toMatch(/Wrote in worktree \S+ on branch/);
  expect(text).toContain("To merge them: git -C ");
  expect(text).not.toContain("Nothing is there to merge");
});

test("a stopped fresh writer that left nothing is told there is nothing to merge", async () => {
  const text = await stoppedWriterText(false);
  expect(text).toContain("was stopped by the user before it answered");
  expect(text).toContain("Nothing is there to merge");
  expect(text).not.toContain("To merge them");
});

test("planWorktree reserves unique paths and branches and refuses what cannot be honoured", async () => {
  const repo = gitRepo("unit-repo");
  const sessionDir = scratchDir("sessions");
  const a = planWorktree(
    repo,
    sessionDir,
    "aaaaaaaa-1111-4111-8111-111111111111",
    "fix the login flow",
  );
  const b = planWorktree(
    repo,
    sessionDir,
    "bbbbbbbb-1111-4111-8111-111111111111",
    "fix the login flow",
  );
  const c = planWorktree(
    repo,
    sessionDir,
    "cccccccc-1111-4111-8111-111111111111",
    "",
  );
  if (!("path" in a) || !("path" in b) || !("path" in c))
    throw new Error("a seeded repo must yield worktree plans");
  expect(a.path).toContain("/worktrees/aaaaaaaa");
  expect(a.branch).toBe("skyr/fix-the-login-flow-aaaaaaaa");
  expect(b.branch).not.toBe(a.branch);
  expect(c.branch.startsWith("skyr/change-")).toBe(true);

  // An unborn HEAD has no sha to cut from and no parent diff recipe: refuse.
  const unborn = scratchDir("unborn");
  execFileSync("git", ["-C", unborn, "init"], { stdio: "ignore" });
  const noHead = planWorktree(
    unborn,
    sessionDir,
    "dddddddd-1111-4111-8111-111111111111",
    "x",
  );
  expect(noHead).toEqual({ why: expect.anything() });
  // A plain directory is not a repository.
  const plain = scratchDir("plain");
  const notRepo = planWorktree(
    plain,
    sessionDir,
    "eeeeeeee-1111-4111-8111-111111111111",
    "x",
  );
  expect(notRepo).toEqual({
    why: expect.stringContaining("not a git repository"),
  });

  // The add registers with the source repo at the planned path.
  await addWorktree(repo, a, undefined);
  const list = execFileSync("git", ["-C", repo, "worktree", "list"], {
    encoding: "utf8",
  });
  expect(list.includes(a.path)).toBe(true);
});

test("worktreeState sees an untracked file and a commit, counts a worktree git cannot read as holding writes, and knows an absent one", async () => {
  const repo = gitRepo("holds-repo");
  const plan = planWorktree(
    repo,
    scratchDir("holds-sessions"),
    "ffffffff-1111-4111-8111-111111111111",
    "x",
  );
  if (!("path" in plan)) throw new Error("a seeded repo must yield a plan");
  await addWorktree(repo, plan, undefined);
  expect(await worktreeState(plan)).toBe("clean");

  // The user's git may hide untracked files from status; the state must not.
  execFileSync("git", [
    "-C",
    plan.path,
    "config",
    "status.showUntrackedFiles",
    "no",
  ]);
  writeFileSync(join(plan.path, "note.txt"), "x");
  expect(await worktreeState(plan)).toBe("writes");

  execFileSync("git", ["-C", plan.path, "add", "-A"]);
  execFileSync(
    "git",
    [
      "-C",
      plan.path,
      "-c",
      "user.name=skyr-test",
      "-c",
      "user.email=skyr-test@example.com",
      "commit",
      "-m",
      "note",
    ],
    { stdio: "ignore" },
  );
  expect(await worktreeState(plan)).toBe("writes");

  // A directory git cannot read is not known to be clean.
  writeFileSync(join(plan.path, ".git"), "garbage");
  expect(await worktreeState(plan)).toBe("writes");

  rmSync(plan.path, { recursive: true, force: true });
  expect(await worktreeState(plan)).toBe("absent");
});
