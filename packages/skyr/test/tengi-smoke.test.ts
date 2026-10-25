// This package loaded by Pi inside tengi, driven over ACP as a client would: ask_user's forms and
// the subagent task list end to end. Local only: set SKYR_TENGI_DIR to a tengi checkout with its
// Pi installed (`npm run pi:install` there), or the whole file skips.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { isRecord as isObj } from "../src/tengi.js";
import FIXTURE from "./fixtures/ask-user-form.json";
import {
  clientCapabilities,
  startTengi,
  TENGI_DIR,
  type Tengi,
} from "./tengi-host.js";

const ASK = `@tool ${JSON.stringify({ name: "ask_user", args: { questions: FIXTURE.questions } })}`;
const TIMEOUT = 30_000;

async function newSession(
  tengi: Tengi,
  caps = clientCapabilities(),
): Promise<string> {
  await tengi.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: caps,
  });
  const response = await tengi.request("session/new", {
    cwd: tengi.cwd,
    mcpServers: [],
  });
  if (!isObj(response) || typeof response.sessionId !== "string")
    throw new Error("session/new did not answer with a sessionId");
  return response.sessionId;
}

const prompt = (tengi: Tengi, sessionId: string, text: string) =>
  tengi.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }],
  });

const formsAsked = (tengi: Tengi) =>
  tengi.records.filter(
    (r) =>
      r.dir === "agent->client" &&
      isObj(r.msg) &&
      r.msg.method === "elicitation/create",
  ).length;

/** The tool names the faux model reads from its own request, which the wire does not show. */
async function declaredTools(tengi: Tengi, sessionId: string) {
  await prompt(tengi, sessionId, "@tools");
  // The reply streams in chunks, one text block per update
  const text = tengi.records
    .map(({ msg }) => {
      const update =
        isObj(msg) && isObj(msg.params) ? msg.params.update : undefined;
      const content = isObj(update) ? update.content : undefined;
      return isObj(content) && typeof content.text === "string"
        ? content.text
        : "";
    })
    .join("");
  const names = /declared tools: (\S*)/.exec(text)?.[1];
  if (names === undefined) throw new Error("no declared-tools reply");
  return names.split(",");
}

function taskItems(update: unknown): unknown[] | undefined {
  const meta = isObj(update) ? update._meta : undefined;
  const tasks = isObj(meta) ? meta["agentui/tasks"] : undefined;
  return isObj(tasks) && Array.isArray(tasks.items) ? tasks.items : undefined;
}

describe.skipIf(TENGI_DIR === undefined)("inside tengi", () => {
  test(
    "a question asked through ask_user reaches the client as one form, and the picked label comes back",
    async () => {
      const tengi = startTengi();
      const sessionId = await newSession(tengi);
      tengi.expectForm({ question_0: "1" });

      expect(await prompt(tengi, sessionId, ASK)).toEqual({
        stopReason: "end_turn",
      });
      expect(formsAsked(tengi)).toBe(1);
      const completed = tengi.records.filter(({ msg }) => {
        const update =
          isObj(msg) && isObj(msg.params) ? msg.params.update : undefined;
        return (
          isObj(update) &&
          update.sessionUpdate === "tool_call_update" &&
          update.status === "completed" &&
          JSON.stringify(update.content).includes("-> Postgres")
        );
      });
      expect(completed).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    "every UI member still works with this package loaded",
    async () => {
      const tengi = startTengi();
      const sessionId = await newSession(tengi);
      // select, confirm, input and editor, in the probe's order
      tengi.expectForm({ value: "0" });
      tengi.expectForm({ confirmed: true });
      tengi.expectForm({ value: "ok" });
      tengi.expectForm({ value: "edited" });

      expect(await prompt(tengi, sessionId, "/probe-ui-all")).toEqual({
        stopReason: "end_turn",
      });
      expect(formsAsked(tengi)).toBe(4);
      const probed = tengi
        .probeLog()
        .filter((rec) => isObj(rec) && "member" in rec);
      expect(probed).toHaveLength(28);
      expect(probed.filter((rec) => isObj(rec) && rec.ok !== true)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "after a reload, ask_user still asks exactly one form per call",
    async () => {
      const tengi = startTengi();
      const sessionId = await newSession(tengi);
      const loads = () =>
        tengi.probeLog().filter((rec) => isObj(rec) && rec.loaded === true)
          .length;
      tengi.expectForm({ question_0: "0" });
      await prompt(tengi, sessionId, ASK);
      expect(formsAsked(tengi)).toBe(1);

      const before = loads();
      await prompt(tengi, sessionId, "/probe-reload");
      expect(loads()).toBe(before + 1);
      tengi.expectForm({ question_0: "0" });
      expect(await prompt(tengi, sessionId, ASK)).toEqual({
        stopReason: "end_turn",
      });
      expect(formsAsked(tengi)).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "ask_user is offered to a client with form support and hidden from one without",
    async () => {
      const withForms = startTengi();
      expect(
        await declaredTools(withForms, await newSession(withForms)),
      ).toContain("ask_user");

      const without = startTengi();
      const sessionId = await newSession(
        without,
        clientCapabilities({ elicitation: undefined }),
      );
      const declared = await declaredTools(without, sessionId);
      expect(declared).toContain("read");
      expect(declared).not.toContain("ask_user");
    },
    TIMEOUT,
  );

  test(
    "a running subagent shows as one task in the client, and the list empties when it ends",
    async () => {
      const tengi = startTengi();
      const sessionId = await newSession(
        tengi,
        clientCapabilities({ _meta: { agentui: { version: 1, tasks: true } } }),
      );
      // The child's shell waits for this file, so the test decides when the run ends
      const gate = join(tengi.out, "release");
      // Pi's bash runs detached, so a failed assertion must still end the child's shell
      onTestFinished(() => writeFileSync(gate, ""));
      const task = `@bash ${JSON.stringify({ command: `until [ -e '${gate}' ]; do sleep 0.1; done` })}`;
      const turn = prompt(
        tengi,
        sessionId,
        `@tool ${JSON.stringify({ name: "subagent", args: { description: "hold for the test", task } })}`,
      );

      const running = await tengi.nextUpdate((u) => taskItems(u)?.length === 1);
      expect(taskItems(running)?.[0]).toMatchObject({
        id: expect.stringMatching(/^skyr\/subagents\//),
        title: '"hold for the test"',
        status: "running",
      });

      writeFileSync(gate, "");
      expect(await turn).toEqual({ stopReason: "end_turn" });
      await tengi.nextUpdate((u) => taskItems(u)?.length === 0);
    },
    TIMEOUT,
  );
});
