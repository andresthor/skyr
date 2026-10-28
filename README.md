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
- `subagent` — hands tasks to agents defined in markdown files. Each agent runs as a fresh
  session with its own context and returns only its final answer. The tasks of one call run in
  parallel; Esc stops them unless the call runs in the background.
- `bash` — Pi's own `bash` with the same parameters, output and limits, plus `background`; a slow
  call keeps running as a background job. See [Background shells](#background-shells).
- `bash_stop` — stops a background job by its id; see [Background shells](#background-shells).
- `/shells` — lists this session's background jobs and stops them; see
  [Background shells](#background-shells).
- `ask_user` — asks you a question in place of the input editor and waits for your answer; see
  [Ask user](#ask-user).
- `advisor` — asks a stronger model to review the session so far; off until `skyr.json` names a
  model; see [Advisor](#advisor).

## Ask user

The model can ask you a question in place of the input editor and wait. Pick an option with the
arrows and Enter, or tick several with Space when the question allows it, or type your own answer
in the `Other` row. The option the model recommends is marked and the cursor starts on it; nothing
is ticked for you. Esc declines, and the model is told to stop and wait; on a row holding text,
Esc first clears it. It can ask up to four questions at once: Tab and Shift+Tab move between
them, Space picks an option without moving on, and a Submit tab shows every answer before you
send them. A question left unanswered goes to the model as not answered; sending none declines.
The answers stay in the transcript as one row per question, after a resume too. The terminal
bell rings when a question opens.

The terminal offers the tool, and so does a host that embeds Pi and answers form requests over
Pi's event bus, where the questions become one form in the client; the bus contract a host
implements is documented in the [tengi](https://github.com/andresthor/tengi) README. Runs without
such a host, like print, JSON and plain RPC, hide it from the model, and subagents never get it. A half-typed draft comes back when the dialog
closes; a large paste comes back written out in full instead of as its `[paste #…]` marker.

## Voice

`ctrl+space` (or `/voice`) starts dictating into the input editor: spoken words commit at the
cursor as plain text, with the interim ones following the cursor as ghost text. Esc cancels and
puts the editor back the way it was, Enter stops without sending (the next Enter sends), so text
is never auto-sent. Quiet only asks the server for the pending final early — it never ends a
dictation. Without `CORTI_*` credentials, `/voice` says so in one line and does nothing else.
`/voice on` starts a dictation and leaves a running one alone; `/voice off` discards it like
Esc. Any other argument is refused with the valid forms. A dialog from any extension that takes
the keyboard stops a running dictation as Enter does: the mic closes, and words already spoken
land in the editor once it is back.

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
    "replacements": [{ "find": "type script", "replace": "TypeScript" }],
    "formatting": { "numbers": "numerals", "times": "h24" }
  }
}
```

`keyterms` and `replacements` are appended to the built-in coding vocabulary; edits apply on the
next session. A malformed section degrades to the defaults and is reported once per session,
never a startup failure. Term caps are Corti's: 50 chars / 5 words per keyterm, 100 chars / 10 words per
replacement, 1,000 per connection.

`formatting` sets how Corti writes `dates`, `times`, `numbers`, `measurements`, `numericRanges`
and `ordinals`, with the values in [Corti's formatting docs](https://docs.corti.ai/stt/formatting);
a field left out keeps Corti's default.

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
a project Pi trusts, in `.claude/agents/` at the repo root (Claude Code's location) and in
`.pi/agents/`. A project agent replaces a user agent of the same name, and a `.pi/agents/` agent
replaces a `.claude/agents/` one.
Edits apply after `/reload`. An agent with a field skyr does not act on, such as Claude Code's
`disallowedTools` or another extension's, still loads; the field is named in a warning. Without
`tools`, an agent gets `read`, `grep`, `find`, `ls`, `bash`, `web_search` and `web_fetch`. Pi
lists the agents to the model.

A call runs one to eight tasks, each in its own subagent and each with its job in `prompt`: they run
in parallel and can't see each other's answers, and a foreground call returns once the last of them
ends, with every answer in task order. A call with a bad task runs none of them, and its error names
every bad task. A task needs no agent file: without `agent` it gets a general-purpose subagent with
Pi's own prompt, the default tools, the parent's model and working directory. On any task, `role`
(added to the system prompt), `tools`, `model` and `cwd` (an existing directory) override what the
agent file or the default gives. A call fails only when no task gave an answer.

A subagent whose tools include `edit` or `write` is a writer, and one writer runs per directory at
a time: a second one for the same directory, from the same call or another, waits until the first
ends. Writers in different directories, such as worktrees you made, run in parallel. A directory
other than the parent's takes its project trust from Pi's own record for it, then from the parent's
verdict. A writer task with no `cwd` runs in its own fresh git worktree (cut from HEAD, under the
session's directory) instead of queueing: its answer states the path and branch, its writes are
uncommitted there (usually untracked), and the note carries the inspect and commit-then-merge
recipes. Nothing deletes a worktree automatically; in a non-git directory a bare writer falls back
in-tree and its answer says so.

With `background: true` on the call, it returns at once and each task's answer arrives later as a
message that starts a new turn, once the parent is idle; answers that end while the parent is busy
arrive together. Esc does not stop a background subagent; `/subagents` lists the live ones and
`/subagents stop <id|all>` stops them, one task at a time or all. A `/reload` stops background
subagents; the reloaded session receives one message naming each, so the model knows their answers
will not come. A widget above the editor shows every live subagent, running, queued or in the
background; past ten, it shows nine and a count of the rest. Plain `pi --mode rpc` clients don't get
the widget: Pi's RPC mode passes on widgets made of lines only, and this one is a component. A
delivered message shows one line per subagent, naming why any of them gave no answer; expand it to
read the answers. A background subagent's token usage is in the delivered message, not in the
footer.

The model reads each answer inside a `<subagent-answer>` block, foreground or delivered, whose
attributes carry the run's status, tokens and 8-char `id`; the subagent's own text can't open or
close a block, and harness notes (a spill file, a worktree) follow it. A background start names
the same id. A task with `continue: <id>` starts a second run on a finished subagent's
saved session — same agent, tools, model and directory, a fresh prompt. The ids are valid in the
current session only; ongoing and other sessions can't continue from them.

A subagent runs in-process by default, but runs as its own process when (a) the child entry can
load (a jiti-backed TypeScript child, checked by a one shot smoke probe per session) and (b) the
call's model works from the agent dir's own `auth.json` + `models.json` — a model that only
resolves in the parent's runtime (faux, registered providers, `--api-key` keys) stays in-process.
Progress crosses back over a file protocol: a 500 ms heartbeat snapshot plus one final result.
A stopped heart's widget line shows `· stalled`; nothing kills a stalled child, the user decides
via `/subagents stop`. A child process that is killed reports no token usage. A crashed host's
finished answers are collected and delivered on the next session start; nothing keeps a stale
child crossing sessions. Pi saves a turn's tool results only once its slowest call ends, so a
hard kill before then loses answers that had already ended; their child session files stay on
disk.

`packages/skyr/examples/agents/` has three to copy: `scout`, `reviewer` and `web-researcher`.

## Background shells

skyr serves Pi's own `bash` in the TUI and in RPC mode, built from Pi's definition so a call
behaves as Pi's does, with output, limits and `shellPath` unchanged. What it adds is that a command
is not lost to a timeout or a wait: it can keep running, and the model is told when it ends.

- **A slow call moves.** A call still running after 120 s is not killed. It keeps running as a
  background job, the call returns what it printed so far with the job's id and log path, and a
  message tells the model when the job ends. A `timeout` of 120 s or less keeps Pi's kill and stays
  in the foreground; a longer `timeout` becomes the job's deadline.
- **`background: true`** starts the command as a job and returns at once, for servers, watchers
  and builds. `timeout`, if set, is the job's deadline. If the job can't be identified, it runs as a
  normal call and moves at 120 s.
- **`bash_stop {id}`** stops a job: SIGTERM to its process group, then SIGKILL after 5 s.
  Stopping a job that has ended is not an error. Processes that leave the group (`setsid`,
  `docker run -d`, `tmux`) are neither tracked nor stopped.
- **`/shells`** lists this session's jobs, running first, with their state and log. `/shells stop
  <id|all>` stops them; the model is told, without a new turn. Running jobs also show in a
  widget above the editor (past ten, nine and a count of the rest; not for plain `pi --mode rpc`
  clients, as with the subagent widget), and in an ACP client's task list, where a moved call's
  card points to its job's task instead of showing an exit code.
- **Messages.** A job's end arrives when the session is idle and starts a turn: its exit code or
  how it was stopped, the last lines of output and the log path. After a `/compact` the model is
  reminded of the jobs still running. A shell that exits and leaves processes in its group is
  reported once as lingering, and `bash_stop` ends them.

**When skyr leaves `bash` alone.** Print and json runs and Windows keep Pi's `bash`, silently, and
so do a subagent's children. skyr steps aside, with a warning that names the cause ("background
shells are off because …; bash is left as it is"), when another extension or the host already
provides `bash`, when Pi's `bash` takes other parameters than `command` and `timeout`, when
`shellPath` is not bash, sh, zsh, dash or ksh, when `ps` is missing or cannot identify Pi's own
process, or when the job directory can't be created.

One case is not detected. Pi picks a tool by extension load order, and skyr registers `bash` in
its `session_start`. An extension that loads after skyr and registers its own `bash` in its
`session_start` or later (a sandbox switched on by a command, say) is silently shadowed by skyr's:
skyr checked before it registered, and nothing reports it.

**Jobs end with Pi.** `/reload` hands running jobs to the reloaded session. `/quit`, `/new` and
`/resume` stop them (SIGTERM, then SIGKILL after 5 s), so quitting can take up to 6 s while a job
ignores SIGTERM. Closing the terminal, or a SIGTERM to Pi, stops them the same way. A job's output
still runs through Pi, so after a hard kill (SIGKILL, out of memory) a job dies the next time it
writes; a quiet one keeps running until the next session's cleanup stops it, and the session that
started it is told it ended with Pi. Under tengi, jobs end when tengi exits.
Job directories are kept for seven days.

## Advisor

The `advisor` tool lets the model ask a stronger model for a second opinion: before it
commits to an approach, when it is stuck, and before it declares a task done. It takes no
arguments; skyr sends the session as a transcript and returns the advice as the tool result.

It is off until `<agentDir>/skyr.json` names a model, in Pi's `provider/id` form:

```json
{ "advisor": { "model": "corti/corti-s1-beta" } }
```

The model must be one Pi knows (`/model` lists them) and has credentials for; otherwise the
tool stays off and a warning says why (an unknown model when the session starts, missing
credentials at the first prompt). Remove the key to turn it off; the change applies from the
next session.

**Privacy.** Once a model is set, every advisor call sends the active branch to that model's
provider: your messages, the agent's messages and latest reasoning, every tool call and
result (file contents and command output included), and the system prompt. `skyr.json` is
per agent dir, so this holds in every project that agent dir serves.

**Cost.** Each call sends the whole branch as input, so a call on a long session costs about
as much as one request of that size to the advisor's model. Only what is new since the last
call is uncached, so where the provider caches prompts, a call within a few minutes of the
previous one reads the earlier part from the cache and costs a fraction of the first. Its tokens
and cost count toward the session totals in the footer and `/session`.

A session too long for the advisor's context window is cut: each part keeps its first and last
user message, the call to the advisor and its most recent turns; then whole parts go, oldest
first, though the first part always stays; and every cut is marked so the advisor knows what it
cannot see. Parts go a few at a time, so the calls between two cuts still read the earlier parts
from the cache; until the session is long enough for that, each call that has to drop one more
part misses the cache.

## Embedding it

A host that builds its own Pi distribution can call `await registerSkyr(pi)` instead of
loading the default export — see `packages/skyr/src/index.ts`. The promise settles once
skyr's shells `session_start` handler is in place; a session that starts before then keeps Pi's
own `bash`, and skyr serves it from the next session start.

## Developing

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

## License

MIT
