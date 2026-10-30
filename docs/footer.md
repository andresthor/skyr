# Footer

skyr replaces Pi's footer in the terminal UI, in up to three lines.

- **First:** the context window's use as a percentage, a meter and tokens over the window; the
  session's turns and cost; the model and its thinking level; the profile (the agent dir's parent:
  `experimental`, or `pi` for `~/.pi/agent`) and the time. The cost is Pi's own total plus the usage
  of background subagent runs delivered into the session, which Pi leaves out.
- **Second:** the directory, git branch and session name; the token totals (`↑` input, `↓` output,
  `R` cache read, `W` cache write) and the latest response's cache hit rate (`CH`); and the spend of
  the provider of the current model, `anthropic Σ $4.12·day  $102·mo`: today and the last 30 local
  days, never summed across providers.
- **Third:** other extensions' statuses, when there are any.

On a narrow pane a line gives up its parts one by one. The spend comes from the session files under
the running profile's `<agentDir>/sessions` (a custom `sessionDir` setting is not followed), children
of subagents included, a fork's copied entries counted once, git worktrees skipped, and files more
than six levels down left out. skyr scans them in short slices when a session starts and after every agent run, and
reads only what a file has gained since.

The footer is drawn only in Pi's terminal UI. `{"ui": {"footer": false}}` in `<agentDir>/skyr.json`
leaves Pi's footer, from the next session.
