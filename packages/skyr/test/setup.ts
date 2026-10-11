// No test may see the real home, agent dir, credentials or network. Plain assignments, not
// vi.stubEnv/stubGlobal: tests that call vi.unstubAll* would otherwise restore the real ones.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET_ENV =
  /_(API_KEY|TOKEN)$|^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|PROFILE)$|^GOOGLE_(APPLICATION_CREDENTIALS|CLOUD_PROJECT)$|^AZURE_/;

process.env.HOME = mkdtempSync(join(tmpdir(), "skyr-test-home-"));
// Not under HOME, so code that hardcodes ~/.pi instead of calling getAgentDir() misses it.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(
  join(tmpdir(), "skyr-test-agent-"),
);
process.env.PI_OFFLINE = "1";
for (const key of Object.keys(process.env)) {
  if (SECRET_ENV.test(key)) delete process.env[key];
}

globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  throw new Error(`test reached the network: ${url}`);
};
