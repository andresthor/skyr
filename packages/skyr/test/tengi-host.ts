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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import { isRecord } from "../src/guards.js";
import { type WireRecord, wireProblems } from "./tengi-wire.js";

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

/** `@tool` directive for the faux model: it calls `name` with `args` as its whole reply. */
export const tool = (name: string, args: Record<string, unknown>) =>
  `@tool ${JSON.stringify({ name, args })}`;

const clientCapabilities = ({ forms = true, tasks = false } = {}) => ({
  ...(forms ? { elicitation: { form: {} } } : {}),
  session: { notices: {}, compaction: {} },
  _meta: { agentui: { version: 1, ...(tasks ? { tasks: true } : {}) } },
});

const taskItems = (update: unknown) => {
  const meta = isRecord(update) ? update._meta : undefined;
  const tasks = isRecord(meta) ? meta["agentui/tasks"] : undefined;
  return isRecord(tasks) && Array.isArray(tasks.items)
    ? tasks.items
    : undefined;
};

export interface Tengi {
  /** How many times `reload-probe.ts` has been loaded, so a reload shows as one more. */
  loads(): number;
  /**
   * Accepts the next form tengi asks with `content`, in queue order. A form with nothing queued
   * is refused, and anything still queued when the test ends fails it.
   */
  expectForm(content: unknown): void;
  /** Opens the one session `prompt` talks to, as a client with forms and, if `tasks`, task lists. */
  session(caps?: { forms?: boolean; tasks?: boolean }): Promise<void>;
  /** Runs one turn to its end; rejects on any other stop reason. */
  prompt(text: string): Promise<void>;
  /** The tool names the faux model reads from its own request, which the wire does not show. */
  declaredTools(): Promise<string[]>;
  formsAsked(): number;
  /** Resolves once the agent has said `text`. */
  agentSaid(text: string): Promise<void>;
  /** Every completed tool call: its content as JSON, and its `_meta`. */
  toolResults(): { text: string; meta: Record<string, unknown> }[];
  /** The task list of the first update after the previous match whose items satisfy `pred`. */
  nextTasks(pred: (items: unknown[]) => boolean): Promise<unknown[]>;
  /**
   * A shell command that waits for `release()`, with a cap so it cannot outlive the test. Pi's
   * bash runs outside tengi's process group, so the test's end must release it too.
   */
  gate(name: string): { command: string; release(): void };
}

/**
 * Starts tengi with this package installed, the faux model as default and the reload probe
 * loaded. When the test finishes it stops tengi, and fails the test if tengi exited on its own,
 * left a queued form unasked, or put invalid ACP on the wire.
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
  const probeFile = join(out, "probe.log");
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
      join(FIXTURES, "reload-probe.ts"),
    ],
    { cwd, env, stdio: "pipe", detached: true },
  );

  const records: WireRecord[] = [];
  const unparsed: string[] = [];
  const listeners = new Set<() => void>();
  const forms: unknown[] = [];
  let stderr = "";
  let nextId = 1;
  let sessionId = "";
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
  // `exit`, not `close`: a grandchild holding the stdout pipe would delay `close` past the hook
  const exited = new Promise<void>((resolve) => {
    const ended = (why: string) => {
      if (!stopping) exit = why;
      for (const listener of [...listeners]) listener();
      resolve();
    };
    child.on("exit", (code, signal) =>
      ended(`tengi exited on its own (${signal ?? code})`),
    );
    child.on("error", (error) =>
      ended(`tengi did not start: ${error.message}`),
    );
  });

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
    child.stdout.destroy();
    child.stderr.destroy();
    rmSync(root, { recursive: true, force: true });
    const problems = [
      ...(exit === undefined ? [] : [`${exit}\n${stderr}`]),
      ...(forms.length === 0 ? [] : [`${forms.length} queued form(s) unasked`]),
      ...unparsed.map((line) => `not JSON on stdout: ${line}`),
      ...wireProblems(tengiDir, records),
    ];
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }, 3 * STOP_STEP_MS);

  async function request(method: string, params: unknown): Promise<unknown> {
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
  }

  const updates = () =>
    records.flatMap(({ msg }): Record<string, unknown>[] => {
      const update =
        isRecord(msg) && msg.method === "session/update" && isRecord(msg.params)
          ? msg.params.update
          : undefined;
      return isRecord(update) ? [update] : [];
    });
  const agentText = () =>
    updates()
      .map((u) =>
        u.sessionUpdate === "agent_message_chunk" && isRecord(u.content)
          ? String(u.content.text)
          : "",
      )
      .join("");
  const prompt = async (text: string) => {
    const result = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    if (!isRecord(result) || result.stopReason !== "end_turn")
      throw new Error(`turn stopped early: ${JSON.stringify(result)}`);
  };

  return {
    loads: () => readFileSync(probeFile, "utf8").split("\n").length - 1,
    expectForm(content) {
      forms.push(content);
    },
    async session(caps) {
      await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: clientCapabilities(caps),
      });
      const response = await request("session/new", { cwd, mcpServers: [] });
      if (!isRecord(response) || typeof response.sessionId !== "string")
        throw new Error("session/new did not answer with a sessionId");
      sessionId = response.sessionId;
    },
    prompt,
    async declaredTools() {
      await prompt("@tools");
      const names = /declared tools: (\S*)/.exec(agentText())?.[1];
      if (names === undefined) throw new Error("no declared-tools reply");
      return names.split(",");
    },
    formsAsked: () =>
      records.filter(
        (r) =>
          r.dir === "agent->client" &&
          isRecord(r.msg) &&
          r.msg.method === "elicitation/create",
      ).length,
    agentSaid: async (text) => {
      await until(
        () => (agentText().includes(text) ? true : undefined),
        `"${text}"`,
      );
    },
    toolResults: () =>
      updates()
        .filter(
          (u) =>
            u.sessionUpdate === "tool_call_update" && u.status === "completed",
        )
        .map((u) => ({
          text: JSON.stringify(u.content),
          meta: isRecord(u._meta) ? u._meta : {},
        })),
    nextTasks: (pred) =>
      until(() => {
        const all = updates();
        for (let i = updateMark; i < all.length; i++) {
          const items = taskItems(all[i]);
          if (items === undefined || !pred(items)) continue;
          updateMark = i + 1;
          return items;
        }
        return undefined;
      }, "a matching task list"),
    gate(name) {
      const file = join(out, name);
      const release = () => writeFileSync(file, "");
      onTestFinished(release);
      return {
        command: `until [ -e '${file}' ] || [ $SECONDS -ge 30 ]; do sleep 0.1; done`,
        release,
      };
    },
  };
}
