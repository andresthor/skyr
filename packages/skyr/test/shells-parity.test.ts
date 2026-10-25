// skyr's bash runs Pi's own code path. These rows pin that against the pinned Pi, so a Pi bump that
// changes what a call returns, or what `bash` declares, turns one of them red.
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { registerSkyr } from "../src/index.js";
import { scratchDir, script } from "./session.js";
import {
  bashInEffect,
  type ShellRuntime,
  shellRuntime,
} from "./shells-runtime.js";

type Call = [id: string, args: Record<string, string | number | boolean>];

const mask = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value ?? null)
      .replace(/pi-bash-[A-Za-z0-9_-]+\.log/g, "pi-bash-X.log")
      .replace(/"wall_time_seconds":[\d.]+/g, '"wall_time_seconds":0')
      .replace(/wall_time_seconds\\":[\d.]+/g, 'wall_time_seconds\\":0')
      .replace(/durationMs\\":\d+/g, 'durationMs\\":0'),
  );

/** A tool that runs `bash` as a nested call, the way a codemode script does. */
const nest = defineTool({
  name: "nest",
  label: "nest",
  description: "Runs bash as a nested call.",
  parameters: Type.Object({}),
  async execute(_id, _params, _signal, _onUpdate, ctx) {
    const outcome = await ctx.executeTool("bash", {
      command: "echo nested; exit 2",
    });
    return {
      content: [{ type: "text", text: JSON.stringify(mask(outcome)) }],
      details: undefined,
    };
  },
}) as unknown as ToolDefinition;

/** A shell at `~/probe/bash`, which a `~` and a `file://` shellPath both reach. */
function probeShell(): string {
  const dir = join(homedir(), "probe");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "bash");
  if (!existsSync(path)) symlinkSync("/bin/bash", path);
  return path;
}

/** Pi's own bash in one session and skyr's in another, given the same settings and calls. */
async function bothRun(
  settings: Record<string, unknown>,
  calls: Call[],
  during?: (rt: ShellRuntime) => void,
) {
  const run = async (extensions: (typeof registerSkyr)[]) => {
    const rt = await shellRuntime({
      extensions,
      settings,
      customTools: [nest],
      respond: script(
        ...calls.map(([id, args]) =>
          fauxAssistantMessage([
            fauxToolCall(id === "nest" ? "nest" : "bash", args, { id }),
          ]),
        ),
      ),
    });
    during?.(rt);
    await rt.session.prompt("go");
    return rt;
  };
  const pi = await run([]);
  const skyr = await run([registerSkyr]);
  expect(bashInEffect(pi.session)?.sourceInfo.source).toBe("builtin");
  expect(bashInEffect(skyr.session)?.sourceInfo.source).not.toBe("builtin");
  return { pi, skyr };
}

function resultsOf(rt: ShellRuntime) {
  return Object.fromEntries(
    rt.session.messages.flatMap((m) =>
      m.role === "toolResult"
        ? [
            [
              m.toolCallId,
              mask({
                content: m.content,
                details: m.details,
                structuredContent: rt.structured.get(m.toolCallId),
                isError: m.isError,
              }),
            ],
          ]
        : [],
    ),
  );
}

/** Streaming differs in timing from one run to the next, so only none, one or many compare. */
function partialClasses(rt: ShellRuntime) {
  return Object.fromEntries(
    [...rt.updates].map(([id, partials]) => [
      id,
      partials.length > 1 ? "many" : "one",
    ]),
  );
}

async function expectParity(
  settings: Record<string, unknown>,
  calls: Call[],
  during?: (rt: ShellRuntime) => void,
) {
  const { pi, skyr } = await bothRun(settings, calls, during);
  const want = resultsOf(pi);
  expect(Object.keys(want)).toEqual(calls.map(([id]) => id));
  expect(resultsOf(skyr)).toEqual(want);
  expect(partialClasses(skyr)).toEqual(partialClasses(pi));
}

// What skyr adds to the description of Pi's bash
const SUFFIX =
  "A call still running after 120 s keeps running as a background job, and you are told when it ends.";

const PREFIX = { shellCommandPrefix: "export PREFIXED=yes" };

describe("bash parity with Pi's own", () => {
  test("results and exit codes", () =>
    expectParity({}, [
      ["exit0", { command: "echo hi" }],
      ["exit3", { command: "echo out; echo err >&2; exit 3" }],
      ["empty", { command: "true" }],
      ["empty-fail", { command: "false" }],
    ]));

  test("truncation and its temp-file footer", () =>
    expectParity({}, [
      ["lines", { command: "seq 1 3000" }],
      ["longline", { command: "head -c 60000 /dev/zero | tr '\\0' x" }],
    ]));

  test("the session environment and shellCommandPrefix reach the command", async () => {
    const calls: Call[] = [
      [
        "env",
        {
          command:
            'printf "%s|%s|%s" "${#PI_SESSION_ID}" "$PI_MODEL" "$PREFIXED"',
        },
      ],
    ];
    await expectParity(PREFIX, calls);
    const { skyr } = await bothRun(PREFIX, calls);
    expect(JSON.stringify(resultsOf(skyr).env)).toContain("36|faux-1|yes");
  });

  test.each([
    ["~", () => "~/probe/bash"],
    ["file://", () => `file://${join(homedir(), "probe", "bash")}`],
  ])("a %s shellPath runs the command", async (_form, shellPath) => {
    probeShell();
    await expectParity({ shellPath: shellPath() }, [
      ["probe", { command: "echo $0 | grep -c probe" }],
    ]);
  });

  // exec: a shell that outlives its killed child prints the child's pid
  test("a timeout kills the call, and an invalid one is Pi's error", () =>
    expectParity({}, [
      ["timeout", { command: "echo start; exec sleep 5", timeout: 0.5 }],
      ["bad-timeout", { command: "echo x", timeout: -1 }],
    ]));

  test("Esc mid-call gives Pi's abort result", () =>
    expectParity(
      {},
      [["esc", { command: "echo started; exec sleep 30" }]],
      (rt) => {
        rt.session.subscribe((e) => {
          if (
            e.type === "tool_execution_update" &&
            JSON.stringify(e.partialResult).includes("started")
          )
            void rt.session.abort();
        });
      },
    ));

  test("a missing command reports line 1, so nothing is prepended on its line", () =>
    expectParity({}, [["missing", { command: "nosuchcmd" }]]));

  test("a background child without a redirect leaves the call as Pi does", () => {
    // The child ends when the test's scratch dir is removed, or after 30 s
    const dir = scratchDir("gate");
    return expectParity({}, [
      [
        "amp",
        {
          command: `(while [ -d '${dir}' ] && [ $SECONDS -lt 30 ]; do sleep 0.05; done) & echo started`,
        },
      ],
    ]);
  });

  test("a nested call runs as Pi's does", () =>
    expectParity({}, [["nest", {}]]));

  test("the definition is Pi's plus one sentence: renderers, schemas and prompt text", async () => {
    const { pi, skyr } = await bothRun({}, [["x", { command: "true" }]]);
    const a = pi.session.getToolDefinition("bash");
    const b = skyr.session.getToolDefinition("bash");
    expect(b).toBeDefined();
    expect(String(b?.renderCall)).toBe(String(a?.renderCall));
    expect(String(b?.renderResult)).toBe(String(a?.renderResult));
    expect(b?.description).toBe(`${a?.description} ${SUFFIX}`);
    for (const key of [
      "name",
      "label",
      "promptSnippet",
      "promptGuidelines",
      "parameters",
      "outputSchema",
      "constrainedSampling",
    ] as const)
      expect(b?.[key], key).toEqual(a?.[key]);
  });

  test("the model is offered Pi's bash entry in Pi's place among the tools, with Pi's prompt lines for it", async () => {
    const { pi, skyr } = await bothRun({}, [["x", { command: "true" }]]);
    const system = (rt: ShellRuntime) => {
      const message = rt.requests[0]?.messages.find((m) => m.role === "system");
      return {
        tools: message?.toolsAdded ?? [],
        // skyr's other tools add their own lines; the bash lines are what must match
        lines: Object.values(message?.sections ?? {})
          .flatMap((text) => (text ?? "").split("\n"))
          .filter((line) => /\bbash\b|PI_\*/.test(line)),
      };
    };
    const want = system(pi);
    const got = system(skyr);
    const piNames = want.tools.map((t) => t.name);
    expect(
      got.tools.map((t) => t.name).filter((n) => piNames.includes(n)),
    ).toEqual(piNames);
    const piBash = want.tools.find((t) => t.name === "bash");
    expect(got.tools.find((t) => t.name === "bash")).toEqual({
      ...piBash,
      description: `${piBash?.description} ${SUFFIX}`,
    });
    expect(got.lines).toEqual(want.lines);
    expect(want.lines.length).toBeGreaterThan(0);
  });
});
