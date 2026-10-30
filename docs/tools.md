# Tools

`web_search` — searches through Tavily, then Exa, then Parallel, each taking over when the one
before fails; no key needed. `TAVILY_API_KEY`, `EXA_API_KEY` or `PARALLEL_API_KEY` moves that
service off its rate-limited free tier. Queries go to those services and may carry
conversation content.

`web_fetch` — fetches one URL as markdown; refuses private and local addresses.
