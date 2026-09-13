> **ARCHIVED — Terminal-Bench 2.1.** This document belongs to the closed 2.1
> campaign (Claude Code agent loop + `claude-sonnet-5`). It is retained for
> provenance and is **not** current guidance. The active campaign is
> Terminal-Bench 3.0; see `benchmark/terminal-bench/`.
# TerranSoul Observability & Evaluation: HoneyHive-Style Gap Analysis and Roadmap

> **PROGRESS, 2026-08-12.** Tier 0 is done: items 2+3 shipped in `07f4a172`
> (`mcp.tool_call` spans now carry `tool`/`status` for real; item 1 was
> correctly ruled unnecessary by the correction note above, since the current
> architecture already goes through `init_observability()`). The concrete,
> ready-to-execute next step is **Tier 1 item 6** (destination-verification for
> `brain_tool_names_match_dispatch_arms`) — checked today: the existing test at
> `tools.rs:5461` is confirmed presence-only exactly as this report describes
> (it asserts the tool-name LIST equals a fixed array; it never opens
> `dispatch()`'s body at all), so it genuinely could not have caught the
> `get_entry`→`get_entry_detail` bug it is named after. Deferred rather than
> rushed in this pass because a real fix needs either (a) an explicit
> `tool_name → expected gateway method` manifest precise enough to reject
> `get_entry_detail` as a match for `get_entry` (a naive substring/`contains`
> check would NOT have caught that specific bug — `"get_entry_detail"` contains
> `"get_entry"`), which means authoring and eyeballing ~90 correct mappings, or
> (b) collapsing straight to item 5's generated single-source-of-truth table.
> Doing either well needs a `cargo build && cargo test` round-trip this session
> couldn't safely interleave with a live, monitored bench recovery — tracked
> instead of half-shipped.

*Prepared 2026-08-10, following a single debugging session that found and fixed three real, previously-unknown bugs purely via manual live investigation (curl probes, netstat, crash-dump reading, hand-tracing code).*

> **⚠️ CORRECTION, same day, made before Tier 0 shipped.** This report's original
> Tier 0 item 1 and Top Recommendation named `run_headless_host()` as "the exact
> binary Terminal-Bench spawns per trial," trusting an in-code doc comment
> (`lib.rs:2071`) at face value. **That comment is stale.** `run_headless_host`
> (behind `--headless`) is not referenced anywhere in `benchmark/terminal-bench/*`
> — it belongs to an EARLIER, now-CLOSED architecture ("TerranSoul's own agentic
> loop," see `TerminalBench.md`). The current architecture ("TS + Claude Code +
> Opus 5") runs `--mcp-tray` on the host, which already goes through the same
> `setup()` closure that calls `init_observability()` unconditionally — verified
> live: the real bench-store `obs.sqlite` already held 10,702 spans, 203 of them
> `mcp.tool_call`, before this fix landed. **So Tier 0 item 1 (wire init into the
> headless host) was unnecessary for the current architecture** — worth doing
> eventually for completeness (a real gap for anyone who DOES use `--headless`),
> but it is not on the critical path. The other half of the original finding
> held exactly as stated: every one of those 203 real spans had `attrs: "{}"`
> and `status: "ok"`, confirmed by direct query. **Item 2 (populate `tool`,
> `handler`, `status`) and item 3 (`SpanStatus::Error` plumbing) were the real,
> live gaps, and both have now been fixed** — see `crates/observability/src/sink.rs`
> and `src-tauri/src/ai_integrations/mcp/tools.rs::dispatch`. The `handler`
> (actual callee) attribute remains unshipped; see Tier 1.
>
> The lesson generalizes past this one report: an audit is only as good as the
> assumptions it trusts without checking, including ones already sitting in the
> code as comments.

## 1. Context

Today's session fixed three bugs on TerranSoul's MCP surface, none caught by existing tests or tooling until a human/agent manually poked the running system:

1. **Idle-timeout watchdog killed the HTTP listener mid-task** because it tracked only `tools/call` activity, not general protocol traffic (fixed in `router.rs:298-308` / `lib.rs:729`, commit `e86da0b3`).
2. **An append-size-bounding function silently truncated a large ORIGINAL memory entry** on its first-ever append, destroying most of a verified solution (fixed, commits `11698d9a`/`d88d6879`).
3. **`brain_get_entry`'s dispatch arm called `gw.get_entry_detail(...)`**, a different method than `gw.get_entry(...)`, the one two rounds of recovery-logic fixes were actually written into — both fixes were silently inert on the real product surface, caught only because a live tool call disagreed with passing unit tests (`tools.rs:2098-2106`, `gateway.rs:12566`/`12647`, commit `f12b89d9`).

The user wants HoneyHive-style observability/evaluation specifically so **this class of bug** — silent truncation, dead/misrouted code paths, watchdog false-positives — is caught by a standing system next time, rather than rediscovered by hand. This report compares HoneyHive, the 2026 open-source/SaaS baseline (Langfuse, Arize Phoenix, LangSmith; Helicone as contrast), and TerranSoul's actual current-state code, then proposes a prioritized, local-first roadmap.

## 2. Comparison Table

| Dimension | HoneyHive | Langfuse / Phoenix / LangSmith (2026 baseline) | **TerranSoul today** |
|---|---|---|---|
| **Trace/span model** | `session` (root) → `model` / `tool` / `chain` events, all sharing `session_id`; Tree/Timeline/Graph/Trajectory/Thread views | `trace → observation (span\|generation\|tool)`; sessions group multiple traces; Phoenix spans carry OpenInference LLM semantics | Real schema exists (`crates/observability/schema.rs`: Span/LogRecord/MetricSample/Finding, `KNOWN_SPAN_NAMES` incl. `mcp.tool_call`) — architecturally comparable, but only **one** span kind is ever emitted end-to-end |
| **Transport** | OTel-native (OTLP), auto-instrumented providers/vector DBs + decorators | Phoenix fully OTel/OTLP via OpenInference; Langfuse/LangSmith accept OTel as one path alongside native SDK | Rust `tracing` crate + custom `ObsLayer` → bounded mpsc → SQLite writer (`sink.rs`). No OTel/OTLP — fine for local-first, but means no interop with external collectors |
| **Attribute capture on spans** | `enrich_span()`/`enrich_session()` attach metadata/metrics/feedback post-hoc; auto-instrumentation captures tool/model identity by construction | Langfuse evaluators "target observations by name/type and read input/output directly off the span" — attribution is structural | **The one span that exists, `mcp.tool_call` (`tools.rs:1976`), is `#[instrument(skip_all)]` with zero fields recorded anywhere in its ~3000-line dispatch body** — contradicts `docs/observability.md`'s own documented attribute table (tool/caller/status) |
| **Error/status semantics** | Feedback + evaluator scores attach per span; failed calls are queryable | Evaluators run per-span/session and log distinguishable pass/fail | **`SpanStatus::Error` is never constructed anywhere in the codebase** (only appears in two serialization match arms, `sqlite.rs:187`, `query.rs:132`). `sink.rs::on_close` hard-codes `SpanStatus::Ok`. A "show failed tool calls" query returns zero rows by construction, always |
| **Eval harness — offline** | LLM-judge / code / human, dataset × prompt/config → versioned, diffable Evaluation Report, CI-gated | Same shape across all three (dataset → evaluator → experiment → diff vs. prior run) | Real, but **quality-only**: LongMemEval-S/LoCoMo/jd-million never-regress floors, measured via CLI/gateway path — no dataset/evaluator abstraction for functional/wire-contract correctness |
| **Eval harness — online (production)** | Server-side evaluators run automatically against live production events | LangSmith online evaluators run continuously against production traces/threads for real-time alerting | **None.** No evaluator concept — online or offline — exists for functional invariants (e.g., "append never truncates the pre-cap tail") |
| **Dataset curation / promotion loop** | Curate directly from underperforming production traces + human corrections | All three: "promote a failing production trace into the dataset" is the explicit mechanism that turns a one-off catch into a permanent regression check | **None.** Each of today's three bugs became a one-off hand-written unit test (e.g., `gateway.rs:12647`), not a systemic fixture other tools/paths are checked against |
| **Dispatch-target / wiring verification** | Not explicitly solved by any researched tool at the product level; HoneyHive's Claude-Code-hooks daemon gets real-handler identity "for free" by intercepting at the hook layer, not by trusting app code | Not explicitly solved either — span attribution assumes the emitting code told the truth | **The only generic check, `brain_tool_names_match_dispatch_arms` (`tools.rs:5427`), is explicitly presence-only** by its own comment — cannot notice an arm that exists but calls the *wrong* method. This is exactly bug #3's shape and it recurred despite two rounds of fixes |
| **Production monitoring / dashboards** | Cost/latency/quality/usage dashboards, custom charts, segment slicing | Same, all three | Vue `ObservabilityView.vue` (4 tabs) + 5 MCP tools (`obs_query/trace/logs/metrics/search`) exist and are real — but on the one surface that matters most (headless MCP host / `terransoul-headless`, the exact binary Terminal-Bench spawns), **the tracing pipeline is never initialized**, so these tools query a database nothing ever wrote to |
| **Alerting** | Aggregate (threshold) + Drift (% deviation), any schema property, hourly→monthly cadence, lifecycle states | LangSmith online evaluators feed real-time anomaly alerting | **None at all.** No alert concept, no heartbeat/liveness signal independent of tool-call activity (the exact signal that would have modeled bug #1) |
| **Coding-agent-facing surface** | Zero-instrumentation Claude Code hooks daemon; docs MCP server; CLI; packaged SKILL.md agent skills | Framework auto-instrumentation (LangChain/LlamaIndex/etc.) is the closest analogue | TerranSoul **is itself** an MCP server exposed to coding agents — the inverse relationship. `obs_*` tools already exist as agent-facing surface, they are just unfed |
| **Deployment model** | SaaS / SaaS-hybrid / self-hosted | Langfuse/Phoenix self-host (Docker; Postgres+ClickHouse+Redis+S3 for Langfuse); LangSmith SaaS-first with hybrid option | **Already fully local-first**: SQLite (`obs.sqlite`), zero external services, zero new infra — this is TerranSoul's structural advantage over all four researched tools, not a gap |

## 3. Gap Analysis (honest)

**The core finding is not "TerranSoul lacks an observability system."** It has already built roughly the right *shape* of one — a real span/log/metric schema with FTS5 search, retention, aggregation, and five bearer-gated MCP tools mirroring exactly the kind of agent-facing surface HoneyHive/Phoenix/Langfuse provide. The gap is that **this system is disconnected from the traffic that matters and undersamples the exact fields needed to catch the three bug classes observed today:**

- **It's a no-op where it counts.** `init_observability()` is called from exactly one site (`lib.rs:5281`, inside the Tauri GUI app's `setup()`), never from `run_headless_host()` — which, per its own doc comment, is the exact binary Terminal-Bench spawns per trial. Every span/event on that surface, including the sole `mcp.tool_call` span, is a silent no-op. This was verified independently in this session (`grep init_observability` → one call site).
- **Even when live, the one span that exists carries no identifying data.** `skip_all` plus zero explicit `record()` calls means a stored span cannot say which tool ran, with what arguments, or whether it succeeded — confirmed by direct inspection of `tools.rs:1976` and its dispatch body.
- **Status is fabricated, not derived.** `SpanStatus::Error` literally cannot be produced by any code path (confirmed: it appears only in two serialization `match` arms). A future "show me failed calls" query is guaranteed to return nothing, forever, regardless of how many calls actually fail.
- **Adopting a new SaaS platform (HoneyHive, Langfuse Cloud, LangSmith) would not fix any of this on its own.** All four researched tools are transport + storage + evaluator layers that sit *on top of* instrumentation the calling application must still write correctly. Swapping `obs.sqlite` for a hosted store doesn't create the missing `record(tool=..., status=...)` calls, doesn't wire `init_observability` into the headless binary, and doesn't add an invariant check for the append-cap bug. The leverage is entirely in **instrumentation correctness and a dispatch-integrity mechanism**, not in the choice of backend — and TerranSoul's local-first SQLite architecture is already structurally *ahead* of LangSmith's SaaS-first model and roughly at parity with Langfuse's self-hosted shape, at a fraction of the operational footprint (no Postgres/ClickHouse/Redis/S3 quadruple-stack).
- **Where outside prior art teaches something genuinely missing:**
  - *Trace-completeness / heartbeat.* None of TerranSoul's signals are independent of tool-call activity — which is precisely how bug #1 happened. Phoenix/Langfuse dashboards routinely surface orphaned or abnormally-long-running traces because they have a continuous timeline to compare against; TerranSoul has no such continuous signal at all.
  - *Production-trace → dataset promotion.* All three comparable tools plus HoneyHive treat "promote a caught bug into a permanent regression fixture" as core product logic. TerranSoul's never-regress benches are real but retrieval-quality-only; each of today's three bugs became a bespoke, tool-specific unit test rather than a fixture other future changes get checked against automatically.
  - *Online/continuous evaluators.* TerranSoul's obs stack has metrics and logs but zero evaluator concept, offline or online, for functional invariants. This is exactly what bug #2 (append-cap truncation) needed: an invariant that runs against every real production call, not just a synthetic unit test that happened not to cover "first-ever append, large original."
  - *Dispatch/handler identity as a first-class signal.* None of the four researched tools explicitly solve "verify the handler invoked matches the handler the fix was written into" — their span model would surface it as a matter of course (tag the span with the REAL callee), but only if the emitting code is trustworthy. HoneyHive's Claude-Code-hooks daemon is the interesting exception: it gets real tool-call identity "for free" by intercepting at the OS/hook boundary rather than trusting in-app instrumentation — analogous to what a wire-level MCP integration test does for TerranSoul (verify the actual JSON-RPC response, not the internal function called directly).
- **Be honest about a limit that applies to every option here:** populating spans with the *requested* tool name (`brain_get_entry`) would **not** by itself have caught bug #3, because the wrong handler (`get_entry_detail`) still returns a structurally valid response — nothing about that call looks like a failure at the span-status level. Catching this class requires either (a) recording the *actual callee* as a distinct span attribute and something comparing it against an expectation, or (b) removing the possibility of divergence altogether via a single source-of-truth dispatch table. Observability makes this class of bug *cheaper to notice*; only an architectural fix makes it *impossible to introduce*. The roadmap below includes both, and the top recommendation and final assessment are explicit about which is which.

## 4. Prioritized Roadmap (local-first, no new SaaS dependency)

### Tier 0 — Make the existing skeleton real (days, zero new dependencies)

1. **Wire `init_observability` into the headless MCP host.**
   Files: `src-tauri/src/lib.rs` (`run_headless_host`, ~line 2038), `src-tauri/src/bin/headless_host.rs`, `crates/observability/src/lib.rs` (no API change needed — reuse the exact call+`ObsHandle` pattern already at `lib.rs:5281`).
   Add a regression test that spawns the headless path, issues one MCP call, and asserts `obs.sqlite` gained ≥1 row — this test fails on the pre-change tree (no such test exists today), satisfying `rules/tests-must-be-able-to-fail.md`.

2. **Populate `mcp.tool_call` span attributes, including the actual callee.**
   File: `src-tauri/src/ai_integrations/mcp/tools.rs:1976`, `dispatch()`. Replace `#[instrument(skip_all)]` with named empty fields (`tool`, `handler`, `status` = `tracing::field::Empty`); record `tool` at entry, record `status` (`"ok"`/`"error"`) from the `Result`, and — critically — record `handler` with the literal method name string at each dispatch arm (e.g. `"get_entry_detail"`), not just the requested tool name. This is the single attribute that turns "trace shows `tool=brain_get_entry` succeeding" into "trace shows `tool=brain_get_entry handler=get_entry_detail`" — visible in one `obs_trace` query instead of a live curl probe. Also widen the span to cover `router.rs:288-453` (auth + trust-ledger), not just `dispatch()`, to stop understating latency.

3. **Fix `SpanStatus::Error` plumbing.**
   File: `crates/observability/src/sink.rs` (`on_close` ~214-224, `on_event` ~173-212). Have `on_close` read the `status` field recorded in item 2 instead of hard-coding `SpanStatus::Ok`. Add a test asserting a span wrapping a tool call that returns `isError:true` persists as `SpanStatus::Error` — fails today by construction per direct grep confirmation.

### Tier 1 — Kill the "dispatch drifted from tests" bug class (bug #3's shape)

4. **Add an MCP wire-level regression suite** that calls `tools/call` over the real JSON-RPC path (`router.rs`), not `gateway::dispatch()` directly, for a fixed golden set of tool+args pairs, asserting response shape against checked-in fixtures. New file: `src-tauri/tests/mcp_wire_contract.rs`, run under `cargo test --workspace --lib`. Targets audit gap #5 (no e2e wire-contract replay exists today; Terminal-Bench's only wire check is a single `/health==200` preflight in `run-dg.sh`).

5. **Replace the hand-written string-match dispatch table with a single declarative table** mapping `tool_name → gateway method`, generated so the same table drives both `EXPOSED_TOOLS` and the call site. Files: `src-tauri/src/ai_integrations/mcp/tools.rs` `dispatch()` (~2000-3000), `gateway.rs`'s `AppStateGateway`. Large diff across ~60 tools, so treat as a Tier-1 stretch item — but this is the **only** item in this roadmap that makes bug #3's class structurally impossible rather than merely detectable.

6. **Extend `brain_tool_names_match_dispatch_arms` (`tools.rs:5427`) from presence-only to destination-verification** — assert, via naming convention or an explicit tool→method manifest, that each arm's call target matches its expected gateway method. Cheaper than item 5, ships sooner, catches future NAME drift before the full macro refactor lands.

### Tier 2 — Invariant evaluators for silent-corruption bugs (bug #2's shape)

7. **Build a lightweight production-invariant evaluator**, modeled on HoneyHive/Langfuse's code-based evaluators but running server-side against real calls, not just unit tests: a small registry of `(event_type, invariant_fn)` pairs invoked when a matching span closes. First invariant: the append-with-cap postcondition (`post_len >= min(pre_len, cap)`, no silent loss of the pre-cap tail) attached to the function patched in commit `b5e94b23`/`11698d9a`. New file: `crates/observability/src/evaluators.rs`, consulted from `sink.rs::on_close`, writing violations into the **existing but unused** `Finding` table (`schema.rs`) so a violation is queryable via `obs_query`/`obs_search` — not something requiring a re-read of a crash dump.
   Expose findings via a new 6th MCP tool, `obs_findings`, alongside the existing five.

8. **Turn the append-cap edge case into a permanent dual fixture**: keep the unit-test regression already landed in `gateway.rs` *and* register it as a golden case consumed by item 7's evaluator, so the same invariant is checked both offline (unit test) and online (real production writes) — closing the specific "the unit test suite passed the whole time" gap shared by bugs #2 and #3.

### Tier 3 — Liveness/heartbeat + alerting (bug #1's shape)

9. **Add a periodic heartbeat span/metric independent of tool-call activity.** Emit an obs metric sample every N seconds from the MCP host's main loop — piggyback on the watchdog logic already computing `is_idle_timed_out` at `mod.rs:404-429`. Files: `src-tauri/src/ai_integrations/mcp/mod.rs`, `crates/observability/src/aggregator.rs` (extend the existing 60s rollup). Important: the heartbeat must derive from an actual liveness check (e.g., the HTTP listener's accept-loop), not from tool-call activity again, or it reproduces the exact blind spot it's meant to close.

10. **Add HoneyHive-style Aggregate/Drift alert rules** on top of `aggregator.rs`'s rollups: an absolute-threshold alert ("no heartbeat span for >X seconds while the listener is still bound" — bug #1's exact shape) and a drift alert (tool-call error rate vs. trailing baseline, now meaningful once item 3 makes `SpanStatus::Error` real). New sibling module `crates/observability/src/alerts.rs`, surfaced as a 7th MCP tool `obs_alerts` and a new tab/banner in `ObservabilityView.vue`.

### Tier 4 — Close the production-trace → regression-dataset loop

11. **Give `obs_findings`/`obs_trace` a "promote to fixture" action**: when a finding (or a manually-caught bug like today's three) is confirmed real, write the exact request/response/pre-post-state into a checked-in fixture (`benchmark/mcp-regression/fixtures/*.json`) consumed by item 4's wire-contract suite. This is the Langfuse/Phoenix/HoneyHive "promote a production trace into the dataset" loop, implemented as a local CLI/MCP action instead of a SaaS UI button. New script `scripts/promote-finding-to-fixture.mjs` or MCP tool `obs_promote_to_fixture`.

12. **Update `rules/observability-first.md` and `rules/mcp-response-audit.md`** once items 1-3 land, to require checking `obs_findings`/`obs_alerts` (now real and queryable) as the *first* mechanical step, instead of prose-only manual inspection — turning "please remember to check" into a rule backed by an actual signal, closing audit gap #7.

---

## Top Recommendation

Ship **Tier 0, items 1+2 together**, as a single PR: wire `init_observability()` into `run_headless_host()` (`src-tauri/src/lib.rs`, `src-tauri/src/bin/headless_host.rs`) using the identical call pattern already proven at `lib.rs:5281`, and simultaneously replace `#[instrument(skip_all)]` on `dispatch()` (`tools.rs:1976`) with named fields that record `tool`, the literal `handler` method name at each match arm, and `status` derived from the `Result`. This is the single highest-leverage change because it is the precondition for every other item in this roadmap (evaluators, alerts, wire-contract tests, and dashboards are all worthless against an empty database), it requires zero new dependencies or infrastructure, it is a small, reviewable diff confined to two files most engineers already understand, and it directly targets the exact binary Terminal-Bench spawns per trial — meaning it also closes a live blind spot in the benchmark harness itself, not just in ad hoc debugging sessions.

## Would This Have Caught the Three Bugs?

**Bug #1 (idle-timeout watchdog killed the listener):** Likely yes, but only via a heartbeat/liveness metric independent of tool-call activity (Tier 3) — Tier 0/1/2 alone would not catch it, and the heartbeat must be tied to real listener state, not another activity proxy, or it inherits the same blind spot. Solid catch if scoped correctly.

**Bug #2 (append-cap silently truncating the original entry):** Yes, with high confidence. A production-side invariant evaluator (`post_len >= min(pre_len, cap)`) checking every real append, not just unit-test cases, would have flagged the first violating production call immediately.

**Bug #3 (`brain_get_entry` dispatching to the wrong method):** Only partially. Recording just the requested tool name in a span would NOT have caught it, since the wrong handler still returns a valid-looking response — nothing looks like a failure at the span-status level. Catching it needs the actual callee/handler name recorded as its own span attribute PLUS a check comparing it to an expectation (a destination-verification test), and that still depends on someone remembering to write the assertion — the same vigilance gap that let the bug survive two rounds of fixes already. The only roadmap item that makes this bug class structurally impossible rather than merely observable-after-the-fact is collapsing the hand-written dispatch match into a single generated source-of-truth table (tool name and gateway method defined once, not duplicated).

**Summary: strong yes for the silent-corruption bug, conditional yes for the watchdog bug, and honest partial-credit for the dispatch-drift bug** — observability makes it visible in a trace, it does not auto-detect it the way an invariant evaluator does.
