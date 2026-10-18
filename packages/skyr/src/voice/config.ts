/**
 * The `voice` section of `skyr.json`: schema, defaults, validation and merging. The section is
 * the behaviour-knob channel (`src/config.ts` owns the file mechanics); credentials stay in env.
 *
 * Per-field coercion, never wholesale rejection: a section that is 4/5 valid yields those 4/5.
 * Corti caps (docs.corti.ai/stt/*): language 2–3 letters + optional locale; keyterms ≤ 50 chars
 * and ≤ 5 words; replacements ≤ 100 chars and ≤ 10 words; 1,000 items per connection; and two
 * replacements differing only in case are CONFIG_DENIED — this validator owns that rule.
 */

import { clip } from "../tools/render.js";
import type { Replacement, SttConfig } from "./client.js";

/** Case-sensitive written forms; Corti caps each at 50 chars / 5 words. */
export const CODING_KEYTERMS: readonly string[] = [
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
export const CODING_REPLACEMENTS: readonly Replacement[] = [
  { find: "vitist", replace: "vitest" },
  { find: "vi test", replace: "vitest" },
  { find: "async await", replace: "async/await" },
  { find: "type script", replace: "TypeScript" },
  { find: "Get Hub", replace: "GitHub" },
];

/** The voice section as the user wrote it: a Corti config before mergeVocabulary adds the built-ins. */
export type VoiceConfig = SttConfig;

export const VOICE_DEFAULTS: VoiceConfig = {
  language: "en",
  interims: true,
  punctuation: "automatic",
  keyterms: [],
  replacements: [],
};

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
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Echoes a failed string into a problem string without flooding one: clipped, and quoted so
 * anything the terminal would read as control text shows as its escape instead. */
const quoted = (s: string) => JSON.stringify(clip(s, 40));

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
        `${quoted(term)} is over ${KEYTERM_CHARS} characters; dropped`,
      );
      continue;
    }
    if (words(term) > KEYTERM_WORDS) {
      problem(
        `keyterms[${i}]`,
        `${quoted(term)} is over ${KEYTERM_WORDS} words; dropped`,
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
    if (find.length > REPLACEMENT_CHARS || replace.length > REPLACEMENT_CHARS) {
      problem(
        `replacements[${i}]`,
        `${quoted(find)} is over ${REPLACEMENT_CHARS} characters; dropped`,
      );
      continue;
    }
    if (words(find) > REPLACEMENT_WORDS || words(replace) > REPLACEMENT_WORDS) {
      problem(
        `replacements[${i}]`,
        `${quoted(find)} is over ${REPLACEMENT_WORDS} words; dropped`,
      );
      continue;
    }
    // two rules differing only in case are CONFIG_DENIED, so reject here instead
    const key = find.toLowerCase();
    if (seen.has(key)) {
      problem(
        `replacements[${i}]`,
        `repeats the find ${quoted(find)} (ignoring case); dropped`,
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

/** Parses and coerces the unknown section; wrong-typed fields drop to their default with a problem string. */
export function parseVoiceSection(raw: unknown): {
  config: VoiceConfig;
  problems: string[];
} {
  const config: VoiceConfig = { ...VOICE_DEFAULTS };
  const problems: string[] = [];
  // the source is part of every problem; the path names where, the text says what and the consequence
  const problem = (path: string, msg: string) =>
    problems.push(`skyr.json: voice.${path} ${msg}`);
  if (raw === undefined) return { config, problems };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push("skyr.json: voice must be an object; using defaults");
    return { config, problems };
  }
  const section = raw as Record<string, unknown>;
  for (const key of Object.keys(section))
    if (!(key in VOICE_DEFAULTS))
      problem(
        key,
        `is not a setting; ignored (settings: ${Object.keys(VOICE_DEFAULTS).join(", ")})`,
      );

  const { language, interims, punctuation, keyterms, replacements } = section;
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
  return { config, problems };
}

/** Merges user terms over the built-ins (built-ins win the case-duplicate check; counts were
 * capped during parsing, so the merged lists stay inside Corti's 1,000). */
export function mergeVocabulary(
  config: VoiceConfig,
): Pick<SttConfig, "keyterms" | "replacements"> {
  const seen = new Set(CODING_KEYTERMS.map((t) => t.toLowerCase()));
  const keyterms = [...CODING_KEYTERMS];
  for (const term of config.keyterms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keyterms.push(term);
  }
  const replaced = new Set(
    CODING_REPLACEMENTS.map((r) => r.find.toLowerCase()),
  );
  const replacements = [...CODING_REPLACEMENTS].map((r) => ({ ...r }));
  for (const r of config.replacements) {
    const key = r.find.toLowerCase();
    if (replaced.has(key)) continue;
    replaced.add(key);
    replacements.push({ ...r });
  }
  return { keyterms, replacements };
}
