# Built-in tool rows

Pi's seven built-in tools, `read`, `write`, `edit`, `bash`, `grep`, `find` and `ls`, draw records in
the transcript: `✓ grep "pattern" src` with the count of matches and files (or lines, or entries)
and the time. A failure shows its reason and up to three lines of the tool's message; for `bash`,
the last three lines of its output (and the path of its full log, when Pi kept one) and `exit 2`.
A successful `bash` row keeps the last three lines of its output, so the tail it showed while
running stays when the call settles. `ctrl+o` shows the listing, the file or the
output, up to 400 lines and a count of the rest. A running `bash` row shows the last three lines of
its output so far and no clock: the working line and the bar carry the time. An `edit` shows its
diff under the record: once its arguments are complete, the diff Pi computes from the file while
the call runs; after the result, the diff Pi saved, six lines collapsed with a count and all of it
under `ctrl+o`, with `+N −M` on the record. A result skyr does not recognise is drawn as Pi's own
row for it, with whatever colour Pi gives it: text for most tools, and its coloured card for an edit.

skyr restyles only Pi's own renderers, through Pi's public tool renderer resolver; another
extension's override of a built-in tool is left as it is. `{"ui": {"builtinRows": false}}` in
`<agentDir>/skyr.json` gives Pi's rows back, from the next `/reload` or restart.
