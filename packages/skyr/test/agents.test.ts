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

test("a file with an unknown tool or malformed YAML is skipped alone, and its error is one line naming the file", async () => {
  await writeFile(
    join(user, "bad.md"),
    "---\ndescription: bad\ntools:\n  - read\n  - TodoWrite\n  - subagent\n---\n",
  );
  await writeFile(
    join(user, "broken.md"),
    "---\ndescription: [unclosed\n---\n",
  );
  await writeFile(join(user, "good.md"), "---\ndescription: good\n---\nBody.");

  const { agents, errors } = await loadAgents({
    user,
    project: [join(root, "missing")],
  });

  expect([...agents.keys()]).toEqual(["good"]);
  expect(errors).toHaveLength(2);
  expect(errors.join("\n")).toContain(join(user, "bad.md"));
  expect(errors.join("\n")).toContain("TodoWrite, subagent");
  expect(errors.join("\n")).toContain(join(user, "broken.md"));
  for (const error of errors) expect(error).not.toContain("\n");
});

test("an absent tools field stays absent, so the default applies, and skyr's own fields and Claude Code's color warn about nothing", async () => {
  await writeFile(
    join(user, "plain.md"),
    "---\ndescription: plain\ntools: read\nmodel: inherit\ncolor: green\n---\nBody.",
  );
  await writeFile(
    join(user, "bare.md"),
    "---\ndescription: bare\nmodel: inherit\n---\nBody.",
  );

  const { agents, errors, warnings } = await loadAgents({ user });

  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
  expect(agents.get("bare")).toMatchObject({
    tools: undefined,
    model: undefined,
  });
  expect(agents.get("plain")?.tools).toEqual(["read"]);
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
  // A missing dir loads clean, so an empty result would otherwise pass.
  expect(agents.size).toBeGreaterThan(0);
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

test("a skipped file is an error only, never also a warning", async () => {
  await writeFile(
    join(user, "bad.md"),
    "---\ndescription: bad\ntools: TodoWrite\nthinking: high\n---\n",
  );
  await writeFile(
    join(user, "a.md"),
    "---\nname: twin\ndescription: first\n---\n",
  );
  await writeFile(
    join(user, "b.md"),
    "---\nname: twin\ndescription: second\nmaxTurns: 3\n---\n",
  );

  const { errors, warnings } = await loadAgents({ user });

  // One error for the unknown tool, one for the repeated name.
  expect(errors).toHaveLength(2);
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

test("a later project dir overrides an earlier one and both override the user dir", async () => {
  const claude = join(root, "claude");
  await mkdir(claude);
  const agent = (description: string) =>
    `---\ndescription: ${description}\n---\nBody.`;
  await writeFile(join(user, "scout.md"), agent("user scout"));
  await writeFile(join(user, "helper.md"), agent("user helper"));
  await writeFile(join(claude, "scout.md"), agent("claude scout"));
  await writeFile(join(claude, "helper.md"), agent("claude helper"));
  await writeFile(join(claude, "only.md"), agent("claude only"));
  await writeFile(join(project, "scout.md"), agent("project scout"));

  const { agents, errors } = await loadAgents({
    user,
    project: [claude, project],
  });

  expect(errors).toEqual([]);
  expect(agents.get("scout")).toMatchObject({
    body: "Body.",
    source: join(project, "scout.md"),
  });
  expect(
    [...agents.values()].map((a) => `${a.name}: ${a.description}`).sort(),
  ).toEqual([
    "helper: claude helper",
    "only: claude only",
    "scout: project scout",
  ]);
});
