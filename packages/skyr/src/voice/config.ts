/**
 * The `voice` section of `skyr.json`: schema, defaults, validation and merging. The section is
 * the behaviour-knob channel (`src/config.ts` owns the file mechanics); credentials stay in env.
 *
 * Per-field coercion, never wholesale rejection: a section that is 4/5 valid yields those 4/5.
 * Corti caps (docs.corti.ai/stt/*): language 2–3 letters + optional locale; keyterms ≤ 50 chars
 * and ≤ 5 words; replacements ≤ 100 chars and ≤ 10 words; 1,000 items per connection; and two
 * replacements differing only in case are CONFIG_DENIED — this validator owns that rule.
 */

import { quoted } from "../ui/text.js";
import type { Formatting, Replacement, SttConfig } from "./client.js";

/** Case-sensitive written forms; Corti caps each at 50 chars / 5 words. */
const CODING_KEYTERMS: readonly string[] = [
  "npm",
  "pnpm",
  "npx",
  "Node.js",
  "TypeScript",
  "JavaScript",
  "vitest",
  "async/await",
  "GitHub",
  "JSON",
  "YAML",
  "README",
  "API",
  "CLI",
  "OAuth",
  "regex",
  "localhost",
  "React",
  "Git",
  "commit",
  "refactor",
  "stdout",
  "stderr",
  "env",
  "TODO",
];

/**
 * Deterministic fixes for misses measured on the live endpoint. `find` matches
 * case-insensitively, and two rules differing only in case are CONFIG_DENIED.
 */
const CODING_REPLACEMENTS: readonly Replacement[] = [
  { find: "vitist", replace: "vitest" },
  { find: "vi test", replace: "vitest" },
  { find: "async await", replace: "async/await" },
  { find: "type script", replace: "TypeScript" },
  { find: "Get Hub", replace: "GitHub" },
];

/** The settings a section leaves out, before the built-in vocabulary is merged in. */
const VOICE_DEFAULTS: SttConfig = {
  language: "en",
  interims: true,
  punctuation: "automatic",
  keyterms: [],
  replacements: [],
  formatting: {},
};

/** Corti's documented values per field, its default first; a value Corti adds later is refused
 * here until it is listed. */
const FORMATTING: Readonly<Record<keyof Formatting, readonly string[]>> = {
  dates: ["locale:long", "locale:medium", "locale:short", "iso", "as_dictated"],
  times: ["locale", "h24", "h12"],
  numbers: ["numerals_above_nine", "numerals", "as_dictated"],
  measurements: ["abbreviated", "as_dictated"],
  numericRanges: ["numerals", "as_dictated"],
  ordinals: ["numerals_above_nine", "numerals", "as_dictated"],
};
const isFormattingField = (key: string): key is keyof Formatting =>
  Object.hasOwn(FORMATTING, key);

/** Corti's locale form: 2–3 letters + optional `-<2–8 letters>`; it rides in the config JSON
 * body, not a hostname, so credential-grade hostname rules don't apply (credentials.ts). */
const LANGUAGE = /^[a-z]{2,3}(-[a-zA-Z]{2,8})?$/;
/** Corti caps one keyterm at this many characters. */
const KEYTERM_CHARS = 50;
/** Corti caps one keyterm at this many words. */
const KEYTERM_WORDS = 5;
/** Corti caps each side of a replacement at this many characters. */
const REPLACEMENT_CHARS = 100;
/** Corti caps each side of a replacement at this many words. */
const REPLACEMENT_WORDS = 10;
/** Corti takes 1,000 terms per connection; the built-ins are sent too, so user entries leave room. */
const MAX_TERMS = 1_000;
/** How much of an echoed entry a problem line quotes. */
const ECHO_CHARS = 40;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** One reported problem: the `skyr.json:` prefix and the path stay in the caller. */
type Problem = (path: string, msg: string) => void;

function parseKeyterms(raw: unknown, problem: Problem): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) {
    problem("keyterms", "must be an array; sending the built-in terms only");
    return out;
  }
  for (const [i, item] of raw.entries()) {
    if (typeof item !== "string") {
      problem(`keyterms[${i}]`, "is not a string; dropped");
      continue;
    }
    const term = item.trim();
    if (!term) {
      problem(`keyterms[${i}]`, "is empty; dropped");
      continue;
    }
    if (term.length > KEYTERM_CHARS) {
      problem(
        `keyterms[${i}]`,
        `${quoted(term, ECHO_CHARS)} is over ${KEYTERM_CHARS} characters; dropped`,
      );
      continue;
    }
    if (words(term) > KEYTERM_WORDS) {
      problem(
        `keyterms[${i}]`,
        `${quoted(term, ECHO_CHARS)} is over ${KEYTERM_WORDS} words; dropped`,
      );
      continue;
    }
    out.push(term);
  }
  const room = MAX_TERMS - CODING_KEYTERMS.length;
  if (out.length > room) {
    out.length = room;
    problem("keyterms", `has over ${room} entries; the rest dropped`);
  }
  return out;
}

function parseReplacements(raw: unknown, problem: Problem): Replacement[] {
  const out: Replacement[] = [];
  if (!Array.isArray(raw)) {
    problem(
      "replacements",
      "must be an array; sending the built-in rules only",
    );
    return out;
  }
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const entry =
      typeof item === "object" && item !== null
        ? (item as { find?: unknown; replace?: unknown })
        : undefined;
    const find = typeof entry?.find === "string" ? entry.find.trim() : "";
    const replace =
      typeof entry?.replace === "string" ? entry.replace.trim() : "";
    if (!find || !replace) {
      problem(
        `replacements[${i}]`,
        'needs a non-empty "find" and "replace"; dropped',
      );
      continue;
    }
    const sides = { find, replace };
    const overChars = (["find", "replace"] as const).find(
      (side) => sides[side].length > REPLACEMENT_CHARS,
    );
    if (overChars) {
      problem(
        `replacements[${i}].${overChars}`,
        `${quoted(sides[overChars], ECHO_CHARS)} is over ${REPLACEMENT_CHARS} characters; dropped`,
      );
      continue;
    }
    const overWords = (["find", "replace"] as const).find(
      (side) => words(sides[side]) > REPLACEMENT_WORDS,
    );
    if (overWords) {
      problem(
        `replacements[${i}].${overWords}`,
        `${quoted(sides[overWords], ECHO_CHARS)} is over ${REPLACEMENT_WORDS} words; dropped`,
      );
      continue;
    }
    // two rules differing only in case are CONFIG_DENIED, so reject here instead
    const key = find.toLowerCase();
    if (seen.has(key)) {
      problem(
        `replacements[${i}]`,
        `repeats the find ${quoted(find, ECHO_CHARS)} (ignoring case); dropped`,
      );
      continue;
    }
    seen.add(key);
    out.push({ find, replace });
  }
  const room = MAX_TERMS - CODING_REPLACEMENTS.length;
  if (out.length > room) {
    out.length = room;
    problem("replacements", `has over ${room} entries; the rest dropped`);
  }
  return out;
}

function parseFormatting(raw: unknown, problem: Problem): Formatting {
  const out: Formatting = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problem("formatting", "must be an object; using Corti's defaults");
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!isFormattingField(key)) {
      problem(
        `formatting.${quoted(key, ECHO_CHARS)}`,
        `is not a setting; ignored (settings: ${Object.keys(FORMATTING).join(", ")})`,
      );
      continue;
    }
    const allowed = FORMATTING[key];
    if (typeof value === "string" && allowed.includes(value)) out[key] = value;
    else
      problem(
        `formatting.${key}`,
        `must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}; using Corti's default ${JSON.stringify(allowed[0])}`,
      );
  }
  return out;
}

/**
 * The Corti config the section asks for, with the built-in coding vocabulary merged in: what a
 * session is started with. Never throws; a wrong-typed field drops to its default, and each
 * problem is one line naming the field and the fallback.
 */
export function parseVoiceSection(raw: unknown): {
  config: SttConfig;
  problems: string[];
} {
  const problems: string[] = [];
  const user = userSettings(raw, problems);
  return { config: withVocabulary(user), problems };
}

/** The section's own settings, before the built-ins; each problem is pushed onto `problems`. */
function userSettings(raw: unknown, problems: string[]): SttConfig {
  const config: SttConfig = { ...VOICE_DEFAULTS };
  // the source is part of every problem; the path names where, the text says what and the consequence
  const problem = (path: string, msg: string) =>
    problems.push(`skyr.json: voice.${path} ${msg}`);
  if (raw === undefined) return config;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push("skyr.json: voice must be an object; using defaults");
    return config;
  }
  const section = raw as Record<string, unknown>;
  for (const key of Object.keys(section))
    if (!Object.hasOwn(VOICE_DEFAULTS, key))
      problem(
        quoted(key, ECHO_CHARS),
        `is not a setting; ignored (settings: ${Object.keys(VOICE_DEFAULTS).join(", ")})`,
      );

  const {
    language,
    interims,
    punctuation,
    keyterms,
    replacements,
    formatting,
  } = section;
  if (language !== undefined) {
    if (typeof language === "string" && LANGUAGE.test(language))
      config.language = language;
    else
      problem(
        "language",
        `must be a locale like "en" or "en-US"; using ${JSON.stringify(VOICE_DEFAULTS.language)}`,
      );
  }
  if (interims !== undefined) {
    if (typeof interims === "boolean") config.interims = interims;
    else
      problem(
        "interims",
        `must be true or false; using ${VOICE_DEFAULTS.interims}`,
      );
  }
  if (punctuation !== undefined) {
    if (punctuation === "automatic" || punctuation === "spoken")
      config.punctuation = punctuation;
    else
      problem(
        "punctuation",
        `must be "automatic" or "spoken"; using ${JSON.stringify(VOICE_DEFAULTS.punctuation)}`,
      );
  }
  if (keyterms !== undefined)
    config.keyterms = parseKeyterms(keyterms, problem);
  if (replacements !== undefined)
    config.replacements = parseReplacements(replacements, problem);
  if (formatting !== undefined)
    config.formatting = parseFormatting(formatting, problem);
  return config;
}

/** Last-write-wins merge by a case-insensitive key: a matching earlier entry is dropped, so
 * a user rule never sits beside the one it replaces. */
function mergeList<T>(
  builtins: readonly T[],
  user: readonly T[],
  key: (t: T) => string,
): T[] {
  const out = [...builtins];
  for (const item of user) {
    const k = key(item);
    const at = out.findIndex((existing) => key(existing) === k);
    if (at >= 0) out.splice(at, 1);
    out.push(item);
  }
  return out;
}

/** Merges the user's terms with the built-ins: a user rule that matches a built-in (ignoring
 * case) replaces it — sending both would be CONFIG_DENIED. The swap is one-for-one, and the
 * user lists were capped against the built-ins during parsing, so each merged list stays
 * inside Corti's 1,000. */
function withVocabulary(config: SttConfig): SttConfig {
  return {
    ...config,
    keyterms: mergeList(CODING_KEYTERMS, config.keyterms, (t) =>
      t.toLowerCase(),
    ),
    replacements: mergeList(
      CODING_REPLACEMENTS.map((r) => ({ ...r })),
      config.replacements,
      (r) => r.find.toLowerCase(),
    ),
  };
}
