# Background shells

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
- **`/shells`** opens the bar on this session's jobs; outside the terminal UI, or on a pane too
  small for the tab, it lists them, running first, with their state and log. `/shells stop
  <id|slot|$slot|all>` stops them (a bare number is a slot, as on agents); the model is told, without a new turn. Running jobs also show in the
  bar above the editor (see [Subagents](subagents.md); Pi's terminal UI only), and in an ACP client's task list,
  where a moved call's card points to its job's task instead of showing an exit code.
- **Messages.** A job's end arrives when the session is idle and starts a turn: its exit code or
  how it was stopped, the last lines of output and the log path. After a `/compact` the model is
  reminded of the jobs still running. A shell that exits and leaves processes in its group is
  reported once as lingering, and `bash_stop` ends them. In the transcript a job's end is one record, with its exit code and time, and
  its log path under `ctrl+o`; the output and the model's instructions are not drawn.

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
