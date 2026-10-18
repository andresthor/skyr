/**
 * The skyr.json mechanics and the voice section's validation, through the public functions:
 * a broken user file must never throw, a broken section must degrade per field, and the
 * case-insensitive replacement trap must be caught here — never as CONFIG_DENIED live.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readSkyrFile } from "../src/config.js";
import {
  CODING_KEYTERMS,
  CODING_REPLACEMENTS,
  mergeVocabulary,
  parseVoiceSection,
  VOICE_DEFAULTS,
} from "../src/voice/config.js";
import { scratchDir } from "./session.js";

function agentDir(file?: string): string {
  const dir = scratchDir("agent");
  if (file !== undefined) writeFileSync(join(dir, "skyr.json"), file);
  return dir;
}

test("readSkyrFile: a missing file is just defaults", () => {
  const { data, problems } = readSkyrFile(agentDir());
  expect(data).toEqual({});
  expect(problems).toEqual([]);
});

test("readSkyrFile: malformed JSON never throws, names the reason, and keeps startup alive", () => {
  for (const text of ['{"voice":', "not json", "", "null"] as const) {
    const { data, problems } = readSkyrFile(agentDir(text));
    expect(data).toEqual({});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^skyr\.json/);
  }
});

test("readSkyrFile: a mis-spelled section name is reported, not silently dropped", () => {
  const { data, problems } = readSkyrFile(
    agentDir('{"voicee":{"language":"da"},"voice":{}}'),
  );
  expect(data).toEqual({ voice: {} });
  expect(problems).toEqual([
    'skyr.json: "voicee" is not a section; ignored (sections: voice)',
  ]);
});

test("readSkyrFile: a section for a module with no settings is reported, not silently accepted", () => {
  const { data, problems } = readSkyrFile(
    agentDir('{"webSearch":{"maxResults":5},"subagent":{}}'),
  );
  expect(data).toEqual({});
  expect(problems).toEqual([
    'skyr.json: "webSearch" is not a section; ignored (sections: voice)',
    'skyr.json: "subagent" is not a section; ignored (sections: voice)',
  ]);
});

test("readSkyrFile: a non-object file degrades to defaults with one problem", () => {
  const { data, problems } = readSkyrFile(agentDir("[1,2]"));
  expect(data).toEqual({});
  expect(problems).toEqual([
    "skyr.json: must be an object with one key per module; using defaults",
  ]);
});

test("readSkyrFile: an unreadable file names the errno, never the whole path", () => {
  // ENOENT is the missing-file path; a permissions failure echoes the agent dir in its
  // message, which the problem string must not carry to the TUI
  const dir = agentDir('{"voice":{}}');
  chmodSync(join(dir, "skyr.json"), 0o000);
  const { data, problems } = readSkyrFile(dir);
  expect(data).toEqual({});
  expect(problems).toEqual(["skyr.json: can't read (EACCES); using defaults"]);
  chmodSync(join(dir, "skyr.json"), 0o644);
});

test("an absent section parses to the defaults with no problems", () => {
  expect(parseVoiceSection(undefined)).toEqual({
    config: VOICE_DEFAULTS,
    problems: [],
  });
});

test("a wrong-typed section degrades whole to defaults", () => {
  const { config, problems } = parseVoiceSection("en");
  expect(config).toEqual(VOICE_DEFAULTS);
  expect(problems).toEqual([
    "skyr.json: voice must be an object; using defaults",
  ]);
});

test.each([
  [
    "language",
    "english",
    'voice.language must be a locale like "en" or "en-US"; using "en"',
  ],
  ["interims", "yes", "voice.interims must be true or false; using true"],
  [
    "punctuation",
    "sometimes",
    'voice.punctuation must be "automatic" or "spoken"; using "automatic"',
  ],
  [
    "keyterms",
    "wrong",
    "voice.keyterms must be an array; sending the built-in terms only",
  ],
])(
  "a wrong-typed %s drops to its default with the fallback named",
  (key, value, problem) => {
    const { config, problems } = parseVoiceSection({ [key]: value });
    expect(problems).toEqual([`skyr.json: ${problem}`]);
    for (const setting of Object.keys(config))
      expect(config[setting as keyof typeof config]).toEqual(
        VOICE_DEFAULTS[setting as keyof typeof VOICE_DEFAULTS],
      );
  },
);

test("fields coerce per field: a 4/5-valid section keeps its 4/5", () => {
  const { config, problems } = parseVoiceSection({
    language: "da-DK",
    interims: false,
    punctuation: "spoken",
    keyterms: ["Skýr"],
    replacements: "wrong",
  });
  expect(problems).toHaveLength(1);
  expect(config).toEqual({
    language: "da-DK",
    interims: false,
    punctuation: "spoken",
    keyterms: ["Skýr"],
    replacements: [],
  });
  expect(problems[0]).toBe(
    "skyr.json: voice.replacements must be an array; sending the built-in rules only",
  );
});

test("unknown keys inside the section are named, and what exists is listed", () => {
  const { config, problems } = parseVoiceSection({
    language: "da",
    colors: [],
  });
  expect(config.language).toBe("da");
  expect(problems).toEqual([
    "skyr.json: voice.colors is not a setting; ignored (settings: language, interims, punctuation, keyterms, replacements)",
  ]);
});

test("language accepts Corti locale forms and rejects the rest", () => {
  const good = ["en", "da", "gsw-CH", "en-US"];
  for (const value of good)
    expect(parseVoiceSection({ language: value }).problems).toEqual([]);
  for (const value of ["english", "en--US", "x", "en_US"])
    expect(parseVoiceSection({ language: value }).problems).toEqual([
      'skyr.json: voice.language must be a locale like "en" or "en-US"; using "en"',
    ]);
});

test("keyterms exceeding Corti's per-term caps are dropped by position", () => {
  const long = "a".repeat(51);
  const wide = "one two three four five six";
  const { config, problems } = parseVoiceSection({
    keyterms: ["typescript", 5, "", long, wide],
  });
  expect(config.keyterms).toEqual(["typescript"]);
  expect(problems).toEqual([
    "skyr.json: voice.keyterms[1] is not a string; dropped",
    "skyr.json: voice.keyterms[2] is empty; dropped",
    `skyr.json: voice.keyterms[3] "${long.slice(0, 40)}…" is over 50 characters; dropped`,
    `skyr.json: voice.keyterms[4] "${wide}" is over 5 words; dropped`,
  ]);
});
test("replacements exceeding Corti's per-rule caps are dropped by position", () => {
  const { config, problems } = parseVoiceSection({
    replacements: [
      { find: "vitist", replace: "vitest" },
      { find: "", replace: "x" },
      { find: "a b c d e f g h i j k", replace: "x" },
      { find: "y", replace: "a".repeat(101) },
      { find: 5 },
      { find: "dup", replace: "dup" },
      { find: "DUP", replace: "other" },
    ],
  });
  expect(config.replacements).toEqual([
    { find: "vitist", replace: "vitest" },
    { find: "dup", replace: "dup" },
  ]);
  expect(problems).toEqual([
    'skyr.json: voice.replacements[1] needs a non-empty "find" and "replace"; dropped',
    'skyr.json: voice.replacements[2] "a b c d e f g h i j k" is over 10 words; dropped',
    'skyr.json: voice.replacements[3] "y" is over 100 characters; dropped',
    'skyr.json: voice.replacements[4] needs a non-empty "find" and "replace"; dropped',
    'skyr.json: voice.replacements[6] repeats the find "DUP" (ignoring case); dropped',
  ]);
});

test("case-insensitive duplicate replacements are rejected at the validator, not by the server", () => {
  const { config, problems } = parseVoiceSection({
    replacements: [
      { find: "get hub", replace: "GitHub" },
      { find: "Get Hub", replace: "gethub" },
      { find: "GET HUB", replace: "gethub" },
    ],
  });
  expect(config.replacements).toHaveLength(1);
  expect(problems).toEqual([
    'skyr.json: voice.replacements[1] repeats the find "Get Hub" (ignoring case); dropped',
    'skyr.json: voice.replacements[2] repeats the find "GET HUB" (ignoring case); dropped',
  ]);
});

test("more than 975 keyterms (1,000 minus the built-ins) is cut with one problem", () => {
  const many = Array.from({ length: 1000 }, (_, i) => `term ${i}`);
  const { config, problems } = parseVoiceSection({ keyterms: many });
  expect(config.keyterms).toHaveLength(975);
  expect(problems).toEqual([
    "skyr.json: voice.keyterms has over 975 entries; the rest dropped",
  ]);
});

test("more than 995 replacements is cut with one problem", () => {
  const many = Array.from({ length: 1010 }, (_, i) => ({
    find: `find ${i}`,
    replace: `replace ${i}`,
  }));
  const { config, problems } = parseVoiceSection({ replacements: many });
  expect(config.replacements).toHaveLength(995);
  expect(problems).toEqual([
    "skyr.json: voice.replacements has over 995 entries; the rest dropped",
  ]);
});

test("mergeVocabulary appends the user terms over the built-ins, built-ins winning case dups", () => {
  const config = {
    ...VOICE_DEFAULTS,
    keyterms: ["npm", "Skýr"],
    replacements: [
      { find: "async await", replace: "duplicating" },
      { find: "vitst", replace: "vitest" },
    ],
  };
  const merged = mergeVocabulary(config);
  expect(merged.keyterms).toEqual([...CODING_KEYTERMS, "Skýr"]);
  expect(merged.replacements.map((r) => r.find)).toEqual([
    ...CODING_REPLACEMENTS.map((r) => r.find),
    "vitst",
  ]);
});

test("mergeVocabulary leaves count and content untouched when the user adds nothing", () => {
  expect(mergeVocabulary(VOICE_DEFAULTS)).toEqual({
    keyterms: [...CODING_KEYTERMS],
    replacements: [...CODING_REPLACEMENTS],
  });
});
