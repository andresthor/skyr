// The in-process runner never reports stall: a stalled row can only come from the subprocess
// runner's heartbeat poll, however long a quiet faux turn keeps the child running.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import {
  call,
  hold,
  parentSession,
  results,
  taskOf,
  textOf,
} from "./session.js";

test("a quiet in-process child is never shown as stalled, and finishes once released", async () => {
  const held = hold();
  let turns = 0;
  const parent = await parentSession({
    respond: (context, options, state, model) => {
      if (taskOf(context) !== "go")
        return held.step(context, options, state, model);
      turns += 1;
      return turns === 1
        ? fauxAssistantMessage([call({ task: "quiet" })])
        : fauxAssistantMessage("done");
    },
  });

  const run = parent.session.prompt("go");
  await held.entered;
  // Longer than a pulse (250 ms) and a store tick, so a mis-wired stall flag would surface.
  await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
  expect(parent.widgets.at(-1)).toHaveLength(1);
  expect(parent.widgets.flat().join("\n")).not.toContain("stalled");

  await held.release();
  await run;
  await parent.session.waitForIdle();
  expect(textOf(results(parent.session).get("quiet")!)).toContain("released");
  expect(parent.widgets.at(-1)).toBeUndefined();
});
