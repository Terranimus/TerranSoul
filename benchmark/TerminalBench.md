# TerminalBench

## How the leaderboard computes each column

Audited 2026-08-19 against the submission pipeline's own source,
`terminal-bench-2-1/leaderboard/src/leaderboard/core/metrics.py`, not against
the rendered page. Our table previously carried `accuracy | trials | tasks |
status` and **no cost or token columns at all**, so it could not be compared to
a leaderboard row. These are the real definitions:

| column | formula | the part that is easy to get wrong |
|---|---|---|
| **Accuracy** | `100 × successful_trials / total_trials` | `is_success(reward)` is **`reward > 0`**, not `reward == 1`. Any positive partial reward counts. |
| **± stderr** | `100 × √v`, `v = (1/n²) · Σᵢ pᵢ(1−pᵢ)/(kᵢ−1)` over **tasks** (n = tasks, kᵢ = trials in task i) | Tasks with `k < 2` are skipped — `p(1−p)/(k−1)` is undefined at k=1. This is a per-task pooled SE, not a binomial SE over trials. |
| **pass@k** (k = 2,3,4,5) | unbiased `1 − C(n−c, k)/C(n, k)`, averaged over tasks | Per-**task**, any-of-k. **Not an accuracy.** A task with `n < k` is skipped for that k. |
| **Tokens** | `uncached + cached + output` | `uncached = max(input_tokens − cache_tokens, 0)`. Harbor's `input_tokens` **already includes** cache tokens, so summing input+cache double-counts. |
| **Cost** | `Σ trial.cost_usd`, 2 dp | — |
| **Hacks** | `−100 × n_disqualified / n_trials` | Displayed with a leading minus because the rate **has already been deducted from accuracy**. |
| Avg duration | mean wall-clock over trials reporting both timestamps | — |

Two rules that bite in opposite directions, both from the source:

- **Errored trials count as reward 0 in accuracy** — they are failures, never
  exclusions. Confirmed against our own data: harbor reports `n_trials: 5,
  n_errors: 1` yet `metrics[0].mean = 1/6`, i.e. it divides by 6.
- **Disqualified trials count as 0 in accuracy but their tokens and dollars
  still count** — *"disqualified trials still consumed tokens and dollars"*.
  Cost and accuracy therefore have different denominators.

Reimplementing the accuracy formula against our own runs reproduces harbor's
`metrics[0].mean` exactly (16.67% both ways), which is what validates this audit.

## Results

| date | benchmark | model | agent | accuracy (per-trial) | pass@2 | tokens | cost | trials | tasks | status |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-08-12 | Terminal-Bench 2.1 | claude-sonnet-5 | terransoul (Claude Code loop) | 82.15% ± 1.14% | — | — | — | 493 | 89 | archived, private — cost/tokens not recorded at the time |
| 2026-08-19 | Terminal-Bench 3.0 | claude-sonnet-5 | claude-code + TerranSoul MCP | **5.6% pooled (1/18)** | — | 1.44M | $8.66 | 18 | 3 | **not a benchmark number** — see below |
| 2026-08-20 | Terminal-Bench 3.0 | claude-opus-5 | claude-code + TerranSoul MCP | **33.3% (2/6)** | — | 14.2M in / 174k out | $15.48 imputed | 6 | 3 | **not a benchmark number** — 3 hand-picked tasks, n=6 |

**The ± is the point, and repetition proved it.** By the leaderboard's own
stderr formula that figure is `16.67% ± 16.67%` — the error bar equals the
estimate. Three runs of the identical shape (same 3 tasks, k=2, sonnet-5) have
now been done, and **pooling them gives 1 success in 18 trials = 5.6%**:

| run | result | what differed |
|---|---|---|
| `tsval` | 1/6 | baseline, one-shot gate |
| `tsval2` | 0/6 | bounded re-block gate — measured worse, reverted |
| `tsval3` | 0/6 | gate reverted to 1, plus the HTML-comment and final-stop fixes |

So the "16.67% floor" this campaign has been quoting was **one lucky trial**.
`memcached-backdoor` passed once in six attempts and nothing else ever passed.
Treat 5.6% (1/18) as the honest current estimate for these three tasks, and note
that even that is three hand-picked debugging tasks, not a benchmark. A
submission-grade row needs all 74 tasks at ≥5 trials each.

Four runs exist; none is a benchmark result:

| job | scope | result | why it is not a TB3.0 number |
|---|---|---|---|
| `tsval-20260819-041437` | 3 tasks, k=2 | 16.67% ± 16.67%, pass@2 0.333, 451,337 tok, $2.73 | Hand-picked debugging tasks, n=6, 1 errored. Validates the stack end to end. |
| `tsval2-20260819-060815` | 3 tasks, k=2 | 0.00% ± 0.00%, pass@2 0, 989,321 tok, $5.93 | A/B of a bounded re-block gate: measured **worse** and reverted (`TBENCH-STOP-BLOCK-BOUND-AB-1`). |
| `tsval3-20260819-142214` | 3 tasks, k=2 | 0.00% ± 0.00%, pass@2 0 | Re-run after the stop-block revert and the HTML-comment fix. Valid run (zero `0xC0000142`), scored 0/6. |
| `tsbroad-20260819-080345` | 20 tasks, k=2 | **INVALID** | 19 of 20 trials died with `0xC0000142` (Windows process-creation failure); harbor could not spawn `docker compose`. A measurement of nothing, not a 0%. |

Note `tsval2` burned **2.2× the tokens for a worse score** — the resource
columns carry signal the accuracy column does not.

## Does TerranSoul improve the score? Not measurable on this testbed.

A control arm was run 2026-08-19 to answer the campaign's actual question:
`tsctrl-20260819-163144-42979` — **stock Claude Code, no TerranSoul MCP, no Stop
hook** (`TB_ALLOW_NO_BRAIN=1`), same 3 tasks, same k=2, same model. It scored
**0/6**, with zero `0xC0000142`, so it is a valid run.

| arm | TerranSoul | result |
|---|---|---|
| treatment | full MCP + Stop hook | 1/18 pooled (5.6%) |
| control | none | 0/6 (0%) |

**Both arms sit on the floor, so the difference between them is not
measurable.** 1/18 vs 0/6 is one lucky trial against zero; no experiment of this
size can separate those. This is a property of the *testbed*, not a finding
about TerranSoul — three hand-picked hard debugging tasks on which the base
agent solves essentially nothing leave no headroom for an intervention to show
an effect in either direction.

### 2026-08-20: the actor was the binding constraint, not the harness

Switching to **claude-opus-5 on the host's own subscription** (OAuth, the same
credential path TB2.1 used — no third-party endpoint) moved the same 3 tasks
from 0–5.6% to **33.3% (2/6)**. For the first time in this campaign a run has
headroom in both directions.

| arm | model | TerranSoul | accuracy |
|---|---|---|---|
| `tsval` ×3 pooled | sonnet-5 | full | 1/18 = 5.6% |
| `tsctrl` | sonnet-5 | none | 0/6 = 0% |
| `tsfable` | fable-5 | full | 1/6 = 16.7% |
| `tsopus` | **opus-5** | full | **2/6 = 33.3%** |

**This is not evidence that TerranSoul helps.** The model changed at the same
time and there is no Opus 5 control yet, so the 6× jump over the Sonnet arm is
most parsimoniously explained by the actor.

**The Opus 5 control was attempted and is INVALID.**
`tsopusctl-20260820-033713-59433` (same 3 tasks, k=2, no TerranSoul MCP) came
back `trials: 6, errored: 5` — `ApiRateLimitError: 1`, `RewardFileNotFoundError:
1`, `RuntimeError: 3`. Exactly one trial graded (`session-window-debug`, reward
0), and **both `memcached-backdoor` trials errored** — i.e. the control carries
no information about the only task that showed any signal in the treatment arm.
Do not read its `accuracy=0.0` as a result; it is the `tsbroad` failure shape
again, where 19 of 20 dead trials produced a 0% that meant nothing.

Root cause: these runs authenticate with the host's **personal Max
subscription** (OAuth) rather than a paid API endpoint, and the treatment arm
consumed quota immediately before. Subscription rate limits are a real capacity
constraint on back-to-back sweeps and were flagged as a risk when the credential
path was chosen. A valid control needs quota headroom, lower concurrency, or a
paid endpoint.

Cheapest experiment that would actually settle it: run the control on
**`memcached-backdoor` alone** at k=2 — 2 trials rather than 6. It is the only
task that discriminates (2/2 with TerranSoul, 1/6 for Sonnet), so a control
there answers the question at a third of the quota.

### The A/B, finally clean — and it is a NULL

`tsctl3-20260820-054214-31067`: Opus 5, `memcached-backdoor`, k=2, **no
TerranSoul MCP**. Valid run — `n_trials=2, n_errors=0`, zero MCP calls logged,
`mean=1.0`.

| arm | `memcached-backdoor` |
|---|---|
| Opus 5 **+ TerranSoul** (`tsopus`) | 2/2 |
| Opus 5 **without TerranSoul** (`tsctl3`) | **2/2** |

Same task, same model, same credential path, same k. One variable. **TerranSoul
changed nothing.** Opus 5 solves this task reliably on its own, so the 6× gain
over the Sonnet arms is entirely attributable to the actor.

**And the testbed has now failed in BOTH directions.** Against Sonnet 5 these
three tasks were a floor (0/6 control, nothing to improve on). Against Opus 5,
`memcached-backdoor` is a ceiling (2/2 both arms, no room to improve) while
`mvcc-lsm-compaction` and `session-window-debug` remain a floor (0/2 each, with
TerranSoul). All three tasks are saturated at one end or the other, so none of
them can measure an intervention against this actor.

What a discriminating experiment now requires is tasks on which Opus 5 scores
**strictly between 0 and 100%** — which cannot be known without first sweeping
enough of the 74-task set to find them. That is the real prerequisite for any
claim about TerranSoul's effect on task success, and it is a sweep, not a
harness change.

Cost note: this control was 2 trials for $12.41 imputed (it ran on the host's
subscription, so no charge was incurred) — a useful unit for sizing that sweep.

### Finding the measurable tasks: `tsscan`, partial

`tsscan-20260820-065417-41965` — Opus 5 with TerranSoul, k=2, on **12 tasks
selected deterministically** (every 13th across the alphabetically sorted
159-task pool, excluding the three already known to be saturated). The selection
rule is stated so the sample cannot be mistaken for cherry-picking.

Purpose was NOT a score. It was to find tasks on which Opus 5 lands strictly
between 0 and 100%, since the null result above showed that saturated tasks —
at either end — cannot measure an intervention.

Result at the point the credential window closed (11 of 24 trials graded):

| classification | tasks |
|---|---|
| **discriminating** (1 of 2) | `html-js-filter` |
| floor (0 of 2) | `cargo-flight-dispatch` |
| ceiling (2 of 2) | `freecad-platform-drawing`, `telecom-entity-resolution` |

**1 of 4 fully-classified tasks is measurable.** If that rate holds, TB3.0
contains roughly 18-20 usable A/B tasks — enough for a real experiment, but only
discoverable by sweeping first.

Three operational facts this run established, each of which invalidated an
earlier assumption:

- **Real TB3.0 tasks take 1-2 hours**, not the ~35 min the three validation
  tasks take. `cumulative-layout-shift` alone ran over 3 hours with a
  multi-service environment. A 12-task k=2 scan is a **multi-day** job on this
  host, not an overnight one — the sizing that produced this partial result was
  extrapolated from the short validation tasks and was wrong by 4-6x.
- **Trial "errors" are usually image pulls.** Two trials died with
  `failed to solve: python:3.11-slim ... TLS handshake timeout` against
  `registry-1.docker.io`. The same signature was previously blamed on API rate
  limits and on a stopped Docker daemon before anyone read `exception.txt`.
  Pre-pulling every base image the selected tasks declare removes the failure
  mode; the launcher should do it during preflight.
- **`reward.txt` format varies by verifier** — one task wrote `1`, another
  wrote `1.0`. A shell test of the form `[ "$v" = "1" ]` silently classifies
  `1.0` as neither pass nor fail. Parse numerically and apply the leaderboard's
  own rule, `is_success(reward) = reward > 0`.

Caveat on the one discriminating task: TB2.1's investigation of a similarly
named task found its scoring was **lossy** — two valid approaches each earned
partial credit and every attempt saw "1 of 2". A 0/1 split produced by a lossy
grader is indistinguishable from genuine agent variance, so `html-js-filter`
must be checked for that before it is trusted as an A/B instrument. What it does establish is that the
*testbed* is no longer degenerate: an intervention now has room to register.

Two secondary observations, both confounded with the model change:

- **Consultation rose to 2.33 `brain_search` per trial** (14 across 6), against
  a flat 1.0/trial in every prior run, plus the campaign's first
  `brain_kg_neighbors` calls — the agent following graph neighbours from a hit.
  This is the first run in which the de-suppressed `SERVER_INSTRUCTIONS`
  doctrine was actually live, so doctrine and actor cannot be separated here.
- **The PostToolUseFailure push channel contributed nothing**: 8 failure
  observations across the run, **0 pushes**. Its 37.3% projected coverage was
  calibrated on transcripts averaging 3.9 Bash failures/trial; this actor
  produced **1.33** (8 across all **six** trials). A failure-triggered channel
  gets quieter exactly as the agent gets more capable, so that projection is an
  overestimate for a strong actor.

  *Corrected 2026-08-20: this first read "~1.6", which is 8/5 — computed over
  only the five trials that left a hook log, silently dropping the trial with
  zero Bash failures. Dividing by the trials that produced output rather than by
  the trials that ran is the same denominator error the campaign has made
  before, and it biases the rate upward precisely when the actor is strong.*

- **The push channel is not merely silent — when it fires, it did not work.**
  The control arm (`tsopusctl`, no TerranSoul MCP, but the hook is wired at the
  settings layer and still runs) fired Tier C in
  `session-window-debug__fsG6rQE`: hook log line 3, `pushed:true`,
  session-fallback, delivered to the model as a `hook_success` attachment. The
  agent's next two tool calls were both Bash, with **no `brain_search`**. So the
  one observed delivery produced no consultation. n=1, and one non-response is
  not proof of futility — but it is the first direct evidence about the
  *outcome* rather than the fire rate, and it points the wrong way.

The consequence for the campaign: **the 3-task testbed cannot answer whether
TerranSoul helps, and no number produced on it should be read as if it could.**
Discriminating power requires either a task set where the base agent scores well
away from 0% and 100%, or a trial count large enough to resolve single-digit
differences — the 74-task × k≥5 sweep, which the host-capacity limit above
currently blocks. The next arm therefore changes the model rather than the task
set (`tsfable`, Fable 5, whose baseline on these same tasks is 2/6 rather than
0/6) purely to obtain a non-floor baseline against which an MCP-on/MCP-off
comparison can register at all.

## What is established

The 2026-08-18 shakedown ran with the agent holding **zero** TerranSoul tools:
its proxy log is 19 calls, every one `brain_verify_completion` from the Stop
hook, with no `initialize`, no `tools/list`, no `brain_search`. The committed
launcher never passed `--mcp-config`. Fixed in `TBENCH-MCP-WIRE-1`; the first
run afterwards shows `initialize`, `tools/list` and real `brain_search` calls
from the agent. Every number above is the first measured with TerranSoul
actually in the loop.

## Two constraints on producing a real number

- **Submissions are closed.** Verified upstream 2026-08-19: TB2.1 — *"Community
  submissions are currently closed… Only submissions run by the maintainers will
  be added"*; the HuggingFace channel Harbor's docs point to — *"Submissions are
  currently CLOSED"*; TB3.0's Hub board exposes no community submission path;
  and **Frontier-Bench is the former name (a rebrand), not a successor channel**
  — its "submissions" are for contributing tasks, not results. A run can be
  produced and uploaded (`harbor upload`), not self-submitted.
- **Host capacity, not cost, is the binding limit.** Real TB3.0 tasks run
  multi-service Docker environments for hours. `tsbroad` collapsed on
  process/desktop-heap exhaustion (1038 processes, 90 `node.exe`, 115
  `conhost.exe`) with 27 GB RAM still free — memory checks report "fine" while
  process creation fails. `run-terransoul-verifyhook.sh` now refuses to start
  without process headroom.

Working record: [`terminal-bench-3.0/CAMPAIGN-RECORD.md`](terminal-bench-3.0/CAMPAIGN-RECORD.md).
Chunk history: [`../rules/completion-log.md`](../rules/completion-log.md).
