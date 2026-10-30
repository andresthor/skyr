# Advisor

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
