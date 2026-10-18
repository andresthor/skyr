/**
 * The skyr.json mechanics and the voice section's validation, through the public functions:
 * a broken user file must never throw, a broken section must degrade per field, and the
 * case-insensitive replacement trap must be caught here — never as CONFIG_DENIED live.
 */
import { writeFileSync } from "node:fs";
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
  expect(problems).toEqual(['skyr.json: unknown section "voicee", ignored']);
});

test("readSkyrFile: a section for a module with no settings is reported, not silently accepted", () => {
  const { data, problems } = readSkyrFile(
    agentDir('{"webSearch":{"maxResults":5},"subagent":{}}'),
  );
  expect(data).toEqual({});
  expect(problems).toEqual([
    'skyr.json: unknown section "webSearch", ignored',
    'skyr.json: unknown section "subagent", ignored',
  ]);
});

test("readSkyrFile: a non-object file degrades to defaults with one problem", () => {
  const { data, problems } = readSkyrFile(agentDir("[1,2]"));
  expect(data).toEqual({});
  expect(problems).toEqual([
    "skyr.json: expected an object with one key per module",
  ]);
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
    "skyr.json voice: expected an object, section defaults used",
  ]);
});

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
  expect(problems[0]).toMatch(/"replacements" must be an array/);
});

test("unknown keys inside the section are named and ignored", () => {
  const { config, problems } = parseVoiceSection({
    language: "da",
    colors: [],
  });
  expect(config.language).toBe("da");
  expect(problems).toEqual(['skyr.json voice: unknown key "colors", ignored']);
});

test("language accepts Corti locale forms and rejects the rest", () => {
  const good = ["en", "da", "gsw-CH", "en-US"];
  for (const value of good)
    expect(parseVoiceSection({ language: value }).problems).toEqual([]);
  for (const value of ["english", "en--US", "x", "en_US"])
    expect(parseVoiceSection({ language: value }).problems).toHaveLength(1);
});

test("keyterms exceeding Corti's per-term caps are dropped by name", () => {
  const long = "a".repeat(51);
  const wide = "one two three four five six";
  const { config, problems } = parseVoiceSection({
    keyterms: ["typescript", 5, "", long, wide],
  });
  expect(config.keyterms).toEqual(["typescript"]);
  expect(problems).toHaveLength(4);
});
test("replacements exceeding Corti's per-rule caps are dropped by name", () => {
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
  expect(problems).toHaveLength(5);
  expect(problems.some((p) => p.includes("duplicates an existing one"))).toBe(
    true,
  );
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
  expect(problems).toHaveLength(2);
});

test("more than 975 keyterms (1,000 minus the built-ins) is cut with one problem", () => {
  const many = Array.from({ length: 1000 }, (_, i) => `term ${i}`);
  const { config, problems } = parseVoiceSection({ keyterms: many });
  expect(config.keyterms).toHaveLength(975);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/975 keyterms/);
});

test("more than 995 replacements is cut with one problem", () => {
  const many = Array.from({ length: 1010 }, (_, i) => ({
    find: `find ${i}`,
    replace: `replace ${i}`,
  }));
  const { config, problems } = parseVoiceSection({ replacements: many });
  expect(config.replacements).toHaveLength(995);
  expect(problems).toHaveLength(1);
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
