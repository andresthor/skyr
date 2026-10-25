/**
 * Runs tengi, the ACP adapter, against this package for tengi-smoke. Everything tengi-shaped comes
 * from the checkout `SKYR_TENGI_DIR` names: its bin, its vendored Pi, and the ACP schema with the
 * validator it is checked by. Nothing here imports tengi's tests, so they can change freely.
 * tengi runs in its own process group on an allowlisted env, so no credential reaches it, and
 * every message on the wire, both ways, is validated against the ACP schema at teardown.
 */
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import { isRecord } from "../src/tengi.js";

export const TENGI_DIR = process.env.SKYR_TENGI_DIR;

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("fixtures/tengi/", import.meta.url));
const ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
];
const DEFAULT_MS = 15_000;
const STOP_STEP_MS = 3_000;

export function clientCapabilities(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    elicitation: { form: {} },
    session: { notices: {}, compaction: {} },
    _meta: { agentui: { version: 1 } },
    ...overrides,
  };
}

interface WireRecord {
  dir: "agent->client" | "client->agent";
  msg: unknown;
}

export interface Tengi {
  readonly cwd: string;
  /** A scratch directory the test owns, outside tengi's cwd. */
  readonly out: string;
  readonly records: readonly WireRecord[];
  /** Lines `dialog-probe.ts` logged, parsed: one per load, one per UI member probed. */
  probeLog(): unknown[];
  /**
   * Accepts the next form tengi asks with `content`, in queue order. A form with nothing queued
   * is refused, and anything still queued when the test ends fails it.
   */
  expectForm(content: unknown): void;
  request(method: string, params: unknown): Promise<unknown>;
  /** The first `session/update` after the previous match whose `update` satisfies `pred`. */
  nextUpdate(pred: (update: unknown) => boolean): Promise<unknown>;
}

/**
 * Starts tengi with this package in a fresh agent dir's `packages`, the faux model as default
 * and the probe extension loaded. When the test finishes it stops tengi, removes its dirs, and
 * fails the test if tengi exited on its own, left a queued form unasked, or put invalid ACP on
 * the wire.
 */
export function startTengi(): Tengi {
  const tengiDir = TENGI_DIR;
  if (tengiDir === undefined) throw new Error("SKYR_TENGI_DIR is not set");
  const root = mkdtempSync(join(tmpdir(), "skyr-tengi-"));
  const agent = join(root, "agent");
  const cwd = join(root, "cwd");
  const out = join(root, "out");
  for (const dir of [agent, cwd, out]) mkdirSync(dir);
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "wbfaux",
      defaultModel: "scripted",
      defaultProjectTrust: "always",
      retry: { enabled: false },
      compaction: { enabled: false },
      enableInstallTelemetry: false,
      packages: [PACKAGE],
    }),
  );
  const probeFile = join(out, "probe.jsonl");
  const env: Record<string, string> = {
    SHELL: "/bin/bash",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PROBE_OUT: probeFile,
  };
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      join(tengiDir, "src", "bin", "tengi.ts"),
      "--agent-dir",
      agent,
      "--pi-dir",
      join(tengiDir, "test/pi/node_modules/@earendil-works/pi-coding-agent"),
      "--extension",
      join(FIXTURES, "faux-provider.ts"),
      "--extension",
      join(FIXTURES, "dialog-probe.ts"),
    ],
    { cwd, env, stdio: "pipe", detached: true },
  );

  const records: WireRecord[] = [];
  const unparsed: string[] = [];
  const listeners = new Set<() => void>();
  const forms: unknown[] = [];
  let stderr = "";
  let nextId = 1;
  let updateMark = 0;
  let exit: string | undefined;
  let stopping = false;

  const send = (msg: Record<string, unknown>) => {
    records.push({ dir: "client->agent", msg });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  };

  // tengi's only request to a client here is a form; anything else is refused
  function answerAgent(id: unknown, method: string): void {
    const content = method === "elicitation/create" ? forms.shift() : undefined;
    send(
      content === undefined
        ? { id, error: { code: -32601, message: `unexpected ${method}` } }
        : { id, result: { action: "accept", content } },
    );
  }

  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const lines = (buffered + chunk).split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        unparsed.push(line);
        continue;
      }
      records.push({ dir: "agent->client", msg });
      if (isRecord(msg) && typeof msg.method === "string" && "id" in msg)
        answerAgent(msg.id, msg.method);
      for (const listener of [...listeners]) listener();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  child.stdin.on("error", () => {
    // EPIPE once tengi has exited; its exit is reported below, with its stderr
  });
  const exited = new Promise<void>((resolve) =>
    child.on("close", (code, signal) => {
      if (!stopping) exit = `tengi exited on its own (${signal ?? code})`;
      for (const listener of [...listeners]) listener();
      resolve();
    }),
  );

  /** Resolves with `found()`'s first value; rejects at once if tengi exits first. */
  function until<T>(found: () => T | undefined, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const value = found();
        if (value !== undefined) {
          done();
          resolve(value);
        } else if (exit !== undefined) {
          done();
          reject(new Error(`${exit} while waiting for ${what}\n${stderr}`));
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`timed out waiting for ${what}\n${stderr}`));
      }, DEFAULT_MS);
      const done = () => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      listeners.add(check);
      check();
    });
  }

  onTestFinished(async () => {
    stopping = exit === undefined;
    child.stdin.end();
    const gone = () => child.exitCode !== null || child.signalCode !== null;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      await Promise.race([
        exited,
        new Promise((r) => setTimeout(r, STOP_STEP_MS)),
      ]);
      if (gone() || child.pid === undefined) break;
      process.kill(-child.pid, signal);
    }
    await exited;
    rmSync(root, { recursive: true, force: true });
    const problems = [
      ...(exit === undefined ? [] : [`${exit}\n${stderr}`]),
      ...(forms.length === 0 ? [] : [`${forms.length} queued form(s) unasked`]),
      ...unparsed.map((line) => `not JSON on stdout: ${line}`),
      ...wireProblems(tengiDir, records),
    ];
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }, 3 * STOP_STEP_MS);

  return {
    cwd,
    out,
    records,
    probeLog: () =>
      readFileSync(probeFile, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line): unknown => JSON.parse(line)),
    expectForm(content) {
      forms.push(content);
    },
    async request(method, params) {
      const id = nextId++;
      const reply = until<Record<string, unknown>>(() => {
        const answer = records.find(
          (r) =>
            r.dir === "agent->client" &&
            isRecord(r.msg) &&
            r.msg.id === id &&
            !("method" in r.msg),
        )?.msg;
        return isRecord(answer) ? answer : undefined;
      }, `the ${method} answer`);
      send({ id, method, params });
      const msg = await reply;
      if ("error" in msg)
        throw new Error(`${method} failed: ${JSON.stringify(msg.error)}`);
      return msg.result;
    },
    nextUpdate(pred) {
      return until(() => {
        for (let i = updateMark; i < records.length; i++) {
          const msg = records[i]?.msg;
          if (!isRecord(msg) || msg.method !== "session/update") continue;
          const update = isRecord(msg.params) ? msg.params.update : undefined;
          if (!pred(update)) continue;
          updateMark = i + 1;
          return update;
        }
        return undefined;
      }, "a matching session/update");
    },
  };
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
function wireProblems(
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
