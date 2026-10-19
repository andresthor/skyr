/**
 * The `skyr.json` file reader: a broken user file never throws, names what it couldn't read,
 * leaves Pi's startup alive with defaults, and is reported once per session whatever reads it.
 * Each module validates and reports its own section (the voice one: voice-config.test.ts).
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, onTestFinished, test } from "vitest";
import { readSkyrFile } from "../src/config.js";
import { parentSession, scratchDir } from "./session.js";

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
      'skyr.json: "voicee" is not a section; ignored (sections: voice, advisor)',
    ]);
  });

  test("a section for a module with no settings is reported, not silently accepted", () => {
    const { data, problems } = readSkyrFile(
      agentDir('{"webSearch":{"maxResults":5},"subagent":{}}'),
    );
    expect(data).toEqual({});
    expect(problems).toEqual([
      'skyr.json: "webSearch" is not a section; ignored (sections: voice, advisor)',
      'skyr.json: "subagent" is not a section; ignored (sections: voice, advisor)',
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

describe("reporting", () => {
  const answer = () => fauxAssistantMessage("done");

  test("a broken skyr.json is reported at session start, with voice off for want of credentials", async () => {
    const parent = await parentSession({ respond: answer, skyr: '{"voice":' });
    expect(parent.notices).toHaveLength(1);
    expect(parent.notices[0]).toMatch(
      /^skyr\.json: not valid JSON \(.*\); using defaults$/,
    );
  });

  test("with voice on, the file's problems and the voice section's are each reported once", async () => {
    // Voice reads its section only with credentials.
    const creds = {
      CORTI_ENVIRONMENT: "eu",
      CORTI_TENANT_NAME: "tenant",
      CORTI_CLIENT_ID: "client",
      CORTI_CLIENT_SECRET: "secret",
    };
    const previous = Object.keys(creds).map(
      (k) => [k, process.env[k]] as const,
    );
    Object.assign(process.env, creds);
    onTestFinished(() => {
      for (const [key, value] of previous)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
    const parent = await parentSession({
      respond: answer,
      skyr: { voicee: {}, voice: { frobnicate: true } },
    });
    expect([...parent.notices].sort()).toEqual([
      'skyr.json: "voicee" is not a section; ignored (sections: voice, advisor)',
      expect.stringMatching(
        /^skyr\.json: voice\."frobnicate" is not a setting; ignored/,
      ),
    ]);
  });
});
