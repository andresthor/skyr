/**
 * The bar's keys in the editor: with the bar open and the draft empty, ↑ and ↓ move its
 * highlight. The class sits directly over Pi's `CustomEditor`, which would otherwise spend the
 * same keys on history, and under a feature's extension (voice), so a feature's key hook sees
 * every key first (voice's Esc cancels a dictation before it can close the bar).
 */
import type {
  CustomEditor,
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { failureLatch } from "../ui/guard.js";
import type { BarKeys } from "./bar.js";
import type { EditorClass, MixinArgs } from "./editor.js";

export interface BarKeysDeps {
  readonly bar: BarKeys;
  /** Tells the user once that the keys stopped working. */
  readonly notify: ExtensionUIContext["notify"];
}

/** `Base` with ↑↓ acting on an open bar; every other key, and these when they are not the bar's, reach `Base`. */
export function withBarKeys<B extends EditorClass>(
  Base: B,
  { bar, notify }: BarKeysDeps,
): B {
  class BarKeysEditor extends Base {
    /** A throw from the bar's side happened once: for this editor's life every key goes to Pi. */
    private latched = false;
    private readonly failures = failureLatch();
    private readonly bindings: KeybindingsManager;

    constructor(...args: MixinArgs) {
      super(...args);
      this.bindings = (args as ConstructorParameters<typeof CustomEditor>)[2];
    }

    override handleInput(data: string) {
      if (!this.takes(data)) super.handleInput(data);
    }

    /** Whether the bar took `data`. Pi calls this outside any handler of its own, so nothing may throw out of it. */
    private takes(data: string): boolean {
      if (this.latched) return false;
      try {
        if (!bar.listing() || this.isShowingAutocomplete()) return false;
        const keys = this.bindings;
        let by: 1 | -1 | undefined;
        if (keys.matches(data, "tui.select.up")) by = -1;
        else if (keys.matches(data, "tui.select.down")) by = 1;
        // A draft in the box means the arrows are the editor's; so are they when the bar has nothing to move
        if (by === undefined || this.getText() !== "") return false;
        return bar.move(by);
      } catch (cause) {
        this.latched = true;
        this.failures.trip(cause, (reason) =>
          notify(
            `skyr: the bar's keys stopped working after an error (${reason}); /reload brings it back`,
            "warning",
          ),
        );
        return false;
      }
    }
  }
  return BarKeysEditor;
}
