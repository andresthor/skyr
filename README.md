# skyr

*Skýr* — Icelandic for clear, sharp. Without the accent, the yoghurt: made by stirring a
spoonful of the last batch into the next.

My setup for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
as a Pi package.

## Install

Needs Pi 1.3.0 or later. From a checkout:

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
- `subagent` — hands a task to an agent defined in a markdown file. The agent runs as a fresh
  session with its own context and returns only its final answer. Several calls in one turn run
  in parallel, and Esc stops them.

## Voice

`ctrl+space` (or `/voice`) starts dictating into the input editor: spoken words commit at the
cursor as plain text, with the interim ones following the cursor as ghost text. Esc cancels and
puts the editor back the way it was, Enter stops without sending (the next Enter sends), so text
is never auto-sent. Quiet only asks the server for the pending final early — it never ends a
dictation. Without `CORTI_*` credentials, `/voice` says so in one line and does nothing else.
`/voice on` starts a dictation and leaves a running one alone; `/voice off` discards it like
Esc. Any other argument is refused with the valid forms.

While voice is on, the editor's bottom rule shows it: a level meter that rises only for speech,
`●` while the mic records (`○` before the first audio and after it closes), the state
(`starting`, `listening`, `finishing`), and the keys that apply right now. Esc and ctrl+c both
discard; if they reverted words already committed, the rule offers `ctrl+-` to undo that for two
seconds or until the next key. The footer shows the same marks only while the voice editor
cannot carry its rule — a card has the keyboard, another extension owns the editor, or the
rule drawing failed. Under `NO_COLOR` the marks stay and lose their colour; `TERM=dumb` gets
ASCII.

Credentials, like every other secret here, come from the environment:

```
CORTI_ENVIRONMENT          e.g. eu
CORTI_TENANT_NAME          the tenant realm
CORTI_CLIENT_ID
CORTI_CLIENT_SECRET
```

Behaviour knobs live in `<agentDir>/skyr.json` under the `voice` key:

```json
{
  "voice": {
    "language": "en-US",
    "interims": true,
    "punctuation": "automatic",
    "keyterms": ["TypeScript"],
    "replacements": [{ "find": "type script", "replace": "TypeScript" }]
  }
}
```

`keyterms` and `replacements` are appended to the built-in coding vocabulary; edits apply on the
next session. A malformed section degrades to the defaults and is reported once per session,
never a startup failure. Term caps are Corti's: 50 chars / 5 words per keyterm, 100 chars / 10 words per
replacement, 1,000 per connection.

## Subagents

An agent is a markdown file. The frontmatter describes it; the body is added to its system
prompt.

```markdown
---
name: scout                  # optional; defaults to the file name
description: Finds code and explains how something works in this repository.
tools: read, grep, find, ls  # optional; Claude Code names such as Read or Glob also work
model: provider/model-id     # optional; anything `pi --model` accepts; defaults to the parent's
---
You are a scout. …
```

Pi looks for agents in `agents/` under its config dir (`~/.pi/agent/agents/` by default) and, in
a project Pi trusts, in `.pi/agents/`. A project agent replaces a user agent of the same name.
Edits apply after `/reload`. Without `tools`, an agent gets `read`, `grep`, `find`, `ls`,
`bash`, `web_search` and `web_fetch`. Pi lists the agents to the model.

A call needs no agent file: without `agent` the model gets a general-purpose subagent with Pi's
own prompt, the default tools, the parent's model and working directory. On any call, `prompt`
(added to the system prompt), `tools`, `model` and `cwd` (an existing directory) override what the
agent file or the default gives.

A subagent whose tools include `edit` or `write` is a writer, and one writer runs per directory at
a time: a second one for the same directory waits until the first ends. Writers in different
directories, such as worktrees you made, run in parallel. A directory other than the parent's
takes its project trust from Pi's own record for it, then from the parent's verdict. A writer call
with no `cwd` runs in its own fresh git worktree (cut from HEAD, under the session's directory)
instead of queueing: the result states the path and branch, its writes are uncommitted there
(usually untracked), and the note carries the inspect and commit-then-merge recipes. Nothing
deletes a worktree automatically; in a non-git directory a bare writer falls back in-tree
and the result says so.

With `background: true` the call returns at once and the answer arrives later as a message that
starts a new turn, once the parent is idle. Esc does not stop a background subagent; `/subagents`
lists the live ones and `/subagents stop <id|all>` stops them. A widget above the editor shows
every live subagent, running, queued or in the background. Its token usage is in the delivered
message, not in the footer.

Every foreground result ends with an `(id ab12cd34)` tag and every background message names the
same tag in its header. With `continue: <tag prefix>` the next call starts a second run on a
finished subagent's saved session — same agent, tools, model and directory, a fresh task. The ids
are valid in the current session only; ongoing and other sessions can't continue from them.

A subagent runs in-process by default, but runs as its own process when (a) the child entry can
load (a jiti-backed TypeScript child, checked by a one shot smoke probe per session) and (b) the
call's model works from the agent dir's own `auth.json` + `models.json` — a model that only
resolves in the parent's runtime (faux, registered providers, `--api-key` keys) stays in-process.
Progress crosses back over a file protocol: a 500 ms heartbeat snapshot plus one final result.
A stopped heart's row shows `· stalled`; nothing kills a stalled child, the user decides via
`/subagents stop`. A crashed host's finished answers are collected and delivered on the next
session start; nothing keeps a stale child crossing sessions.

`packages/skyr/examples/agents/` has three to copy: `scout`, `reviewer` and `web-researcher`.

## Embedding it

A host that builds its own Pi distribution can call `registerSkyr(pi)` instead of
loading the default export — see `packages/skyr/src/index.ts`.

## Developing

```sh
pnpm install
pnpm test        # vitest across packages
pnpm typecheck
pnpm lint        # biome, then knip: nothing unused, and nothing exported only for tests unless @internal
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
