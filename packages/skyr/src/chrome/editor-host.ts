/**
 * Installs skyr's input editor once per terminal session and answers whether Pi still has it.
 * The class is built per mount, innermost first: Pi's `CustomEditor`, a feature's extension, the
 * working line; a feature never installs an editor of its own, so Pi swaps editors (and discards
 * what a swap discards) once.
 */
import type {
  CustomEditor,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { loadPi } from "../pi.js";
import { type Tier, tierOf } from "../ui/caps.js";
import type { Paint } from "../ui/palette.js";
import { withWorkingLine } from "./editor.js";
import type { Working } from "./working.js";

type EditorClass = typeof CustomEditor;

export interface EditorHost {
  /** Registers how a feature extends the editor class; called once at registration. The class it returns sits under the working line. */
  extend(extension: (Base: EditorClass, paint: Paint) => EditorClass): void;
  /** Installs the editor for a terminal session, once; leaves the slot alone when another extension holds it. */
  mount(ctx: Pick<ExtensionContext, "ui">): Promise<void>;
  /** Whether Pi still has the host's own factory installed. */
  owns(ui: { getEditorComponent(): unknown }): boolean;
  /** A session ended: a mount still waiting for Pi's module installs nothing. */
  stop(): void;
}

export function createEditorHost(deps: {
  working: Working;
  /** Test seam; the terminal's own tier when not given. */
  mode?: Tier;
}): EditorHost {
  const mode = deps.mode ?? tierOf(process.env);
  let extension: Parameters<EditorHost["extend"]>[0] | undefined;
  let factory: Parameters<ExtensionUIContext["setEditorComponent"]>[0];
  // Bumped by every mount and by stop(), so a mount that lost the race to either installs nothing
  let generation = 0;
  return {
    extend(next) {
      extension = next;
    },
    async mount(ctx) {
      if (!extension) return;
      const mine = ++generation;
      const installed = ctx.ui.getEditorComponent();
      // A foreign editor wins; Pi's own loader then shows
      if (installed && installed !== factory) return;
      const { CustomEditor } = await loadPi();
      if (mine !== generation) return;
      // Pi's theme handle is one live proxy, so /theme reaches the editor
      const paint: Paint = { theme: ctx.ui.theme, mode };
      const Editor = withWorkingLine(extension(CustomEditor, paint), {
        paint,
        working: deps.working,
        notify: (message, type) => ctx.ui.notify(message, type),
      });
      factory = (tui, theme, keys) =>
        // Pi does not copy this constructor-only flag; without it Pi draws its loader in a row of its own
        new Editor(tui, theme, keys, { embedWorkingStatus: true });
      ctx.ui.setEditorComponent(factory);
    },
    owns: (ui) => factory !== undefined && ui.getEditorComponent() === factory,
    stop() {
      generation += 1;
    },
  };
}
