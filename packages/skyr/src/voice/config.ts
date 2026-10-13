/**
 * The `voice` section of `skyr.json`: schema, defaults, validation and merging. The section is
 * the behaviour-knob channel (`src/config.ts` owns the file mechanics); credentials stay in env.
 *
 * Per-field coercion, never wholesale rejection: a section that is 4/5 valid yields those 4/5.
 * Corti caps (docs.corti.ai/stt/*): language 2–3 letters + optional locale; keyterms ≤ 50 chars
 * and ≤ 5 words; replacements ≤ 100 chars and ≤ 10 words; 1,000 items per connection; and two
 * replacements differing only in case are CONFIG_DENIED — this validator owns that rule.
 */

/** Built-in coding vocabulary appended under every user list, unchanged from the vendored copy. */

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
export const CODING_REPLACEMENTS: readonly { find: string; replace: string }[] =
  [
    { find: "vitist", replace: "vitest" },
    { find: "vi test", replace: "vitest" },
    { find: "async await", replace: "async/await" },
    { find: "type script", replace: "TypeScript" },
    { find: "Get Hub", replace: "GitHub" },
  ];

export interface VoiceConfig {
  language: string;
  interims: boolean;
  punctuation: "automatic" | "spoken";
  keyterms: string[];
  replacements: { find: string; replace: string }[];
}

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
const LANGUAGE_MAX = 12;
const KEYTERM_MAX = 50;
const KEYTERM_WORDS = 5;
const REPLACEMENT_MAX = 100;
const REPLACEMENT_WORDS = 10;
/** Corti takes 1,000 per connection; the built-ins are sent too, so user entries leave room. */
const ITEM_LIMIT = 1000;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Echoes a failed value into a problem string without flooding one. */
const quoted = (s: string) =>
  JSON.stringify(s.length > 30 ? `${s.slice(0, 29)}…` : s);

type Problem = (msg: string) => void;

function parseKeyterms(raw: unknown, problem: Problem): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) {
    problem('"keyterms" must be an array, built-ins only sent');
    return out;
  }
  for (const item of raw) {
    if (typeof item !== "string") {
      problem(
        `keyterm ${JSON.stringify(item ?? null)} is not a string, dropped`,
      );
      continue;
    }
    const term = item.trim();
    if (!term) {
      problem("empty keyterm dropped");
      continue;
    }
    if (term.length > KEYTERM_MAX) {
      problem(
        `keyterm ${quoted(term)} exceeds ${KEYTERM_MAX} characters, dropped`,
      );
      continue;
    }
    if (words(term) > KEYTERM_WORDS) {
      problem(
        `keyterm ${quoted(term)} exceeds ${KEYTERM_WORDS} words, dropped`,
      );
      continue;
    }
    out.push(term);
  }
  const room = ITEM_LIMIT - CODING_KEYTERMS.length;
  if (out.length > room) {
    out.length = room;
    problem(
      `more than ${room} keyterms (${ITEM_LIMIT} including the built-ins), extras dropped`,
    );
  }
  return out;
}

function parseReplacements(
  raw: unknown,
  problem: Problem,
): { find: string; replace: string }[] {
  const out: { find: string; replace: string }[] = [];
  if (!Array.isArray(raw)) {
    problem('"replacements" must be an array, built-ins only sent');
    return out;
  }
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = item as { find?: unknown; replace?: unknown } | undefined;
    const find = typeof entry?.find === "string" ? entry.find.trim() : "";
    const replace =
      typeof entry?.replace === "string" ? entry.replace.trim() : "";
    if (!find || !replace) {
      problem(
        `replacement ${JSON.stringify(item ?? null)} must have non-empty "find" and "replace", dropped`,
      );
      continue;
    }
    if (find.length > REPLACEMENT_MAX || replace.length > REPLACEMENT_MAX) {
      problem(
        `replacement ${quoted(find)} exceeds ${REPLACEMENT_MAX} characters, dropped`,
      );
      continue;
    }
    if (words(find) > REPLACEMENT_WORDS || words(replace) > REPLACEMENT_WORDS) {
      problem(
        `replacement ${quoted(find)} exceeds ${REPLACEMENT_WORDS} words, dropped`,
      );
      continue;
    }
    // two rules differing only in case are CONFIG_DENIED, so reject here instead
    const key = find.toLowerCase();
    if (seen.has(key)) {
      problem(
        `replacement ${quoted(find)} duplicates an existing one (case-insensitive), dropped`,
      );
      continue;
    }
    seen.add(key);
    out.push({ find, replace });
  }
  const room = ITEM_LIMIT - CODING_REPLACEMENTS.length;
  if (out.length > room) {
    out.length = room;
    problem(
      `more than ${room} replacements (${ITEM_LIMIT} including the built-ins), extras dropped`,
    );
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
  const problem = (msg: string) => problems.push(`skyr.json voice: ${msg}`);
  if (raw === undefined) return { config, problems };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problem("expected an object, section defaults used");
    return { config, problems };
  }
  const section = raw as Record<string, unknown>;
  for (const key of Object.keys(section))
    if (!(key in VOICE_DEFAULTS))
      problem(`unknown key ${quoted(key)}, ignored`);

  const { language, interims, punctuation, keyterms, replacements } = section;
  if (language !== undefined) {
    if (
      typeof language === "string" &&
      language.length <= LANGUAGE_MAX &&
      LANGUAGE.test(language)
    )
      config.language = language;
    else
      problem(
        '"language" must be a Corti locale (2–3 letters, optional -<2–8>), default "en" used',
      );
  }
  if (interims !== undefined) {
    if (typeof interims === "boolean") config.interims = interims;
    else problem('"interims" must be true or false, default true used');
  }
  if (punctuation !== undefined) {
    if (punctuation === "automatic" || punctuation === "spoken")
      config.punctuation = punctuation;
    else
      problem(
        '"punctuation" must be "automatic" or "spoken", default "automatic" used',
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
export function mergeVocabulary(config: VoiceConfig): {
  keyterms: string[];
  replacements: { find: string; replace: string }[];
} {
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
