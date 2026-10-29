/** The ACP schema, tengi's own validator and the check of a whole session's wire against them. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isRecord } from "../src/guards.js";

export interface WireRecord {
  dir: "agent->client" | "client->agent";
  msg: unknown;
}

/** What a compiled JSON Schema check reports; the shape is ajv's, loaded from tengi's install. */
type Check = ((value: unknown) => boolean) & {
  errors?: { instancePath: string; message?: string }[] | null;
};
interface Ajv {
  addFormat(name: string, format: unknown): void;
  addSchema(schema: unknown, key: string): void;
  getSchema(ref: string): Check | undefined;
}

// The schema's numeric formats; ajv-formats ships none of them
const RANGE_FORMATS: Record<string, (n: unknown) => boolean> = {
  uint16: (n) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 0xffff,
  uint32: (n) =>
    Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 0xffff_ffff,
  uint64: (n) => Number.isInteger(n) && Number(n) >= 0,
};

/** Every string `format` keyword in the schema; an object at a `format` key is a data field. */
function formatsUsed(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const item of node) formatsUsed(item, found);
  else if (isRecord(node)) {
    if (typeof node.format === "string") found.add(node.format);
    for (const value of Object.values(node)) formatsUsed(value, found);
  }
  return found;
}

/**
 * Each record checked against the ACP schema's def for its method and direction: a request or
 * notification by its params, a response by the def of the request it answers.
 */
export function wireProblems(
  tengiDir: string,
  records: readonly WireRecord[],
): string[] {
  const fromTengi = createRequire(join(tengiDir, "package.json"));
  const schema: unknown = JSON.parse(
    readFileSync(
      fromTengi.resolve("@agentclientprotocol/sdk/schema/v1/schema.json"),
      "utf8",
    ),
  );
  const ajv: Ajv = new (fromTengi("ajv/dist/2020.js").Ajv2020)({
    strict: false,
    allErrors: true,
  });
  const loaded: unknown = fromTengi("ajv-formats/dist/formats.js").fullFormats;
  const formats = { ...(isRecord(loaded) ? loaded : {}), ...RANGE_FORMATS };
  // ajv skips an unknown format silently, so a schema upgrade must not add one unchecked
  const missing = [...formatsUsed(schema)].filter((f) => !(f in formats));
  if (missing.length > 0)
    return [`the ACP schema uses unchecked formats: ${missing.join(", ")}`];
  for (const [name, format] of Object.entries(formats))
    ajv.addFormat(name, format);
  ajv.addSchema(schema, "acp");

  const defs = isRecord(schema) && isRecord(schema.$defs) ? schema.$defs : {};
  const defFor = (method: string, response: boolean) =>
    Object.keys(defs).find((name) => {
      const def = defs[name];
      return (
        isRecord(def) &&
        def["x-method"] === method &&
        name.endsWith("Response") === response
      );
    });
  const check = (name: string | undefined, value: unknown, what: string) => {
    if (name === undefined) return [`${what}: no schema def`];
    const validate = ajv.getSchema(`acp#/$defs/${name}`);
    if (validate === undefined) return [`${what}: ${name} does not compile`];
    if (validate(value)) return [];
    return (validate.errors ?? []).map(
      (e) => `${what}: ${e.instancePath || "/"} ${e.message ?? ""}`,
    );
  };

  // Ids are per sender: a response is matched against the other side's requests
  const asked = {
    "agent->client": new Map<unknown, string>(),
    "client->agent": new Map<unknown, string>(),
  };
  return records.flatMap(({ dir, msg }) => {
    if (!isRecord(msg)) return [`${dir}: not an object`];
    if (typeof msg.method === "string") {
      if ("id" in msg) asked[dir].set(msg.id, msg.method);
      if (msg.method.startsWith("_")) return [];
      return check(
        defFor(msg.method, false),
        msg.params ?? {},
        `${dir} ${msg.method}`,
      );
    }
    if ("error" in msg) return check("Error", msg.error, `${dir} error`);
    const other = dir === "agent->client" ? "client->agent" : "agent->client";
    const method = asked[other].get(msg.id);
    if (method === undefined) return [`${dir}: answer to unknown id`];
    if (method.startsWith("_")) return [];
    return check(defFor(method, true), msg.result, `${dir} ${method} result`);
  });
}
