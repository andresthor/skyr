import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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

test("nothing under src/ui imports from src outside src/ui", () => {
  const UI = join(KIT, "ui");
  const offenders: string[] = [];
  for (const f of readdirSync(UI, { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(join(UI, f), "utf8");
    for (const [, spec = ""] of src.matchAll(
      /(?:from|import\()\s*"(\.[^"]+)"/g,
    )) {
      if (!resolve(dirname(join(UI, f)), spec).startsWith(UI + sep))
        offenders.push(`${f} → ${spec}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("nothing under src/chrome imports a feature module", () => {
  const FEATURES = new Set(
    ["subagent", "shells", "voice", "ask-user", "advisor", "tools"].map((d) =>
      join(KIT, d),
    ),
  );
  const CHROME = join(KIT, "chrome");
  const offenders: string[] = [];
  for (const f of readdirSync(CHROME, { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(join(CHROME, f), "utf8");
    for (const [, spec = ""] of src.matchAll(
      /(?:from|import\()\s*"(\.[^"]+)"/g,
    )) {
      const target = resolve(dirname(join(CHROME, f)), spec);
      if ([...FEATURES].some((dir) => target.startsWith(dir + sep)))
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
