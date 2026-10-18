/**
 * The voice section of `skyr.json`, through the public reader: a broken section never
 * throws, a broken field degrades alone, and the case-insensitive replacement trap is caught
 * here — never as CONFIG_DENIED live. The file itself is read by `src/config.ts`
 * (config.test.ts); credentials stay in env.
 */
import { describe, expect, test } from "vitest";
import { parseVoiceSection } from "../src/voice/config.js";

/** What Corti gets when the user sets nothing: the defaults and the built-in coding vocabulary. */
const DEFAULTS = parseVoiceSection(undefined).config;

describe("parseVoiceSection", () => {
  test("an absent section gives the defaults with no problems", () => {
    expect(parseVoiceSection(undefined).problems).toEqual([]);
    expect(DEFAULTS).toMatchObject({
      language: "en",
      interims: true,
      punctuation: "automatic",
    });
  });

  test("a wrong-typed section degrades whole to defaults", () => {
    const { config, problems } = parseVoiceSection("en");
    expect(config).toEqual(DEFAULTS);
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
      expect(config).toEqual(DEFAULTS);
    },
  );

  test("one wrong field falls back to its default; the others keep their values", () => {
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
      keyterms: [...DEFAULTS.keyterms, "Skýr"],
      replacements: DEFAULTS.replacements,
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

  test("names inherited from Object are not settings either", () => {
    const { problems } = parseVoiceSection({ toString: 1, constructor: 2 });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(
      /^skyr\.json: voice\.toString is not a setting/,
    );
  });

  test.each(["en", "da", "gsw-CH", "en-US"])(
    "language %s matches Corti's locale forms, so it is kept",
    (value) => {
      expect(parseVoiceSection({ language: value }).problems).toEqual([]);
    },
  );

  test.each(["english", "en--US", "x", "en_US"])(
    'language %s is not a locale like "en" or "en-US", so the default is named',
    (value) => {
      expect(parseVoiceSection({ language: value }).problems).toEqual([
        'skyr.json: voice.language must be a locale like "en" or "en-US"; using "en"',
      ]);
    },
  );

  test("keyterms exceeding Corti's per-term caps are dropped by position", () => {
    const long = "a".repeat(51);
    const wide = "one two three four five six";
    const { config, problems } = parseVoiceSection({
      keyterms: ["Skýr", 5, "", long, wide],
    });
    expect(config.keyterms).toEqual([...DEFAULTS.keyterms, "Skýr"]);
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
        { find: "teh", replace: "the" },
        { find: "", replace: "x" },
        { find: "a b c d e f g h i j k", replace: "x" },
        { find: "y", replace: "a".repeat(101) },
        { find: 5 },
        { find: "dup", replace: "dup" },
        { find: "DUP", replace: "other" },
      ],
    });
    expect(config.replacements).toEqual([
      ...DEFAULTS.replacements,
      { find: "teh", replace: "the" },
      { find: "dup", replace: "dup" },
    ]);
    expect(problems).toEqual([
      'skyr.json: voice.replacements[1] needs a non-empty "find" and "replace"; dropped',
      'skyr.json: voice.replacements[2].find "a b c d e f g h i j k" is over 10 words; dropped',
      `skyr.json: voice.replacements[3].replace "${"a".repeat(40)}…" is over 100 characters; dropped`,
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
    // the first stands, in place of the built-in rule with the same find
    expect(
      config.replacements.filter((r) => r.find.toLowerCase() === "get hub"),
    ).toEqual([{ find: "get hub", replace: "GitHub" }]);
    expect(problems).toEqual([
      'skyr.json: voice.replacements[1] repeats the find "Get Hub" (ignoring case); dropped',
      'skyr.json: voice.replacements[2] repeats the find "GET HUB" (ignoring case); dropped',
    ]);
  });

  test.each(["keyterms", "replacements"] as const)(
    "a flood of user %s is cut so what reaches Corti never exceeds its 1,000",
    (key) => {
      const entries =
        key === "keyterms"
          ? Array.from({ length: 1000 }, (_, i) => `term ${i}`)
          : Array.from({ length: 1010 }, (_, i) => ({
              find: `find ${i}`,
              replace: `replace ${i}`,
            }));
      const { config, problems } = parseVoiceSection({ [key]: entries });
      // the parser leaves room for the built-ins, so the merged list lands exactly on the cap
      const room = 1000 - DEFAULTS[key].length;
      expect(problems).toEqual([
        `skyr.json: voice.${key} has over ${room} entries; the rest dropped`,
      ]);
      expect(config[key]).toHaveLength(1000);
    },
  );
});

describe("the built-in vocabulary", () => {
  test("a user term or rule replaces the built-in it matches, in either case", () => {
    const { config: merged } = parseVoiceSection({
      keyterms: ["Skýr", "NPM"],
      replacements: [
        { find: "type script", replace: "TS!" }, // the built-in's letters, all lower
        { find: "get hub", replace: "GH" }, // the built-in's find, all lower
        { find: "vitst", replace: "vitest" },
      ],
    });
    expect(merged.keyterms).toContain("NPM");
    expect(merged.keyterms).not.toContain("npm");
    expect(merged.keyterms).toContain("Skýr");
    expect(merged.keyterms).toHaveLength(DEFAULTS.keyterms.length + 1);
    expect(merged.replacements).toContainEqual({
      find: "type script",
      replace: "TS!",
    });
    expect(merged.replacements).toContainEqual({
      find: "get hub",
      replace: "GH",
    });
    expect(merged.replacements).not.toContainEqual({
      find: "Get Hub",
      replace: "GitHub",
    });
    // one-for-one: every replacement removed a built-in instead of growing the list,
    // so the merged counts stay inside Corti's 1,000 cap
    expect(merged.replacements).toHaveLength(DEFAULTS.replacements.length + 1);
  });

  test("with nothing from the user, the built-in coding vocabulary goes to Corti", () => {
    expect(DEFAULTS.keyterms).toContain("pnpm");
    expect(DEFAULTS.replacements).toContainEqual({
      find: "vitist",
      replace: "vitest",
    });
  });

  test("the built-in vocabulary stays inside what Corti accepts: short terms, finds unique in any case", () => {
    for (const term of DEFAULTS.keyterms) {
      expect(term.length).toBeLessThanOrEqual(50);
      expect(term.split(/\s+/).length).toBeLessThanOrEqual(5);
    }
    const finds = DEFAULTS.replacements.map((r) => r.find.toLowerCase());
    expect(new Set(finds).size).toBe(finds.length);
  });
});
