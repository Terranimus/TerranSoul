# Design note — `extra-instruction-harness.md`

MAINTAINER DOCUMENT. Nothing here is shipped to an agent. It used to be an HTML
comment at the foot of `extra-instruction-harness.md`, on the assumption that a
comment is invisible; that assumption was wrong and is the first finding below.

## Why this file exists at all (2026-08-19)

Harbor does not parse the extra instruction as Markdown. `models/task/task.py`
does `resolved_path.read_text()` and then `"\n\n".join([instruction, *extras])`,
and `claude_code.py` pipes that single concatenated string into `claude --print`
on stdin. An HTML comment is invisible to a Markdown *renderer*, not to a model
reading a prompt string — so the 2252-byte design note was 25.7% of the shipped
file, delivered verbatim in the recency-strongest final position of the prompt,
under a first line claiming it was "not shown as a rule to the agent".

Its content actively worked against the file's own purpose. One passage told
the agent, in plain text, that the "How to work" prose it had just read WAS the
generic prior pre-seeded into the memory store — an in-prompt argument that
searching that store would retrieve text it already had. Another asserted, as a
design guarantee, that the file makes "no claim that the memory holds anything
about the current task — the opening paragraph says the opposite, explicitly".

Guarded by `test-run-terransoul.sh` test 17b, which fails if `<!--` appears in
the shipped file, and test 17c, which fails if THIS file is ever wired onto
`--extra-instruction-path`.

## The 2026-08-19 de-suppression

MEASURED, across 6 trials of the Terminal-Bench 3.0 campaign: the agent made
exactly six `brain_search` calls — one per trial, at the start — and then zero
further memory calls for the remaining ~40 minutes of each task. Campaign-wide
the proxy log shows ~17 agent-initiated searches against 222 automatic Stop-hook
`brain_verify_completion` calls. The retrieval surface was advertised and
essentially unused.

The instruction text was a verified contributing cause. Three passages, all
removed:

1. `"It may hold nothing relevant to what you are doing now; treat that as the
   default expectation rather than a surprise."` — a bench-local addition with
   no counterpart in `SERVER_INSTRUCTIONS`, arriving in the file's second
   sentence and instructing the agent to hold a prior of irrelevance before its
   first search. Purity requires only that we not CLAIM the memory holds task
   content; it does not require predicting emptiness.
2. `"Consult it when you hit something you are unsure about"` — the file's only
   consultation trigger, and it fires on an internal state a competent model
   rarely reports to itself mid-task. Replaced with three OBSERVABLE triggers
   (before committing to an approach, after an unpredicted result, before
   declaring done) that an agent cannot decline by feeling confident.
3. `"If a search returns nothing useful, move on and solve the task directly.
   Do not let consulting memory delay you."` — the last sentence of the memory
   section, the only standalone one-sentence paragraph in it, and singular ("a
   search"), so it licensed permanent abandonment after exactly one miss. That
   is precisely the measured behaviour. The anti-stall intent is legitimate and
   survives, but bound to the individual query rather than the session: two
   queries per trigger, then get on with the work and search again at the next
   trigger.

Every DISCOURAGING sentence from the product text had been carried over and the
single encouraging one had not. That asymmetry, more than any one sentence, was
the shape of the suppression.

The repair itself then over-reached, twice, and both are recorded here because
they are the more instructive half.

FIRST, IT SHIPPED AN INERT REMEDY. The replacement text offered `mode='multihop'`
as one of two ways to recover from a search that missed. At this transport that
does nothing at all:

    mcp-auth-proxy.mjs  THINKING_MODE (default 'think'), THINKING_MODE_TOOLS =
                        {brain_search} — overwrites `thinking_mode` on EVERY
                        brain_search before it reaches the server
      -> tools.rs       parse_thinking_mode_arg  => Some(ChatMode::Think)
      -> tools.rs       ladder_rung(Think)       => LadderRung::Bridge
      -> tools.rs       Bridge + `mode` absent   => SearchMode::Multihop

Multihop is therefore ALREADY the effective default here. Passing it explicitly
only flips `mode_was_explicit` on a request whose mode is that same value, so
the query on the wire is identical. An agent that took the advice spent a turn
to change nothing and then had every reason to read the unchanged result as the
store being empty — the suppression the section was written to remove, arrived
at by a different road. The shipped text now states the pin, states that
`multihop` specifically is a no-op here, and points at the remedy that does
move the result: different WORDS.

THE FIX FOR THAT OVER-REACH THEN OVER-REACHED IN TURN (corrected 2026-08-20).
The replacement sentence generalised the inertness to the whole argument —
*"so choosing `mode` yourself — `multihop` included — changes nothing about
what comes back"* — and that is FALSE. `LadderRung::Bridge` rewrites the
request only when `mode_was_explicit` is false (`tools.rs` ~2142, and the
comment above it at ~2137 says so in as many words: "It must not override an
explicit `mode`"); the `thinking_mode` schema at `tools.rs` ~117 says the same
thing to the model on every single request — "It upgrades the DEFAULT only —
pass 'mode' explicitly and your choice is honoured". So `hyde`, `hybrid`,
`rrf_iterative` and an explicit `rrf` all reach the server intact and all
change the result. The shipped file was contradicting the tool description the
model reads beside it, which is worse than saying nothing: it invites the agent
to distrust one of the two. Only the NARROW claim is true and it is the only
one now shipped — an omitted `mode` already IS the bridge hop, so `multihop`
asks for what it is already getting, while every other value is honoured.

SECOND, IT MISDESCRIBED THE MODE IT RECOMMENDED. Both this file and
`SERVER_INSTRUCTIONS` said `multihop` "also searches derived sub-queries". The
`mode` schema in that same source file says the opposite in as many words: "a
non-LLM `memory_edges` bridge hop (graph expansion over the prior hop's
neighbours + entities) ... No LLM query-decomposition". Two descriptions of one
argument, disagreeing inside one file, and the wrong one was the copy actually
delivered to the model. Corrected in `SERVER_INSTRUCTIONS` (where the mode is
NOT inert, because the product default `thinking_mode` is `chat`) and deleted
from the shipped bench file. Pinned by
`tools.rs::multihop_is_described_as_a_graph_hop_not_query_decomposition`, which
reads the ground truth out of the schema rather than restating it.

Guarded by `test-run-terransoul.sh` test 17b: the absence of the five
suppression phrases, the presence of the four transport-delta literals — one of
which changed on 2026-08-20, because the old literal `changes nothing about what
comes back` pinned the falsehood above INTO the file — and (17b-iii) the ABSENCE
of the product doctrine this file used to restate. Four of 17b-iii's five
literals are honestly labelled regression guards; the fifth, "Keep `limit`
small", is red on both pre-change trees and is the gate on the deletion recorded
under "What stays local" below.

## What stays local, and why

`rules/one-path-three-surfaces.md`: Desktop, CLI and MCP are transports, so
guidance true of any task on any surface belongs in
`src-tauri/src/ai_integrations/mcp/tools.rs::SERVER_INSTRUCTIONS`, which every
client receives at `initialize` — including this one. This file keeps ONLY the
transport delta, which is exactly the set of things the server cannot say
because it does not know it is being fronted by a rewriting proxy:

  * the deferred-schema `ToolSearch` one-call load (a property of this host);
  * the read-only note (this campaign's proxy refuses every write tool, so the
    server's own WRITING section would otherwise cost the agent refused calls)
    and the workspace-file substitute for the recording those instructions ask
    for;
  * the automatic Stop-hook completion check (bench wiring — and the reason the
    agent need not load that tool's schema at all);
  * the pinned `thinking_mode` (`mcp-auth-proxy.mjs` overwrites the argument on
    every call, so "you cannot change it" is literally true at the transport),
    AND the consequence nobody reading the schema could infer: that the pin
    moves the `mode` default off the documented `rrf`, which makes `multihop` —
    and only `multihop` — a no-op here.

THE SMALL-`limit` ADVICE WAS ON THIS LIST AND DID NOT BELONG (removed
2026-08-20). It is not a transport delta: it is a near-verbatim copy of
`SERVER_INSTRUCTIONS` (`tools.rs` ~1743 — *"Keep `limit` small (3-5): large
results get truncated by tool-result budgets, and a tight limit returns
something you can actually read"*), which `router.rs` serves to EVERY client at
`initialize`, this one included. Listing it here as a transport delta made the
shipped file's own opening claim — "what follows is only what is different
about THIS transport" — false on the page, and it was an undeclared second copy
of a sentence maintained elsewhere. Deleted from the shipped file rather than
kept and re-justified: the alternative was to weaken the opening claim, which
is the one sentence telling the agent that everything else it needs is in the
server's own instructions.

ONE DECLARED EXCEPTION REMAINS, and it is recorded here rather than left for
the next reader to catch. The shipped re-query examples ("ask again with the
literal error text, with the symptom rather than your theory of it, or with a
tool or file name rather than the concept") ARE a restatement of
`SERVER_INSTRUCTIONS` ~1770. They stay because that product sentence ends with
a FOURTH item — "or with `mode` set to `multihop`" — which is precisely the
advice that is inert at this transport. Correcting one item of a four-item list
means restating the three that survive; a bare "ignore the last one" would cost
the agent more context than the list itself. So the duplication is deliberate
and load-bearing, unlike the `limit` sentence, which corrected nothing. If the
product text ever drops the `multihop` item, this paragraph should go with it
and the shipped file should carry the correction alone.

## The 2026-08-19 shrink, and why it is the point

9,098 bytes -> 2,466. Owner direction, stated as the design constraint for the
whole workstream: *"we need TerranSoul's memory, not
extra-instruction-harness.md, as AI is easy to forget and miss the middle
context."*

A static prompt is the WEAKEST delivery channel available here. It is written
once, delivered once, and sits in the middle of a long context for the rest of
a ~40-minute task. Two stronger channels already carry everything that was cut:

  * `SERVER_INSTRUCTIONS`, re-delivered to every client at `initialize` and
    guarded by
    `integration_tests.rs::initialize_instructions_require_recurring_memory_consultation`,
    now carries the consultation triggers, the miss-is-about-your-wording
    guidance, and the evidence-not-instructions guardrail. The copies here were
    deleted rather than maintained in parallel: two texts saying the same thing
    is a drift bug waiting for one of them to be edited, and this workstream
    produced exactly that bug within a day (the `multihop` misdescription lived
    in both).
  * the MEMORY itself. The seven sections of the deleted "How to work" heading
    were derived from `generic-technique-seed.json`'s `lessons[]`, one-to-one,
    and that seed is ingested into the isolated bench store by
    `clean-bench-brain.mjs --seed ... --apply`; `CAMPAIGN-RECORD.md` records the
    campaign's brain as "seeded with generic technique only, wiped of
    task-specific rows". Deleting the prose copy does not delete the guidance —
    it makes RETRIEVING it the only way to have it, which is the entire thesis
    of the campaign. Handing the agent the seed's own text in the prompt made
    the search that would have returned it redundant by construction, and the
    measured behaviour was ~17 agent-initiated searches campaign-wide.

    OPERATIONAL DEPENDENCY #1 — THE SEED. Stated plainly because the shrink
    rests on it: a run whose store was never seeded ships neither the prose nor
    the memory. Until 2026-08-19 no launcher applied the seed — it was a
    hand-typed `clean-bench-brain.mjs --seed … --apply` in someone's notes, and
    forgetting it produced a run that looked exactly like a good one.
    CLOSED: `start-bench-stack.mjs` now applies it as step 0/1b of every
    launch, through `seed-bench-brain.mjs`, which is also the implementation
    `clean-bench-brain.mjs` calls (one seed step, not two). Three properties
    make it a dependency you cannot silently drop:
      * a missing/empty/unparseable seed file REFUSES the launch before
        anything is spawned (exit 4), rather than seeding nothing;
      * it is idempotent WITHOUT client-side state — the gateway dedups on
        exact trimmed content and answers `deduplicated:true`, so the counts on
        the receipt (`seed=7(0 new)`) come from the server, not from a local
        record of what we believe we wrote;
      * a lesson naming a dataset task refuses the WHOLE seed (behaviour change
        from `clean-bench-brain.mjs`, which skipped it and wrote the rest — a
        partial seed is a third state nobody would notice).
    `TB_STACK_NO_SEED=1` is the only way past it, and it is printed on the
    READY receipt and written into `.stack/proxy-*.json`, so an unseeded run is
    never indistinguishable afterwards. Guarded by `test-run-terransoul.sh`
    tests 34-37.

    OPERATIONAL DEPENDENCY #2 — THE REBUILD. The shrink rests on
    `SERVER_INSTRUCTIONS` just as much as on the seed, and a SOURCE change is
    not a DEPLOYED change. MEASURED 2026-08-19 against the binary the stack was
    actually running (`target-mcp/release/terransoul.exe`, Aug 18 20:49):

        "do not let consulting memory delay you"  -> 4 hits
        "also searches derived sub-queries"       -> 4 hits
        "BEFORE YOU COMMIT TO AN APPROACH"        -> 0 hits

    i.e. the de-suppression documented above was live in `tools.rs` and absent
    from the .exe, while `initialize_instructions_require_recurring_memory_consultation`
    was green — that test links the SOURCE and can never see the shipped
    binary. A sweep launched in that state measures the OLD doctrine and ships
    the deleted guidance in NEITHER channel.
    CLOSED THE SAME WAY: `check-served-instructions.mjs` POSTs `initialize` to
    the running server and asserts the served text carries every consultation
    trigger and none of the suppression literals. It runs in
    `start-bench-stack.mjs` (on the `initialize` the launcher already makes, so
    it costs nothing) and again in `run-terransoul-verifyhook.sh`'s preflight,
    which is the last gate before money is spent and the one that catches a
    stack somebody else started. The cue literals live in that one module and
    are the same literals the Rust test asserts, so the two cannot drift; a
    green `cargo test` plus a green gate is the pair that proves source and
    binary agree. Guarded by tests 38-39. **So: after any change to
    `SERVER_INSTRUCTIONS`, rebuild the MCP binary and restart the stack before
    launching — the gate now refuses instead of letting it pass silently.**

Every duplicated token is also paid in every trial's context window, on a run
whose stated failure mode is context pressure — but that is the lesser reason.
The larger one is that a fact stated in two places is a fact that will
eventually be true in one.

## Provenance

Split out of `benchmark/terminal-bench-3.0/extra-instruction.md`, which was
orphaned — no committed launcher read it, and the resolved config of the
2026-08-18 shakedown has no `extra_instruction_paths` key at all. That original
file is SUPERSEDED and should be deleted once nothing else references it; it is
left on disk only because a concurrent session committed a deliberate restore of
it (e37f0181) while the split was in flight. Two halves came out of it:

  * `extra-instruction-harness.md` SHIPS. It is read-side memory usage plus
    task-agnostic engineering discipline, wired via
    `run-terransoul-verifyhook.sh`'s `--extra-instruction-path`. Note that the
    flag sits inside the `if [ -n "${TERRANSOUL_MCP_URL:-}" ]` branch, so a
    `TB_ALLOW_NO_BRAIN=1` run ships no extra instruction at all — such a run
    removes the memory AND the methodology prose in one step and is therefore
    not a clean A/B on "TerranSoul attached vs not".
  * `extra-instruction-memory.md` holds the lesson-WRITING half. It is
    deliberately NOT wired: those tools are cross-trial writes, refused by
    `mcp-auth-proxy.mjs`'s default allowlist, and telling an agent to call a
    tool that will be refused wastes turns and misdescribes the session. It
    ships only if and when the cross-trial-write legitimacy question is settled.
    Guarded by test 9.

The "How to work" section was DERIVED FROM `generic-technique-seed.json`'s
`lessons[]` — an author-written, purity-audited generic prior that is also
pre-seeded into the bench store. It is not agent-learned and must never be
reported as self-improvement. It was removed from the shipped file in the
2026-08-19 shrink above, so the seed is now its only delivery path; if it is
ever restored here, do NOT restate that provenance in the shipped file, because
told to the agent it reads as an argument that searching the store is redundant.

## Purity constraints the shipped file is written to satisfy

`rules/bench-agi-purity.md`. No task names, task hints, walkthroughs, expected
answers, domain vocabulary, or curated term sets, and no claim that the memory
holds anything about the current task. Every paragraph is held to the seed's own
test: "would it read identically for a benchmark about a different subject?"

Enforced by a gate in `test-run-terransoul.sh` (test 17) that reads the task
roster from the DATASET — never a hardcoded list, same standard as
`clean-bench-brain.mjs` — and fails if any task name appears in the shipped
file.

---

# 2026-08-19 — the PUSH channel: `hooks.PostToolUseFailure`

The shrink above made the static file smaller. It did not solve the problem the
shrink was reasoning about: a file delivered once at session start decays out of
the middle of a long context, and the campaign's own numbers say so — ~17
agent-initiated `brain_search` calls against 222 Stop-hook-fired
`brain_verify_completion` calls, same sessions, same tools, same model. Push
beat pull by more than 13x.

`terransoul failure-hook` (`packages/terransoul-cli/src/failure-hook.mjs`) is
the second push point. The Stop hook pushes at the END of a session; this one
pushes DURING it, at the moments the harness can see that the agent is not
making progress.

## What was MEASURED before any code was written

Reproduce-first (`rules/agent-self-learning-doctrine.md` Principle 8). All of
this came from a local probe hook plus real `claude -p` runs on claude 2.1.235,
not from documentation:

* **`PostToolUseFailure` fires on a non-zero Bash exit.** It is also mutually
  exclusive with `PostToolUse` — a failing command fires only the former, a
  succeeding one only the latter. The `isError` verdict comes from a classifier
  rather than literally `exit != 0`, which is why this had to be measured.
* **The event payload** carries `session_id`, `cwd`, `tool_input.command`,
  `tool_use_id`, `is_interrupt` and `error` — where `error` is a STRING
  beginning `"Exit code N\n"`, not the object an API-shaped guess produces.
* **`hookSpecificOutput.additionalContext` really reaches the model.** In the
  end-to-end run the agent quoted the pushed text back verbatim and identified
  it as `PostToolUseFailure:Bash hook additional context`.
* **It costs no extra turn.** The push lands in the transcript as an
  `attachment` hanging off the tool result that triggered it — unlike the Stop
  hook's `{"decision":"block"}`, which is re-injected as a meta user turn and
  demonstrably added a second leg to a trial.
* **Token cost, via `messages.count_tokens`** (never a bytes/4 estimate — wrong
  tokenizer). THE FIRST FIGURES PUBLISHED HERE WERE WRONG and are kept struck
  through as a record: ~~448 bytes / 112 tokens typical, 554 bytes / 139 tokens
  worst case, 417-token ceiling~~. They counted the raw `pushText` string, not
  the text AS DELIVERED — Claude Code prefixes it with its own
  `PostToolUseFailure:Bash hook additional context:` label, worth 13 tokens —
  and the "worst case" used a shell-like command rather than the dense base64
  that actually maximises tokens at `ECHO_CAP`. Re-measured against the live
  endpoint with the envelope subtracted, on the tiered text that now ships:
  **111 tokens** for tier A/B typical, **102** for tier C, **151** for a
  realistic 124-char command truncated at `ECHO_CAP`, **230** for a dense
  base64 blob in the same slot. With the 3-push session cap that is a
  **690-token ceiling per task**, and exactly **zero** on every request where
  nothing fires — against the ~101k cache-read tokens even a trivial trial
  carries, still negligible. `TOKEN_COST` in the source pins each figure to the
  byte length of the exact probe text it was measured on, so a reword now turns
  the suite red instead of silently invalidating this paragraph.
* **Latency.** NOT zero, and an earlier claim of "no latency on the critical
  path" was wrong. ~110-120 ms median wall clock per failed Bash command in the
  container (~575 ms as Claude Code reports it, including its own dispatch);
  re-measured locally over 25 real `terransoul failure-hook` spawns at 165 ms
  median / 136 ms min / 659 ms p90 on Windows. Node startup dominates; the
  decision itself is microseconds. Paid only on FAILING commands.

## The design's own gate was INERT at this transport — the second time

The design called for feeding each observation to `brain_observe_outcome` and
pushing only when the SERVER's detector reported the dead end, so the decision
would live in brain-seeded Rust rather than a JS `if`. That is the right
instinct and it does not work here. Verified in `mcp-auth-proxy.mjs`:

| proxy configuration | what happens to `brain_observe_outcome` |
|---|---|
| default (the "0 brain writes" mode) | NOT in `READ_ONLY_TOOLS` → `gate()` refuses it with `-32001`. The detector never runs. |
| `TB_PROXY_MODE=learn TB_DEFER_WRITES=1` (the k≥5 submittable config) | IS in `LEARN_TOOLS` → the proxy spools it and answers with a synthetic `{"deferred":true}` ack. The verdict envelope `{"verdict":"dead_end","repeats":3}` never comes back. |

This is the same failure shape as the `mode='multihop'` advice documented
above: a remedy that reads correctly and provably does nothing at the transport
it ships on. So the repeat window is computed in the hook, as a faithful port of
`LoopDetector::observe` (`crates/shared-types/src/loop_detect.rs`), and a test
reads that Rust file to pin `REPEAT_THRESHOLD`/`WINDOW_CAPACITY` against it so
the two cannot drift. `rules/mcp-single-source-of-truth.md` names this case
explicitly as allowed: *"Loop-detector window … **harness state**, not
knowledge."* No lesson, no retrieved text, no domain fact is stored — only
opaque fingerprints, discarded with the session.

A second consequence: the hook makes **no brain call at all**, which is also
the latency answer. It runs on the agent's critical path, and the Stop hook's
own brain calls were measured at 23.6 s and 37.9 s.

## Why the trigger is REPEAT, not FAILURE — and why that was not enough

A hook can only see failure; the trigger `SERVER_INSTRUCTIONS` actually names is
SURPRISE. Most failing commands in a terminal task are expected probes, and
identical text after every one of them is the textbook shape of a notice a model
learns to skip — which would poison the channel for anything that matters later.

The first gate was therefore three identical **consecutive**
`(cwd, command, error)` observations, the product detector's own definition of a
dead end. Safe, defensible, and **measured to be very nearly silent.**

### The correction, measured on 59 real trials

Replayed offline over every completed TB3.0 session transcript on disk
(`jobs-terransoul` 38 + `jobs-learn` 18 + `jobs-claude-mcp` 3 = 59 trials, 4,208
Bash calls, 231 Bash failures), driving the hook's own `decideFailurePush`
rather than a description of it:

| rule | trials reached | pushes | source |
|---|---|---|---|
| ≥3 consecutive identical (the original) | 3/59 = **5.1%** | 3 | re-run here |
| ≥2 consecutive identical | 4/59 = 6.8% | 5 | sweep |
| ≥2 identical ANYWHERE in the session (= tier A alone) | 4/59 = 6.8% | 4 | re-run here |
| 3 attempts + ≥2 distinct errors (= tier B alone) | 3/59 = 5.1% | 4 | re-run here |
| ≥2 same `(cwd, command)`, error ignored | 6/59 = 10.2% | 11 | sweep |
| novel signature after ≥3 total failures | 17/59 = 28.8% | 39 | sweep |
| ≥3 failures within the last 8 Bash calls | 12/59 = 20.3% | 20 | sweep |
| **Kth failure of the session, K=3, once (= tier C alone)** | 22/59 = **37.3%** | 22 | re-run here |
| Kth failure of the session, K=2, once | 25/59 = 42.4% | 25 | sweep |
| **A + B + C, as shipped** | 22/59 = **37.3%** | 28 | re-run here |

"re-run here" = replayed by running the SHIPPED `decideFailurePush` (with the
other tiers switched off) over the corpus while making this change. "sweep" =
inherited from the measurement phase's own replay of that candidate rule, which
this tree does not implement and therefore cannot re-verify. Both K=2 rows and
the burst/novel rows are rejected candidates, so they are quoted, not relied on.

Two of the rejections are not about coverage. "Novel signature after K failures"
has the second-best reach and the worst nag profile (2.3 pushes per firing
trial), and its semantics are backwards — a NOVEL failure is the one situation
where the agent is demonstrably still exploring new ground. K=2 buys +5.1pp over
K=3 but moves the fire to a median 33% into the trial, and with a median of 1
failure per trial a second failed command is ordinary exploration.

A channel reaching one trial in twenty cannot produce a readable bench number —
the effect, whatever its sign, is diluted below the noise of an 89-task sweep.
The gating that made it safe from nagging also made it useless as a measurement.
That is the same trap this campaign has fallen into repeatedly, and it is why
the trigger is now **tiered**:

* **A — identical repeat.** The same `(cwd, command, error)` twice, ANYWHERE in
  the session. "Consecutive" is dropped because it measures identically here and
  was a fragile condition buying nothing; the count drops 3 → 2 because the full
  triple matching byte for byte is stronger evidence than a repeated action, and
  it is the only change in the identical-repeat family that buys any coverage.
  Text unchanged, and now TRUE — see the fingerprint correction below.
* **B — same command, different error.** Same `(cwd, command)`, 3 attempts, ≥2
  distinct error texts. The original design treated this as progress; on this
  corpus it is the **majority** case — of the 6 trials that repeated a failing
  command at all, 4 (66.7%) saw the error change. One change is progress; three
  attempts producing several different errors is churn. Its text says exactly
  that and offers rather than instructs.
* **C — session fallback.** The 3rd failed Bash command of the session, whatever
  it was, at most once and only when nothing else has fired. This is the
  coverage lever. It is also the weakest text in the file and the source says
  so: if a live run shows Tier C pushes being ignored, the correct response is
  to **delete Tier C** and accept 6.8%, never to make it louder.

A+B+C measured together: **22/59 = 37.3%**, 7.3× the original, with the median
first fire moving from 73% to 54% of the way through the trial — while there is
still time to act on it. **64.4% is the hard ceiling** for any
failure-triggered channel here: 21 of 59 trials never fail a Bash command.

Reach into the population that motivates all of this: of the 33 trials that made
**zero** agent-initiated `brain_search` calls, the tiered trigger fires in 10;
the original rule fires in 2.

### The anti-nag mechanism, which is the price of the widening

Five bounds, each a measured number rather than an assertion:

1. `MAX_PUSHES_PER_SESSION = 3`, and the counter only ever advances.
2. Per-trigger dedup — a signature (A), a command (B) or the session (C) fires
   once each. Measured push-per-trial distribution `{0: 37, 1: 17, 2: 4, 3: 1}`:
   **91.5% of trials get at most one push in the whole task**, and the 3-push
   case is the single trial with 38 failures across 334 Bash calls.
3. `MIN_PUSH_SPACING = 6` observed failures between pushes. Measured **in
   failures, not Bash calls** — a `PostToolUseFailure` hook never sees a
   succeeding command, so that is the only clock it has. Six is the value that
   reproduces the offline 10-Bash-call rule exactly on this corpus: same 28
   total pushes, same minimum gap of 18 Bash calls, same gap list (18, 36, 69,
   72, 124, 193). Swept 1→10: coverage is 37.3% at every value, so spacing
   trades volume for quiet and never costs reach.
4. Tier C cannot repeat, held by two independent guards (a constant dedup key
   and `pushes === 0`). Dropping either alone still leaves it firing once; only
   dropping both makes it repeat, and the tests pin that.
5. Silence stays the default: 28 pushes over 231 failures means **87.9% of
   failures are seen and deliberately absorbed.**

### The fingerprint truncation that made the push text FALSE

`fingerprint()` truncated its input at 4096 characters while the push asserted
"a byte-identical error". Three errors agreeing on a 5000-char prefix and
diverging after it collapsed to one fingerprint, so the model was told they were
byte-identical when the harness had never looked at the bytes that differ. Fixed
by hashing the whole value — measured 1.1–1.3 ms/MB against a hook whose node
startup alone is ~150 ms, and Claude Code truncates tool output long before a
megabyte arrives. A regression test pins both halves: three errors sharing a
>4096-char prefix must NOT be described as identical (they are correctly Tier
B), and a genuinely identical pair must still be.

## Both hooks needed a `timeout`, and the settings file is the only place it can come from

MEASURED 2026-08-19, on `claude -p` with a deliberately blocking hook: with no
`timeout` key, ONE failed Bash command left the run stalled until the harness
killed it at 400 s (`EXIT=124`, empty result). The identical run with
`"timeout": 5` finished in 18 s with
`{"is_error":false,"subtype":"success","num_turns":2}`. Claude Code applies no
usable default here, and the hook's own `try/catch` cannot cover a blocking
syscall — a hung `fetch`, a locked file, a DNS stall — so the bound exists only
if `claude-settings-verifyhook.json` states it. JSON holds no comments, so the
reasoning lives beside `SETTINGS_SOURCE` in `run-terransoul-verifyhook.sh`.

The two hooks get opposite budgets, because they are in opposite regimes:

* **`PostToolUseFailure` = 5 s.** It sits on the agent's CRITICAL PATH and makes
  no brain call at all; its honest cost is a fingerprint and one small file
  write. 5 s is slack, not an allowance.
* **`Stop` = 240 s.** This is the hook that is allowed to be slow — its brain
  calls were measured at 23.6 s and 37.9 s. 240 s is 6.3x the slowest measured
  run and exactly 2x the hook's own per-call ceiling (`MCP_TIMEOUT=120000`, set
  by the runner), so the ledger `status` op and the LLM-judge `verify` op may
  BOTH hit their own ceiling and the hook still returns by itself and logs.
  What the bound really cuts is the unbounded case: `stop-hook.mjs` issues one
  `record` call per Bash command in the session, so a brain that hangs rather
  than refuses multiplies 120 s by however many commands the trial ran. Note
  the asymmetry deliberately: a truncated verify gate is not a slow run, it is
  a run that measures nothing, so the Stop bound is set generously and the
  critical-path bound tightly.

Guarded by `test-run-terransoul.sh` test 33, which asserts the property over
EVERY hook in the file rather than the two by name, so a third hook added later
without a bound also fails.

## Where the measurement lives

* **Numerator (fires)** — already in the artifact Harbor collects: Claude Code
  persists each push as `{"type":"attachment","attachment":{"type":"hook_success",
  "hookName":"PostToolUseFailure:Bash",…}}` in the session transcript.
* **Denominator (every observation, fired or not)** — VERIFIED that a silent
  hook invocation leaves **no** transcript trace at all, so this exists only in
  the hook's own JSONL. `claude-settings-verifyhook.json` therefore sets
  `TERRANSOUL_HOOK_LOG=/logs/agent/terransoul-failure-hook.jsonl` — the same
  Harbor-collected mount Claude Code tees `claude-code.txt` into.
  `TERRANSOUL_HOOK_DIR` is deliberately left unset so the volatile window state
  stays in the container's tmp and is not published as an artifact.
* Both files stamp `caller` from the same vocabulary (`CALLER_FAILURE_HOOK`,
  beside `CALLER_STOP_HOOK`) and the same `at` ISO field the proxy's `record()`
  writes, so proxy log and hook log join without a translation step.

## Not built, and why

* **Channel A (moving the consultation triggers into the `brain_search` tool
  description)** — feasible and probably worthwhile, but the design is explicit
  that shipping it in the same measured run as this hook makes any delta
  unattributable, and `rules/bench-never-regress.md` turns a below-floor result
  into a mandatory investigate/optimise/rebench loop that two simultaneous
  changes make far more expensive to exit. It should be a separately measured
  second change, funded by filtering the 38 host-scoped tools the proxy refuses
  anyway (~20.2 KB / ~5.5k tokens per request).
* **`brain_observe_outcome` feeding** — blocked/deferred at this transport, as
  traced above. Making it work needs a proxy policy change, not hook code.
* **Trigger RATE in a real 40-minute task** — still unknown. It is the one
  genuinely open question about this channel, which is exactly why the log
  carries the denominator rather than only the fires.

## What the 37.3% is NOT — read before quoting it

1. **The hook has never actually run.** Every rate above is a REPLAY of
   `decideFailurePush` over recorded events. Grepping all 59 transcripts for
   `PostToolUseFailure` hook attachments returns nothing — the only
   `hook_success` attachments in the corpus are `hookName: "Stop"`, and no
   `terransoul-failure-hook.jsonl` exists under any trial. The first real run is
   a MEASUREMENT, not a confirmation.
2. **The sample is not a representative TB3.0 slice.** 56 of the 59 trials are
   re-runs of just three tasks used for harness validation (median 19.5 Bash
   calls); only 3 are distinct full-size TB3.0 tasks (median 236 Bash calls, 12
   / 23 / 38 failures). Trials of the same task are not independent. On the
   broad subset the tiered trigger fires 3/3 and the original rule 1/3 — n=3 is
   not a measurement, so 37.3% is quoted as a FLOOR and the plausible range on a
   real sweep is 40–65%, hard-capped at 64.4%.
3. **"Failure" means `is_error == true`, which includes expected probes.** 9.5%
   of the corpus's failures have no output beyond `Exit code N`, and 3.5% are
   signals the agent sent itself. Tier C fires on those too. That is a real cost
   of the widening and is why Tier C is capped at one push per session.
4. **`cwd` barely discriminates here.** 4,092 of 4,208 Bash calls ran in `/app`,
   so the "same command in a different cwd is a different dead end" behaviour is
   essentially untested by this data.
5. **Coverage is not benefit.** This measures only how often the channel FIRES.
   It says nothing about whether a push changes behaviour, whether the agent
   calls `brain_search` in response, or whether that improves the score.
   Coverage is a precondition for a readable number, not evidence of one.
