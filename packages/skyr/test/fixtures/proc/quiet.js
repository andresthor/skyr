// One heartbeat, then silence: exercises the stale-heartbeat verdict without a real wait.
import { renameSync, writeFileSync } from "node:fs";

const dir = process.argv[2];
const write = (target, data) => {
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, data);
  renameSync(temp, target);
};
write(
  `${dir}/activity.json`,
  JSON.stringify({
    v: 1,
    id: "spec",
    turns: 0,
    toolCalls: 0,
    tokens: 0,
    now: Date.now(),
  }),
);
process.on("SIGTERM", () => {
  write(
    `${dir}/result.json`,
    JSON.stringify({
      v: 1,
      status: "aborted",
      text: undefined,
      error: undefined,
      usage: { input: 0, output: 0 },
      description: "quiet",
    }),
  );
  process.exit(0);
});
setInterval(() => {}, 100);
