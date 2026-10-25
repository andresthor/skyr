// The command-context probes tengi-smoke drives, as an extension tengi loads with `--extension`.
// Each load and each UI member `/probe-ui-all` tries is one JSON line in $PROBE_OUT. Its table is
// keyed by every member of `ExtensionUIContext`, so a Pi upgrade that adds one fails `tsc` here.
import { appendFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

function log(rec: Record<string, unknown>): void {
  const out = process.env.PROBE_OUT;
  if (out === undefined) throw new Error("dialog-probe: PROBE_OUT is not set");
  appendFileSync(out, `${JSON.stringify(rec)}\n`);
}

type UICoverage = {
  [K in keyof ExtensionUIContext]: (
    ui: ExtensionUIContext,
  ) => Promise<unknown> | unknown;
};

const UI_COVERAGE: UICoverage = {
  select: (ui) => ui.select("probe", ["a", "b"], { timeout: 50 }),
  confirm: (ui) => ui.confirm("probe", "probe", { timeout: 50 }),
  input: (ui) => ui.input("probe", "probe", { timeout: 50 }),
  notify: (ui) => ui.notify("probe-ui-all notify", "info"),
  onTerminalInput: (ui) => ui.onTerminalInput(() => undefined)(),
  setStatus: (ui) => ui.setStatus("probe", "probe"),
  setWorkingMessage: (ui) => ui.setWorkingMessage("probe"),
  setWorkingVisible: (ui) => ui.setWorkingVisible(true),
  setWorkingIndicator: (ui) => ui.setWorkingIndicator({ frames: ["."] }),
  setHiddenThinkingLabel: (ui) => ui.setHiddenThinkingLabel("probe"),
  setWidget: (ui) => ui.setWidget("probe", ["probe"]),
  setFooter: (ui) => ui.setFooter(undefined),
  setHeader: (ui) => ui.setHeader(undefined),
  setTitle: (ui) => ui.setTitle("probe"),
  custom: (ui) =>
    ui.custom<string>((_tui, _theme, _keybindings, done) => {
      queueMicrotask(() => done("probe"));
      return { render: () => [], invalidate: () => {} };
    }),
  pasteToEditor: (ui) => ui.pasteToEditor(""),
  setEditorText: (ui) => ui.setEditorText(""),
  getEditorText: (ui) => ui.getEditorText(),
  editor: (ui) => ui.editor("probe", "probe"),
  addAutocompleteProvider: (ui) =>
    ui.addAutocompleteProvider((current) => current),
  setEditorComponent: (ui) => ui.setEditorComponent(undefined),
  getEditorComponent: (ui) => ui.getEditorComponent(),
  theme: (ui) => ui.theme.fg("accent", "probe"),
  getAllThemes: (ui) => ui.getAllThemes(),
  getTheme: (ui) => ui.getTheme("default"),
  setTheme: (ui) => ui.setTheme(ui.theme),
  getToolsExpanded: (ui) => ui.getToolsExpanded(),
  setToolsExpanded: (ui) => ui.setToolsExpanded(ui.getToolsExpanded()),
};

export default function (pi: ExtensionAPI): void {
  log({ loaded: true });
  pi.registerCommand("probe-ui-all", {
    description: "probe: every ExtensionUIContext member once",
    handler: async (_args, ctx) => {
      for (const [member, call] of Object.entries(UI_COVERAGE)) {
        try {
          await call(ctx.ui);
          log({ member, ok: true });
        } catch (error) {
          log({ member, ok: false, error: String(error) });
        }
      }
    },
  });
  pi.registerCommand("probe-reload", {
    description: "probe: ExtensionCommandContext.reload",
    handler: async (_args, ctx) => ctx.reload(),
  });
}
