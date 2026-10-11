import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadAgents } from "../src/subagent/agents.js";

let root: string;
let user: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skyr-agents-"));
  user = join(root, "user");
  project = join(root, "project");
  await mkdir(user);
  await mkdir(project);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a project agent overrides a user agent of the same name", async () => {
  await writeFile(
    join(user, "scout.md"),
    "---\ndescription: user scout\n---\nUser body.",
  );
  await writeFile(
    join(project, "scout.md"),
    "---\ndescription: project scout\n---\nProject body.",
  );

  const { agents, errors } = await loadAgents({ user, project });

  expect(errors).toEqual([]);
  expect(agents.get("scout")).toMatchObject({
    description: "project scout",
    body: "Project body.",
    source: join(project, "scout.md"),
  });
});

test("Claude Code tool names map to Pi names", async () => {
  await writeFile(
    join(user, "cc.md"),
    "---\nname: cc\ndescription: from Claude Code\ntools: Read, Grep, Glob, Bash, WebFetch, WebSearch, Edit, Write, ls\n---\n",
  );

  const { agents, errors } = await loadAgents({ user });

  expect(errors).toEqual([]);
  expect(agents.get("cc")?.tools).toEqual([
    "read",
    "grep",
    "find",
    "bash",
    "web_fetch",
    "web_search",
    "edit",
    "write",
    "ls",
  ]);
});

test("an unknown tool fails only that agent and names it", async () => {
  await writeFile(
    join(user, "bad.md"),
    "---\ndescription: bad\ntools:\n  - read\n  - TodoWrite\n  - subagent\n---\n",
  );
  await writeFile(
    join(user, "good.md"),
    "---\ndescription: good\ntools: read\n---\n",
  );

  const { agents, errors } = await loadAgents({ user });

  expect([...agents.keys()]).toEqual(["good"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(join(user, "bad.md"));
  expect(errors[0]).toContain("TodoWrite, subagent");
  expect(errors[0]).toMatch(/^subagent: /);
});

test("a malformed file is skipped and the others load", async () => {
  await writeFile(
    join(user, "broken.md"),
    "---\ndescription: [unclosed\n---\n",
  );
  await writeFile(join(user, "fine.md"), "---\ndescription: fine\n---\nBody.");

  const { agents, errors } = await loadAgents({
    user,
    project: join(root, "missing"),
  });

  expect([...agents.keys()]).toEqual(["fine"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(join(user, "broken.md"));
  expect(errors[0]).not.toContain("\n");
});

test("an absent tools field stays absent, so the default applies", async () => {
  await writeFile(
    join(user, "plain.md"),
    "---\ndescription: plain\nmodel: inherit\n---\nBody.",
  );

  const { agents, errors } = await loadAgents({ user });

  expect(errors).toEqual([]);
  expect(agents.get("plain")).toMatchObject({
    tools: undefined,
    model: undefined,
  });
});

test("the shipped example agents load", async () => {
  const examples = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "examples",
    "agents",
  );

  const { agents, errors } = await loadAgents({ user: examples });

  expect(errors).toEqual([]);
  expect([...agents.keys()].sort()).toEqual([
    "reviewer",
    "scout",
    "web-researcher",
  ]);
});
