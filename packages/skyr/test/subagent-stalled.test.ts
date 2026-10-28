// The in-process runner never reports stall: a stalled listing line can only come from the
// subprocess runner's heartbeat poll, however long a quiet faux turn keeps the child running.
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import {
  call,
  hold,
  listing,
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
        ? fauxAssistantMessage([call({ prompt: "quiet" })])
        : fauxAssistantMessage("done");
    },
  });

  const run = parent.session.prompt("go");
  await held.entered;
  // A second of quiet, so a mis-wired stall flag would surface.
  await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
  const lines = await listing(parent);
  expect(lines).toHaveLength(1);
  expect(lines.join("\n")).not.toContain("stalled");

  await held.release();
  await run;
  await parent.session.waitForIdle();
  expect(textOf(results(parent.session).get("quiet")!)).toContain("released");
  expect(await listing(parent)).toEqual([]);
});
