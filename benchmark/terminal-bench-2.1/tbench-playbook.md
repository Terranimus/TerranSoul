> **ARCHIVED — Terminal-Bench 2.1.** This document belongs to the closed 2.1
> campaign (Claude Code agent loop + `claude-sonnet-5`). It is retained for
> provenance and is **not** current guidance. The active campaign is
> Terminal-Bench 3.0; see `benchmark/terminal-bench/`.
# Terminal-Bench playbook — run this, do not redesign it

> Entry point for `/loop finish TerminalBench`. Everything needed is here. Three
> architectures were tried and two are closed; do not reopen them without reading
> "Closed paths" at the bottom first.

## The architecture: TS + Claude Code + Opus 5 (owner decision, D-G)

**Claude Code runs INSIDE the task container** (Harbor's built-in `claude-code`
agent). **TerranSoul attaches as an MCP server** on the host, supplying memory,
retrieval and `max`-mode reasoning. Claude Code consumes MCP natively, so this
needs no shim, no ReAct parser, and no exec bridge.

Publish it as **"TS + Claude Code + Opus 5"** — never as TerranSoul alone. Claude
Code contributes the agent loop; TerranSoul contributes memory. Claiming otherwise
is the misattribution `rules/one-path-three-surfaces.md` exists to prevent.

## ⛔ BLOCKER 2026-08-04: every path needs an ANTHROPIC_API_KEY

The D-G run reached authentication and stopped there:

    AgentAuthenticationError    1        runtime 1m 27s

That is GOOD news architecturally — Harbor, the container, the `claude-code`
agent and `--mcp-config` are all correct, or it would have failed earlier. Claude
Code installed and ran inside the container. It simply has NO CREDENTIALS there:
the container is a fresh Linux box with no keychain, no OAuth token, no
`ANTHROPIC_API_KEY`. The owner's subscription lives on the Windows host.

**Three architectures now fail at the same place for the same reason:**

| path | fails at |
|---|---|
| TerranSoul's own loop + subscription | `--bare` strips the agent identity and reads ONLY `ANTHROPIC_API_KEY`; with the identity intact the model refuses tools it lacks and executes on the HOST |
| Claude Code in container (D-G) | `AgentAuthenticationError` — no credential inside the container |
| local 12B | no auth problem, but cause #4 undiagnosed and 83.8 % is a stretch for a 12B |

This is ONE structural fact, not three bugs: **automated benchmark harnesses
authenticate with API keys; subscriptions authenticate interactive humans.**

**To unblock, supply a key and pass it into the container:**

    "$HARBOR" run -a claude-code -m claude-opus-5 ...       --ae ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"

### OWNER DECISION 2026-08-04 — subscription OAuth token, risk accepted

This section previously read *"Do NOT attempt to inject an OAuth/subscription
token into task containers."* **The owner has overruled that**, choosing the
subscription route over a metered API key. Recorded here so it is not
re-litigated every session — and so the reasoning that was overruled is still
visible rather than quietly deleted.

**The mechanism.** `claude setup-token` (Claude Code 2.1.221 has it: *"Set up a
long-lived authentication token"*) mints a `CLAUDE_CODE_OAUTH_TOKEN` for
headless use on a Pro/Max plan. It is the same mechanism `claude-code-action`
uses in GitHub Actions, so this is a supported headless path, not a bypass.
It is **interactive** — a browser OAuth round trip — so an agent cannot mint
it; the owner runs it and exports the result.

    "$HARBOR" run -a claude-code -m claude-opus-5 ...       --ae CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"

**The risk that was accepted, stated plainly.** Task containers run untrusted
benchmark code with network access. A token handed to that container is
readable by anything running inside it, and it is a *subscription* credential,
not a scoped per-run key — so the blast radius of a leak is the owner's whole
Claude account, not a revocable project key. Mitigations worth taking:

* Revoke the token (`/logout` on the CLI, or the console) once a sweep ends —
  do not leave a long-lived token minted between runs.

  **⚠️ OWED FOR THE 2026-08-04 CAMPAIGN, owner-scheduled: rotate when the sweep
  finishes, not before.** The active token was printed in full into an agent
  transcript by a botched shell check (`${v:+YES}${v:-NO}` prints the VALUE when
  the variable is set — it was meant to print YES/NO). The file itself never
  leaked: `mcp-data/.tb-token.env` is gitignored (`.gitignore:49`) and untracked,
  so nothing reached git. Rotating mid-run would kill the sweep, so the owner's
  sequence is: let it finish → `claude setup-token` → overwrite
  `mcp-data/.tb-token.env`. It is a SUBSCRIPTION credential, so the blast radius
  is the whole Claude account, not a scoped project key.
* Prefer a fresh token per campaign over reusing one across weeks.
* Remember every call also draws on the owner's Pro/Max quota and competes
  with their own Claude Code usage.

The API-key route (`--ae ANTHROPIC_API_KEY=…`) remains available and is still
the lower-blast-radius option if the owner reverses this.

## Preflight (all four, every time)

> **Just run `benchmark/terminal-bench/run-dg.sh`** — it performs every check
> below as a hard gate and refuses to start if one fails. The manual list is
> kept because knowing *why* each gate exists is what stops someone deleting one.

```bash
# 1. brain must answer — the container talks to it via host.docker.internal
curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7423/health   # want 200
# if not: node scripts/copilot-start-mcp.mjs

# 1b. ⚠️ /health IS NOT ENOUGH — it is unauthenticated and answers 200 for
#     everyone. /mcp is credential-gated. Probing only /health is how the
#     committed mcp.json shipped with no auth header at all: every brain_*
#     call inside the container would have been rejected, the trial would
#     still have completed, and the number would have been plain Claude Code
#     wearing TerranSoul's name. Probe the route the container really calls:
curl -s -m 8 -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:7423/mcp \
  -H "Authorization: Bearer $(tr -d '\r\n' < mcp-data/mcp-token.txt)" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'          # want 200

# 2. harbor must resolve. It is a `uv` tool and is NOT on PATH in backgrounded
#    shells — this silently produced exit 127 twice. Resolve it once:
HARBOR="$(command -v harbor || echo "$HOME/.local/bin/harbor")"
"$HARBOR" --version

# 3. UTF-8 or the CLI dies on its own table glyphs before running anything
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1

# 4. no leftover containers from a previous run
docker ps -a --format '{{.Names}}' | grep -E 'env-main' | xargs -r docker rm -f
```

## The run

```bash
TB21=<clone of harbor-framework/terminal-bench-2-1>     # tasks live in $TB21/tasks
"$HARBOR" run \
  -a claude-code \
  -m claude-opus-5 \
  -p "$TB21/tasks" \
  -i fix-git \
  --env docker \
  --mcp-config D:/Git/TerranSoulApp/benchmark/terminal-bench/terransoul.mcp.json \
  -o <jobs-dir> --job-name tsg1 -n 1 -k 1 -y
```

* `-m claude-opus-5` — **Opus 5**. `claude-opus-4-5` is Opus 4.5 and was passed by
  mistake once; it is a different model.
* `-p $TB21/tasks` — the **tasks/** subdirectory, not the repo root. Resolving by
  dataset name instead pulls `terminal-bench-core`, a DIFFERENT and partly
  contaminated benchmark that runs cleanly and scores plausibly.
* `--mcp-config` — at `benchmark/terminal-bench/terransoul.mcp.json`, pointing at
  `http://host.docker.internal:7423/mcp`. **⛔ See the blocker directly below —
  this does NOT currently give the container brain access.**

## ✅ RESOLVED 2026-08-04 — was: harbor CANNOT pass MCP auth headers

**Fixed by the header-injecting proxy** (`benchmark/terminal-bench/mcp-auth-proxy.mjs`,
owner's choice of the three options below; started and torn down automatically
by `run-dg.sh`). Proven at $0 — the same invalid-token probe that exposed the
failure now reports, from inside the task container:

    "mcp_servers":[{"name":"terransoul","status":"connected"}]

and the proxy's own host-side log shows the container completing the full
handshake: `initialize` → `notifications/initialized` → `tools/list` →
`resources/list` → `prompts/list`.

**The MCP token is deliberately NOT passed into the container.** The proxy adds
it host-side, so the brain credential never enters an environment running
untrusted benchmark code — strictly safer than `--ae` would have been.

**Writes are blocked by default** (`TB_PROXY_ALLOW_WRITES=1` lifts it, and then
the run is NOT a clean measurement). This is TB-3's "0 brain writes during a
5-task run" criterion enforced mechanically rather than trusted.

The diagnosis below is kept because it is the reason the fix looks the way it
does — and because the next person to see `status:"failed"` needs it.

### The original blocker

Proven at $0 with an invalid-token probe (`cost_usd: 0.0`). The trial's own
`agent/claude-code.txt` reported:

    "mcp_servers":[{"name":"terransoul","status":"failed"}]

**Root cause, read from harbor's source, not inferred.**
`harbor/agents/installed/claude_code.py::_build_register_mcp_servers_command`
serialises every non-stdio server as exactly:

```python
servers[server.name] = {"type": transport, "url": server.url}
```

Only `type` and `url` survive. A `headers` block in the `--mcp-config` file is
**silently dropped** — verified by diffing the rendered config (which contained
`Authorization: Bearer …`) against what harbor actually wrote into the
container's `$CLAUDE_CONFIG_DIR/.claude.json` (which did not). The stdio branch
is no better: it carries `command` and `args` but no `env`.

This is structural in harbor 0.20.0, not a version gap or a config mistake.

**And TerranSoul's MCP requires that header.** `router.rs::validate_auth`
accepts *only* `Authorization: Bearer <token>` — no query parameter, no
alternative scheme. So as shipped, the D-G container can reach the brain
(`host.docker.internal` resolves, `/health` and authed `/mcp` both return 200
from inside a container) but can never authenticate to it.

**Three fixes, all viable, with different trade-offs:**

| | how | keeps writes blocked? | touches |
|---|---|---|---|
| A | `lan_public_read_only` — TerranSoul's own designed escape hatch. `router.rs::is_public_tool_name` already allowlists `brain_search`, `brain_suggest_context`, `brain_health`, `brain_kg_neighbors`, `brain_summarize`, `brain_get_entry`, `brain_list_recent` for token-free access. Needs `settings.lan_enabled = true` + `lan_auth_mode = PublicReadOnly`. | **yes** — and that *is* TB-3's "0 brain writes during a run" criterion | a setting |
| B | header-injecting local proxy on a spare port; point the container at it | no (full tool surface) | a new script |
| C | patch `claude_code.py` to emit `headers` | no | a third-party file, lost on upgrade |

**A is the recommended default**: it is TerranSoul's own mechanism rather than
a workaround, and read-only is what the bench *should* have — a benchmark that
can write to the brain contaminates it, which `rules/bench-agi-purity.md` and
TB-3 both exist to prevent. Note it does widen access: anything that can reach
:7423 gets token-free read-only brain calls. It does **not** change the bind
address — the headless tray passes `lan_enabled: false` to the server
(`lib.rs:3840`) regardless; only the auth gate changes.

## Reading the result — two separate questions

**1. Did the task pass?** Read `<jobs-dir>/<job>/result.json`.
⚠️ **NEVER the exit code.** `harbor` exits **0 on a FAILED trial**, because a
failed trial is a valid result. Reading exit 0 as success reported a 1h48m timeout
as a pass once already.

⚠️⚠️ **AND `mean` IS NOT THE SCORE EITHER — check `n_errored_trials`.**
Measured on job `dg-20260804-161447`: the agent died with `UnknownApiError`
(the OAuth token expired mid-run) and that **same trial** reported

    metrics          [{'mean': 1.0}]
    exception_stats  {'UnknownApiError': ['fix-ocaml-gc__WBapfE5']}
    verifier/reward.txt -> 1

The verifier ran regardless of the agent erroring and scored the container as
it found it. **An errored trial still contributes its reward to the headline
mean.** Over a 445-trial sweep a handful of transient API errors is close to
certain, so a mean read without `n_errors` is inflated by construction. Re-run
or exclude errored trials, and state which you did. `run-dg.sh` now shouts
about this automatically.

**2. Did TerranSoul actually get used?** Grep the agent logs for MCP tool calls
(`brain_search`, `brain_suggest_context`, …). **A pass with zero MCP calls is
Claude Code's score with TerranSoul as decoration** — do not publish that under a
name containing "TS".

## Progress signal while it runs

`docker ps` is more truthful than any log tail. A live `*__env-main-1` container
means Harbor really started and built the environment. Absence of one means it
never got that far, whatever the shell said.

## Then, in order

### ✅ RESOLVED 2026-08-04 — was: a fresh brain can never earn write trust

Both blockers below are fixed. **The remaining gate before a sweep is
operational, not a bug: the running brain must be a REBUILT binary** (see
"Rebuild or the fix is not live" at the end of this section).

**The bug (TRUST-BOOTSTRAP-1).** A freshly reset bench brain refused every
learning write:

    action gated by earned autonomy: tool `brain_ingest_lesson` is in the
    `safe_write` category, whose trust (0.50) is below the earned threshold
    (0.60).

Read from the live store rather than inferred — `mcp-data-tbench/memory.db`:

    action_trust_ledger: safe_write  success=0 failure=1 consec_fail=1 quarantined=0
    confidence (0+2)/(0+1+3) = 0.50  <  threshold 0.60

**Not quarantine — a plain below-threshold dip after exactly ONE failed write**
(a caller omitting a required argument is enough; `invalid argument` legitimately
debits). `safe_write` is *born open* by design: its seeded 0.60 threshold sits
BELOW the ≈0.67 cold-start prior so an agent can record lessons from minute one.
One failure dropped it under, and the half-open probe — the only exit — required
`success_count > 0`, a success the gate would never let it record. **Permanent,
for every new user, not just this bench.**

**The fix.** Probe eligibility now asks *"did this category have trust to
lose?"* instead of *"has it ever succeeded?"*:

```rust
probe_eligible = led.success_count > 0 || born_trusted(cfg, cat)
born_trusted   = cold_start_confidence(cfg) >= threshold_for(cfg, cat)
```

Deny-by-default is untouched — `external_fetch` 0.75 / `code_execute` 0.80 /
`system_modify` 0.90 all sit ABOVE the cold start, so they are not born trusted
and stay hard-denied at zero successes. The rule is read from seeded config, so
hardening stays data: seed `action_trust.threshold.safe_write` above the prior
and it becomes deny-by-default too, with no code change. Rate limiting is
unchanged (one probe per `quarantine_probe_cooldown_ms`), and one successful
probe puts trust back at 0.60 — open again.

`crates/memory/src/action_trust.rs` (+ `crates/shared-types`, `store.rs`,
`mcp-data/shared/seed-config.sql`). Five regression tests; four fail on the
pre-change tree, verified by reverting the predicate and re-running.

**Second blocker, also fixed: the instrumentation could not have told you.**
`check-terransoul-used.sh` counted calls the PROXY forwarded; nothing read what
the brain answered (an MCP refusal is HTTP 200 with `result.isError:true`, and
the proxy piped responses through unread). `TB_DEFER_WRITES` was worse — three
layers claimed success for writes that never landed: the synthetic ack, the
`flushed:N` count (which counted requests SENT), and "N calls served".

Now: the proxy tees each response and records the brain's verdict
(`accepted` / `refused` / `gate-denied`); `flushed` is the ACCEPTED count;
`check-terransoul-used.sh` gained witness 3 (brain-side verdicts, **decisive** —
it fails the run if the brain accepted nothing or gate-denied anything) and
witness 4 (`memory_total` before/after, from the `/health` body `run-dg.sh`
already fetched and threw away). Six new test cases; five fail pre-change —
**the old script exited 0, "TerranSoul was genuinely used", for a run in which
the brain refused every call.**

Proven end to end by `deferred-writes.test.sh`, which was silently red for this
exact reason and now names it:

    [tb-proxy] flushed 0/1 deferred lesson(s) on request, 1 REFUSED by the brain
    [tb-proxy] deferred lesson REFUSED by the brain: action gated by earned
               autonomy: ... trust (0.50) is below the earned threshold (0.60)

**⚠️ THE PORT IS A RACE, NOT A SETTING — hit while verifying this fix.**
`TERRANSOUL_MCP_PORT` is **not read by the Rust backend at all** (only
`TERRANSOUL_MCP_DATA_DIR` is); a tray takes `:7423` if it is free, else `:7424`.
So the port a store lands on depends on which one finishes loading first.
Restarting both at once put the 9 MB bench store on `:7423` and the 300 MB
production store on `:7424` — **silently swapped**. In learn mode that means a
sweep writing "isolated" bench lessons straight into the production brain.

Start them ONE AT A TIME, production first, and wait for `:7423` to answer
before starting the bench brain:

    $env:TERRANSOUL_MCP_DATA_DIR="D:\Git\TerranSoulApp\mcp-data"          # then wait for :7423
    $env:TERRANSOUL_MCP_DATA_DIR="D:\Git\TerranSoulApp\mcp-data-tbench"   # then it takes :7424

Verify by `memory_total`, which distinguishes them (production ≫ bench), not by
`/health` returning 200 — both do.

**This is why the authed `tools/list` probe at `run-dg.sh:122-132` is
load-bearing and must not be "simplified" into the `/health` check.** It uses
`$BRAIN_DATA/mcp-token.txt`, and the two stores carry DIFFERENT 64-char tokens,
so a swapped brain fails auth and the run refuses — the probe is a store
IDENTITY check, not merely a credential check.

**⚠️ Rebuild or the fix is not live.** Both trays run
`target-mcp/release/terransoul.exe`. A source fix does nothing for an
already-running binary — lesson 24165 recorded this once and it cost a session.
Note the build will **fail to link** (`error: failed to remove file ...
Access is denied. (os error 5)`) while either tray is running: stop them first,
build, then restart. And read the build OUTPUT — that failure was reported to
the caller as exit code 0.

    cargo build --release --no-default-features --features headless-mcp \
      --manifest-path src-tauri/Cargo.toml --target-dir target-mcp

then restart the tray (`:7423`) and the bench brain (`:7424`). Confirm with
`bash benchmark/terminal-bench/deferred-writes.test.sh` — 4/4 green means a
lesson written by one trial is really retrievable by the next.

### ⚑ SELF-LEARNING: a lesson is not retrievable until it is EMBEDDED

`deferred-writes.test.sh`'s `retrievable_after_flush` case does **not** test
retrievability — it asserts `memory_total` grew, and its own comment concedes
"brain_search does not reliably match a marker token". So the loop was only ever
proven to STORE. Probed properly on 2026-08-04, same store, same two queries,
only elapsed time differing:

| when | `pending_embedding_count` | result |
|---|---|---|
| 15 s after the write | > 0 | **not retrievable** — missed even a query containing its OWN literal phrase |
| after the backfill | 0 | **rank 1**, on that phrase AND on a paraphrase |

So cross-task learning is real — rank-1 recall from a paraphrase is genuine
semantic retrieval, not keyword luck — but it has a LATENCY, and the earlier
session's "marker tokens don't match" workaround was papering over it.

That latency lands exactly on the sweep's critical path: `TB_DEFER_WRITES`
flushes at job END and `run-sweep.sh` starts the next job seconds later, so
without a barrier task N+1 queries a brain that cannot yet see what task N
learned — while the log happily reports "N lessons flushed". `run-dg.sh` now
waits for `pending_embedding_count == 0` in TWO places (`wait_for_embeddings`):

* **preflight** — a freshly reseeded store starts at rag 0% with every row
  queued; starting a trial there measures keyword-only retrieval and calls it
  TerranSoul (the same shape as the `LONGMEM_EMBED=1` regression, where a
  "retrieval regression" was really the dense channel switched off);
* **post-flush** — what turns "wrote a lesson" into "the next task can find it".

Cost on this machine: a full 1123-row backfill is ~5.5 min; steady-state
between tasks is seconds. `TB_EMBED_WAIT_S` caps the wait and the run says so
loudly rather than proceeding silently degraded.

**VERIFIED 2026-08-04 on the rebuilt binary: 4/4 green**, and the bench ledger
shows the whole recovery arc rather than an assertion about it:

    before   success=0 failure=1  -> 0.50  -> gate-denied, no exit
    after    success=1 failure=1  -> 0.60  -> OPEN        (flushed 1/1, "accepted")

One granted probe was enough: the write landed, and trust returned to threshold
on the same call.

### ⚑ OWNER INSTRUCTION 2026-08-04 — "thinking is max", and what it costs

Audited against the published capability spec,
[memory-evolution.html](https://terranimus.github.io/TerranSoul/LLM-Brain-Design-Research-Paper/memory-evolution.html),
so the bench stops losing capability silently.

**The bench was running the CHEAPEST rung of a max-mode product.**
`brain_search`'s `thinking_mode` defaults to `chat`, and across every recorded
job trajectory — **46 `brain_search` calls — ZERO carried the argument.** The
rungs are cumulative, not stylistic: `chat` = plain recall; `think` = + the
reason-then-rank judge; `research` = + iterative sub-queries, completeness
critic and KG-edge expansion; `max` = + claim-level verification of the
ranking. So chat did not merely run faster, it removed the reranker, the graph
expansion and the verifier from the measurement — spec stages 4 and 6 ride on
this one argument and were lost with it.

**Now pinned host-side**, in `mcp-auth-proxy.mjs`, beside the existing
learn-mode category rewrite and for the same reason: *an instruction the agent
may decline is not a configuration*. `TB_THINKING_MODE` (default `max`,
`off` restores agent discretion). Guarded by `thinking-mode-pin.test.sh`;
3 of its 5 cases fail on the pre-change tree.

**⚠️ THE COST, MEASURED — read before launching a sweep.** Against the tray on
`:7423` (ollama `gemma4:12b-it-qat`):

| `thinking_mode` | one `brain_search` |
|---|---|
| `think` | **0.5 s** |
| `max` | **374 s** (a second probe did not return within 240 s) |

**⚑ OWNER DECISION 2026-08-04, taken ON that measurement: the sweep runs at
`think`, and `max` is measured SEPARATELY on a task subset.** A full sweep at
max blows the >12 h STOP guardrail below, and a task that runs out of
wall-clock scores 0 however good its retrieval was — so pinning max to the
headline run would have bought a worse number and a longer wait. `think` still
carries the reason-then-rank judge, i.e. a real rung above plain recall.
Encoded as `TB_THINKING_MODE` (`run-sweep.sh` exports `think`; the proxy's own
default stays `max` for one-off runs).

**Whatever a config says, publish the rung the WIRE saw.** With two rungs in
one campaign, attaching the wrong one to a number is the easiest available
misattribution, so `check-terransoul-used.sh` now has a witness 5 that reads
the rung out of the proxy log, names `chat` explicitly when nothing was
recorded, and shouts if ONE run contains more than one rung.

Consequences, none of them optional:
* `run-dg.sh` now passes `MCP_TOOL_TIMEOUT=900000` into the container. Without
  it every brain call aborts client-side and the run reads as a brain failure
  rather than a latency cost.
* **The playbook's ~4 h / ~$197 estimate for ~89 trials no longer holds.** At
  ~6 min per search, a handful of searches per task is hours by itself. Re-time
  a single task before committing, and apply the existing >12 h STOP guardrail.
* Task wall-clock is a Terminal-Bench failure mode in its own right — a task
  that times out scores 0 regardless of how good the retrieval was.

### ⛔ `thinking_mode: think` IS A NO-OP ON THE MCP PATH — label the run `chat`

`tools.rs:1704`:

    ChatMode::Auto | ChatMode::Chat | ChatMode::Think => LadderRung::Recall,

`think` and `chat` route to the SAME plain-recall rung. Only `research` and
`max` leave it. So the sweep pinned to `think` measured chat-level retrieval,
and witness 5's `think(N)` records what was REQUESTED, not what ran.

**Consequence for the write-up: describe the retrieval as plain recall
(chat-equivalent), not as "think".** The compromise that chose `think` over
`max` for latency bought a label, not a capability — the real choice on this
path is chat (sub-second) or research/max (seconds to minutes).

**And it is a product contradiction, not just a bench one.** The MCP tool schema
sells the rung it does not deliver (`tools.rs:53`): *"'think' = recall + the
reason-then-rank judge"* — a judge `ladder_rung` never invokes. Either route
`think` through the reranker or stop advertising it. Note this AGREES with
memory-evolution.html, which already says think shares chat's retrieval path
unchanged; the MCP description is the outlier. Fix at the source
(`ladder_rung` / the schema text), never by special-casing the bench.

### ⚑ What the container can actually reach (audited 2026-08-04)

The MCP wire carries `tools.rs::EXPOSED_TOOLS` — an owner-approved **nine-tool**
product API (2026-08-01, "one coherent CRUD+RAG API", down from 84), not the
84-tool sprawl the proxy allowlist still mirrors. In default mode the container
can call **4** (`brain_search`, `brain_get_entry`, `brain_kg_neighbors`,
`brain_health`); in learn mode **8** (+ `brain_ingest_lesson`, `brain_append`,
`brain_add_edge`, `brain_close_edge`).

Three corrections landed from this audit:

* **`extra-instruction.md` told the agent to call `brain_suggest_context`
  three times — a tool that is NOT on the wire** (cut from EXPOSED_TOOLS as a
  near-synonym of `brain_search`). Every time the agent obeyed it burned a turn
  on an error. Removed.
* **It also recommended `rerank: true`** — which the spec's own stage 7 records
  as measured NET-NEGATIVE (0.52 NDCG@10 below chat at 7.1× latency) and
  removed from `think`'s path on 2026-08-02. Recommending a known regression.
  Removed.
* **The proxy refused 43 of 47 advertised tools with `'X' is a write/mutating
  tool`** — false for the 21 (`code_*`, `repo_*`, `obs_*`, `canvas_snapshot`,
  `cross_source_search`) that `action_trust.rs` classifies SafeRead. They stay
  blocked, but for the true reason: they read the HOST's filesystem and code
  index, which a container running untrusted benchmark code must not reach
  (host exposure + `rules/bench-agi-purity.md` contamination). Message fixed,
  and it now enumerates only tools the server really serves.

Known remaining losses, stated so the submission does not overclaim:

| spec stage | status in the bench |
|---|---|
| 3 ANN / shard router | **absent** — `mcp-data-tbench/vectors/` is empty, all shards `ann_index_exists:false`, router `centroid_count:0`. At 1121 rows the exact-scan fallback is at least as accurate; the loss is the scale claim, not recall. Do not claim stage 3. |
| 9 consolidation, 8 governed write | **off the wire** by the nine-tool API decision — `brain_consolidate` / `brain_govern_memory` are not exposed. Reachable only by a host-side call between tasks. |
| 11 learned frontier (MMR, PPR, RaBitQ, MUVERA) | **default-off config rows**; the container has no config-write tool. Per `rules/no-unexercised-features.md` each would need its own bench arm — not a blanket enable. |
| corpus breadth | the bench brain holds **423** non-config memories vs the live brain's **1222** — 802 live-only lessons were never synced to `seed-lessons.sql`. Disclose the corpus size; it frames the cross-task-learning claim. |

Two prior beliefs were **REFUTED** by direct measurement and should not be
re-derived: the bench store is *not* unseeded (698 config rows, zero value
mismatches vs the shipped seed, 350 KG edges), and its `memory_edges` table is
*not* empty. `run-sweep.sh` now also defaults `TB_DEFER_WRITES=1` — it defaulted
to `TB_ATTEMPTS=5` with deferral OFF, i.e. the cross-attempt-leaky combination
was the default.

### ⚑ DISK: the sweep leaks a docker image per task, and pruning does NOT free the host

Measured across this campaign: C: free went 50 GB -> 40 -> 25 while docker
images grew 14.4 GB -> 29.4 GB. Each task builds its own image and nothing
reaps them, so a 89-task sweep would have run the system disk to zero.

Prune BY AGE, never blanket `-a`:

    docker image prune -a -f --filter "until=3h"     # reclaimed 23.6 GB, live task unharmed

A blanket `docker image prune -a` would delete the base images the CURRENT
tasks reuse, forcing a rebuild per task — more network, longer setup, and
`AgentSetupTimeoutError` is already the second-most-common failure here. The
age filter keeps anything recent, so the running container is untouched
(verified: it stayed `Up` across the prune).

**⚠️ And host free space will NOT move.** Docker Desktop keeps everything in
`%LOCALAPPDATA%\Docker\wsl\...\docker_data.vhdx` (149.6 GB here). Pruning frees
space INSIDE that virtual disk; the file itself never shrinks. So after
reclaiming 23.6 GB, `C:` still read 25.0 GB free — which is fine and is the
point: the reclaimed space is reused by later image builds instead of growing
the vhdx further. Reclaiming it on the HOST needs the vhdx compacted with
docker stopped, which would kill a running sweep — not worth it mid-campaign.

Watch `C:` each loop iteration; act below ~10 GB.

### ⚑ UNATTENDED RUNS: the machine will SLEEP and kill the sweep

Measured 2026-08-04 on this host: `standby-timeout-ac` was **900 s**. A sweep
left running while the owner is away dies at the 15-minute mark — a CPU-busy
process does not reliably keep Windows awake, because idle sleep keys on USER
INPUT. Before any unattended run:

    powercfg /change standby-timeout-ac 0     # never sleep
    powercfg /change hibernate-timeout-ac 0

**DO NOT "restore" 900 on this host.** The owner keeps never-sleep ON
deliberately (stated 2026-08-04). An agent that reads a 900 s value and helpfully
puts it back is undoing the owner's own configuration — check with them before
changing a power setting back, rather than treating the pre-run value as the
intended one.

Blanking the displays is unrelated and safe (`SC_MONITORPOWER`); any input or
an RDP connection wakes them, and it does not affect the run.

### ⚠️ FOLLOW-UP OWED — `last_job_errored` retries the wrong class of error

`d3d8e9e7` stopped the sweep marking an ERRORED trial complete (which would have
hidden it from `TB_RESUME=1` while leaving its 0.0 in the mean). Correct as far
as it went, but it treats every exception as retryable, and they are not the
same thing:

| exception | what it means | right action |
|---|---|---|
| `UnknownApiError` | credential died / API broke — the run broke | RETRY |
| `AgentTimeoutError` | the agent ran out of time — the AGENT failed | ACCEPT as a legitimate 0.0 |

Measured on `caffe-cifar-10`, which failed twice for two different reasons:
`UnknownApiError` at 42 min (the per-batch token expiry, now fixed), then
`AgentTimeoutError` at 1 h 6 m with a fresh 478-min token. The second is a real
result — the task is heavy (CIFAR-10 training) and the agent cannot finish it in
budget. Left as-is, every `TB_RESUME=1` re-runs it for another ~1 h and ~$1.50
and it times out again.

**Fix when no sweep is in flight** (do NOT edit `run-sweep.sh` while it is
running — bash reads scripts incrementally and editing one mid-execution can
jump it to a wrong offset): make `last_job_errored` retry only INFRASTRUCTURE
exception names and treat agent-side ones as completed failures. Keep the
distinction visible in the merged report, because "the agent timed out" and
"the harness broke" must never average into the same number.

### ⚑ THE "90% TOKEN SAVING" CLAIMS DO NOT APPLY TO US (audited 2026-08-05)

Owner asked whether the ~90% figures advertised by open-source memory projects
should show up in our attempts 2-5. **No — they measure a different mechanism.**

**Family A, "context substitution"** — mem0 90% (1.8K vs 26,031 tok), Zep 98%
(1.6k vs 115k), Supermemory 99.4%. Every one measures INPUT tokens only, against
a full-context baseline that replays an entire prior conversation into the prompt
on each query. mem0's own blog scopes it: *"single-pass retrieval setup: one
retrieval call, one answer, no agentic loops."* **This mechanism does not exist
here.** A Terminal-Bench container is fresh, with no prior conversation, so our
denominator is zero — it is 90% of a cost we never pay. These claims also exclude
the cost of WRITING memories, which we do pay.

**Family B, "exploration reduction"** — the agent explores fewer dead ends
because it already knows. THIS is our mechanism, and the honest published range
is 14%-79%, not 90%.

The decisive comparison is GenericAgent (arXiv 2604.17091) Table 8: nine repeated
rounds of one task on Claude Opus 4.6, its round-1 -> round-2 step being the exact
analogue of our k=2.

| | output | input(+cache) | runtime |
|---|---|---|---|
| OURS (attempt 1 -> 2+) | **-39.2%** | -18.3% | **-42.5%** |
| GenericAgent (R1 -> R2) | -36.4% | -71.3% | -42.4% |

Output and runtime agree to ~3 points and ~0.1 points. **Our pipeline is already
at parity with the best published agentic repeat-attempt result on the two axes
that measure "the agent explored less"** — and that was measured on the PRE-FIX
corpus. The gap is entirely input/cache, and the cause is visible in their table:
their LLM call count collapsed 32 -> 12, and cache-read is calls x prefix. Our
-18.3% implies a large fixed per-call prefix (system prompt, tool schemas, MCP
definitions) that fewer turns cannot move. That is the one actionable finding.

GA's 89.6% headline needs NINE rounds AND crystallising the workflow into
EXECUTABLE CODE. Their natural-language-SOP ceiling after five rounds is -84%;
the last ~6 points come from codification. We write NL lessons, so that route is
closed to us. Their curve is also front-loaded then flat (rounds 6-9 converge to
23k +/- 1k), so k=5 should show one big step at attempt 2 and then a plateau.

**Credibility caveat, worth remembering before citing anyone in this field.**
Zep's 84% LoCoMo was corrected to 58.44% by mem0; Zep re-rebutted at 75.14%.
Letta could not reproduce mem0's MemGPT numbers. Independent testing found mem0
OSS at 32.4% on LongMemEval against 93.4% self-reported for the managed product
-- and, most damning, **a plain LLM with NO memory scored 57.6%, beating most
dedicated memory systems**. Any claim we publish needs a no-memory control for
exactly this reason.

**Expect at k=2: ~35-45% fewer output tokens, ~40% less runtime.** Which is what
we already measured. Not 90%.

### ⚑ CHEAPEST DEFENSIBLE ATTRIBUTION (owner 2026-08-05: "save cost as much as possible")

**For a PAIRED comparison, power comes from the number of PAIRS, not attempts per
task.** Five attempts of one task are highly correlated with each other; two
attempts of 89 tasks give 89 independent pairs. That inverts the cost table:

| design | NEW trials | cost | pairs |
|---|---|---|---|
| k=5, full 89 | 356 | ~$486 | 89 (correlated within task) |
| **k=2, reusing the existing attempt 1** | **89** | **~$56** | **89** |
| k=2 fresh (both attempts re-run) | 178 | ~$154 | 89 |

The cheap option is possible only because attempt 1 is configuration-identical
under both deferral settings, and every k=1 trial is already on disk.

⚠️ **The confound, and which way it cuts.** Reusing the old attempt 1 means
attempt 2 runs later, so it benefits from BOTH its own task's lesson AND every
cross-task lesson written in between. That INFLATES apparent uplift — it biases
toward the answer we want, which is the dangerous direction. It is bounded, not
ignorable: only 7 of 74 tasks (9%) demonstrably acted on a cross-task lesson, so
the contamination is small relative to a same-task lesson written minutes
earlier. Report the corpus size at each attempt alongside the result, and if the
uplift is small the confound could account for all of it.

If the measured uplift is large and the budget allows, `k=2 fresh` at ~$154
removes the confound entirely by running both attempts back to back.

### ⚑ THE k=5 PLAN (owner 2026-08-05: "both, sequentially")

**REVISED 2026-08-05 (owner): do NOT run these back to back from scratch.**
"You can do both without sequentially. You have all bench recorded and
checkpoint so you can resume without doing the entire things again."

The saving is real and rests on one fact: **attempt 1 is configuration-identical
under both settings.** No same-task lesson exists yet either way, so deferral
on/off cannot affect it. Therefore

* the ATTRIBUTION run (deferral OFF, k=5) already yields a clean, full-coverage
  attempt-1 pass@1 as a by-product, and
* the SUBMITTABLE arm does not need a fresh k=5 -- it needs the FOUR extra clean
  attempts per task, reusing attempt 1 rather than repeating it.

So the campaign is: finish k=1 -> attribution run -> decide, on what it shows,
whether the submittable arm is worth 30 more hours. That is ~40 h instead of
~74 h, and every stage is resumable from `$STATE` + `jobs/` rather than restarted.

⚠️ One methodological caveat to state if trials from different runs are ever
pooled into one pass@5: they are not i.i.d. The brain's corpus GROWS between
runs, so a later trial has more memory available than an earlier one. That is
already covered by the agreed "cross-task memory writes occurred during the run"
disclosure, but it must be said explicitly rather than assumed harmless.

### ⚠️ SUPERSEDED 2026-08-06 — deferral is OFF, always, by default

The two-run table below was written on the assumption that a submittable pass@5
requires deferral ON. **The owner overrode that**, in these words: *"It should
both self-improve for every task in first iteration and pass these knowledge to
other 2-5 iterations. It should be the default behaviour for TerranSoul for all
self-learning, self-improve for all jobs."*

The reasoning is a product one and it is sound: **production TerranSoul has no
deferral mechanism at all.** Deferral-ON was the setting that made the BENCH
deviate from the SHIPPED PRODUCT — the harness was measuring a system nobody
runs. A user who hits the same problem twice gets the lesson the second time;
so does the bench.

`TB_DEFER_WRITES` now defaults to **0**, and `TB_ONE_JOB_PER_TASK` to **1** so
attempt 1 actually completes before attempt 2 starts (see the trap below).
Guarded by `selfimprove-default.test.sh`. Deferral remains implemented and
tested (`deferred-writes.test.sh`) as an opt-in strict-independence arm.

**The obligation this creates.** Attempts are not independent, so pass@k is NOT
comparable to entries whose agents start each attempt blank. Any leaderboard
submission built on this setting must disclose it in the PR, plainly, without
burying it. Cross-TASK learning (task N using lessons from 1..N-1) is the
separate and uncontested claim and holds under either setting.

### ⛔ THE OLD `jobs/` CORPUS CANNOT BE RELABELLED INTO A SUBMISSION

Asked three times on 2026-08-06, because the saving looks large and it is:
**324 verified trials covering all 89 tasks, 12 already at >=5 attempts — 73%
of the 445 a submission needs**, roughly 27 h. So "it would not save much" is
false; do not reach for that argument, it collapses on inspection.

The dataset field is ALSO not the real objection. The old eval key is
`claude-code__claude-opus-5__tasks` (a local `-p` path), but
`/d/Git/terminal-bench-2-1` is a clean tree at `5c8eadf1`, so the task content
those trials ran was almost certainly identical to the pinned dataset. (The run
never verified `sha256:7d7bdc1c…` though, so writing that hash into the records
asserts something never measured — that alone is disqualifying for uploaded
evidence.)

**The disqualifying objection is harness drift.** ~20 commits landed under
`benchmark/terminal-bench/` between those trials and the submittable run:

| commit | what it changed |
|---|---|
| `f77deda0` | parallel workers were force-killing each other's containers — the "OOM" was sabotage |
| `ac8f20c2` | resume guard killed healthy workers; dead-on-setup trials read as "memory doesn't help" |
| `33c9b34d` | docker network pool exhaustion + a silent 35-task under-run |
| `5271f4cb` | rewrote `extra-instruction.md` — changes what the agent is TOLD |

So a share of those 324 trials are zeros TerranSoul did not earn, and the agent
instructions differ between old and new. Pooling them yields a pass@5 that
describes neither system — and it would **depress** the number, not inflate it.

**Rule: when reuse is proposed, check harness drift FIRST**
(`git log --since=<date> -- benchmark/terminal-bench/`). Provenance fields are
the cheap objection; a changed harness is the disqualifying one. The legitimate
lever for wall-clock is worker count (cap 5), not data reuse.

Original table, kept for the reasoning it records:

| run | deferral | what it yields | ~time | ~cost |
|---|---|---|---|---|
| 1. attribution | **OFF** | attempt 1 = control, attempts 2-5 = treatment; uplift + runtime delta. Attempt-1-only is also a clean full-coverage pass@1 | 37 h | $486 |
| ~~2. submittable~~ | ~~**ON**~~ | ~~leaderboard-shaped pass@5, no cross-attempt leakage~~ — superseded above | 37 h | $486 |

Projections measured over 91 real jobs: median **7.5 min** and **$1.10** per
trial, with attempts 2-5 ~42.5% faster (measured on archived k=5 data), which is
what brings this in at ~$970 rather than the naive ~$1,800.

**⛔ THE TRAP THAT WOULD SILENTLY VOID RUN 1.** `run-sweep.sh:233` branches
one-job-per-task on `TB_DEFER_WRITES = 1`. Turn deferral OFF for the attribution
run and it takes the BATCH branch instead: 10 tasks x 5 attempts = 50 trials in
ONE harbor job at concurrency 4. Attempts of the SAME task can then overlap, so
attempt 1's lesson does not exist when attempt 2 starts -- and the experiment
returns "no uplift", which reads as "memory does not help" rather than "the
harness never let it".

Before run 1, therefore:
1. Decouple one-job-per-task from the deferral flag (a `TB_ONE_JOB_PER_TASK`
   switch), and set it for BOTH runs.
2. Force `TB_CONCURRENCY=1` on run 1 so a task's five attempts are strictly
   sequential. Verified on job `dg-20260804-182446` that harbor already spaced
   them 15-20 min apart with no overlap, but that was luck of scheduling, not a
   guarantee, and this experiment cannot rely on it.
3. Clear `$RETRIES` as well as `$STATE`. `run-sweep.sh` truncates the state file
   on a fresh run but NOT the retry ledger, so a new campaign inherits the old
   one and previously-flaky tasks start with their retry budget already spent.
4. **Snapshot `.tb-sweep-prefixes.txt` per campaign.** It accumulates, and the
   merge reads it -- leave it and run 2's number will silently include run 1's
   jobs.

Analysis tooling is already built and validated: `attempt-uplift.sh` (orders
attempts by file mtime, since harbor's trial ids carry a random suffix and no
index; reports pass-rate uplift AND the runtime delta) and
`self-improve-rate.sh` (write-rate split by task outcome).

### ⚑ SWEEP IN FLIGHT 2026-08-04 — how to resume it cold

    TB_RESUME=1 TB_ATTEMPTS=1 bash benchmark/terminal-bench/run-sweep.sh
    bash benchmark/terminal-bench/merge-sweep.sh benchmark/terminal-bench/jobs

Config, and why each value is what it is:

| | | |
|---|---|---|
| `TB_ATTEMPTS=1` | **not 5** | k>1 + writable memory = same-task retry leakage. See below. |
| `TB_PROXY_MODE=learn` | isolated brain `:7424`, `mcp-data-tbench/` | production brain and committed seed untouched |
| batch | 10 tasks | each batch finishes far inside the ~7 h token window |
| est. | ~89 trials, ~$197, ~4 h | measured $2.21/trial from the 5-task probe |

**⚠️ If you reset or re-run, reset the BENCH STORE too.** Restarting over tasks
whose earlier attempts already wrote lessons re-creates the leakage even at
k=1. `rm -rf mcp-data-tbench` and let it reseed to its 1120-memory baseline.
(Lesson 25909.)

**Why k=1.** Cross-TASK learning is the legitimate claim and is preserved —
task N uses lessons from tasks 1..N-1. Cross-ATTEMPT learning is leakage: with
`-k 5`, attempt 1 could write a lesson attempts 2–5 of the *same* task then
read, and pass@k is precisely the metric that inflates. Caught at batch 1 of a
live sweep; the leaky config cost ~$982/~20 h and bought only a bigger number.

### ⚑ OWNER DECISIONS 2026-08-04 (post-probe)

* **If the sweep beats 83.8 %** → prepare a **draft submission**, named
  **"TS + Claude Code + Opus 5"**, with these disclosures stated UP FRONT, not
  in a footnote:
  * cross-task memory **writes occurred during the run**, so TB-3's "0 brain
    writes" criterion does **not** hold for this result;
  * **k=1, not k=5** — not directly comparable to pass@5 entries;
  * the brain was an **isolated bench store**, not the shipped one;
  * the exact **brain-call counts** from `check-terransoul-used.sh`.
  The owner reviews; **submission itself remains unauthorised.**
* **Below the bar** → stays private, per the original gate.

### ⚑ OWNER AUTHORISATION 2026-08-04 — run steps 1→3 without checking back

The owner was asked how far an agent may go unattended and answered **"go all
the way to the sweep"**. So steps 1, 2 and 3 below are **pre-authorised**: do
not stop to ask permission between them. **Step 4 is NOT authorised** — the
submission decision stays with the owner.

### ⚑ OWNER DECISION 2026-08-05 — the guardrails are now AGENT-DECIDED

The owner's instruction: *"For stop-and-ask, please auto select the best
answer."* So the STOP-and-ask conditions below (cost ceiling, >12 h runtime,
sustained 429s, and any comparable operational fork) no longer halt the run —
pick the best option on the evidence and keep going. Record the decision and its
reasoning in the run report so it is reviewable after the fact rather than
approved before it.

**One boundary is NOT covered by this and still stands: step 4, SUBMISSION.**
That was gated separately and explicitly ("submission itself remains
unauthorised"), and it is a publishing decision, not an operational one — a
different class from "should the sweep pause for a rate limit". Do not read
autonomy over the guardrails as autonomy over publishing.

Two guardrails on that authorisation, chosen by the agent because "as long as
the probe cost looks sane" needs a number that survives a context reset:

* **Cost ceiling.** From the 5-task probe, compute cost-per-trial and
  extrapolate to the full 445 trials (89 tasks × 5 attempts). If that exceeds
  **≈2× the $600 floor (i.e. >$1,200), STOP and ask.** Proceed otherwise.
* **⚠️ With subscription auth `cost_usd` may be `null`.** The oracle run
  already reported `"cost_usd": null`. If the probe reports no dollar figure,
  the ceiling above cannot be evaluated — fall back to measuring **wall-clock
  per trial and any rate-limiting**, extrapolate the total runtime, and if the
  sweep would exceed ~12 h or hit sustained 429s, STOP and ask. Do not silently
  treat "no cost reported" as "free": it is the owner's Pro/Max quota, and it
  competes with their own Claude Code usage.

1. **One task passing** with MCP calls present → that is the integration proof.
2. **5-task run** → measure real per-task cost before committing to a sweep. The
   ~$600 figure for 89×5 is a FLOOR extrapolated from single probes ($0.067 for a
   9-token reply, $0.22 for a slightly longer one — cost scales with prompt size).
3. **Full sweep**, subject to the two guardrails above.
4. **Submit only if it beats 83.8 %** (owner gate). A below-bar run stays private.
   **Stop here and report — do not submit unattended.**

## Closed paths — do not reopen without reading this

**TerranSoul's own agentic loop + the Claude Code subscription: CLOSED.** Four
probes. `--bare` is the mode that strips Claude Code's agent identity, and its own
help says *"Anthropic auth is strictly ANTHROPIC_API_KEY … (OAuth and keychain are
never read)"*. The mode that removes the identity is the mode that refuses
subscription auth — a designed boundary, not a bug. With the identity intact the
model refuses tools it does not have and executes on the HOST instead
(`--allowedTools ""` did not strip its tools; it ran `ls -la /app` on Windows and
reported the real path). This needs an **API key**, not a better prompt.

**TerranSoul's own loop + local 12B: parked, cause #4 undiagnosed.** Three real
blockers were fixed — production-DB contention (`56636fc9`), Anthropic routing
(`30255661`), resident services booting per one-shot run (`cc7232eb`). A fourth
remains: the process boots cleanly, warms the model, then sits idle with no tool
call and no ollama activity. Diagnose from a thread stack, not by reasoning.

## Assets already built (do not rebuild)

| | |
|---|---|
| Harbor adapter + exec bridge | `1fa4d87e` |
| Isolated brain store per trial | `56636fc9` |
| TB-6 Anthropic routing seam | `30255661` |
| One-shot headless boot | `cc7232eb` |
| Oracle smoke, 2/2 mean 1.000 at $0 | verified |
| MCP config for the container | `benchmark/terminal-bench/terransoul.mcp.json` |

The exec bridge and TB-6 are **unused on the D-G path** — they belong to the
API-key route. Keep them; do not wire them into D-G.

---

## NEXT SESSION STARTS HERE — 2026-08-06 10:18 handoff

**k=1 is CLOSED and defensible. k=2 is 27/89 and resumable. Nothing is lost.**

### State

| | |
|---|---|
| k=1 FINAL | **0.8315** official per-task, 89/89 tasks, $178.34, 95 lessons |
| k=2 | 27/89 complete, ~$60 spent, 113 lessons captured |
| checkpoint | `mcp-data/tb-checkpoints/k2-handoff-0806-1018` |
| jobs on disk | 182 (results are durable; the merge takes best-trial-per-task) |

### Resume the run

```bash
bash benchmark/terminal-bench/run-parallel.sh 2      # 2 workers; 4 saturates disk I/O
bash benchmark/terminal-bench/merge-sweep.sh benchmark/terminal-bench/jobs   # the number
bash benchmark/terminal-bench/attempt-uplift.sh benchmark/terminal-bench/jobs # attribution
bash benchmark/terminal-bench/redo-candidates.sh    # what to re-run, by ROOT CAUSE
```

**Use 2 workers, not 4.** Four containers saturated disk I/O and made the machine
unusable. Two is still 2x the sequential rate.

### The measured result so far (25-task readout)

* head-to-head vs k=1: **2 improved, 0 regressed, 23 unchanged**
* errored trials on the same tasks: **54 -> 8, an 85% reduction**
* runtime: **-18.2%, 17 of 22 paired tasks faster, p ~ 0.008 (significant)**
* within-run attempt-2 uplift: **null** (-1.3 pp +/- 9.0)

The honest reading: memory's benefit is **efficiency, not retry success**. Same
outcomes, far fewer wasted attempts. The gain lives ACROSS campaigns (k=1's
corpus lifting k=2's *first* attempt from the 83.15% baseline to ~88%), not
within a run.

### Open items

* **`diskpart compact` on the Docker vhdx** reclaims ~110 GB (needs admin; models
  were deleted from inside it but a vhdx does not shrink on its own).
* **`tb-instruction-*` leak**: `run-dg.sh` mktemps one per task and never removes
  it. Only ~0.8 MB, but add `rm -f "$INSTRUCTION_FILE"` to its EXIT trap. Do NOT
  edit `run-dg.sh` while workers run it — bash reads scripts lazily.
* **worker lockfiles vanish** while workers run (EXIT trap firing from a
  subshell), defeating the concurrent-sweep guard. Monitor on process liveness.
* 9 timeout-class tasks remain the path to 90%: 1 of 3 resolved so far converted
  (`caffe-cifar-10`, 0.0x3 -> 1.0x2).

### ⚠️ OWED AFTER THE 2026-08-06 SWEEP — `brain_append` refusals moved, they did not stop

**Do not fix mid-sweep.** Both fixes below change what the agent is told, so
applying either partway through a run makes early and late tasks incomparable.

Every refusal recorded on 2026-08-06 was the same call:

    {"name":"brain_append","verdict":"refused",
     "detail":"missing required param: addition"}   x4

The schema is NOT at fault — `tools/list` reports `required: ['id','addition']`
and documents `addition` as *"Free-form text to append. Must be non-empty."*

**The likely cause is our own instruction text, and it is an over-correction.**
An earlier round of refusals was all missing `id`, so `extra-instruction.md`
gained: *"**It takes that entry's `id`** … without it the call is rejected and
the correction is lost."* That paragraph names exactly ONE required parameter.
The refusals then moved from missing-`id` to missing-`addition` — the guidance
did not close the failure, it relocated it. Naming one member of a required set
appears to make the model treat that member AS the requirement.

**MEASURED RATE, clean run par*08061227:** `brain_append` 5 accepted / 3
refused — **37.5% of refinement calls fail**. Every other tool is clean in the
same window: `brain_search` 11/11, `brain_ingest_lesson` 4/4, `brain_add_edge`
1/1. So the defect is isolated to one tool, not to writes generally.

**Why it was still DEFERRED at 37.5% rather than fixed on the spot** — the
decision is recorded because the rate is high enough that the opposite call is
reasonable. The measurement this sweep exists to produce is *does attempt 2
beat attempt 1 within a task*, and attempt 2 benefits from attempt 1's
`brain_ingest_lesson`, which is accepted 100% of the time. `brain_append`
refines PRE-EXISTING entries — a second-order, cross-task effect worth ~18 more
lost calls against a 1235-entry corpus over the remaining tasks. Weighed
against that: this campaign has already had three separate measurement bugs,
and changing the agent's prompt halfway through a run is precisely what makes a
benchmark number indefensible afterwards.

**✅ FIXED 2026-08-06, and the fix WORKED — but the defect CLASS is wider than
the one tool.** `extra-instruction.md` now states `brain_append`'s requirement
as a SET ("requires BOTH `id` and `addition`") instead of naming one member.
Measured on the post-fix run: **`brain_append` 78 accepted / 0 refused**,
against 5 accepted / 3 refused before. That is the whole 37.5 % failure closed.

**Then the same failure appeared on a DIFFERENT tool**, which is the point worth
carrying forward:

    {"name":"brain_add_edge","verdict":"refused",
     "detail":"missing required param: rel_type"}

`brain_add_edge` requires THREE arguments — `src_id`, `dst_id`, `rel_type` — and
`extra-instruction.md` describes what the tool is *for* while naming NONE of
them. Same shape as the original: purpose documented, contract omitted. The
maintainer note added with the append fix already generalises this ("state the
contract, not a favourite argument"); it was only APPLIED to one tool.

**Owed:** apply the same treatment to every write tool the instruction lists —
`brain_add_edge` (3 required), `brain_close_edge`, `brain_ingest_lesson` — and
check each against `tools/list` rather than from memory. Not urgent: measured
**1 refusal in 205 accepted calls (0.5 %)** on the post-fix run, and it was
deliberately NOT fixed mid-sweep because the prompt change would split the
cohort a second time and re-running the 41 completed tasks costs ~3.5 h to
recover 0.5 %.

Original analysis follows — `brain_ingest_lesson` (new lessons, the primary
learning path) was unaffected and accepted throughout; only `brain_append`
(refining an EXISTING entry) was losing calls:

1. `extra-instruction.md` — state the required set as a set (`id` AND
   `addition`), and stop enumerating which param was forgotten last time. The
   enumeration is what steered it.
2. `tools.rs` `brain_append` description — the prose says only "Requires write
   capability" while the schema carries the real contract. Say both params in
   the description, since that is what the agent reads first. Needs an MCP
   rebuild + tray restart, so it cannot be done during a sweep either.

Reported impact when it happens: one lost correction and one wasted agent turn.
It does NOT fail the trial and does not gate-deny.
