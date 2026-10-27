// This package loaded by Pi inside tengi, driven over ACP as a client would: ask_user's forms,
// reload, and the task lists and idle delivery of subagents and background shells. Local only:
// set SKYR_TENGI_DIR to a tengi checkout with its Pi installed (`npm run pi:install` there), or
// the whole file skips.
import { describe, expect, test } from "vitest";
import FIXTURE from "./fixtures/ask-user-form.json";
import { startTengi, TENGI_DIR, tool } from "./tengi-host.js";

const ASK = tool("ask_user", { questions: FIXTURE.questions });
const TIMEOUT = 30_000;

describe.skipIf(TENGI_DIR === undefined)("inside tengi", () => {
  test(
    "ask_user is offered, asks exactly one form per call before and after a reload, and returns the picked label",
    async () => {
      const tengi = startTengi();
      await tengi.session();
      expect(await tengi.declaredTools()).toContain("ask_user");

      tengi.expectForm({ question_0: "1" });
      await tengi.prompt(ASK);
      expect(tengi.formsAsked()).toBe(1);
      expect(
        tengi.toolResults().filter(({ text }) => text.includes("Postgres")),
      ).toHaveLength(1);

      const loads = tengi.loads();
      await tengi.prompt("/probe-reload");
      expect(tengi.loads()).toBe(loads + 1);
      tengi.expectForm({ question_0: "0" });
      await tengi.prompt(ASK);
      expect(tengi.formsAsked()).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "ask_user is hidden from a client without form support",
    async () => {
      const tengi = startTengi();
      await tengi.session({ forms: false });
      const declared = await tengi.declaredTools();
      expect(declared).toContain("read");
      expect(declared).not.toContain("ask_user");
    },
    TIMEOUT,
  );

  test(
    "a running subagent shows as one task in the client, and the list empties when it ends",
    async () => {
      const tengi = startTengi();
      await tengi.session({ tasks: true });
      const gate = tengi.gate("release");
      const turn = tengi.prompt(
        tool("subagent", {
          tasks: [
            {
              description: "hold for the test",
              prompt: tool("bash", { command: gate.command }),
            },
          ],
        }),
      );

      const [task] = await tengi.nextTasks((items) => items.length === 1);
      expect(task).toMatchObject({
        id: expect.stringMatching(/^skyr\/subagents\//),
        status: "running",
      });

      gate.release();
      await turn;
      await tengi.nextTasks((items) => items.length === 0);
    },
    TIMEOUT,
  );

  test(
    "a background subagent card carries no `agentui/exit`",
    async () => {
      const tengi = startTengi();
      await tengi.session({ tasks: true });
      const gate = tengi.gate("release");
      await tengi.prompt(
        tool("subagent", {
          tasks: [
            {
              description: "hold for the test",
              prompt: tool("bash", { command: gate.command }),
            },
          ],
          background: true,
        }),
      );

      await tengi.nextTasks((items) => items.length === 1);
      const [card] = tengi.toolResults();
      expect(card?.text).toContain("started 1 task in the background");
      expect(card?.meta).not.toHaveProperty(["agentui/exit"]);

      gate.release();
      await tengi.nextTasks((items) => items.length === 0);
      await tengi.agentSaid("quick reply");
    },
    TIMEOUT,
  );

  test(
    "a running background shell shows as one task, and its end empties the list and starts a turn",
    async () => {
      const tengi = startTengi();
      await tengi.session({ tasks: true });
      const gate = tengi.gate("release");
      await tengi.prompt(
        tool("bash", { command: gate.command, background: true }),
      );

      const [job] = await tengi.nextTasks((items) => items.length === 1);
      expect(job).toMatchObject({
        id: expect.stringMatching(/^skyr\/shells\//),
        status: "running",
      });
      // The call's card points at that task, so the client shows it handed off, not exited
      const [moved] = tengi.toolResults();
      expect(moved?.meta["agentui/task"]).toEqual({
        id: (job as { id: unknown }).id,
      });
      expect(moved?.meta).not.toHaveProperty(["agentui/exit"]);

      gate.release();
      await tengi.nextTasks((items) => items.length === 0);
      // The tool turn closed with other text; only a turn the job's end starts says this
      await tengi.agentSaid("quick reply");
    },
    TIMEOUT,
  );
});
