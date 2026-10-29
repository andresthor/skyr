// The editor skyr installs: one factory per terminal session, built from Pi's own editor class.
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

const newHost = () =>
  createEditorHost({ working: createWorking(), mode: "color" });
/** The host's mount, handed the narrow context the tests build. */
const mount = (host: ReturnType<typeof newHost>, ctx: Ctx) =>
  host.mount(ctx as never);

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
