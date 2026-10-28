/**
 * The shared reader for `<agentDir>/skyr.json` — one config file, namespaced by module key.
 * Each module owns its section's schema and validation (see `src/voice/config.ts`) and reports
 * its own section's problems; this file owns file location, JSON structure, the never-throw
 * rule (a broken user file must not kill pi's startup) and reporting the file's own problems.
 * Every problem names a known path as it is (`voice.language`) and quotes a key the file has and
 * skyr does not know (`voice."colour"`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errnoOf } from "./errno.js";
import { loadPi } from "./pi.js";
import { clip, quoted } from "./ui/text.js";

/** One key per module that reads the file; a section is added with the code that reads it. */
const SECTIONS = ["voice", "advisor"] as const;

type Section = (typeof SECTIONS)[number];
type ConfigFile = Partial<Record<Section, unknown>>;

export interface SkyrFile {
  data: ConfigFile;
  problems: string[];
}

/**
 * Warns once per session about problems with the file itself, such as invalid JSON or an
 * unknown section, whichever modules go on to read it; theirs are their own to report.
 */
export function reportSkyrFile(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const { getAgentDir } = await loadPi();
    const { problems } = readSkyrFile(getAgentDir());
    if (problems.length > 0) ctx.ui.notify(problems.join("\n"), "warning");
  });
}

/**
 * The `key` section of `<agentDir>/skyr.json`, unchecked, for its module to validate; undefined
 * when the file or the section is missing, or the file is unreadable or not a JSON object.
 * Never throws. The file's own problems are `reportSkyrFile`'s to report, so a module reports
 * only its section's.
 */
export async function readSkyrSection(key: Section): Promise<unknown> {
  const { getAgentDir } = await loadPi();
  return readSkyrFile(getAgentDir()).data[key];
}

/**
 * Reads `<agentDir>/skyr.json`. Missing file → `{ data: {}, problems: [] }`; malformed JSON
 * → defaults plus one problem string. Never throws. Unknown top-level keys are reported
 * (a mistyped section name would otherwise be silently ignored) and dropped.
 * @internal
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
      problems: [
        `skyr.json: can't read (${errnoOf(error) ?? "error"}); using defaults`,
      ],
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
        `skyr.json: ${quoted(key, 40)} is not a section; ignored (sections: ${SECTIONS.join(", ")})`,
      );
      continue;
    }
    data[key as keyof ConfigFile] = value;
  }
  return { data, problems };
}
