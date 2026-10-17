/**
 * `registerVoice` through its public interface: registration shape, the no-credential stub,
 * the headless start (no UI mount in a UI-less mode), the config pick-up from skyr.json, and
 * the refused-start guard. A minimal fake ExtensionAPI/ExtensionContext stands in for the host;
 * this drive reaches the same public entry the resource loader reaches in
 * test/pi-contract.test.ts for the other registrars.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import type { SessionOptions } from "../src/voice/client.js";
import type { SttCredentials } from "../src/voice/credentials.js";
import type { VoiceEditorLike } from "../src/voice/editor.js";
import {
  registerVoice,
  startRefusal,
  VOICE_SHORTCUT,
} from "../src/voice/index.js";

interface FakePi {
  commands: Map<
    string,
    {
      description: string;
      handler: (args: string, ctx: unknown) => Promise<void>;
    }
  >;
  shortcuts: Map<
    string,
    { description: string; handler: (ctx: unknown) => void }
  >;
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<void>>;
}

function fakePi(): FakePi {
  const commands = new Map();
  const shortcuts = new Map();
  const handlers = new Map();
  return {
    commands,
    shortcuts,
    handlers,
    registerCommand: (name: string, spec: never) => commands.set(name, spec),
    registerShortcut: (keys: string, spec: never) => shortcuts.set(keys, spec),
    on: (event: string, fn: never) => handlers.set(event, fn),
  } as unknown as FakePi;
}

interface ThemeStub {
  name: string;
  getFgAnsi(token: string): string;
}

/** `theme` is a mutable property so a test can swap it mid-session the way /theme does. */
function fakeCtx(
  mode: "tui" | "json",
  theme?: ThemeStub & Record<string, unknown>,
) {
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setEditorComponent: vi.fn(),
    getEditorComponent: vi.fn(() => undefined),
    getEditorText: vi.fn(() => ""),
    setEditorText: vi.fn(),
    theme,
  };
  const ctx = { ui, mode, hasUI: true, cwd: tmpdir() };
  return { ui, ctx: ctx as never, uiTyped: ui as unknown };
}

/** A theme stub where every token answers in one SGR colour, so any glyph names the theme. */
const theme = (
  light: boolean,
  rgb: string,
): ThemeStub & Record<string, unknown> => ({
  name: light ? "fake-light" : "fake-dark",
  getFgAnsi: () => rgb,
});

const CORTI = [
  "CORTI_ENVIRONMENT",
  "CORTI_TENANT_NAME",
  "CORTI_CLIENT_ID",
  "CORTI_CLIENT_SECRET",
] as const;

/** CORTI_* env for one test; test/setup.ts scrubs them from other tests, not this one. */
function withCreds(
  run: (creds: SttCredentials) => Promise<void> | void,
): Promise<void> {
  const creds: SttCredentials = {
    environment: "test-env",
    tenant: "integration-tenant",
    clientId: "integration-id",
    clientSecret: "integration-secret",
  };
  const before = new Map(CORTI.map((k) => [k, process.env[k]]));
  process.env.CORTI_ENVIRONMENT = creds.environment;
  process.env.CORTI_TENANT_NAME = creds.tenant;
  process.env.CORTI_CLIENT_ID = creds.clientId;
  process.env.CORTI_CLIENT_SECRET = creds.clientSecret;
  onTestFinished(() => {
    for (const k of CORTI) process.env[k] = before.get(k);
  });
  return Promise.resolve(run(creds));
}

/** An agent dir per test — skyr.json reads are per-session, and setup.ts's shared tmp is not mine. */
function ownAgentDir(skyrJson?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "skyr-test-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  if (skyrJson !== undefined) writeFileSync(join(dir, "skyr.json"), skyrJson);
  onTestFinished(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("without credentials only the stub /voice exists, and it says so once", async () => {
  const pi = fakePi();
  registerVoice(pi as never, { ascii: true });
  expect(pi.commands.get("voice")?.description).toContain("speech-to-text");
  expect([...pi.shortcuts.keys()]).toEqual([]);
  const ui = { notify: vi.fn() };
  await pi.commands.get("voice")!.handler("", { ui });
  expect(ui.notify).toHaveBeenCalledTimes(1);
  expect(ui.notify.mock.calls[0]?.[0]).toContain("CORTI_CLIENT_ID");
});

test("with credentials, a headless session_start reads the config but mounts no UI", async () => {
  await withCreds(() => {
    const agentDir = ownAgentDir('{"voice": {"frobnicate": true}}');
    const pi = fakePi();
    registerVoice(pi as never, { ascii: true });
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setEditorComponent: vi.fn(),
      getEditorComponent: vi.fn(() => undefined),
    };
    const ctx = { ui, mode: "json", hasUI: false, cwd: agentDir };
    return pi.handlers.get("session_start")!(null, ctx).then(() => {
      // the malformed key is told about once, with the key named
      expect(ui.notify).toHaveBeenCalledTimes(1);
      expect(ui.notify.mock.calls[0]?.[0]).toMatch(/unknown key "frobnicate"/);
      expect(ui.notify.mock.calls[0]?.[1]).toBe("warning");
      // headless ⇒ no editor takeover, no status row
      expect(ui.setEditorComponent).not.toHaveBeenCalled();
      expect(ui.setStatus).not.toHaveBeenCalled();
      // and the shortcut exists regardless of UI mode
      expect([...pi.shortcuts.keys()]).toEqual([VOICE_SHORTCUT]);
    });
  });
});

test("a tui session_start mounts no widget, starts the status cleared, and dictation picks the config up", async () => {
  await withCreds((creds) => {
    ownAgentDir(
      '{"voice": {"language": "da", "punctuation": "spoken", "keyterms": ["Skýr"], "replacements": [{"find": "teh", "replace": "the"}]}}',
    );
    const pi = fakePi();
    const starts: SessionOptions[] = [];
    registerVoice(pi as never, {
      ascii: true,
      controller: {
        start: (o) => {
          starts.push(o);
          return { stop: () => Promise.resolve(""), cancel: () => {} };
        },
      },
    });
    const { ui, ctx } = fakeCtx("tui");
    return pi.handlers.get("session_start")!(null, ctx).then(async () => {
      expect(ui.setEditorComponent).toHaveBeenCalledTimes(1);
      // the status row starts cleared, not drawn over anything permanent
      expect(ui.setStatus).toHaveBeenCalledWith("voice", undefined);
      expect(pi.shortcuts.get(VOICE_SHORTCUT)!.description).toContain(
        "dictation",
      );
      // the shortcut toggles a dictation that resolves the skyr.json config
      pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
      expect(starts).toHaveLength(1);
      const sent = starts[0]!;
      expect(sent.language).toBe("da");
      expect(sent.punctuation).toBe("spoken");
      expect(sent.interims).toBe(true);
      expect(sent.keyterms).toContain("Skýr");
      expect(sent.keyterms).toContain("TypeScript");
      expect(sent.replacements).toContainEqual({ find: "teh", replace: "the" });
      expect(sent.creds).toEqual(creds);
      expect(sent.creds.clientSecret).toBe("integration-secret");
    });
  });
});

test("the voice editor keeps Pi's working status in its top rule, as Pi's own editor does", async () => {
  await withCreds(async () => {
    ownAgentDir();
    const pi = fakePi();
    registerVoice(pi as never, { ascii: true });
    const { ui, ctx } = fakeCtx("tui");
    await pi.handlers.get("session_start")!(null, ctx);
    const factory = ui.setEditorComponent.mock.calls[0]?.[0] as (
      t: unknown,
      theme: unknown,
      keys: unknown,
    ) => { embedWorkingStatus: boolean };
    const ed = factory({ requestRender: () => {} }, {}, {});
    expect(ed.embedWorkingStatus).toBe(true);
  });
});

test("the refused start names the fix, only when a focused editor could have dictated", () => {
  expect(
    startRefusal(true, { focused: false } as unknown as VoiceEditorLike),
  ).toBeUndefined();
  expect(startRefusal(false, undefined)).toBeUndefined();
  expect(
    startRefusal(false, { focused: true } as unknown as VoiceEditorLike),
  ).toBeUndefined();
  expect(
    startRefusal(false, { focused: false } as unknown as VoiceEditorLike),
  ).toMatch(/a card or selector has the keyboard/);
});

test("a second session_start reinstates the voice editor, and a foreign factory keeps the fallback", () => {
  return withCreds(() => {
    ownAgentDir();
    const pi = fakePi();
    const starts: SessionOptions[] = [];
    registerVoice(pi as never, {
      ascii: true,
      controller: {
        start: (o) => {
          starts.push(o);
          return { stop: () => Promise.resolve(""), cancel: () => {} };
        },
      },
    });
    const { ui, ctx } = fakeCtx("tui");
    return pi.handlers.get("session_start")!(null, ctx)
      .then(async () => {
        expect(ui.setEditorComponent).toHaveBeenCalledTimes(1);
        // second session: ours is still the installed factory, so it is reinstated, not skipped
        return pi.handlers.get("session_start")!(null, ctx);
      })
      .then(() => {
        expect(ui.setEditorComponent).toHaveBeenCalledTimes(2);
        // and dictation still goes through the controller afterwards
        pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
        expect(starts).toHaveLength(1);

        // a foreign editor wins: nothing of ours is installed, dictation rides setEditorText
        const foreign = () => ({});
        const foreignUi = {
          getEditorComponent: vi.fn(() => foreign),
          setEditorComponent: vi.fn(),
          setStatus: vi.fn(),
        };
        const foreignCtx = {
          ui: foreignUi,
          mode: "tui",
          hasUI: true,
          cwd: tmpdir(),
        };
        return pi.handlers.get("session_start")!(null, foreignCtx).then(() => {
          expect(foreignUi.setEditorComponent).not.toHaveBeenCalled();
        });
      });
  });
});

test("a mid-session theme switch reaches the status row and the editor's ghost/firm palette", () => {
  return withCreds(() => {
    ownAgentDir();
    const pi = fakePi();
    const starts: SessionOptions[] = [];
    registerVoice(pi as never, {
      ascii: false,
      controller: {
        start: (o) => {
          starts.push(o);
          return { stop: () => Promise.resolve(""), cancel: () => {} };
        },
      },
    });
    const dark = theme(false, "\x1b[38;2;10;20;30m");
    const light = theme(true, "\x1b[38;2;200;190;180m");
    const { ui, ctx } = fakeCtx("tui", dark);
    return pi.handlers.get("session_start")!(null, ctx).then(() => {
      pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
      const row = ui.setStatus.mock.calls.at(-1)?.[1] as string;
      expect(row.startsWith("\x1b[38;2;10;20;30m")).toBe(true);
      // the switch: the same row is rendered from the other theme on the next render
      ui.theme = light;
      pi.shortcuts.get(VOICE_SHORTCUT)!.handler(ctx);
      const switched = ui.setStatus.mock.calls.at(-1)?.[1] as string;
      expect(switched.includes("\x1b[38;2;200;190;180m")).toBe(true);
      // and the editor reads the palette through the same live theme ref
      const factory = ui.setEditorComponent.mock.calls[0]?.[0] as (
        t: unknown,
        theme2: unknown,
        keys: unknown,
      ) => { palette(): { accent: string } };
      const ed = factory(
        { requestRender: () => {} } as never,
        {} as never,
        {} as never,
      );
      expect(ed.palette().accent).toBe("#c8beb4");
    });
  });
});
