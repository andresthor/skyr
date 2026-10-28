import { expect, test } from "vitest";
import {
  delivery,
  type LaneOutcome,
  resultText,
} from "../src/subagent/result.js";

const outcome = (tokens: number): LaneOutcome => ({
  run: {
    id: "0123456789abcdef",
    description: "count",
    status: "done",
    startedAt: 0,
    endedAt: 1,
    turns: 1,
    toolCalls: 0,
    tokens,
  },
  body: "done",
  notes: [],
});

test("the model reads token counts in thousands, a million included", () => {
  expect(delivery([outcome(1_234_567)])).toContain('tokens="1235k tok"');
  expect(resultText([outcome(800), outcome(1_233_767)])).toContain(
    " · 1235k tok\n",
  );
});
