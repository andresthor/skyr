/**
 * The shared reader for `<agentDir>/skyr.json` — one config file, namespaced by module key.
 * Each module owns its section's schema and validation (see `src/voice/config.ts`); this file
 * owns only file location, JSON structure and the never-throw rule: a broken user file must
 * not kill pi's startup.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One skyr extension per module key; a section exists only when the module has knobs. */
export interface ConfigFile {
  voice?: unknown;
  webSearch?: unknown;
  subagent?: unknown;
}

const SECTIONS = ["voice", "webSearch", "subagent"] as const;

export interface SkyrFile {
  data: Partial<ConfigFile>;
  problems: string[];
}

/**
 * Reads `<agentDir>/skyr.json`. Missing file → `{ data: {}, problems: [] }`; malformed JSON
 * → defaults plus one problem string. Never throws. Unknown top-level keys are reported
 * (a mistyped section name would otherwise be silently ignored) and dropped.
 */
export function readSkyrFile(agentDir: string): SkyrFile {
  const path = join(agentDir, "skyr.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT")
      return { data: {}, problems: [] };
    return { data: {}, problems: [`skyr.json: ${(e as Error).message}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { data: {}, problems: [`skyr.json: ${(e as Error).message}`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {
      data: {},
      problems: ["skyr.json: expected an object with one key per module"],
    };
  const data: Partial<ConfigFile> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!(SECTIONS as readonly string[]).includes(key)) {
      problems.push(`skyr.json: unknown section "${key}", ignored`);
      continue;
    }
    data[key as keyof ConfigFile] = value;
  }
  return { data, problems };
}
