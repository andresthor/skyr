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
} from "@earendil-works/pi-coding-agent";
import { loadPi } from "../pi.js";
import { processRunner } from "./child/proc-runner.js";
import { type Providers, runChildSession } from "./child/spec-session.js";
import type {
  ChildEvent,
  ChildResult,
  ChildSpec,
  Runner,
} from "./child/types.js";

export type {
  ChildEvent,
  ChildResult,
  ChildSpec,
  Runner,
  Usage,
} from "./child/types.js";

/**
 * `providers` are copied into each child's own model runtime, since the parent's is private;
 * `--api-key` keys and virtual models do not carry over. `registerTools` is the child's only
 * extension: Pi's and the user's extensions, skills and prompt templates stay off.
 */
export function inProcessRunner(
  providers: Pick<
    ModelRegistry,
    | "getRegisteredProviderIds"
    | "getRegisteredNativeProvider"
    | "getRegisteredProviderConfig"
  >,
  registerTools: ExtensionFactory,
): Runner {
  return {
    async run(spec, signal, onEvent) {
      return runChildSession(spec, {
        providers,
        registerTools,
        signal,
        onEvent,
      });
    },
  };
}

/** The smoke probe runs once per process; its verdict is whether the child entry can load. */
let probed: boolean | undefined;

/**
 * The child is a TypeScript entry whose sibling imports are .js specifiers into .ts files,
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
 * Does the model a child would get (the agent dir's file config alone) resolve this model,
 * AND does the same model NOT resolve through the parent's providers? A model both resolve
 * composes differently in the child; the parent's effective config is the one that runs, so
 * those stay in-process. A parent-runtime-only model (faux, registered provider, --api-key
 * key) is the in-process runner's case; the preflight fails soft, never failing the call.
 */
async function childModelResolves(
  providers: Pick<
    ModelRegistry,
    | "getRegisteredProviderIds"
    | "getRegisteredNativeProvider"
    | "getRegisteredProviderConfig"
  >,
  model: string,
): Promise<boolean> {
  try {
    const pi = await loadPi();
    const agentDir = pi.getAgentDir();
    const fileRuntime = await pi.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const fileModel = pi.resolveCliModel({
      cliModel: model,
      modelRuntime: fileRuntime,
    }).model;
    if (!fileModel) return false;
    mixedRuntime ??= await pi.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    for (const id of providers.getRegisteredProviderIds()) {
      const native = providers.getRegisteredNativeProvider(id);
      const config = providers.getRegisteredProviderConfig(id);
      if (native) mixedRuntime.registerNativeProvider(native);
      else if (config) mixedRuntime.registerProvider(id, config);
    }
    return !pi.resolveCliModel({
      cliModel: model,
      modelRuntime: mixedRuntime,
    }).model;
  } catch {
    return false;
  }
}

/** One mixed runtime per session: the provider copy loop mutates it, so it is cached. */
let mixedRuntime:
  | import("@earendil-works/pi-coding-agent").ModelRuntime
  | undefined;

/**
 * The session's runner: the subprocess kind when the child entry can load AND the model
 * resolves in a file-only child runtime; else the in-process kind it has always been.
 * Everything else — records, abort wiring, results — flows through the same Runner seam.
 */
export function runnerFor(
  providers: Pick<
    ModelRegistry,
    | "getRegisteredProviderIds"
    | "getRegisteredNativeProvider"
    | "getRegisteredProviderConfig"
  >,
  registerTools: ExtensionFactory,
): Runner {
  return {
    async run(spec, signal, onEvent) {
      probed ??= await probeProcRunner();
      if (probed && (await childModelResolves(providers, spec.model))) {
        const entry = fileURLToPath(
          new URL("./child/main.ts", import.meta.url),
        );
        return processRunner(entry, { loader: await childLoaderArgs() }).run(
          spec,
          signal,
          onEvent,
        );
      }
      return inProcessRunner(providers, registerTools).run(
        spec,
        signal,
        onEvent,
      );
    },
  };
}
