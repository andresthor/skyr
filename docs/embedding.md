# Embedding it

A host that builds its own Pi distribution can call `await registerSkyr(pi)` instead of
loading the default export — see `packages/skyr/src/index.ts`. The promise settles once
skyr's shells `session_start` handler is in place; a session that starts before then keeps Pi's
own `bash`, and skyr serves it from the next session start.
