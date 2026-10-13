// The double-resolution preflight: which runner a call lands on, decided by the file runtime
// alone. The proc runner is stubbed out, so "selected proc" is observable without spawning.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import {
  call,
  type Parent,
  parentSession,
  results,
  router,
  taskOf,
} from "./session.js";

const proc = vi.hoisted(() => ({ runs: 0 }));

vi.mock("../src/subagent/child/proc-runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/subagent/child/proc-runner.js")
    >();
  return {
    ...actual,
    processRunner: () => {
      proc.runs += 1;
      return {
        run: async () => ({
          status: "done" as const,
          text: "PROC-RAN",
          error: undefined,
          usage: {
            input: 0,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          sessionFile: undefined,
        }),
      };
    },
  };
});

const childAnswers = (text: string) => () => fauxAssistantMessage(text);

/** Writes a file-backed provider into the test agent dir, as a child running alone would see it. */
function fileModel(
  parent: Parent,
  provider: string,
  modelId: string,
  api = "openai-completions",
): void {
  writeFileSync(
    join(parent.agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: "http://localhost:0/v1",
          api,
          apiKey: "test-key",
          models: [{ id: modelId }],
        },
      },
    }),
  );
  writeFileSync(
    join(parent.agentDir, "auth.json"),
    JSON.stringify({ [provider]: { type: "api_key", key: "test-key" } }),
  );
}

/** The parent's tool-result text for a foreground call, once the parent turn is over. */
const textOfResult = (parent: Parent, task: string) =>
  results(parent.session)
    .get(task)!
    .content.map((c) => (c.type === "text" ? c.text : ""))
    .join("");

test("a model the parent registered stays in-process: the child streams through the parent's provider", async () => {
  proc.runs = 0;
  const parent = await parentSession({
    respond: router([call({ task: "look" })], childAnswers("found")),
  });

  await parent.session.prompt("go");

  expect(parent.requests.find((r) => taskOf(r) === "look")).toBeDefined();
  expect(textOfResult(parent, "look")).toContain("found");
  expect(proc.runs).toBe(0);
});

test("a model resolvable only in the agent dir's files selects the subprocess runner", async () => {
  proc.runs = 0;
  const parent = await parentSession({
    respond: router(
      [call({ task: "filed", model: "testy/testy-1" })],
      childAnswers("unused"),
    ),
  });
  fileModel(parent, "testy", "testy-1");

  await parent.session.prompt("go");

  expect(textOfResult(parent, "filed")).toContain("PROC-RAN");
  expect(parent.requests.find((r) => taskOf(r) === "filed")).toBeUndefined();
  expect(proc.runs).toBe(1);
});

test("a model that resolves both ways stays in-process: the parent's live registration wins", async () => {
  proc.runs = 0;
  const parent = await parentSession({
    respond: router([call({ task: "shadowed" })], childAnswers("found")),
  });
  fileModel(parent, "faux", "faux-1");

  await parent.session.prompt("go");

  // Selection only: the registered native provider rules out the subprocess. The child's
  // streaming of a same-id file-configured provider is this pinned version's own stack
  // (the file apiKey does not survive the native copy) and fails before its first request;
  // the result's wording may differ at a Pi upgrade, so it is not named here.
  expect(proc.runs).toBe(0);
  const result = results(parent.session).get("shadowed")!;
  expect(result.isError).toBe(true);
  expect(parent.requests.find((r) => taskOf(r) === "shadowed")).toBeUndefined();
});

test("an unreadable models.json fails soft into the in-process runner", async () => {
  proc.runs = 0;
  const parent = await parentSession({
    respond: router([call({ task: "broken" })], childAnswers("found")),
  });
  writeFileSync(join(parent.agentDir, "models.json"), "not json at all");

  await parent.session.prompt("go");

  expect(parent.requests.find((r) => taskOf(r) === "broken")).toBeDefined();
  expect(textOfResult(parent, "broken")).toContain("found");
  expect(proc.runs).toBe(0);
});
