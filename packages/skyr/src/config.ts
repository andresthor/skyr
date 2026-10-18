/**
 * The shared reader for `<agentDir>/skyr.json` — one config file, namespaced by module key.
 * Each module owns its section's schema and validation (see `src/voice/config.ts`); this file
 * owns only file location, JSON structure and the never-throw rule: a broken user file must
 * not kill pi's startup.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clip, errnoOf } from "./tools/render.js";

/** One key per module that reads the file; a section is added with the code that reads it. */
const SECTIONS = ["voice"] as const;

export type ConfigFile = Partial<Record<(typeof SECTIONS)[number], unknown>>;

export interface SkyrFile {
  data: ConfigFile;
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
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { data: {}, problems: [] };
    // the errno only: the message would repeat the agent-dir path the user knows
    return {
      data: {},
      problems: [`skyr.json: can't read (${errnoOf(error)}); using defaults`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail =
      error instanceof Error ? clip(error.message, 80) : "unparsable";
    return {
      data: {},
      problems: [`skyr.json: not valid JSON (${detail}); using defaults`],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {
      data: {},
      problems: [
        "skyr.json: must be an object with one key per module; using defaults",
      ],
    };
  const data: ConfigFile = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!(SECTIONS as readonly string[]).includes(key)) {
      problems.push(
        `skyr.json: ${JSON.stringify(clip(key, 40))} is not a section; ignored (sections: ${SECTIONS.join(", ")})`,
      );
      continue;
    }
    data[key as keyof ConfigFile] = value;
  }
  return { data, problems };
}
