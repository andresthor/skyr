// The subprocess runner: the protocol, the failure taxonomy, and the stop escalation.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { processRunner } from "../src/subagent/child/proc-runner.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`fixtures/proc/${name}`, import.meta.url));

const specOf = (dir: string, id = "spec-id-1234") => ({
  id,
  cwd: dir,
  model: "faux-1",
  thinkingLevel: undefined,
  tools: ["read"],
  systemPrompt: "",
  task: "run",
  trusted: false,
  description: "run the thing",
  session: { dir, parent: join(dir, "parent.jsonl") },
});

/** A session-shaped dir, so the child's job dir lands under `<session>/jobs/<id>`. */
async function jobDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "skyr-proc-"));
  const dir = join(base, "sess");
  await mkdir(dir, { recursive: true });
  return dir;
}

test("a clean child reports verbatim through the Runner surface", async () => {
  const runner = processRunner(fixture("donefin.js"));
  const base = await mkdtemp(join(tmpdir(), "skyr-proc-"));
  const result = await runner.run(
    { ...specOf(base), session: undefined },
    new AbortController().signal,
    () => {},
  );
  expect(result.status).toBe("done");
  expect(result.text).toBe("THE ANSWER");
  expect(result.usage.input).toBe(3);
});

test("a child that dies instantly reports failed, with the exit code named", async () => {
  const runner = processRunner(fixture("crash.js"));
  const base = await mkdtemp(join(tmpdir(), "skyr-proc-"));
  let message = "";
  try {
    await runner.run(
      { ...specOf(base), session: undefined },
      new AbortController().signal,
      () => {},
    );
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("died without reporting");
});

test("SIGTERM lands: a graceful child writes its own aborted result; the job dir is cleaned", async () => {
  const runner = processRunner(fixture("hang.js"));
  const dir = await jobDir();
  const controller = new AbortController();
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  controller.abort();
  const result = await runner.run(specOf(dir), controller.signal, () => {});
  expect(result.status).toBe("aborted");
  // The job dir is removed once the child's result has been read.
  expect(existsSync(join(dir, "jobs", "spec-id-1234", "result.json"))).toBe(
    false,
  );
}, 10_000);

test("a child that ignores SIGTERM is killed on the grace timer and reported aborted", async () => {
  const runner = processRunner(fixture("silent.js"));
  const base = await mkdtemp(join(tmpdir(), "skyr-proc-"));
  const controller = new AbortController();
  controller.abort();
  const result = await runner.run(
    { ...specOf(base), session: undefined },
    controller.signal,
    () => {},
  );
  expect(result.status).toBe("aborted");
}, 15_000);

test("a child whose heartbeat stops is marked stalled, nothing kills it", async () => {
  const runner = processRunner(fixture("quiet.js"), { stalledMs: 700 });
  const dir = await jobDir();
  const events: unknown[] = [];
  const controller = new AbortController();
  const stop = setTimeout(() => controller.abort(), 1_400).unref();
  const result = await runner.run(specOf(dir), controller.signal, (e) =>
    events.push(e),
  );
  clearTimeout(stop);
  expect(result.status).toBe("aborted");
  expect(
    events.some(
      (e) => (e as { stalled?: boolean; type: string }).stalled === true,
    ),
  ).toBe(true);
}, 15_000);
