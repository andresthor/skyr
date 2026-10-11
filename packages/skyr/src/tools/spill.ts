/** Full text that was cut from a tool result, written where a model can `read` all of it. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let spillRoot: Promise<string> | undefined;

/** One directory per process. Holds the promise, so parallel calls cannot both create one. */
function spillDir(): Promise<string> {
  spillRoot ??= mkdtemp(join(tmpdir(), "skyr-"));
  return spillRoot;
}

/**
 * Writes `text` to `<name>.md` in the OS temp dir and returns the path. Callers pass a name
 * unique to the call, such as its tool-call id, so parallel calls cannot overwrite each other.
 */
export async function spill(name: string, text: string): Promise<string> {
  // A nested call's id contains a slash, which would read as a directory.
  const path = join(await spillDir(), `${name.replace(/[^\w.-]/g, "_")}.md`);
  await writeFile(path, text, "utf8");
  return path;
}
