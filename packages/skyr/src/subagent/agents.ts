/** Agent files: markdown whose frontmatter defines a subagent and whose body is its prompt. */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { errnoOf } from "../errno.js";
import { loadPi } from "../pi.js";
import { quoted, sanitize } from "../ui/text.js";

export interface AgentDef {
  name: string;
  description: string;
  /** `undefined` means the default tool set; `[]` means none. */
  tools: string[] | undefined;
  /** `undefined` means the parent's model. */
  model: string | undefined;
  body: string;
  /** Absolute path of the file the agent came from. */
  source: string;
}

const KNOWN_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
  "web_search",
  "web_fetch",
];

// No edit or write by default: an agent file or the `tools` param names them.
export const DEFAULT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "web_search",
  "web_fetch",
];

// Exact names, so Claude Code agent files load unchanged; PowerShell has no Pi equivalent.
const CLAUDE_CODE_TOOLS: Record<string, string> = {
  Read: "read",
  Edit: "edit",
  Write: "write",
  Bash: "bash",
  Grep: "grep",
  Glob: "find",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
};

export const READ_FIELDS: readonly string[] = [
  "name",
  "description",
  "tools",
  "model",
];
// Claude Code's color only tints its UI, so it does not warn
const QUIET_FIELDS = new Set([...READ_FIELDS, "color"]);

type ParseFrontmatter = (content: string) => {
  frontmatter: unknown;
  body: string;
};

/**
 * Tool names as an agent file or a call gives them: a comma string or a list. Claude Code names
 * are mapped to Pi's; duplicates dropped; order kept. `undefined` or `null` returns `undefined`,
 * meaning the default set. Throws, naming the unknown names and the valid ones, on anything else,
 * including `subagent`.
 */
export function parseTools(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value) && value.every((t) => typeof t === "string")
        ? value
        : undefined;
  if (raw === undefined)
    throw new Error(
      "tools must be a comma-separated string or a list of names",
    );
  const names = raw
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => CLAUDE_CODE_TOOLS[t] ?? t);
  const unknown = names.filter((t) => !KNOWN_TOOLS.includes(t));
  if (unknown.length > 0)
    throw new Error(
      `unknown tools ${unknown.join(", ")}; valid tools are ${KNOWN_TOOLS.join(", ")}`,
    );
  return [...new Set(names)];
}

function parseAgent(
  file: string,
  content: string,
  parseFrontmatter: ParseFrontmatter,
): { agent: AgentDef; ignored: string[] } {
  const { frontmatter, body } = parseFrontmatter(content);
  if (
    typeof frontmatter !== "object" ||
    frontmatter === null ||
    Array.isArray(frontmatter)
  )
    throw new Error("frontmatter must be a YAML mapping of fields");
  const fields = frontmatter as Record<string, unknown>;

  const { name = basename(file, ".md"), description, model } = fields;
  if (typeof name !== "string" || !/^[^\s\p{Cc}]+$/u.test(name))
    throw new Error(
      "name must be a single word without spaces; set name: in the frontmatter",
    );
  if (typeof description !== "string" || description.trim() === "")
    throw new Error(
      "needs a frontmatter block (between --- lines) with a description: field",
    );
  if (model !== undefined && typeof model !== "string")
    throw new Error("model must be a provider/model string or inherit");

  return {
    agent: {
      name,
      description: description.trim(),
      tools: parseTools(fields.tools),
      model: model === undefined || model === "inherit" ? undefined : model,
      body,
      source: file,
    },
    ignored: Object.keys(fields).filter((key) => !QUIET_FIELDS.has(key)),
  };
}

async function loadDir(
  dir: string,
  parseFrontmatter: ParseFrontmatter,
  errors: string[],
  warnings: string[],
): Promise<Map<string, AgentDef>> {
  const agents = new Map<string, AgentDef>();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error: unknown) {
    const code = errnoOf(error);
    if (code !== "ENOENT")
      errors.push(`cannot read agent dir ${dir} (${code ?? ""})`);
    return agents;
  }
  for (const entry of entries.filter((e) => e.endsWith(".md")).sort()) {
    const file = join(dir, entry);
    try {
      const { agent, ignored } = parseAgent(
        file,
        await readFile(file, "utf8"),
        parseFrontmatter,
      );
      const first = agents.get(agent.name);
      if (first)
        throw new Error(
          `defines "${agent.name}", already defined by ${first.source}; skipped`,
        );
      agents.set(agent.name, agent);
      if (ignored.length > 0)
        warnings.push(
          `${sanitize(file)}: ${ignored.map((key) => quoted(sanitize(key), 40)).join(", ")}`,
        );
    } catch (error: unknown) {
      // yaml ends its first line with ":" and appends a multi-line code frame
      const reason =
        error instanceof Error
          ? (error.message.split("\n")[0] ?? "").replace(/:$/, "")
          : String(error);
      errors.push(`${file}: ${reason}`);
    }
  }
  return agents;
}

/**
 * Reads the `*.md` agent files in each dir. A missing dir contributes nothing. A project agent
 * replaces a user agent of the same name, and a later project dir replaces an earlier one;
 * within one dir the first file by name wins. A file
 * or dir that cannot be read, parsed or validated is skipped and described in `errors`; nothing
 * throws for one bad file. A loaded file with frontmatter fields skyr does not act on, such as
 * another tool's agent format, is described in `warnings`.
 */
export async function loadAgents(dirs: {
  user: string;
  /** In rising precedence. */
  project?: string[];
}): Promise<{
  agents: Map<string, AgentDef>;
  errors: string[];
  warnings: string[];
}> {
  const { parseFrontmatter } = await loadPi();
  const errors: string[] = [];
  const warnings: string[] = [];
  const user = await loadDir(dirs.user, parseFrontmatter, errors, warnings);
  const merged = new Map(user);
  for (const dir of dirs.project ?? [])
    for (const [name, agent] of await loadDir(
      dir,
      parseFrontmatter,
      errors,
      warnings,
    ))
      merged.set(name, agent);
  return { agents: merged, errors, warnings };
}
