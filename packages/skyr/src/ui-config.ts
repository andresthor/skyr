/** The `ui` section of `skyr.json`: what skyr draws in Pi's terminal UI. */
import { readSkyrSection } from "./config.js";
import { quoted } from "./ui/text.js";

/**
 * Never throws. A setting that is missing or malformed keeps its default, and each problem names
 * the setting and the consequence.
 */
export async function readUiSettings(): Promise<{
  footer: boolean;
  problems: string[];
}> {
  const raw = await readSkyrSection("ui");
  if (raw === undefined) return { footer: true, problems: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return {
      footer: true,
      problems: [
        'skyr.json: ui must be an object like {"footer": true}; using defaults',
      ],
    };
  const problems: string[] = [];
  for (const key of Object.keys(raw))
    if (key !== "footer")
      problems.push(
        `skyr.json: ui.${quoted(key, 40)} is not a setting; ignored (settings: footer)`,
      );
  const footer = "footer" in raw ? raw.footer : undefined;
  if (footer !== undefined && typeof footer !== "boolean")
    problems.push("skyr.json: ui.footer must be true or false; using true");
  return { footer: footer !== false, problems };
}
