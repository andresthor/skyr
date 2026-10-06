# skyr

*Skýr* — Icelandic for clear, sharp. Without the accent, the yoghurt: made by stirring a
spoonful of the last batch into the next.

My setup for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
as a Pi package.

## Install

Needs Pi 0.99.2 or later. From a checkout:

```sh
pi install /path/to/skyr/packages/skyr    # every `pi` loads it from then on
pi -e /path/to/skyr/packages/skyr         # or try it for one run
```

Pi loads the TypeScript source directly, so edits apply on the next start.

## Tools

- `web_fetch` — fetches one URL as markdown; refuses private and local addresses.
- `web_search` — searches through Tavily, then Exa, then Parallel, each taking over when the one
  before fails; no key needed. `TAVILY_API_KEY`, `EXA_API_KEY` or `PARALLEL_API_KEY` moves that
  service off its rate-limited free tier. Queries go to those services and may carry
  conversation content.

## Embedding it

A host that builds its own Pi distribution can call `registerSkyr(pi, options)` instead of
loading the default export — see `packages/skyr/src/index.ts`.

## Developing

```sh
pnpm install
pnpm test        # vitest across packages
pnpm typecheck
pnpm lint        # biome: formatting, lint and import order
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

## License

MIT
