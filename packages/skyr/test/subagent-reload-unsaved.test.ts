// A run that began but saved no session before a reload stopped it cannot be continued.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import {
  call,
  childIds,
  lanes,
  parentSession,
  results,
  scriptTurns,
  textOf,
} from "./session.js";

const runner = vi.hoisted((): { enter: () => void } => ({
  enter: () => undefined,
}));

// A runner that waits for its stop and reports no session file, as a child killed before its
// first save does.
vi.mock("../src/subagent/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/subagent/runner.js")>();
  const none = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    ...actual,
    runnerFor: () => ({
      run: async (_spec: unknown, signal: AbortSignal) => {
        runner.enter();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {
          status: "aborted" as const,
          text: undefined,
          error: undefined,
          usage: { ...none, totalTokens: 0, cost: none },
          sessionFile: undefined,
        };
      },
    }),
  };
});

test("a run that began but saved no session is not offered for continuing", async () => {
  const entered = new Promise<void>((resolve) => {
    runner.enter = resolve;
  });
  let id: string | undefined;
  let notice = "";
  const parent = await parentSession({
    respond: scriptTurns(
      () => fauxAssistantMessage("unused"),
      () => fauxAssistantMessage([call({ prompt: "bg", background: true })]),
      (context) => {
        id = childIds(context)[0];
        return fauxAssistantMessage("round one");
      },
      (context) => {
        notice =
          context.messages
            .map(textOf)
            .find((text) => text.startsWith("Background subagent answers.")) ??
          "";
        return fauxAssistantMessage([
          lanes("again", [
            { description: "again", continue: id!, prompt: "again bg" },
          ]),
        ]);
      },
    ),
  });

  await parent.session.prompt("go");
  await entered;
  await parent.session.reload();
  await parent.session.prompt("go");
  await parent.session.waitForIdle();

  expect(notice).toContain(
    "was stopped because Pi reloaded before it answered",
  );
  expect(notice).not.toContain("continue:");
  const res = results(parent.session).get("again")!;
  expect(res.isError).toBe(true);
  expect(textOf(res)).toContain(`no subagent matches "${id}"`);
});
