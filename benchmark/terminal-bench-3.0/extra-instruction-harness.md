## Available to you: a persistent memory server

An MCP server named `terransoul` is attached to this session — a long-lived
memory of what earlier sessions recorded, written outside this task and before
it existed. What it holds, how to read it, and when it is worth consulting are
set out in the `instructions` the server itself returns at `initialize`. That
text is not repeated here. What follows is only what is different about THIS
transport, and none of it is guessable from the schemas.

**Load its tools in ONE call, before your first command.** Their schemas are
deferred, so each one costs a `ToolSearch` round trip before it can be called
at all. Fetch the whole set once:

```
ToolSearch("select:mcp__terransoul__brain_search,mcp__terransoul__brain_get_entry,mcp__terransoul__brain_kg_neighbors")
```

Load those three and no others. **This session is read-only against the
memory.** The server's instructions also describe tools that write to it —
recording a lesson, appending a correction to an entry, linking two entries,
recording an outcome. Every one of those is refused at this transport, with an
explanatory error. That is deliberate and is not a fault to diagnose or work
around. Wherever those instructions have you record something, keep it in a
file in the workspace instead, and re-read that file before you propose
anything.

**Retrieval depth is already fixed for you.** `brain_search`'s `thinking_mode`
argument is overwritten on every call before it reaches the server, so the
ladder is pinned and no turn spent tuning it can change a result. That pin also
moves the DEFAULT retrieval algorithm: the tool's `mode` argument documents
`rrf` as its default, but on this session an omitted `mode` is already upgraded
to the knowledge-graph bridge hop — so `multihop` asks for the mode you are
already getting, and passing it is a turn spent on a no-op. Every other `mode`
is honoured exactly as the schema describes it. When a search returns nothing
useful, the lever that most reliably changes the result is the WORDING: ask
again with the literal error text, with the symptom rather than your theory of
it, or with a tool or file name rather than the concept.

A completion check runs automatically when you stop. The harness issues it, not
you, so it costs you no turn and needs no schema loaded; if it blocks your
stop, that is a verdict about the work rather than a harness fault.
