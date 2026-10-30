# Ask user

The model can ask you a question in place of the input editor and wait. Pick an option with the
arrows and Enter, or with its number, or tick several with Space or their numbers when the
question allows it, or type your own answer in the `Other` row. The option the model recommends
is marked and the cursor starts on it; nothing is ticked for you. Esc declines, and the model is
told to stop and wait; on a row holding text, Esc first clears it. It can ask up to four questions
at once: Tab and Shift+Tab move between them, Space picks an option without moving on, and a Review
tab reads every answer back as one receipt before you send them. The tabs and where you are sit in
the dialog's top line, the keys in its bottom line, which drops the least useful ones first on a
narrow pane. A question left unanswered goes to the model as not answered; sending none declines.
The answers stay in the transcript as one row, `Colour → green · Extras → salt; pepper`, the same
receipt, after a resume too. The terminal bell rings when a question opens.

The terminal offers the tool, and so does a host that embeds Pi and answers form requests over
Pi's event bus, where the questions become one form in the client; the bus contract a host
implements is documented in the [tengi](https://github.com/andresthor/tengi) README. Runs without
such a host, like print, JSON and plain RPC, hide it from the model, and subagents never get it. A half-typed draft comes back when the dialog
closes; a large paste comes back written out in full instead of as its `[paste #…]` marker.
