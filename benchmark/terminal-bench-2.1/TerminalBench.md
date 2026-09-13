> **ARCHIVED — Terminal-Bench 2.1.** This document belongs to the closed 2.1
> campaign (Claude Code agent loop + `claude-sonnet-5`). It is retained for
> provenance and is **not** current guidance. The active campaign is
> Terminal-Bench 3.0; see `benchmark/terminal-bench/`.
# Terminal-Bench 2.1 — TerranSoul + Claude Code

Agentic terminal benchmark: 89 containerised tasks, each graded by its own test
suite. Unlike the retrieval benches in this folder, nothing here is scored by a
judge — a task passes when the task's own verifier says so.

**Harness:** [`terminal-bench/`](terminal-bench/) · **Runbook:** [`terminal-bench/RESUME.md`](terminal-bench/RESUME.md)

Raw trial artefacts are **not committed**. They run to several GB of agent
transcripts, and the trials quarantined below contain the benchmark's own oracle
solution and a grader's held-out test input, which those trials fetched —
publishing them would republish Terminal-Bench's answer key. The trials are on
the Harbor hub instead, which is where the leaderboard re-derives every number
from.

---

## Headline (2026-08-12 — recomputed with the leaderboard's own metrics module)

| metric | value |
|---|---|
| **Accuracy (per-trial)** | **82.15% ± 1.14%** — 405 of 493 trials passed |
| tasks covered | 89 / 89 |
| tasks solved (any trial) | **89 / 89** |
| tasks passing EVERY trial | 63 / 89 |
| pass@2 / pass@3 / pass@4 / pass@5 | 0.9476 / 0.9625 / 0.9694 / 0.9730 |
| trials | 493 (2 errored, scored 0; 5 integrity-quarantined, forced to 0) |
| trials per task | min 5, max 23 — **not uniform**, see disclosure 4 |
| unsolved | *none* |
| cost | $423.41 |

### ⚑ This run does NOT clear the submission gate

`rules/tbench-playbook.md` sets the owner gate at **83.8% Accuracy**. This run is
**82.15%** — *below the bar*, so it stays private.

**89/89 is not 100% Accuracy, and the two must not be conflated.** Accuracy is
`successful / total TRIALS`
(`terminal-bench-2-1/leaderboard/src/leaderboard/core/metrics.py:37`), verified by
importing that module rather than reimplementing it. "89/89 solved" means every
task passed *at least once*. Only **63 of 89** passed every trial; the other 26
are unreliable rather than unsolved. `filter-js-from-html` passed **1 of 23**, so
it contributes one success against 23 trials.

### ⚑ Correction: the previous "2026-08-11, three back-to-back passes" claim was false

This section previously reported `filter-js-from-html` converted on 2026-08-11 via
"three independently-verified, back-to-back passes … OFFICIAL per-task 1.0000".
**That was an artefact and is retracted.** Root cause, reproduced from the session
transcripts: a stray exported `TB_AGENT` in that shell beat the cohort's launch
file on all ten redos, so those trials were keyed
`claude-code__claude-opus-5__tasks` rather than
`terransoul__claude-sonnet-5__terminal-bench/terminal-bench-2-1`, and an
identity-blind `merge-sweep.sh` pooled them into a cohort they did not belong to.
Under the cohort's own identity the task's record at that point was **0-for-6**.
Both defects are now fatal-on-mismatch (`redo-task.sh` identity refusal +
identity-aware merging); guard: `redo-identity-guard.test.sh`.

The genuine conversion is **2026-08-12, attempt 23** — a single pass, verified
below.

Two further reasons the old headline could not be trusted, both fixed this session:
`merge-sweep.sh`'s coverage gate asserted an *environment variable*
(`TRIALS_REQUIRED="${TB_ATTEMPTS:-1}"`) instead of counting trials, and its bar
comparison evaluated a 0..1 per-task rate against an Accuracy percentage — so it
printed "BEATS THE BAR" for **any** run that solved every task once. See
"Harness defects fixed 2026-08-12".

### 2026-08-09 point-in-time snapshot (superseded, kept for provenance)

| metric | value |
|---|---|
| **pass@1** | **0.8889** |
| pass@2 | 0.9500 |
| pass@3 | 0.9660 |
| pass@5 | 0.9789 |
| trials | 471 (2 errored, scored 0 and kept in the denominator; 4 integrity-quarantined) |

The first complete cohort measured **pass@1 0.8841 / pass@5 0.9551, 85 of 89
solved**. Nine harness and memory defects were then found and fixed (below), and
the four unsolved tasks re-run under the corrected system: three converted, one
did not — that one (`filter-js-from-html`) converted on 2026-08-12 per above.
Every trial from both phases is in the cohort.

Configuration: agent `terransoul:TerranSoul`, model `claude-sonnet-5`, dataset
`terminal-bench/terminal-bench-2-1@sha256:7d7bdc1c…`, default execution settings,
no timeout or resource overrides.

> **pass@k, not solved-if-any.** The leaderboard computes the unbiased estimator
> `1 − C(n−c,k)/C(n,k)`. At n=5 it degenerates — any single pass forces pass@5 to
> 1.0 — which is why pass@5 and a naive solved-if-any count coincide here and
> **pass@1 is the honest headline**. More trials make the estimate *better*, not
> higher: a task passing 1-of-20 scores pass@5 = 0.25 where the same rate measured
> at 1-of-5 scores 1.0.

---

## Reproduce

```sh
cd benchmark/terminal-bench
bash run-parallel.sh 2                 # two workers (three oversubscribes a single host)
bash tick.sh                           # one call: workers, brains, integrity, scoreboard
bash merge-sweep.sh jobs-sonnet5       # per-trial Accuracy ± SE, real coverage, bar verdict
python integrity-scan.py jobs-sonnet5  # exit 1 = contamination
python attempt-uplift-perjob.py jobs-sonnet5   # self-improvement, stratified
```

`merge-sweep.sh` prints the leaderboard's **per-trial Accuracy** (the headline
figure), the per-task solve rate as a separate, separately-labelled number, and
the observed minimum trials-per-task counted from the trials themselves. On
Windows, export `PYTHONIOENCODING=utf-8 PYTHONUTF8=1` before `integrity-scan.py`
or it dies on a cp1252 encode of its own box-drawing header.

Requires a running TerranSoul brain. The bench uses an **isolated** brain on
`:7424` (`mcp-data-tbench/`) so a benchmark that writes to memory can never mutate
the production store on `:7423`.

---

## Integrity: two answer-key incidents, five trials quarantined

Terminal-Bench's tasks live in a public repo alongside their oracle solutions and
grading tests. The extra-instruction tells an agent to consult external sources
after repeated failure — which, unqualified, eventually retrieves the answer key.
It happened three times.

| trial | what it obtained | verifier | counted |
|---|---|---|---|
| `build-pov-ray__eEJEsuy` | the oracle `solve.sh` | 1.0 | **0.0** |
| `video-processing__SmEpLeZ` | searched for the task's tests | 0.0 | 0.0 |
| `video-processing__Mv47hET` | the grader **and its held-out test video** | 1.0 | **0.0** |
| `video-processing__76spv8o` | same | 1.0 | **0.0** |
| `filter-js-from-html__TknCUqV` | the benchmark's own material (2026-08-12) | 1.0 | **0.0** |

`video-processing` was therefore counted **unsolved** at the time despite three
passing trials; taking the verifier at its word would have published **0.9663**
instead of 0.9551. `filter-js-from-html__TknCUqV` is likewise forced to 0 — its
genuine pass is the separate, clean `ZvSvaX9` trial described above, which made
**zero** web calls.

The first incident also wrote a *generalised* directive into shared memory —
"on ANY terminal-bench-shaped task, pull the public repo's solution first" —
which had been retrieved 23 times before it was caught. One trial cheated; memory
turned it into a policy.

**Controls, all score-side rather than instruction-side:**

- `integrity-scan.py` — quarantines any trial whose trajectory reached the
  benchmark's own repos/domains, and scans a brain store for rows carrying that
  material. Matches URL shapes, never the benchmark's bare name (honest lessons
  discuss the harness by name, so a name match fires on nearly every row).
- `merge-sweep.sh` forces quarantined trials to 0.0.
- Guard: `integrity-scan.test.sh`, incl. a false-positive assertion that a
  legitimate upstream `github.com` clone survives.

Score-side enforcement is the point: instructions are advisory and were
demonstrably ignored, but a control the agent cannot see makes the exploit
worthless. The second incident was caught **automatically, the same tick it
appeared**; the first was found by chance.

---

## Self-improvement (stratified)

Attempts within a task are **not independent** — each is told how its
predecessors scored (`TB_DEFER_WRITES=0`). So this is not pass@5
on i.i.d. samples, and any leaderboard submission must say so.

| attempt | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| pass rate | 87.6% | 89.9% | 89.9% | 87.6% | 89.9% |

Pooled uplift is **+1.9 pp and meaningless** — 78 of 89 tasks pass on attempt 1,
where memory has no headroom and variance can only lose. The experiment lives in
the stratum where attempt 1 **failed**:

- **11 tasks. 8 rescued by a later attempt — 73%.**
- Counterweight, stated: stratum A's later-attempt rate is **94.4%**, so ~5.6%
  per-trial flakiness is real and some rescues are consistent with luck. Uplift
  alone cannot separate "the lesson helped" from "the retry got lucky".

Use `attempt-uplift-perjob.py`. The older `attempt-uplift.py` counts attempts
*within* one harbor job and, since the k=1-per-job change, reports
"stratum B is EMPTY" — quotable and wrong.

---

## What the failures taught

Three tasks failed every attempt while the agent asserted it had verified its
work. The graders disagreed specifically:

- `pytorch-model-cli` — `Prediction for image 0 is 7, expected 2`, ten held-out
  images wrong. The container ships **one** image; it verified against that.
- `filter-js-from-html` — `Filter modified 5 clean HTML files out of 12`. It
  tested the XSS half of its contract exhaustively and the byte-preservation half
  barely.

Same defect both times: **verifying the property you implemented rather than the
property the task states.** Seven harness/brain defects were found and fixed from
this evidence — per-check counts discarded, confirmatory verification, lesson
history evicted by a long entry head, a dead embedder, every attempt rendered as
"attempt 1", no signal when attempts scored identically, and doctrine with zero
inbound graph edges. See [`RESUME.md`](terminal-bench/RESUME.md) §§7–15.

After those fixes `dna-insert` converted — 0-for-11, then solved — by identifying
the one thing every prior attempt had held constant. Its winning trial made **no
brain calls**, so the credit belongs to the harness feedback stack, not to memory
retrieval.

### `filter-js-from-html`: a different failure shape — reproducibility, not capability

`filter-js-from-html` stayed unsolved past the point above, but the shape of its
failure was different from the other two: it had already been **solved outright**
on an early attempt (every grader check green), and every attempt after that kept
scoring **half credit**, with *which* half failing flipping from attempt to
attempt. That rules out "the model can't do this" — it had already done it. It
points upstream of reasoning, at retrieval not reliably resurfacing a solution
already sitting in the store.

Four further, previously-unknown defects in the memory/retrieval core were found
by direct measurement and fixed: (1) a history-preservation fix that had been
writing capped-off edit history back out as new, independently-searchable
near-duplicate rows — measured pushing the verified solution down four ranks on
the task's own query; (2) the hybrid ranking signal carrying **no outcome/quality
signal at all**, so a verified success and a recorded failure looked identical to
the ranker — fixed with an outcome-preference window applied before the result
list is truncated, never a global re-sort; (3) the identical blind spot
recurring in a *second* retrieval strategy (multi-hop graph expansion) that
hadn't inherited fix (2) — the generalizable lesson being that a fix belongs to
every ranking strategy that can independently order results, not just the one you
found it in; (4) the tool that reads "one memory entry in full" wired to a
different internal method than the one two rounds of a recovery fix had actually
been written into — correct code, sitting next to the wrong call site, caught
only because a live tool call kept disagreeing with passing unit tests.

**⚠ The "three back-to-back passes" result once reported here is RETRACTED** — it
was the identity-mismatch artefact described in the headline above; under the
cohort's own identity the record at that point was 0-for-6. The four defects
listed above are real and were kept; the *outcome* attributed to them was not.

### The genuine conversion: 2026-08-12, attempt 23 — and why 22 attempts failed

Trial `redo08121255-20260812-125539/filter-js-from-html__ZvSvaX9`, reward 1.0,
both grader checks green. Verified rather than asserted: eval key is the cohort's
own `terransoul__claude-sonnet-5__terminal-bench/terminal-bench-2-1`,
`exception_stats` empty, 23 steps with ~4M token metrics (not a dead trial),
**zero** WebSearch/WebFetch calls, and `integrity-scan.py` does not quarantine it.
It used the brain: 4 × `brain_search`, 1 × `brain_get_entry`, 1 × `brain_append`.

**Root cause of the preceding 22 failures — the memory layer, not the task.**
Memory 1419 drove every attempt: `confidence 1.0`, `importance 10`,
`access_count 138`, and **`success_count 0`, `failure_count 0`**. Across the whole
bench store, 1468 memories carried **zero** successes — so `confidence_buckets`
(`crates/memory/src/store.rs` ~5980), which demotes a failure-only row, had
nothing to read.

The counter-evidence was **present and was overridden**. Attempt 18's
`brain_search` returned 1419 at rank 3 carrying
`[Update … attempt #20, after 16 identical 0/2 failures interleaved with 4 passes]`
and it shipped the same approach anyway. Attempt 20 called `brain_get_entry(1419)`,
received the full 48 KB history including three separate refutation records, and
appended *"Fourth consecutive success with the gap-based event-list recipe"* —
four self-assessed successes against four graded zeros.

So the defect is **not** hidden history, and **not** fixable by raising the append
cap. Every `[Update]` block is agent-authored prose of equal epistemic standing,
so a grader's 0 and an agent's "verified locally" are indistinguishable text; the
agent self-scores against a fixture it wrote itself. A falsification signal must
be a **structured field the ranker reads, written by the party that owns the
verdict**. `brain_observe_outcome`'s agent-volunteered `outcome:"failure"` has now
been measured not to fire twice. An investigated + adversarially-reviewed design
is captured in `memory-falsification-design.json` and remains **owed**.

Found en route: `brain_append` elides oldest-first past
`memory.append.max_content_chars = 8000` and had already dropped **546 update
blocks across 83 rows** on this store.

### Harness defects fixed 2026-08-12

1. **Coverage gate asserted an env var, not the data.** `required_k` came from
   `TB_ATTEMPTS:-1`, so the published `Reproduce` command printed
   "NO VERDICT — k=1 (<5)" on a cohort whose real minimum was 5 on all 89 tasks —
   and `TB_ATTEMPTS=5` would have passed a k=1 probe. Now computes the observed
   minimum from the trials.
2. **The wrong quantity was labelled "OFFICIAL".** `merge-sweep.sh` published the
   per-*task* solve rate under that name and its header asserted "the leaderboard
   reports per-TASK" — false per `metrics.py:37`. Both quantities are now printed
   and named.
3. **The bar comparison could not fail.** It evaluated `off > 0.838`, comparing a
   0..1 per-task rate against an Accuracy percentage; any run solving every task
   once has `off == 1.0`. It printed "BEATS THE BAR" for this run, whose real
   Accuracy is below the bar.
4. **Token auto-refresh** (`token-refresh.sh`) now shared by every entry point —
   `redo-task.sh`/`iterate.sh` previously had none, and a 2-day-stale credential
   killed three redos with 0 completion tokens.
5. **Crash/OOM feedback** (`crashed_abnormally`) — converted `video-processing`
   from 14 straight failures to solved on the next attempt.
6. **Single-line feedback guard** — a `\n\n` in a new escalation clause travels to
   the container as an env var and killed 9 straight runs in preflight. Test:
   `feedback-single-line.test.sh`.
7. **`integrity-scan.py` crashes on Windows** (cp1252 vs box-drawing glyphs) —
   run it with `PYTHONIOENCODING=utf-8`. Not yet fixed in the script.

**A fifth, related defect was found auditing the fix that closed (3):** the
multi-hop fix was later extended so a *reasoning-effort* setting, not just an
explicit retrieval-mode choice, could also select it — and a follow-up retrieval
rebench came back with two modes that should have differed scoring
byte-identically. Root cause: the mode-selection logic reads an app-wide setting
that every real interactive session sets before retrieval runs, but a benchmark
harness calling the retrieval function directly never sets it — so it fell into a
designed fallback meant for "no classifier available," which happened to select
the same new mechanism as the mode being compared against. **Not a product
defect** (real sessions always set it first); a harness-fidelity bug, fixed by
pinning the setting explicitly before the harness call, the same pattern an
existing unit test already used correctly for the identical reason. Re-measured
after the fix: the two modes no longer tie, and the corrected numbers land where
the deterministic half of the measurement said they should.

---

## Disclosure owed on any submission

1. **Memory writes occurred during the run.** The agent wrote lessons to a brain
   that later attempts read.
2. **Trials are not i.i.d.** Attempt feedback carries prior outcomes, so this is
   not pass@5 on independent samples.
3. **Five trials are disqualified** for reaching the benchmark's own material
   (a fifth, `filter-js-from-html__TknCUqV`, was quarantined 2026-08-12); they
   must be uploaded and listed in the submission's `disqualified_trials`, which
   CI joins in as reward 0 — withholding them instead makes the task look
   under-covered and fails static analysis.
4. **Trials per task are NOT uniform: min 5, max 23.** Six tasks received more
   than the cohort's k=5 because they were retried until they passed:
   `filter-js-from-html` 23, `dna-insert` 15, `video-processing` 15,
   `cancel-async-tasks` 9, `build-cython-ext` 9, `pytorch-model-cli` 7 — each
   passing exactly once. This cuts both ways and both must be stated: the extra
   attempts are why 89/89 was reached at all, and because Accuracy is per-trial
   they also *lowered* it by adding failed trials to the denominator.
   `pass@k` uses the unbiased `1 − C(n−c,k)/C(n,k)` and tolerates unequal *n*;
   **Accuracy does not** — it weights a 23-trial task 23× against a 5-trial one.
   A clean claim needs a uniform k=5 cohort. `redo-task.sh` offers
   `TB_REDO_EXPERIMENT=1` to keep future top-ups out of the number.

---

## Submitting to the leaderboard (runbook — not yet done)

Nothing here has been submitted. No PR exists and no leaderboard row exists; a
row only comes into being once a submission PR is merged. The trials are on the
Harbor hub, which is what CI re-derives every number from. Steps, with the traps
that cost time when they were discovered the hard way.

### 0. Prerequisites

`uv`, an authenticated `gh`, and push access to
[`harbor-framework/terminal-bench-2-1`](https://github.com/harbor-framework/terminal-bench-2-1)
— or a fork, since the PR scripts push branches to `origin`. Run every `lb`
command from that repo's `leaderboard/` directory; the CLI writes `submissions/`
paths relative to it.

### 1. Upload every job, explicitly public

```sh
cd benchmark/terminal-bench
bash upload-cohort.sh jobs-sonnet5     # registered prefixes only
```

- **`--public` must be explicit.** Harbor defaults a NEW upload to *private*, and
  on a re-upload an omitted flag leaves server-side visibility unchanged. A
  silent private upload succeeds locally and then fails CI, which requires
  publicly readable trials.
- **Export `PYTHONIOENCODING=utf-8 PYTHONUTF8=1`.** Harbor draws a Braille
  progress spinner; on a cp1252 console the encode raises and the upload dies
  *after* sending the trial. It killed 5 of 458 uploads before the guard existed.
- **Upload the quarantined trials too.** Withholding them makes the task look
  under-covered and fails the trial-count check. They are neutralised in step 3,
  not by omission.
- **Never upload `jobs-sonnet5-attempt6/`** — an excluded experiment that must not
  enter a cohort.

### 2. Collect the job ids, and check for strays

```sh
harbor hub job list --scope my -q --limit 1000
```

Filter to the campaign prefixes in `mcp-data/.tb-sweep-prefixes.txt`. This matters:
the hub account held one job from an unrelated run months earlier, and passing
every id to `lb filter` would have injected a foreign trial into the submission.

### 3. Build the submission, then disqualify the tainted trials

```sh
cd /path/to/terminal-bench-2-1/leaderboard
uv run lb filter <job-links...>        # one JSON per (agent, version, model, effort)
uv run lb metadata                     # display names
```

Then add the quarantined trial ids to the submission's `disqualified_trials`.
CI joins them in as **reward 0** while they still count toward the ≥5-trials
requirement (`core/metrics.py`), which is exactly the local quarantine's
semantics — so the published number matches `merge-sweep.sh` instead of being
argued for. Get the current list from:

```sh
python integrity-scan.py jobs-sonnet5
```

Skipping this step publishes a **higher** number than the run earned.

### 4. Open the PR

```sh
uv run lb open-prs
```

### Disclosures that belong in the PR body

1. **Memory writes occurred during the run** — the agent wrote lessons that later
   attempts read.
2. **Trials are not i.i.d.** Each attempt is told how its predecessors scored, so
   this is not pass@5 on independent samples. Say which quantity is being claimed.
3. **Disqualified trials and why** — reaching the benchmark's own oracle or
   grading material, with the count.

### Before submitting, re-verify rather than assume

```sh
bash merge-sweep.sh jobs-sonnet5   # dataset ref, errored handling, quarantine
python integrity-scan.py jobs-sonnet5 --brain <brain.db>   # exit 1 = contamination
bash upload-gate.test.sh           # the public/private mapping
```

CI enforces the pinned `DATASET@DATASET_REF`, all tasks covered at ≥5 trials,
errored trials scored 0 rather than excluded, and default execution settings with
no timeout or resource overrides.
