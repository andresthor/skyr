# Subagents

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
arrive together. Esc does not stop a background subagent; `/subagents` opens the bar on the live
ones and `/subagents stop <id|slot|all>` stops them, one task at a time or all (a slot is the number
the bar shows, and a stop names what it stopped). A `/reload` stops background
subagents; the reloaded session receives one message naming each, so the model knows their answers
will not come. A call's row in the transcript is a record, `✓ agent "label"` with its turns, tokens,
time and id; several tasks get a header with their shared mark (`!` for a mix) and one record each
under it. An HTML export draws each finished skyr row (for the built-in tools, `grep` and `find`
only: Pi's export template draws the others itself) with its running head above it, because Pi
gives the export's call no sign of being finished. A bar above the editor shows what runs: nothing at rest; while subagents or shells
run, one line with a mark per run, the latest action and the longest running time; a failed
background subagent or shell leads it, with its reason, until you open the bar. `alt+a` opens and
closes the bar and `alt+s` switches between its AGENTS and SHELLS tabs; `/subagents` and `/shells`
open the bar on their tab (on macOS `alt` needs Option-as-Meta; the commands always work). An open bar lists
each run with its slot number, latest action, turns, tools, time and id, dropping columns as the
pane narrows. It draws as many rows as the pane has room for and scrolls with ↑↓ (a "+N more"
line marks the side where rows are hidden); under 12 terminal rows or 44 columns it stays a pulse,
and `alt+a`, `alt+s`, `/subagents` and `/shells` list in a notice instead. With the bar open and the prompt empty, ↑ and ↓ (Pi's `tui.select.up`
and `tui.select.down`) move a highlight through the rows, and Esc (`app.interrupt`) closes the bar
when the agent is idle and still interrupts when something is. Pi's idle check does not see a
running `!` command, so then Esc closes the bar first and a second Esc stops it; with a `!ls`
draft in the box and the bar open, the first Esc closes the bar instead of leaving bash mode. A
rebinding of those ids moves the keys, and a key the editor shares with them is the bar's while it
lists. ↑↓ stay the editor's when the bar has nothing to move, and under another extension's
editor (see [Editor](editor.md)) the bar has no keys of its own. The bar is drawn only in
Pi's terminal UI;
rpc clients and print mode get none, and there `/subagents` and `/shells` list in a notice. A
delivered message shows one record per subagent, with the first lines of its answer under it, or
why it gave none; expand it to read the rest. A background subagent's token usage is in the delivered message, not in the
footer.

The model reads each answer inside a `<subagent-answer>` block, foreground or delivered, whose
attributes carry the run's status, tokens and 8-char `id`; the subagent's own text can't open or
close a block, and harness notes (a spill file, a worktree) follow it. A background start names
the same id. A task with `continue: <id>` starts a second run on a finished subagent's
saved session — same agent, tools, model and directory, a fresh prompt. The ids are valid in
the current session only, and survive a `/reload`, a background subagent it stopped included; other
sessions can't continue from them.

A subagent runs in-process by default, but runs as its own process when (a) the child entry can
load (a jiti-backed TypeScript child, checked by a one shot smoke probe per session) and (b) the
call's model works from the agent dir's own `auth.json` + `models.json` — a model that only
resolves in the parent's runtime (faux, registered providers, `--api-key` keys) stays in-process.
Progress crosses back over a file protocol: a 500 ms heartbeat snapshot plus one final result.
A stopped heart's bar row shows `stalled`; nothing kills a stalled child, the user decides
via `/subagents stop`. A child process that is killed reports no token usage. A crashed host's
finished answers are collected and delivered on the next session start; nothing keeps a stale
child crossing sessions. Pi saves a turn's tool results only once its slowest call ends, so a
hard kill before then loses answers that had already ended; their child session files stay on
disk.

`packages/skyr/examples/agents/` has three to copy: `scout`, `reviewer` and `web-researcher`.
