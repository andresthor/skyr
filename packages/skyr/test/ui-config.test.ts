import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readUiSettings } from "../src/ui-config.js";

const withUi = async (ui: unknown) => {
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR as string, "skyr.json"),
    ui === undefined ? "{}" : JSON.stringify({ ui }),
  );
  return await readUiSettings();
};

test("both settings default to on", async () => {
  expect(await withUi(undefined)).toEqual({
    footer: true,
    builtinRows: true,
    problems: [],
  });
  expect(await withUi({})).toEqual({
    footer: true,
    builtinRows: true,
    problems: [],
  });
});

test("ui.builtinRows false turns the rows off and leaves the footer on", async () => {
  expect(await withUi({ builtinRows: false })).toEqual({
    footer: true,
    builtinRows: false,
    problems: [],
  });
});

test("a non-boolean setting keeps its default and each problem names the setting", async () => {
  const settings = await withUi({ builtinRows: "no", footer: 0, colour: 1 });
  expect(settings).toMatchObject({ footer: true, builtinRows: true });
  expect(settings.problems).toEqual([
    'skyr.json: ui."colour" is not a setting; ignored (settings: footer, builtinRows)',
    "skyr.json: ui.footer must be true or false; using true",
    "skyr.json: ui.builtinRows must be true or false; using true",
  ]);
});

test("a ui section that is not an object names both settings and uses the defaults", async () => {
  const settings = await withUi([]);
  expect(settings).toMatchObject({ footer: true, builtinRows: true });
  expect(settings.problems).toHaveLength(1);
  expect(settings.problems[0]).toContain("builtinRows");
});
