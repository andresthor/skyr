/**
 * Child entry: `node <basedir>/main.ts <jobdir>` runs one plain-data spec. It writes a 500 ms
 * heartbeat snapshot to `<jobdir>/activity.json` (counters only, never a control channel) and
 * one final `result.json` at the end. `--smoke <jobdir>` is the parent's boot probe; it imports
 * nothing from the runtime family.
 */

import { realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL, writeJson, zeroUsage } from "./protocol.js";
import { type Providers, runChildSession } from "./spec-session.js";
import { registerChildTools } from "./tools.js";
import type { ChildEvent, ChildResult, ChildSpec } from "./types.js";

interface Snapshot {
  v: number;
  id: string;
  turns: number;
  toolCalls: number;
  activity: string | undefined;
  tokens: number;
  startedAt: number;
  /** The child's own clock: a stalled verdict keys on heartbeat age, never event silence. */
  now: number;
  pid: number;
}

interface StoredResult extends ChildResult {
  v: number;
  /** Labels a recovered delivery's header even when the parent died before the answer. */
  description: string;
  agent?: string;
}

const readSpec = (raw: unknown): { spec: ChildSpec } | { invalid: string } => {
  if (typeof raw !== "object" || raw === null)
    return { invalid: "the spec is not an object" };
  const r = raw as Record<string, unknown>;
  for (const key of ["id", "cwd", "model", "task", "description"])
    if (typeof r[key] !== "string" || (r[key] as string).trim() === "")
      return { invalid: `missing or empty "${key}"` };
  if (!Array.isArray(r.tools) || !r.tools.every((t) => typeof t === "string"))
    return { invalid: "tools must be a list of names" };
  if (typeof r.trusted !== "boolean") return { invalid: "missing trusted" };
  if (r.systemPrompt !== undefined && typeof r.systemPrompt !== "string")
    return { invalid: "systemPrompt must be a string" };
  let session: ChildSpec["session"];
  const s = r.session;
  if (s !== undefined && s !== null) {
    if (typeof s !== "object") return { invalid: "session must be an object" };
    const so = s as Record<string, unknown>;
    if (typeof so.resume === "string") session = { resume: so.resume };
    else if (typeof so.dir === "string" && typeof so.parent === "string")
      session = { dir: so.dir, parent: so.parent };
    else return { invalid: "session must be {resume} or {dir, parent}" };
  }
  const spec: ChildSpec = {
    id: r.id as string,
    cwd: r.cwd as string,
    model: r.model as string,
    thinkingLevel: undefined,
    tools: r.tools as string[],
    systemPrompt: typeof r.systemPrompt === "string" ? r.systemPrompt : "",
    task: r.task as string,
    trusted: r.trusted as boolean,
    description: r.description as string,
    ...(typeof r.agent === "string" ? { agent: r.agent } : {}),
    ...(session !== undefined ? { session } : {}),
  };
  // A `:level` suffix on the model overrides thinkingLevel, as `pi --model` spells it.
  const level = /:(minimal|medium|high|off)$/.exec(spec.model);
  if (level) spec.thinkingLevel = level[1] as ChildSpec["thinkingLevel"];
  return { spec };
};

/**
 * One child run against `<jobdir>`. `providers` exists for tests on the faux provider; a real
 * child resolves the model from the agent dir's auth.json + models.json alone.
 */
export async function runChild(
  jobDir: string,
  o: { providers?: Providers } = {},
): Promise<StoredResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(jobDir, "spec.json"), "utf8"));
  } catch {
    return {
      v: PROTOCOL,
      status: "failed",
      text: undefined,
      error: "invalid spec: unreadable spec.json",
      usage: zeroUsage(),
      sessionFile: undefined,
      description: "",
    };
  }
  const shape = readSpec(raw);
  if ("invalid" in shape)
    return {
      v: PROTOCOL,
      status: "failed",
      text: undefined,
      error: `invalid spec: ${shape.invalid}`,
      usage: zeroUsage(),
      sessionFile: undefined,
      description: "invalid spec",
    };
  const spec = shape.spec;
  const failed = (error: string): StoredResult => ({
    v: PROTOCOL,
    status: "failed",
    text: undefined,
    error,
    usage: zeroUsage(),
    sessionFile: undefined,
    description: spec.description,
    ...(spec.agent !== undefined ? { agent: spec.agent } : {}),
  });

  const startedAt = Date.now();
  let turns = 0;
  let toolCalls = 0;
  let tokens = 0;
  let activity: string | undefined;
  const snapshot = (): Snapshot => ({
    v: PROTOCOL,
    id: spec.id,
    turns,
    toolCalls,
    activity,
    tokens,
    startedAt,
    now: Date.now(),
    pid: process.pid,
  });
  let stopped = false;
  let writing: Promise<void> = Promise.resolve();
  const writeSnapshot = () => {
    if (stopped) return;
    writing = writing
      .then(() => writeJson(join(jobDir, "activity.json"), snapshot()))
      .then(
        () => undefined,
        () => undefined,
      );
  };
  // A fixed tick, so one quiet model turn never looks stalled: the heartbeat keeps moving.
  const tick = setInterval(writeSnapshot, 500);
  const onEvent = (event: ChildEvent) => {
    if (event.type === "tool") {
      toolCalls += 1;
      activity = event.name;
      writeSnapshot();
    } else if (event.type === "turn") {
      turns += 1;
      tokens = event.usage.input + event.usage.output;
      writeSnapshot();
    }
  };

  const controller = new AbortController();
  let terminated = false;
  const onTerm = () => {
    terminated = true;
    controller.abort();
  };
  process.on("SIGTERM", onTerm);

  let result: ChildResult;
  try {
    result = await runChildSession(spec, {
      ...(o.providers !== undefined ? { providers: o.providers } : {}),
      registerTools: registerChildTools,
      signal: controller.signal,
      onEvent,
    });
  } catch (error: unknown) {
    result = failed(
      terminated
        ? "stopped"
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
  stopped = true;
  clearInterval(tick);
  await writing;
  process.removeListener("SIGTERM", onTerm);
  const stored: StoredResult = {
    ...result,
    v: PROTOCOL,
    description: spec.description,
    ...(spec.agent !== undefined ? { agent: spec.agent } : {}),
  };
  try {
    await writeJson(join(jobDir, "result.json"), stored);
  } catch (error: unknown) {
    stored.status = "failed";
    stored.error = `could not write result.json: ${error instanceof Error ? error.message : String(error)}`;
  }
  return stored;
}

const main = () => {
  const argv = process.argv.slice(2);
  if (argv[0] === "--smoke") {
    const dir = argv[1];
    if (dir === undefined) {
      process.stderr.write("missing a smoke directory\n");
      process.exit(2);
    }
    void mkdir(dir, { recursive: true })
      .then(() =>
        writeJson(join(dir, "result.json"), {
          v: PROTOCOL,
          status: "done",
          text: undefined,
          error: undefined,
          usage: zeroUsage(),
          sessionFile: undefined,
          description: "smoke",
        }),
      )
      .then(() => process.exit(0))
      .catch(() => process.exit(3));
    return;
  }
  const jobDir = argv[0];
  if (jobDir === undefined) {
    process.stderr.write("usage: node main.ts <jobdir>\n");
    process.exit(2);
  }
  void runChild(jobDir)
    .then((result) => process.exit(result.status === "done" ? 0 : 1))
    .catch(() => process.exit(1));
};

const isMainScript = (): boolean => {
  try {
    return (
      realpathSync(process.argv[1] ?? "?") === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
};

if (isMainScript()) main();
