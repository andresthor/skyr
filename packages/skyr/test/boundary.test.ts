import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("skyr imports nothing from its host", () => {
  const offenders: string[] = [];
  for (const f of readdirSync(KIT, { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(join(KIT, f), "utf8");
    for (const [, spec = ""] of src.matchAll(
      /(?:from|import\()\s*"(\.[^"]+)"/g,
    )) {
      if (!resolve(dirname(join(KIT, f)), spec).startsWith(KIT))
        offenders.push(`${f} → ${spec}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("nothing under src/ imports a pi-coding-agent value statically", () => {
  const offenders: string[] = [];
  for (const f of readdirSync(KIT, { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(join(KIT, f), "utf8");
    for (const [statement] of src.matchAll(
      /^import\s+(?!type\b)[^;]*?from\s*"@earendil-works\/pi-coding-agent";/gm,
    ))
      offenders.push(`${f} → ${statement.split("\n")[0]}`);
  }
  expect(offenders).toEqual([]);
});
