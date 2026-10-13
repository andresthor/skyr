// Live forever writing heartbeats; SIGTERM writes an aborted result and exits.
import { renameSync, writeFileSync } from "node:fs";

const dir = process.argv[2];
const write = (target, data) => {
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, data);
  renameSync(temp, target);
};
const beat = () =>
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
let _stopped = false;
process.on("SIGTERM", () => {
  _stopped = true;
  write(
    `${dir}/result.json`,
    JSON.stringify({
      v: 1,
      status: "aborted",
      text: undefined,
      error: undefined,
      usage: { input: 0, output: 0 },
      description: "hang",
    }),
  );
  process.exit(0);
});
const tick = setInterval(beat, 500);
process.on("disconnect", () => clearInterval(tick));
beat();
