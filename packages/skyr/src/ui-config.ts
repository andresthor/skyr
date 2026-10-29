/** The `ui` section of `skyr.json`: what skyr draws in Pi's terminal UI. */
import { readSkyrSection } from "./config.js";
import { isRecord } from "./guards.js";
import { quoted } from "./ui/text.js";

const SETTINGS = ["footer", "builtinRows"] as const;
type Setting = (typeof SETTINGS)[number];

/**
 * Never throws. A setting that is missing or malformed keeps its default, and each problem names
 * the setting and the consequence.
 */
export async function readUiSettings(): Promise<{
  footer: boolean;
  builtinRows: boolean;
  problems: string[];
}> {
  const raw = await readSkyrSection("ui");
  if (raw === undefined)
    return { footer: true, builtinRows: true, problems: [] };
  if (!isRecord(raw))
    return {
      footer: true,
      builtinRows: true,
      problems: [
        'skyr.json: ui must be an object like {"footer": true, "builtinRows": true}; using defaults',
      ],
    };
  const problems: string[] = [];
  for (const key of Object.keys(raw))
    if (!SETTINGS.some((setting) => setting === key))
      problems.push(
        `skyr.json: ui.${quoted(key, 40)} is not a setting; ignored (settings: ${SETTINGS.join(", ")})`,
      );
  const on = (key: Setting) => {
    const value = raw[key];
    if (value !== undefined && typeof value !== "boolean")
      problems.push(`skyr.json: ui.${key} must be true or false; using true`);
    return value !== false;
  };
  return { footer: on("footer"), builtinRows: on("builtinRows"), problems };
}
