// Continuing a child by id: a second run on the finished child's saved session.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import {
  agentFile,
  CHILD_ID,
  call,
  childIds,
  hold,
  lanes,
  type Parent,
  parentSession,
  results,
  scratchDir,
  scriptTurns,
  sections,
  taskOf,
  textOf,
  toolsSeen,
} from "./session.js";

const SCOUT = {
  "scout.md": agentFile("Finds things", "model: faux-2\n"),
};

/** A continue call: tool-call id = its task, so results are looked up by task. */
const cont = (task: string, prefix: string) =>
  lanes(task, [
    {
      description: `continue ${task}`,
      continue: prefix,
      task: `again ${task}`,
    },
  ]);

/** One child request's view: tools, model, full transcript text, sections. */
interface Observed {
  tools: string[];
  model: string;
  history: string;
  sections: Record<string, string | null>;
}
/** A hold routed only to the resumed child: its transcript contains the second task text. */
function resumedGate(
  secondTask: string,
  held: ReturnType<typeof hold>,
  base: FauxResponseFactory,
): FauxResponseFactory {
  return (context, ...rest) =>
    context.messages.some((m) => m !== undefined && textOf(m) === secondTask)
      ? held.step(context, ...rest)
      : base(context, ...rest);
}

function childLog(answers: Record<string, string> = {}) {
  const seen = new Map<string, Observed[]>();
  const child: FauxResponseFactory = (
    context,
    _options,
    _state,
    model,
    ...rest
  ) => {
    const task = taskOf(context);
    if (!seen.has(task)) seen.set(task, []);
    seen.get(task)!.push({
      tools: toolsSeen(context),
      model: model.id,
      history: context.messages.map(textOf).join("|"),
      sections: sections(context),
    });
    void rest;
    return fauxAssistantMessage(answers[task] ?? "ok");
  };
  return { seen, child };
}

const parentTurns = (parent: Parent) =>
  parent.requests.filter((r) => taskOf(r) === "go");

/** The first child's saved `sessionFile` from a foreground result's details, shape-checked. */
function savedFileOf(toolCallId: string, parent: Parent): string | undefined {
  const details: unknown = results(parent.session).get(toolCallId)?.details;
  const [run] = Array.isArray(details) ? details : [];
  const file =
    typeof run === "object" && run !== null && "sessionFile" in run
      ? run.sessionFile
      : undefined;
  return typeof file === "string" ? file : undefined;
}

test("a continue runs the child's saved session with a fresh task and its old facts", async () => {
  const { seen, child } = childLog({ look: "RUN1-ANSWER" });
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: scriptTurns(
      child,
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      (context) => fauxAssistantMessage([cont("one", childIds(context)[0]!)]),
    ),
  });

  await parent.session.prompt("go");
  await parent.session.waitForIdle();

  expect(results(parent.session).get("look")?.isError).toBe(false);
  const runs = seen.get("look")!;
  expect(runs).toHaveLength(2);
  const [run1, run2] = runs;
  // The resumed transcript reaches the child as context messages, so run 2 reads run 1.
  expect(run2?.history).toContain("RUN1-ANSWER");
  // Run 2's facts are run 1's: the agent-file model, the agent's tools, the agent's sections.
  expect(run1?.model).toBe("faux-2");
  expect(run2?.model).toBe(run1?.model);
  expect(run2?.tools).toEqual(run1?.tools);
  expect(run2?.sections).toEqual(run1?.sections);
  // The second run shares the child id: both foreground results carry the same 8-char prefix.
  const ids = [...results(parent.session).values()]
    .map((m) => CHILD_ID.exec(textOf(m))?.[1])
    .filter(Boolean) as string[];
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  expect(savedFileOf("look", parent)).toBeDefined();
});

test("a continue with overrides is refused before it spends anything", async () => {
  const { seen, child } = childLog();
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: scriptTurns(
      child,
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      (context) =>
        fauxAssistantMessage([
          lanes("meddle", [
            {
              description: "continue meddled",
              continue: childIds(context)[0]!,
              task: "meddle",
              model: "faux-1",
              cwd: "/tmp",
              role: "overridden",
              tools: ["read"],
            },
          ]),
        ]),
    ),
  });

  await parent.session.prompt("go");
  const res = await vi.waitFor(() => results(parent.session).get("meddle"));
  expect(res?.isError).toBe(true);
  expect(textOf(res!)).toContain("omit agent, role, tools, model and cwd");
  // Only run 1 ever ran; the meddled continue spent nothing.
  expect([...seen.keys()]).toEqual(["look"]);
});

test("continuing a still-running child is refused until it finishes", async () => {
  const held = hold();
  const { seen, child } = childLog();
  const parent = await parentSession({
    respond: scriptTurns(
      (context, ...rest) =>
        taskOf(context) === "bg"
          ? held.step(context, ...rest)
          : child(context, ...rest),
      () => fauxAssistantMessage([call({ task: "bg", background: true })]),
      (context) => fauxAssistantMessage([cont("live", childIds(context)[0]!)]),
    ),
  });

  // Turn 1: a held background run — its start text is the tool result that carries the live id.
  const done = parent.session.prompt("go");
  await held.entered;
  await vi.waitFor(() =>
    expect(parentTurns(parent).length).toBeGreaterThanOrEqual(2),
  );
  const res = await vi.waitFor(() => results(parent.session).get("live"));
  expect(res?.isError).toBe(true);
  expect(textOf(res!)).toContain("wait for its answer or stop it");
  // No second run on the held child happened.
  expect(seen.has("bg")).toBe(false);

  held.release();
  await done;
  await parent.session.waitForIdle();
});

test("an unknown or blank id is refused with the rule spelled out", async () => {
  const { seen, child } = childLog();
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: scriptTurns(
      child,
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      () =>
        fauxAssistantMessage([cont("dead", "ffffffff"), cont("blank", "  ")]),
    ),
  });

  await parent.session.prompt("go");
  const dead = await vi.waitFor(() => results(parent.session).get("dead"));
  expect(dead?.isError).toBe(true);
  expect(textOf(dead!)).toContain('no subagent matches "ffffffff"');
  expect(textOf(dead!)).toContain("start a fresh subagent");
  const blank = await vi.waitFor(() => results(parent.session).get("blank"));
  expect(blank?.isError).toBe(true);
  expect(textOf(blank!)).toContain("pass the 8-char id of a finished subagent");
  expect([...seen.keys()]).toEqual(["look"]);
});

test("the same continue id in two calls of one message: the first runs it, the second is refused", async () => {
  const contHold = hold();
  const { child } = childLog();
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: scriptTurns(
      resumedGate("again a", contHold, child),
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      (context) =>
        fauxAssistantMessage([
          cont("a", childIds(context)[0]!),
          cont("b", childIds(context)[0]!),
        ]),
    ),
  });

  const done = parent.session.prompt("go");
  await contHold.entered;

  // The batch's results land only once cont-a releases, tool results-a in one message set.
  contHold.release();
  await done;
  const refused = results(parent.session).get("b")!;
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toContain("already has a run in progress");
  // "a" ran the resumed child to an answer; "b" never got a request.
  expect(textOf(results(parent.session).get("a")!)).toContain("released");
});

test("Esc on a running foreground continue aborts it inline and delivers nothing", async () => {
  const contHold = hold();
  const { child } = childLog({ look: "RUN1-ANSWER" });
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: scriptTurns(
      resumedGate("again two", contHold, child),
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      (context) => fauxAssistantMessage([cont("two", childIds(context)[0]!)]),
    ),
  });

  const run = parent.session.prompt("go");
  await contHold.entered;
  await parent.session.abort();
  await run;

  await vi.waitFor(() =>
    expect(results(parent.session).get("two")?.isError).toBe(true),
  );
  const res = results(parent.session).get("two")!;
  expect(res.isError).toBe(true);
  expect(textOf(res)).toMatch(/was stopped by the user before it answered/);
  // The turn died at the abort: the third parent request never happened.
  expect(parentTurns(parent)).toHaveLength(2);
});

test("a new session clears the records: ids from before it are refused", async () => {
  const { seen, child } = childLog({ look: "RUN1-ANSWER" });
  // The tag of the run-1 child, stashed by the continue-ok factory for the second prompt.
  let tag = "";
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: scriptTurns(
      child,
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      (context) => {
        tag = childIds(context)[0]!;
        return fauxAssistantMessage([cont("ok", tag)]);
      },
      // pi re-requests after every tool result: a filler "done" turn closes prompt 1, so the
      // continue "late" is issued by prompt 2, after the reload reset the extension state.
      () => fauxAssistantMessage("round one done"),
      () => fauxAssistantMessage([cont("late", tag)]),
    ),
  });

  // Prompt 1: run 1, then a continue that works while the record is live.
  await parent.session.prompt("go");
  await parent.session.waitForIdle();
  const ok = results(parent.session).get("ok");
  expect(ok?.isError).toBe(false);

  // A fresh session: pi's reload gives skyr a fresh extension state.
  await parent.session.reload();
  await parent.session.waitForIdle();
  await parent.session.prompt("go");
  await parent.session.waitForIdle();
  const late = results(parent.session).get("late");
  expect(late?.isError).toBe(true);
  expect(textOf(late!)).toContain("no subagent matches");
  // "late" never spent a child run.
  expect(seen.get("look")).toHaveLength(2);
});

test("a continue whose saved session file is gone fails with the honest error", async () => {
  const { child } = childLog({ look: "RUN1-ANSWER" });
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: scriptTurns(
      child,
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      () => fauxAssistantMessage("idling"),
      (context) => fauxAssistantMessage([cont("gone", childIds(context)[0]!)]),
    ),
  });

  await parent.session.prompt("go");
  await parent.session.waitForIdle();
  const file = savedFileOf("look", parent);
  expect(file).toBeDefined();
  rmSync(file!, { force: true });

  await parent.session.prompt("go");
  await parent.session.waitForIdle();
  const res = await vi.waitFor(() => results(parent.session).get("gone"));
  expect(res?.isError).toBe(true);
  expect(textOf(res!)).toContain("the saved session");
  expect(textOf(res!)).toContain("start a fresh subagent");
});

test("a continue whose child's cwd vanished, or stopped being a directory, fails with its own wording", async () => {
  const { seen, child } = childLog({ look: "RUN1-ANSWER" });
  const workdir = scratchDir("cont-cwd");
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: scriptTurns(
      child,
      () =>
        fauxAssistantMessage([
          call({ agent: "scout", task: "look", cwd: workdir }),
        ]),
      () => fauxAssistantMessage("round one"),
      (context) => fauxAssistantMessage([cont("gone", childIds(context)[0]!)]),
      () => fauxAssistantMessage("round two"),
      (context) =>
        fauxAssistantMessage([cont("swapped", childIds(context)[0]!)]),
    ),
  });

  // Run 1 lives in a scratch cwd; the record carries its realpath.
  await parent.session.prompt("go");
  await parent.session.waitForIdle();
  expect(seen.get("look")?.length).toBe(1);

  // Prompt 2: the cwd is gone — the continue refuses with the temporal wording.
  rmSync(workdir, { recursive: true });
  await parent.session.prompt("go");
  await parent.session.waitForIdle();
  const gone = results(parent.session).get("gone");
  expect(gone?.isError).toBe(true);
  expect(textOf(gone!)).toContain("no longer exists");

  // Prompt 3: the path exists again but holds a file now — the kind wording.
  mkdirSync(workdir.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(workdir, "a file");
  await parent.session.prompt("go");
  await parent.session.waitForIdle();
  const swapped = results(parent.session).get("swapped");
  expect(swapped?.isError).toBe(true);
  expect(textOf(swapped!)).toContain("is not a directory anymore");
  expect(textOf(swapped!)).toContain(workdir);
});

/** A bare writer's first run, in its own worktree, then `turns` for the parent's later turns. */
const worktreeChild = async (
  child: FauxResponseFactory,
  ...turns: FauxResponseFactory[]
) =>
  parentSession({
    git: true,
    respond: scriptTurns(
      child,
      () => fauxAssistantMessage([call({ task: "w", tools: ["edit"] })]),
      ...turns,
    ),
  });

/** The worktree path a bare writer's result names. */
const worktreeOf = (parent: Parent) =>
  /in worktree (\S+) on branch/.exec(
    textOf(results(parent.session).get("w")!),
  )?.[1];

test("a continued worktree child states its worktree again", async () => {
  const { child } = childLog();
  const parent = await worktreeChild(child, (context) =>
    fauxAssistantMessage([cont("two", childIds(context)[0]!)]),
  );

  await parent.session.prompt("go");
  await parent.session.waitForIdle();

  const path = worktreeOf(parent);
  expect(path).toBeDefined();
  expect(textOf(results(parent.session).get("two")!)).toContain(
    `in worktree ${path} on branch`,
  );
});

test("a stopped continue of a worktree child still gives the merge recipe", async () => {
  const contHold = hold();
  const { child } = childLog();
  const parent = await worktreeChild(
    resumedGate("again two", contHold, child),
    (context) => fauxAssistantMessage([cont("two", childIds(context)[0]!)]),
  );

  const run = parent.session.prompt("go");
  await contHold.entered;
  await parent.session.abort();
  await run;

  const res = await vi.waitFor(() => results(parent.session).get("two")!);
  expect(textOf(res)).toContain("was stopped by the user before it answered");
  // Run 1's writes may still sit in the worktree, uncommitted.
  expect(textOf(res)).toContain(`To merge them: git -C ${worktreeOf(parent)}`);
});

test("a continued worktree child whose run throws never calls the worktree empty", async () => {
  const { child } = childLog();
  const parent = await worktreeChild(
    child,
    () => fauxAssistantMessage("idling"),
    (context) => fauxAssistantMessage([cont("gone", childIds(context)[0]!)]),
  );

  await parent.session.prompt("go");
  await parent.session.waitForIdle();
  rmSync(savedFileOf("w", parent)!, { force: true });

  await parent.session.prompt("go");
  await parent.session.waitForIdle();
  const res = results(parent.session).get("gone")!;
  expect(res.isError).toBe(true);
  expect(textOf(res)).toContain("the saved session");
  expect(textOf(res)).not.toContain("it is empty");
});

test("a continue with a blank description is refused, and the child can still be continued", async () => {
  const { seen, child } = childLog();
  const parent = await parentSession({
    respond: scriptTurns(
      child,
      () => fauxAssistantMessage([call({ task: "look" })]),
      (context) =>
        fauxAssistantMessage([
          lanes("blank", [
            {
              description: "  ",
              continue: childIds(context)[0]!,
              task: "again blank",
            },
          ]),
        ]),
      (context) => fauxAssistantMessage([cont("after", childIds(context)[0]!)]),
    ),
  });

  await parent.session.prompt("go");
  await parent.session.waitForIdle();

  const blank = results(parent.session).get("blank")!;
  expect(blank.isError).toBe(true);
  expect(textOf(blank)).toContain("give a short description");
  expect(results(parent.session).get("after")?.isError).toBe(false);
  expect(seen.get("look")).toHaveLength(2);
});

test("a continued run's description is trimmed in its label and its details", async () => {
  const { child } = childLog();
  const parent = await parentSession({
    respond: scriptTurns(
      child,
      () => fauxAssistantMessage([call({ task: "look" })]),
      (context) =>
        fauxAssistantMessage([
          lanes(
            "padded",
            [
              {
                description: "  padded  ",
                continue: childIds(context)[0]!,
                task: "again padded",
              },
            ],
            { background: true },
          ),
        ]),
    ),
  });

  await parent.session.prompt("go");
  await parent.session.waitForIdle();

  const started = results(parent.session).get("padded")!;
  expect(textOf(started)).toContain('- task 1: "padded" (id ');
  expect(started.details).toMatchObject([{ description: "padded" }]);
});

test("a continue naming an agent is told to omit it, even an agent that does not exist", async () => {
  const { seen, child } = childLog();
  const parent = await parentSession({
    respond: scriptTurns(child, () =>
      fauxAssistantMessage([
        lanes("named", [
          {
            description: "continue named",
            continue: "ffffffff",
            agent: "nope",
            task: "again named",
          },
        ]),
      ]),
    ),
  });

  await parent.session.prompt("go");
  await parent.session.waitForIdle();

  const res = results(parent.session).get("named")!;
  expect(res.isError).toBe(true);
  expect(textOf(res)).toContain("omit agent, role, tools, model and cwd");
  expect(seen.size).toBe(0);
});

test("the same continue id twice in one call is refused before anything runs", async () => {
  const { seen, child } = childLog();
  const parent = await parentSession({
    respond: scriptTurns(
      child,
      () => fauxAssistantMessage([call({ task: "look" })]),
      (context) => {
        const id = childIds(context)[0]!;
        return fauxAssistantMessage([
          lanes("twice", [
            { description: "first", continue: id, task: "again 1" },
            {
              description: "second",
              continue: id.slice(0, 4),
              task: "again 2",
            },
          ]),
        ]);
      },
    ),
  });

  await parent.session.prompt("go");
  await parent.session.waitForIdle();

  const res = results(parent.session).get("twice")!;
  expect(res.isError).toBe(true);
  expect(textOf(res)).toMatch(
    /^subagent: nothing ran; fix these and call again:\n- task 2 \("second"\): continues the same subagent as task 1 \([0-9a-f]{8}\); one run per subagent at a time, so merge them into one task$/,
  );
  expect(seen.get("look")).toHaveLength(1);
});
