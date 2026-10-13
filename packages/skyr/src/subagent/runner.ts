/** The in-process child runner behind the Runner seam, plus the runner selection for sessions. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ExtensionFactory,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { loadPi } from "../pi.js";
import { processRunner } from "./child/proc-runner.js";
import { copyProviders, runChildSession } from "./child/spec-session.js";
import type { ChildSpec, Runner } from "./child/types.js";

export type {
  ChildEvent,
  ChildResult,
  ChildSpec,
  Runner,
  Usage,
} from "./child/types.js";

/** How the parent's providers name themselves for the copy; both runners agree on this. */
export type Providers = Pick<
  ModelRegistry,
  | "getRegisteredProviderIds"
  | "getRegisteredNativeProvider"
  | "getRegisteredProviderConfig"
>;

/**
 * `providers` are copied into each child's own model runtime, since the parent's is private;
 * `--api-key` keys and virtual models do not carry over. `registerTools` is the child's only
 * extension: Pi's and the user's extensions, skills and prompt templates stay off.
 */
export function inProcessRunner(
  providers: Providers,
  registerTools: ExtensionFactory,
): Runner {
  return {
    async run(spec: ChildSpec, signal, onEvent) {
      return runChildSession(spec, {
        providers,
        registerTools,
        signal,
        onEvent,
      });
    },
  };
}

/**
 * The child is a TypeScript entry whose sibling imports are .js specifiers naming .ts files,
 * exactly as Pi's own extension tree does. Pi loads those through jiti; the child's spawn
 * does the same with jiti resolved from Pi's own dependency set.
 */
async function childLoaderArgs(): Promise<string[]> {
  try {
    const pi = await loadPi();
    const dir = pi.getPackageDir();
    const reg = join(dir, "node_modules", "jiti", "lib", "jiti-register.mjs");
    if (existsSync(reg)) return ["--import", pathToFileURL(reg).href];
  } catch {
    // fall through: the probe fails, the in-process runner stays
  }
  return [];
}

/** One `--smoke` child: whether the child entry can load and speak the protocol. */
async function probeProcRunner(): Promise<boolean> {
  const entry = fileURLToPath(new URL("./child/main.ts", import.meta.url));
  const loader = await childLoaderArgs();
  const dir = await mkdtemp(join(tmpdir(), "skyr-probe-"));
  try {
    const child = spawn(process.execPath, [...loader, entry, "--smoke", dir], {
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", (c) => resolve(c ?? -1)),
    );
    if (code !== 0) return false;
    const raw = await readFile(join(dir, "result.json"), "utf8");
    const parsed = JSON.parse(raw) as { v?: number; status?: string };
    return parsed.v === 1 && parsed.status === "done";
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Does this model resolve in the file-only runtime a child gets, and NOT in the runtime the
 * parent's providers compose? A model both resolve composes differently in the child: the
 * parent's effective config is the one that runs, so those stay in-process. The preflight
 * fails soft — a call that always worked must never start failing here.
 */
async function canSpawnModelFor(
  providers: Providers,
  model: string,
  state: { mixed?: ModelRuntime },
): Promise<boolean> {
  try {
    const pi = await loadPi();
    const agentDir = pi.getAgentDir();
    const fileRuntime = await pi.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    if (
      !pi.resolveCliModel({ cliModel: model, modelRuntime: fileRuntime }).model
    )
      return false;
    state.mixed ??= await pi.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    copyProviders(providers, state.mixed);
    return !pi.resolveCliModel({
      cliModel: model,
      modelRuntime: state.mixed,
    }).model;
  } catch {
    return false;
  }
}

/**
 * The session's runner: the subprocess kind when the child entry can load (smoke probe per
 * session, POSIX only) and the call's model runs in a child's file-only runtime; else the
 * in-process kind it has always been. Records, abort wiring and results flow through the
 * same Runner seam whichever way the call lands.
 */
export function runnerFor(
  providers: Providers,
  registerTools: ExtensionFactory,
): Runner {
  const inProcess = inProcessRunner(providers, registerTools);
  const state: { canSpawn?: boolean; mixed?: ModelRuntime } = {};
  return {
    async run(spec, signal, onEvent) {
      state.canSpawn ??=
        (await probeProcRunner()) && process.platform !== "win32";
      if (
        state.canSpawn &&
        (await canSpawnModelFor(providers, spec.model, state))
      ) {
        const entry = fileURLToPath(
          new URL("./child/main.ts", import.meta.url),
        );
        return processRunner(entry, { loader: await childLoaderArgs() }).run(
          spec,
          signal,
          onEvent,
        );
      }
      return inProcess.run(spec, signal, onEvent);
    },
  };
}
