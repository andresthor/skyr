# Voice

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
