<h3 align="center">
  skyr
</h3>

<p align="center">
  Extensions for the <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent">Pi coding agent</a> — web tools, subagents, voice dictation, background shells and a readier terminal UI.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent">
    <img src="https://img.shields.io/badge/Pi-%E2%89%A5%201.3.0-8bd5ca?style=for-the-badge&colorA=363a4f" alt="Pi ≥ 1.3.0"/>
  </a>
  &nbsp;
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-f5a97f?style=for-the-badge&colorA=363a4f" alt="License: MIT"/>
  </a>
</p>

<p align="center">
  <!-- hero screenshot: theme-aware <picture> block goes here -->
  <picture></picture>
</p>

*Skýr* — Icelandic for clear, sharp. Without the accent, the yoghurt: made by stirring a
spoonful of the last batch into the next.

A Pi package: tools and a terminal UI that every session of the Pi coding agent loads. Pi runs
the TypeScript source directly, so there is nothing to build.

## Features

- **Web tools** — `web_fetch` returns one URL as markdown and refuses private and local addresses; `web_search` tries Tavily, then Exa, then Parallel, each taking over when the one before fails, with no key needed.
- **Subagents from markdown** — an agent is a markdown file; up to eight tasks run in parallel or in the background, and a writer without a directory gets its own fresh git worktree.
- **Nothing is lost to a timeout** — a `bash` call still running at 120 s becomes a background job, `bash_stop` and `/shells` manage it, and the model is told when it ends.
- **`ask_user`** — questions with options in place of the input editor, up to four at once, with a Review tab and a receipt that survives a resume.
- **Dictation** — `ctrl+space` dictates into the input editor: interims follow the cursor as ghost text, commits land at the cursor, and text is never auto-sent.
- **Advisor** — a stronger model reviews the session before the agent commits to an approach or declares a task done, once `skyr.json` names one.
- **A three-line footer** — context meter, turns and cost, cache hit rate, and per-provider spend for the day and the month.
- **Restyled built-in rows** — diffs on `edit` records, output tails on `bash` records, `ctrl+o` expands.

&nbsp;

## Quick start

```sh
git clone https://github.com/andresthor/skyr.git
pi install ./skyr/packages/skyr      # every `pi` from then on loads it
```

Needs Pi 1.3.0 or later. To try it without installing:

```sh
pi -e ./skyr/packages/skyr          # for one run
```

Edits to the source apply on the next start.

&nbsp;

## What's inside

Tools the model gets:

| Tool | What it does | Details |
| --- | --- | --- |
| `web_search` | searches the web, cascading providers, no key needed | [docs/tools.md](docs/tools.md) |
| `web_fetch` | fetches one URL as markdown; refuses private and local addresses | [docs/tools.md](docs/tools.md) |
| `subagent` | hands tasks to agents defined in markdown files; tasks run in parallel or in the background | [docs/subagents.md](docs/subagents.md) |
| `bash`, `bash_stop` | Pi's own `bash` plus background jobs that outlive their timeout | [docs/background-shells.md](docs/background-shells.md) |
| `ask_user` | asks you a question in place of the input editor and waits | [docs/ask-user.md](docs/ask-user.md) |
| `advisor` | asks a stronger model for a second opinion, once configured | [docs/advisor.md](docs/advisor.md) |

What changes on your screen:

| Piece | What it does | Details |
| --- | --- | --- |
| Editor | a working line with a spinner, the running tool and the interrupt key; `/reload` keeps the draft and refills ↑ history | [docs/editor.md](docs/editor.md) |
| Voice | `ctrl+space` or `/voice` dictates into the input editor | [docs/voice.md](docs/voice.md) |
| Bar | one line above the editor with every live subagent and shell; `/subagents` and `/shells` open it | [docs/subagents.md](docs/subagents.md) |
| Footer | context meter, turns and cost, token totals, per-provider spend | [docs/footer.md](docs/footer.md) |
| Built-in tool rows | restyled records for Pi's seven built-in tools | [docs/tool-rows.md](docs/tool-rows.md) |

Hosts building their own Pi distribution can embed skyr with `await registerSkyr(pi)` — see
[docs/embedding.md](docs/embedding.md).

&nbsp;

## Configuration

Everything lives in `<agentDir>/skyr.json` — `<agentDir>` is the agent dir Pi runs,
`~/.pi/agent` by default. Most keys apply from the next session:

```json
{
  "advisor": { "model": "corti/corti-s1-beta" },
  "voice": { "language": "en-US", "keyterms": ["TypeScript"] },
  "ui": { "footer": true, "builtinRows": true }
}
```

- [`advisor`](docs/advisor.md) — off until a model is named; every call sends the whole branch to that model's provider.
- [`voice`](docs/voice.md) — language, keyterms, replacements and Corti formatting rules; `CORTI_*` credentials come from the environment.
- [`ui`](docs/footer.md) — give Pi's footer and rows back with `false` values. See also [built-in rows](docs/tool-rows.md).

&nbsp;

## Developing

<details>
<summary>Commands and scratch configs</summary>

```sh
pnpm install
pnpm test        # vitest across packages
pnpm typecheck
pnpm lint        # biome, knip, bin/craft-check.mjs
pnpm format      # biome: apply its fixes
```

To try changes without touching your own `~/.pi`, run Pi against a separate config dir —
`bin/experimental`, `lib/pi-profile.sh` and `pi -ne` are covered in
[docs/developing.md](docs/developing.md).

</details>

&nbsp;

## License

MIT — see [LICENSE](LICENSE).
