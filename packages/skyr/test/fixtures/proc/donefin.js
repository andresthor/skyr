// Clean finish: result.json then exit 0.
import { renameSync, writeFileSync } from "node:fs";

const dir = process.argv[2];
const temp = `${dir}/result.tmp-p${process.pid}`;
writeFileSync(
  temp,
  JSON.stringify({
    v: 1,
    status: "done",
    text: "THE ANSWER",
    description: "clean",
    usage: { input: 3, output: 5 },
  }),
);
renameSync(temp, `${dir}/result.json`);
process.exit(0);
