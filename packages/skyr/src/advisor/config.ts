/** The `advisor` section of `skyr.json`: which model reviews the session. */
import { quoted } from "../ui/text.js";

export interface AdvisorModel {
  provider: string;
  id: string;
}

/**
 * Never throws. `model` is undefined when the section is absent, empty or malformed; each
 * problem names the field and the consequence. The model is split at its first `/`, so
 * `openrouter/anthropic/x` names model `anthropic/x` of provider `openrouter`.
 */
export function parseAdvisorSection(raw: unknown): {
  model: AdvisorModel | undefined;
  problems: string[];
} {
  if (raw === undefined) return { model: undefined, problems: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return {
      model: undefined,
      problems: [
        'skyr.json: advisor must be an object like {"model": "provider/model-id"}; advisor off',
      ],
    };
  const problems: string[] = [];
  for (const key of Object.keys(raw))
    if (key !== "model")
      problems.push(
        `skyr.json: advisor.${quoted(key, 40)} is not a setting; ignored (settings: model)`,
      );
  const spec = "model" in raw ? raw.model : undefined;
  if (spec === undefined) return { model: undefined, problems };
  const slash = typeof spec === "string" ? spec.indexOf("/") : -1;
  if (typeof spec !== "string" || slash <= 0 || slash === spec.length - 1)
    return {
      model: undefined,
      problems: [
        ...problems,
        'skyr.json: advisor.model must be a string like "provider/model-id"; advisor off',
      ],
    };
  return {
    model: { provider: spec.slice(0, slash), id: spec.slice(slash + 1) },
    problems,
  };
}
