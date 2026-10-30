# Editor

While Pi works, the editor draws a working line above its top rule: a spinner that follows
what the agent does (a star pulse while it thinks, a line while a tool runs, sand while it waits
on subagents, a sparkle while Pi retries or compacts), the running tool and what it works on or
else Pi's working message, the time since the run began and the interrupt key. Pi's own loader,
shown where skyr's editor is not installed, uses the same star pulse. `NO_COLOR` drops the
shimmer on the text, and `TERM=dumb` gets an ASCII line.

skyr installs this editor in every terminal session; [voice](voice.md), when its credentials
resolve, extends it. If another extension installs its own editor first, skyr leaves it: no
working line, and Pi's own loader shows. A `/reload` keeps a draft's text and refills ↑ history
with the session's prompts (not slash or `!` commands, nor prompts before a compaction), and
drops undo; as in Pi itself, a large paste's contents are dropped too and its `[paste #…]`
marker stays literal.
