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
  expect(errors[0]).toMatch(/bad\.md: unknown tools /);
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

  const { agents, errors, warnings } = await loadAgents({ user: examples });

  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
  expect([...agents.keys()].sort()).toEqual([
    "reviewer",
    "scout",
    "web-researcher",
  ]);
});

test("fields skyr does not act on load the agent and are named in a warning", async () => {
  await writeFile(
    join(user, "cc.md"),
    "---\nname: cc\ndescription: from Claude Code\ncolor: blue\ndisallowedTools: Bash\nmaxTurns: 3\n---\n",
  );

  const { agents, errors, warnings } = await loadAgents({ user });

  expect(errors).toEqual([]);
  expect(agents.has("cc")).toBe(true);
  expect(warnings).toEqual([
    `${join(user, "cc.md")}: "disallowedTools", "maxTurns"`,
  ]);
});

test("an agent that only uses skyr's fields and Claude Code's color warns about nothing", async () => {
  await writeFile(
    join(user, "plain.md"),
    "---\ndescription: plain\ntools: read\nmodel: inherit\ncolor: green\n---\n",
  );

  expect((await loadAgents({ user })).warnings).toEqual([]);
});

test("a skipped file is an error only, never also a warning", async () => {
  await writeFile(
    join(user, "bad.md"),
    "---\ndescription: bad\ntools: TodoWrite\nthinking: high\n---\n",
  );

  const { errors, warnings } = await loadAgents({ user });

  expect(errors).toHaveLength(1);
  expect(warnings).toEqual([]);
});

test("a file skipped for repeating a name in its dir never also warns", async () => {
  await writeFile(
    join(user, "a.md"),
    "---\nname: twin\ndescription: first\n---\n",
  );
  await writeFile(
    join(user, "b.md"),
    "---\nname: twin\ndescription: second\nmaxTurns: 3\n---\n",
  );

  const { errors, warnings } = await loadAgents({ user });

  expect(errors).toHaveLength(1);
  expect(warnings).toEqual([]);
});

test("a field name cannot carry invisible or bidi characters into the warning", async () => {
  await writeFile(
    join(user, "odd.md"),
    '---\ndescription: odd\n"x\\u202Eyz\\u200B\\u009B31m": 1\n---\n',
  );

  const { warnings } = await loadAgents({ user });

  expect(warnings).toEqual([`${join(user, "odd.md")}: "xyz31m"`]);
});
