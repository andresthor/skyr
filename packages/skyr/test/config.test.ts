/**
 * The `skyr.json` file reader: a broken user file never throws, names what it couldn't read,
 * and leaves Pi's startup alive with defaults. This file owns location and JSON structure
 * only; each module validates its own section (the voice one: voice-config.test.ts).
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readSkyrFile } from "../src/config.js";
import { scratchDir } from "./session.js";

function agentDir(file?: string): string {
  const dir = scratchDir("agent");
  if (file !== undefined) writeFileSync(join(dir, "skyr.json"), file);
  return dir;
}

describe("readSkyrFile", () => {
  test("a missing file is just defaults", () => {
    const { data, problems } = readSkyrFile(agentDir());
    expect(data).toEqual({});
    expect(problems).toEqual([]);
  });

  test("malformed JSON never throws, names the reason, and keeps startup alive", () => {
    for (const text of ['{"voice":', "not json", "", "null"] as const) {
      const { data, problems } = readSkyrFile(agentDir(text));
      expect(data).toEqual({});
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^skyr\.json/);
    }
  });

  test("a mis-spelled section name is reported, not silently dropped", () => {
    const { data, problems } = readSkyrFile(
      agentDir('{"voicee":{"language":"da"},"voice":{}}'),
    );
    expect(data).toEqual({ voice: {} });
    expect(problems).toEqual([
      'skyr.json: "voicee" is not a section; ignored (sections: voice)',
    ]);
  });

  test("a section for a module with no settings is reported, not silently accepted", () => {
    const { data, problems } = readSkyrFile(
      agentDir('{"webSearch":{"maxResults":5},"subagent":{}}'),
    );
    expect(data).toEqual({});
    expect(problems).toEqual([
      'skyr.json: "webSearch" is not a section; ignored (sections: voice)',
      'skyr.json: "subagent" is not a section; ignored (sections: voice)',
    ]);
  });

  test("a non-object file degrades to defaults with one problem", () => {
    const { data, problems } = readSkyrFile(agentDir("[1,2]"));
    expect(data).toEqual({});
    expect(problems).toEqual([
      "skyr.json: must be an object with one key per module; using defaults",
    ]);
  });

  test("an unreadable file names the errno, never the whole path", () => {
    // ENOENT is the missing-file path; a permissions failure echoes the agent dir in its
    // message, which the problem string must not carry to the TUI
    const dir = agentDir('{"voice":{}}');
    chmodSync(join(dir, "skyr.json"), 0o000);
    const { data, problems } = readSkyrFile(dir);
    expect(data).toEqual({});
    expect(problems).toEqual([
      "skyr.json: can't read (EACCES); using defaults",
    ]);
    chmodSync(join(dir, "skyr.json"), 0o644);
  });
});
