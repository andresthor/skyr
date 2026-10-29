// The editor skyr installs: one factory per terminal session, built from Pi's own editor class.
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createBar } from "../src/chrome/bar.js";
import { createEditorHost } from "../src/chrome/editor-host.js";
import { createWorking } from "../src/chrome/working.js";
import { loaderIndicator } from "../src/ui/spinner.js";
import { realIndicator } from "./ui.js";
import { mountedEditor, testPaint, voiceCtx } from "./voice.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
});

type Ctx = ReturnType<typeof voiceCtx>;

const ownFrames = loaderIndicator(testPaint()).frames ?? [];

const newHost = () =>
  createEditorHost({
    working: createWorking(),
    bar: createBar(),
    mode: "color",
    ownFrames: () => ownFrames,
  });
type Entry = { type: string; message?: { role: string; content?: unknown } };

/** A message entry as a session file holds it. */
const said = (role: string, content: unknown): Entry => ({
  type: "message",
  message: { role, content },
});

/** The host's mount, handed the narrow context the tests build. */
const mount = (
  host: ReturnType<typeof newHost>,
  ctx: Ctx,
  reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup",
  entries: Entry[] = [],
) =>
  host.mount(
    {
      ui: ctx.ui,
      sessionManager: { buildContextEntries: () => entries },
    } as never,
    reason,
  );

const workingIndicator = () =>
  realIndicator("working", "Working", {
    indicator: loaderIndicator(testPaint()),
  });

test("the host installs one editor that asks Pi to embed the working status", async () => {
  const host = newHost();
  host.extend((Base) => Base);
  const ctx = voiceCtx();
  await mount(host, ctx);
  expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(1);
  expect(mountedEditor(ctx.ui).embedWorkingStatus).toBe(true);
});

test("the extension's class sits under the working line: its rows are drawn below the line", async () => {
  const host = newHost();
  host.extend(
    (Base) =>
      class extends Base {
        override render(width: number): string[] {
          return [...super.render(width), "extension row"];
        }
      },
  );
  const ctx = voiceCtx();
  await mount(host, ctx);
  const ed = mountedEditor(ctx.ui);
  ed.setWorkingStatusIndicator(workingIndicator());
  const rows = ed.render(60).map(stripTerminalSequences);
  expect(rows[0]).toMatch(/^[·✧✦] Working/);
  expect(rows[1]).toBe("─".repeat(60));
  expect(rows.at(-1)).toBe("extension row");
});

test("a foreign editor installed before keeps the slot and nothing is installed", async () => {
  const host = newHost();
  host.extend((Base) => Base);
  const ctx = voiceCtx({ installed: () => ({}) });
  await mount(host, ctx);
  expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
  expect(host.owns(ctx.ui)).toBe(false);
});

test("a second mount while the host's own editor is installed replaces it, and only the newest factory is owned", async () => {
  const host = newHost();
  host.extend((Base) => Base);
  const ctx = voiceCtx();
  await mount(host, ctx);
  const first = ctx.ui.setEditorComponent.mock.calls[0]?.[0];
  await mount(host, ctx);
  const second = ctx.ui.setEditorComponent.mock.calls[1]?.[0];
  expect(second).toBeDefined();
  expect(second).not.toBe(first);
  expect(host.owns(ctx.ui)).toBe(true);
  ctx.ui.getEditorComponent.mockReturnValue(first);
  expect(host.owns(ctx.ui)).toBe(false);
});

test("owns is false once another extension has installed its editor", async () => {
  const host = newHost();
  host.extend((Base) => Base);
  const ctx = voiceCtx();
  await mount(host, ctx);
  expect(host.owns(ctx.ui)).toBe(true);
  ctx.ui.setEditorComponent((() => ({})) as never);
  expect(host.owns(ctx.ui)).toBe(false);
});

test("a mount still waiting for Pi's module when the session ends installs nothing", async () => {
  const host = newHost();
  host.extend((Base) => Base);
  const ctx = voiceCtx();
  const pending = mount(host, ctx);
  host.stop();
  await pending;
  expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
  expect(host.owns(ctx.ui)).toBe(false);
});

/** Presses ↑ in the mounted editor and reads what it brought back. */
async function historyAfter(
  reason: Parameters<typeof mount>[2],
  entries: Entry[],
  presses = 1,
) {
  const host = newHost();
  host.extend((Base) => Base);
  const ctx = voiceCtx();
  await mount(host, ctx, reason, entries);
  const ed = mountedEditor(ctx.ui);
  const seen: string[] = [];
  for (let i = 0; i < presses; i++) {
    ed.handleInput("\x1b[A");
    seen.push(ed.getText());
  }
  return seen;
}

test("after a reload, resume or fork, ↑ brings back the session's latest prompt first and the earlier ones in order", async () => {
  const entries = [
    said("user", "first"),
    said("assistant", [{ type: "text", text: "ok" }]),
    said("user", [
      { type: "text", text: "sec" },
      { type: "text", text: "ond" },
    ]),
    said("user", "third"),
  ];
  for (const reason of ["reload", "resume", "fork", "new"] as const)
    expect(await historyAfter(reason, entries, 3)).toEqual([
      "third",
      "second",
      "first",
    ]);
});

test("at startup the editor starts with no history, because Pi fills it after the bind", async () => {
  expect(await historyAfter("startup", [said("user", "earlier")])).toEqual([
    "",
  ]);
});

test("a rebuild of the factory carries the prompts sent since the last build, and a startup mount's first build starts bare", async () => {
  const host = newHost();
  host.extend((Base) => Base);
  const ctx = voiceCtx();
  const entries: Entry[] = [said("user", "before")];
  await mount(host, ctx, "startup", entries);
  const last = () => {
    const ed = mountedEditor(ctx.ui);
    ed.handleInput("\x1b[A");
    return ed.getText();
  };
  expect(last()).toBe("");
  entries.push(said("user", "after"));
  expect(last()).toBe("after");
});

test("only the user's text counts: assistant messages, tool results and image-only messages add nothing", async () => {
  const entries = [
    said("user", "kept"),
    said("assistant", "no"),
    said("toolResult", [{ type: "text", text: "no" }]),
    said("user", [{ type: "image", data: "", mimeType: "image/png" }]),
    { type: "custom", message: undefined },
  ];
  expect(await historyAfter("reload", entries, 2)).toEqual(["kept", "kept"]);
});

test("an old entry with null content does not throw", async () => {
  expect(
    await historyAfter("reload", [said("user", "kept"), said("user", null)]),
  ).toEqual(["kept"]);
});

test("without an extension the host still installs an editor, and it draws the working line above a plain rule", async () => {
  const host = newHost();
  const ctx = voiceCtx();
  await mount(host, ctx);
  expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(1);
  const ed = mountedEditor(ctx.ui);
  ed.setWorkingStatusIndicator(workingIndicator());
  const rows = ed.render(60).map(stripTerminalSequences);
  expect(rows[0]).toMatch(/^[·✧✦] Working/);
  expect(rows[1]).toBe("─".repeat(60));
});

test("after another extension installs its editor, a session start that Pi has reset installs skyr's again", async () => {
  const host = newHost();
  const ctx = voiceCtx({ installed: () => ({}) });
  await mount(host, ctx);
  expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
  // Pi resets the slot to its default editor at every session end
  ctx.ui.getEditorComponent.mockReturnValue(undefined);
  await mount(host, ctx);
  expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(1);
  expect(host.owns(ctx.ui)).toBe(false);
});

test("the bar's keys sit under the extension: the extension's key hook sees every key before the bar does", async () => {
  const bar = {
    listing: vi.fn(() => true),
    move: vi.fn(() => true),
    close: vi.fn(),
  };
  const host = createEditorHost({
    working: createWorking(),
    bar,
    mode: "color",
    ownFrames: () => ownFrames,
  });
  const seen: string[] = [];
  host.extend(
    (Base) =>
      class extends Base {
        override handleInput(data: string) {
          seen.push(data);
          // The extension swallows ↑ and lets the rest through
          if (data !== "\x1b[A") super.handleInput(data);
        }
      },
  );
  const ctx = voiceCtx();
  await mount(host, ctx);
  const ed = mountedEditor(ctx.ui);
  ed.handleInput("\x1b[A");
  ed.handleInput("\x1b[B");
  expect(seen).toEqual(["\x1b[A", "\x1b[B"]);
  expect(bar.move.mock.calls).toEqual([[1]]);
});
