#!/usr/bin/env node
// Checks for the craft rules a linter has no rule for; each hit names the rule it breaks.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "packages/skyr/src");

const CHECKS = [
  {
    test: /\\x1b\[|\\u001b\[|\\x9b/,
    rule: "hand-written escape sequence: style through Theme.style or pi-tui's styleText, strip with stripTerminalSequences",
  },
  {
    test: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    rule: "swallowed error: an empty catch hides the failure; handle it, or state inside the block why nothing can be done",
  },
  {
    test: /(?:JSON\.parse\([^)]*\)|\.json\(\))\s*as\s+(?!unknown\b)/,
    rule: "cast at the boundary: parse to unknown and narrow, never assert the shape",
  },
];
// a module that takes a `now` seam reads time only through it
const NOW_SEAM = /\bnow\??\s*:\s*\(\)\s*=>\s*number/;
const WALL_CLOCK = /Date\.now\(\)/;

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );

const hits = [];
for (const file of files(SRC)) {
  const lines = readFileSync(file, "utf8").split("\n");
  const where = (i) => `${relative(ROOT, file)}:${i + 1}`;
  lines.forEach((line, i) => {
    for (const { test, rule } of CHECKS)
      if (test.test(line)) hits.push(`${where(i)}: ${rule}`);
  });
  if (lines.some((l) => NOW_SEAM.test(l)))
    lines.forEach((line, i) => {
      if (WALL_CLOCK.test(line) && !/=\s*Date\.now\b/.test(line))
        hits.push(
          `${where(i)}: second clock: this module takes a now seam, so read time through it`,
        );
    });
}

for (const hit of hits) console.error(hit);
process.exit(hits.length ? 1 : 0);
