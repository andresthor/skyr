// The child body's own protocol writes, in-process: exactly `runChild`, no runner around it.

import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { expect, onTestFinished, test } from "vitest";
import { runChild } from "../src/subagent/child/main.js";

const faux = fauxProvider();
faux.setResponses(
  Array.from({ length: 50 }, () => () => fauxAssistantMessage("the answer")),
);

/** The Providers pick a child runtime copies, as the parent's registry exposes them. */
const providers = {
  getRegisteredProviderIds: () => ["faux"],
  getRegisteredNativeProvider: (id: string) =>
    id === "faux" ? faux.provider : undefined,
  getRegisteredProviderConfig: () => undefined,
};

/** A temp dir removed at the end; `session` stays off, so the child runs in memory. */
function jobDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skyr-child-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const specOf = (task = "any task inside") =>
  JSON.stringify({
    id: "child-id",
    cwd: process.cwd(),
    model: "faux-1",
    tools: [],
    task,
    trusted: false,
    description: "run the thing",
  });

const readJson = async (file: string) =>
  JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

test("a spec.json that cannot be parsed fails the child without spending a request", async () => {
  const dir = jobDir();
  await writeFile(join(dir, "spec.json"), "not json at all", "utf8");
  const result = await runChild(dir, { providers });
  expect(result.status).toBe("failed");
  expect(result.error).toBe("invalid spec: unreadable spec.json");
  expect(result.description).toBe("");
  expect(result.v).toBe(1);
  expect(result.usage.totalTokens).toBe(0);
  // An unreadable spec short-circuits before the protocol writes: nothing lands on disk, so
  // a spawned parent reads the failure from the exit code, not from result.json.
  await expect(readFile(join(dir, "result.json"), "utf8")).rejects.toThrow();
});

test("a spec.json of the wrong shape fails the child with the bad field named, without spending a request", async () => {
  const dir = jobDir();
  await writeFile(
    join(dir, "spec.json"),
    JSON.stringify({ ...JSON.parse(specOf()), trusted: "yes" }),
    "utf8",
  );
  const result = await runChild(dir, { providers });
  expect(result.status).toBe("failed");
  expect(result.error).toBe("invalid spec: missing trusted");
  expect(faux.state.callCount).toBe(0);
});

test("a clean run writes the heartbeat counters and then result.json on disk, with the stored shape", async () => {
  const dir = jobDir();
  await writeFile(join(dir, "spec.json"), specOf(), "utf8");
  const result = await runChild(dir, { providers });
  expect(result.status).toBe("done");
  expect(result.text).toBe("the answer");
  expect(result.description).toBe("run the thing");
  expect(result.v).toBe(1);
  expect(result.usage.output).toBeGreaterThan(0);
  expect(result.sessionFile).toBeUndefined();

  const snap = await readJson(join(dir, "activity.json"));
  expect(snap).toMatchObject({ v: 1, id: "child-id", turns: 1 });
  expect(snap.tokens).toBeGreaterThan(0);
  expect(snap.now).toBeGreaterThanOrEqual(snap.startedAt as number);
  expect(snap.activity).toBeUndefined();

  const stored = await readJson(join(dir, "result.json"));
  expect(stored).toMatchObject({
    v: 1,
    status: "done",
    text: "the answer",
    description: "run the thing",
  });
  expect(stored.error).toBeUndefined();
});

test("a result.json that cannot be written becomes a failed child that says why", async () => {
  const dir = jobDir();
  await writeFile(join(dir, "spec.json"), specOf(), "utf8");
  // A directory holding the result's name defeats the write, in a way no run could fix.
  await mkdir(join(dir, "result.json"));
  const result = await runChild(dir, { providers });
  expect(result.status).toBe("failed");
  expect(result.error).toContain("could not write result.json");
});
