/**
 * A fresh git worktree for a writer call that names no directory, so parallel writes in
 * different trees run at once instead of queueing. Nothing deletes a worktree; the result
 * text tells the parent how to diff, merge and prune.
 */
import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";

export interface WorktreePlan {
  path: string;
  branch: string;
  /** The commit the worktree was cut from; the parent's HEAD at call time. */
  sha: string;
}

/** A probe that decided against a worktree, with the reason the result text will report. */
export interface WorktreeRefusal {
  why: string;
}

/** Branch names accept these plus `/`, but keep the slug terminal-safe here. */
function slug(text: string): string {
  const clean = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return clean || "change";
}

/** The git toplevel of `cwd`, or `cwd` itself when it is not in a repo or git is unusable. */
export function repoRoot(cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

/**
 * Probes the parent's cwd for a usable git repo and reserves a worktree path & branch.
 * Sync, since the caller resolves calls synchronously; cheap git reads only, no side effects.
 * `sessionDir` names the directory the child's session lives in, where the worktree goes.
 */
export function planWorktree(
  cwd: string,
  sessionDir: string | undefined,
  id: string,
  description: string,
): WorktreePlan | WorktreeRefusal {
  if (sessionDir === undefined)
    return { why: "this session saves no child sessions" };
  let sha: string;
  try {
    const out = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--verify", "HEAD"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    sha = out.trim();
  } catch (error: unknown) {
    // execFileSync puts git's own report on the error's stderr; the message only says "failed".
    const raw =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      why: `git is unusable here (${raw.split("\n")[0]?.trim() || "no detail"})`,
    };
  }
  const id8 = id.slice(0, 8);
  return {
    path: join(sessionDir, "worktrees", id8),
    branch: `skyr/${slug(description)}-${id8}`,
    sha,
  };
}

/** One git add per repo at a time: concurrent adds race the ref/index locks. */
const serials = new Map<string, Promise<void>>();

const runGit = (
  root: string,
  args: string[],
  signal: AbortSignal | undefined,
) =>
  new Promise<void>((resolve, reject) =>
    execFile(
      "git",
      ["-C", root, ...args],
      {
        ...(signal ? { signal } : {}),
        timeout: 120_000,
      },
      (error, _stdout, stderr) => {
        if (error)
          reject(
            new Error(`git ${args[0]}: ${stderr.trim() || error.message}`),
          );
        else resolve();
      },
    ),
  );

/**
 * Creates the worktree the plan reserved. Adds serialize per source repo; a refusal thrown
 * past this point turns the call failed, with git's own detail in the message.
 */
export async function addWorktree(
  root: string,
  plan: WorktreePlan,
  signal: AbortSignal | undefined,
): Promise<void> {
  const ahead = serials.get(root) ?? Promise.resolve();
  const mine = ahead.then(() =>
    runGit(
      root,
      ["worktree", "add", "-b", plan.branch, plan.path, plan.sha],
      signal,
    ),
  );
  const tail = mine.then(
    () => undefined,
    () => undefined,
  );
  serials.set(root, tail);
  try {
    await mine;
  } finally {
    if (serials.get(root) === tail) serials.delete(root);
  }
}

/**
 * The result-text lines a worktree child carries, in the tool result and in a delivery.
 * Pi's edit/write never commit, so the work's files are untracked (or uncommitted edits);
 * a bare "git merge" without a commit first is a no-op. `wrote` separates a run that answered
 * from one that was stopped or failed, where merge recipes would advertise nothing.
 */
export function worktreeNote(plan: WorktreePlan, wrote: boolean): string {
  const head =
    `${wrote ? "Wrote" : "Ran"} in worktree ${plan.path} on branch ${plan.branch} (from ${plan.sha.slice(0, 8)}; ` +
    "the parent's own uncommitted files are absent)\n";
  return wrote
    ? head +
        `The new writes are uncommitted in that directory: list them with ` +
        `git -C ${plan.path} status --porcelain (tracked edits only: git -C ${plan.path} diff ${plan.sha.slice(0, 8)})\n` +
        `To merge them: git -C ${plan.path} add -A && git -C ${plan.path} commit && then ` +
        `git merge ${plan.branch} from your checkout\n` +
        `Nothing deletes the worktree; git worktree remove ${plan.path} does, when done\n`
    : `${head}Nothing is there to merge; nothing deletes the worktree\n`;
}
