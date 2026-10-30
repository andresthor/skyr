# Developing

```sh
pnpm install
pnpm test        # vitest across packages
pnpm typecheck
pnpm lint        # biome, knip (nothing unused; test-only exports need @internal), bin/craft-check.mjs
pnpm format      # biome: apply its fixes
```

To try changes without touching your own `~/.pi`, run Pi against a separate config dir:

```
bin/experimental                  pi against configs/experimental/agent — own settings, sessions and login
source lib/pi-profile.sh <name>   points plain `pi` at configs/<name>/agent for this shell
pi -ne                            bare pi: no extensions, no skyr
```

`PI_CODING_AGENT_DIR` relocates Pi's whole config dir, so configs run side by side and share
nothing. Config dirs hold credentials and sessions and are gitignored.

`bin/experimental` also attaches the extensions listed in `PI_EXTRA_EXTENSIONS` (colon-separated
paths) — useful for ones your own `~/.pi` loads that should follow you into the scratch config.
Set it for one run, or keep it in a gitignored `.env` at the repo root:

```sh
PI_EXTRA_EXTENSIONS="$HOME/.pi/agent/extensions/my-extension.ts"
```
