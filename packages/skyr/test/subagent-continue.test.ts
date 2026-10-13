// Continuing a child by id: a second run on the finished child's saved session.
import { rmSync } from "node:fs";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import {
  agentFile,
  call,
  hold,
  type Parent,
  parentSession,
  results,
  sections,
  taskOf,
  textOf,
  toolsSeen,
} from "./session.js";

const SCOUT = {
  "scout.md": agentFile("Finds things", "model: faux-2\n"),
};

/**
 * One parent prompt per test. The parent's request factories run in order: the first turn
 * creates run 1, later turns read the `(id …)` tag out of earlier messages and issue continues.
 * Turns past the list answer "done"; re-prompting consumes the next factory. A resumed child's
 * context starts with run 1's messages, so a child side sees `taskOf` = run 1's task again.
 */
function script(
  child: FauxResponseFactory,
  ...turns: FauxResponseFactory[]
): FauxResponseFactory {
  let n = 0;
  return (context, ...rest) => {
    if (taskOf(context) !== "go") return child(context, ...rest);
    const own = turns[n];
    n += 1;
    return own ? own(context, ...rest) : fauxAssistantMessage("done");
  };
}

/** Every `(id …)` tag in a request's messages: tool-result texts and delivered headers. */
function tagsOf(context: TranscriptContext): string[] {
  return context.messages.flatMap((m) => {
    const id = /\(id ([0-9a-f]{8})\)/.exec(textOf(m));
    return id ? [id[1]!] : [];
  });
}

/** A continue call: tool-call id = its task, so results are looked up by task. */
const cont = (task: string, prefix: string) =>
  fauxToolCall(
    "subagent",
    {
      description: `continue ${task}`,
      continue: prefix,
      task: `again ${task}`,
    },
    { id: task },
  );

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

/** The child's saved `sessionFile` from a foreground result's details, shape-checked. */
function savedFileOf(toolCallId: string, parent: Parent): string | undefined {
  const message = results(parent.session).get(toolCallId) as unknown as {
    details?: { sessionFile?: unknown };
  };
  const details = message?.details;
  const file =
    details !== undefined &&
    typeof details === "object" &&
    details !== null &&
    "sessionFile" in details
      ? details.sessionFile
      : undefined;
  return typeof file === "string" ? file : undefined;
}

test("a continue runs the child's saved session with a fresh task and its old facts", async () => {
  const { seen, child } = childLog({ look: "RUN1-ANSWER" });
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: script(
      child,
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      (context) => fauxAssistantMessage([cont("one", tagsOf(context)[0]!)]),
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
    .map((m) => /\(id ([0-9a-f]{8})\)/.exec(textOf(m))?.[1])
    .filter(Boolean) as string[];
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  expect(savedFileOf("look", parent)).toBeDefined();
});

test("a continue with overrides is refused before it spends anything", async () => {
  const { seen, child } = childLog();
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: script(
      child,
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      (context) =>
        fauxAssistantMessage([
          fauxToolCall(
            "subagent",
            {
              description: "continue meddled",
              continue: tagsOf(context)[0]!,
              task: "meddle",
              model: "faux-1",
              cwd: "/tmp",
              prompt: "overridden",
              tools: ["read"],
            },
            { id: "meddle" },
          ),
        ]),
    ),
  });

  await parent.session.prompt("go");
  const res = await vi.waitFor(() => results(parent.session).get("meddle"));
  expect(res?.isError).toBe(true);
  expect(textOf(res!)).toContain("omit agent, prompt, tools, model and cwd");
  // Only run 1 ever ran; the meddled continue spent nothing.
  expect([...seen.keys()]).toEqual(["look"]);
});

test("continuing a still-running child is refused until it finishes", async () => {
  const held = hold();
  const { seen, child } = childLog();
  const parent = await parentSession({
    respond: script(
      (context, ...rest) =>
        taskOf(context) === "bg"
          ? held.step(context, ...rest)
          : child(context, ...rest),
      () => fauxAssistantMessage([call({ task: "bg", background: true })]),
      (context) => fauxAssistantMessage([cont("live", tagsOf(context)[0]!)]),
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

test("an unknown or blank id prefix is refused with the rule spelled out", async () => {
  const { seen, child } = childLog();
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: script(
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
  expect(textOf(blank!)).toContain("pass a subagent id prefix");
  expect([...seen.keys()]).toEqual(["look"]);
});

test("two same-turn continues on one child: the first runs, the second is refused", async () => {
  const contHold = hold();
  const { child } = childLog();
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: script(
      resumedGate("again a", contHold, child),
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      (context) =>
        fauxAssistantMessage([
          cont("a", tagsOf(context)[0]!),
          cont("b", tagsOf(context)[0]!),
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
    respond: script(
      resumedGate("again two", contHold, child),
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      (context) => fauxAssistantMessage([cont("two", tagsOf(context)[0]!)]),
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
  expect(textOf(res)).toMatch(/was stopped before it answered/);
  // The turn died at the abort: the third parent request never happened.
  expect(parentTurns(parent)).toHaveLength(2);
});

test("a new session clears the records: ids from before it are refused", async () => {
  const { seen, child } = childLog({ look: "RUN1-ANSWER" });
  // The tag of the run-1 child, stashed by the continue-ok factory for the second prompt.
  let tag = "";
  const parent = await parentSession({
    userAgents: SCOUT,
    respond: script(
      child,
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      (context) => {
        tag = tagsOf(context)[0]!;
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
    respond: script(
      child,
      () => fauxAssistantMessage([call({ agent: "scout", task: "look" })]),
      () => fauxAssistantMessage("idling"),
      (context) => fauxAssistantMessage([cont("gone", tagsOf(context)[0]!)]),
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
