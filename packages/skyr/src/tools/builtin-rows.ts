/**
 * Pi's built-in tool rows as ledger records. The one way to restyle the host's own rows is its
 * public resolver, so this registers one: behind `ui.builtinRows`, only over Pi's own renderers,
 * and handing the host's renderers back for anything else. A view that does not know a result's
 * shape, or throws, makes the row draw the host's components instead (`toolRenderers`).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiModule } from "../pi.js";
import type { Row, ToolView } from "../ui/row.js";
import { toolRenderers } from "../ui/row.js";
import { readUiSettings } from "../ui-config.js";
import { findView, grepView, lsView } from "./builtin/search.js";

/** Views take the arguments of their own tool; a resolver only knows the name. */
type View = (v: ToolView<never>) => Row | undefined;

const VIEWS = new Map<string, View>([
  ["grep", grepView],
  ["find", findView],
  ["ls", lsView],
]);

/**
 * What Pi's renderers for each viewed tool are, as source text: the renderers of `bash` are made
 * fresh on each call, so identity cannot tell Pi's from another extension's, and source can.
 */
function fingerprints(host: PiModule): Map<string, string> {
  const own = {
    grep: host.createGrepToolDefinition,
    find: host.createFindToolDefinition,
    ls: host.createLsToolDefinition,
  };
  return new Map(
    Object.entries(own)
      .filter(([name]) => VIEWS.has(name))
      .map(([name, create]) => [name, fingerprintOf(create(process.cwd()))]),
  );
}

const fingerprintOf = (renderers: {
  renderShell?: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
}): string =>
  [renderers.renderShell, renderers.renderCall, renderers.renderResult]
    .map(String)
    .join("\u0000");

/**
 * Registers the resolver unless `ui.builtinRows` is false. The setting is settled before this
 * returns, which is before Pi builds any row of this load, including the rows of a resumed
 * session: they are drawn before `session_start`, so the setting cannot wait for it.
 */
export async function registerBuiltinRows(
  pi: ExtensionAPI,
  host: PiModule,
): Promise<void> {
  const { builtinRows } = await readUiSettings();
  if (!builtinRows) return;
  const own = fingerprints(host);
  pi.registerToolRenderer((name, next) => {
    // Once: every resolver after this one runs again on a second call
    const base = next();
    const view = VIEWS.get(name);
    if (!base || !view || own.get(name) !== fingerprintOf(base)) return base;
    return toolRenderers(view, base);
  });
}
