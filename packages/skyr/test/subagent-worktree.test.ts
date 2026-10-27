// Worktree creation for bare writers: isolation parallel, in-tree writes keep queueing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import { addWorktree, planWorktree } from "../src/subagent/worktree.js";
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
      call({ task: "w1", tools: ["edit"] }),
      call({ task: "w2", tools: ["edit"] }),
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
      call({ task: "intree", tools: ["edit"], cwd: "." }),
      call({ task: "bare", tools: ["edit"] }),
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
    respond: turnRunner(heldChild(holds), [call({ task: "look" })]),
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
      call({ task: "w", tools: ["edit"], background: true }),
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
