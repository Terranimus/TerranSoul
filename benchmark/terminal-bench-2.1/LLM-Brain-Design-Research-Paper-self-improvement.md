> **ARCHIVED — Terminal-Bench 2.1.** This document belongs to the closed 2.1
> campaign (Claude Code agent loop + `claude-sonnet-5`). It is retained for
> provenance and is **not** current guidance. The active campaign is
> Terminal-Bench 3.0; see `benchmark/terminal-bench/`.
# Self-Improvement, Measured: what a memory system actually earns on Terminal-Bench

> Companion to *Memory as a first-class layer*. This page is about **measurement**,
> not architecture. It records what TerranSoul's self-improvement loop was measured
> to do on Terminal-Bench 2.1, how three separate measurement defects made that
> loop look like it was doing nothing, and what survives once they are corrected.
>
> **Status: partial.** The Opus 5 figures below are final. The Sonnet 5 campaign
> referenced in §7 is in flight; its section is empty until it completes, and no
> number will be written there that has not been measured.

---

## 1. The loop under test

The claim is not "the system has memory". It is that the system runs a closed
loop and gets better inside it:

> **hypothesis → run experiment → evaluate results → self-improve → repeat**

Two of those five steps live in the agent, and three in the memory. Terminal-Bench
is a useful place to test them because each task is a fresh container with a
verifier that returns a hard 0 or 1, and because a task can be attempted *k* times
in sequence — so the first attempt is a control and the later ones are treated.

**The loop was not instructed until 2026-08-07.** Auditing the harness for this
page found that `extra-instruction.md` told the agent to *consult memory → solve →
record*. That is a memory loop. There was no hypothesis to falsify, no requirement
that a command discriminate between competing explanations, and no explicit
confirm/refute step whose outcome could be recorded. "Record what you learn"
presupposes a process that produces learnings; none was specified.

The instruction now states the cycle explicitly: state a falsifiable hypothesis
with a predicted observation; run the smallest command that **discriminates**
between it and the next likely explanation, changing one thing at a time; say
plainly whether the result confirmed or refuted it; update the model and write
generalising findings to memory immediately; repeat.

It names no task, tool, command, or domain vocabulary — it would read identically
for a benchmark of any subject. That is the test `rules/bench-agi-purity.md`
applies, and it is what separates reasoning *wiring* from a *seed*.

### 1a. Why an instruction proves nothing

This project's own doctrine is that **an instruction the agent may decline is not
a configuration**. It was learned expensively: across 46 recorded `brain_search`
calls, *zero* carried the `thinking_mode` argument the instruction asked for, so a
benchmark believed it was measuring a reasoning ladder it never invoked.

So the instruction is step one, and the measurement is step two. §7 reports what
the trajectories actually contain, from an analyzer that scores the loop from
tool-call structure rather than from vocabulary — because the agent has now been
told the vocabulary, and any metric it can satisfy by saying the right words is
worthless.

---

## 2. Three defects that made self-improvement look absent

Every number in this section is from the Opus 5 corpus: 89 tasks, k=5, one harbor
job per task with attempts run strictly sequentially.

### 2a. Harness errors were counted as memory failures

`attempt-uplift.sh` scored an errored trial — `ApiRateLimitError`,
`NetworkConnectionError`, a credential that died mid-task — as a failure of the
treatment arm. That is only sound if errors fall evenly across attempts. On this
corpus they did not: **3 in attempt 1 against 17 in attempts 2–5**.

The primary figure now excludes errored trials and the inclusive figure is kept as
an explicit pessimistic bound.

> ⚠️ The tempting mechanism — "later attempts have burned more quota, so they get
> rate-limited more" — is true of **one error class only**. An independent
> re-derivation over a 260-trial extraction found total errors essentially flat by
> within-job position (12/11/10/9/15), while `ApiRateLimitError` alone was graded
> (2/5/4/5/9). Quota drain across a job's five back-to-back attempts is real; it is
> not the whole trend.

### 2b. Attempts were indexed per task, and the unit is the job

The sweep runs **one harbor job per task carrying all k attempts back to back**.
So "no lesson for this task can exist yet", the property that makes attempt 1 a
control, belongs to a *job*. A task that gets re-run receives a *second* job with
its own fresh attempt 1 — and keying by task pools the two, filing every re-run's
attempt 1 into the treated bucket.

The re-run tasks were the two pathological ones (`extract-moves-from-video` and
`filter-js-from-html`, 30 trials each), so the treatment arm was absorbing the
hardest task's every restart.

### 2c. The sample is saturated, and a pooled uplift is arithmetically capped

Attempt 1 passes 94.3 % of the time on the tasks measured. A task that already
passes on attempt 1 gives memory *no headroom* — the only thing later attempts can
do is regress through retry variance. Reporting one pooled uplift over a saturated
stratum and a small hard stratum is a Simpson-shaped error.

The metric now reports the two strata separately and prints the arithmetic ceiling
alongside the result, so a near-zero pooled figure is read as *forced* rather than
as evidence.

### 2d. What the corrections do to the headline

| reading | uplift |
|---|---|
| as originally reported | **−9.6 pp** |
| errored trials excluded, still keyed by task | −6.2 pp |
| errored excluded **and** keyed by job | **+9.7 pp** (bound +5.4 pp) |

Both defects pushed the same direction. That is how "memory does not help"
survived as long as it did.

**Neither figure is significant**, and the page does not claim otherwise: the
standard error is ±5.9 pp and trials within a task are strongly correlated. The
finding is not "memory helps by 9.7 pp"; it is that **the negative result was an
artifact**, and the honest state is *unresolved on this sample*.

---

## 3. Where the improvement actually landed

The within-task uplift is null, and chasing it was looking in the wrong place.

**Across campaigns, attempt 1 itself got dramatically faster.** For the 29 tasks
present in both corpora, median attempt-1 `agent_execution`:

> **209 s → 138 s — a 47.3 % reduction.**

This is the loop's "repeat" step working at the scale it actually operates on. By
the time the later campaign ran, **32 of 37 tasks' anchor lesson already existed**
(median 3 prior revisions), and **75 % of attempt-1 trials retrieved a
pre-campaign lesson**. Attempt 1 is no longer a cold start.

Which also explains the null within-task result: the *control arm is pre-treated*.
The experiment compares a warm agent against a warm agent. A design that assumes
"no lesson for this task exists at attempt 1" is only valid on a fresh brain.

### 3a. Retrieval is not the bottleneck

Measured over 207 `brain_search` calls in 260 trials:

- **80.5 %** of attempt-2+ searches returned text written verbatim by an earlier
  attempt of the same task (67.8 % at id level); 34 of 37 tasks had at least one
  cross-attempt hit, 23 scored 100 %.
- `brain_search` median **0.76 s**, p90 1.74 s, max 3.99 s. **All** brain tools
  together blocked **238 s across the entire 260-trial corpus.**

The memory is being called, it returns the right thing four times in five, and it
is not the runtime cost.

### 3b. A defect that is real but did not cost accuracy

15.0 % of search responses exceeded the MCP client's tool-result ceiling — 22
replaced by a 2 KB preview of a 50–59 KB payload, 9 rejected outright. The cause
is `brain_append` growing an entry without bound.

An adversarial re-derivation refused the obvious conclusion, and it was right to:
**all 13 trials whose reply never arrived in full still passed** (100 %, against
84.9 % for every other search trial), because the agent self-rescues by calling
`brain_get_entry` on an id visible in the preview. The per-attempt truncation rates
(13.3 / 12.1 / 17.1 %) have fully overlapping confidence intervals and track task
composition, not attempt depth.

So it is a **cost and hygiene defect** — a 30 KB median retrieval payload is tokens
paid on every search — and it is recorded here as one. It is *not* the cause of a
missing uplift, and it should not be cited as one.

---

## 4. The ceiling on what memory can move

A perfect memory that made agent execution instantaneous would cut trial
wall-clock by at most **60 %** and campaign elapsed time by about **30 %**.
Measured phase medians over 260 trials:

| phase | median |
|---|---|
| environment setup | 2 s |
| **agent setup** | **101 s** |
| agent execution | 148 s |
| verifier | 13 s |

The measured attempt-2+ effect is −4.2 % on `agent_execution`, worth −2.5 % of
trial wall-clock — which is why the total delta reads as nothing.

**Speed claims must therefore be reported against `agent_execution`, not against
trial wall-clock**, or the denominator hides the effect. It also means an archived
−42.5 % runtime figure is not a valid never-regress floor: it was measured across a
changing harness with a different control.

---

## 5. What this measurement cannot establish

Stated up front rather than in a footnote:

1. **No cold-start control.** Attempt 1 is memory-warm, so within-task uplift
   measures the marginal value of one more lesson on a mature corpus, not
   learning from scratch.
2. **No no-memory arm.** 45 trials made zero brain calls, but 42 of them errored;
   3 usable trials cannot be a control. Independent testing of other memory
   systems found a plain LLM with *no* memory beating most dedicated ones on
   LongMemEval — any claim here needs that control before it is worth much.
3. **Attempts are not independent.** Attempt 1 teaches attempts 2–5 of the same
   task by design, so pass@k is not comparable to agents that start each attempt
   blank. Cross-*task* learning is the separate and uncontested claim.
4. **Correlated trials.** Within-task ICC ≈ 0.70, so a naive binomial standard
   error understates uncertainty by roughly 1.8×.
5. **Sample selection.** The tasks measured are ~11 pp easier than those not yet
   run, because harder tasks error out before producing clean attempts.

---

## 6. Why the 90 % token-saving figures do not apply

Published memory systems advertise 90–99 % token savings. Those measure
**context substitution** — replaying a prior conversation into each prompt versus
retrieving from memory — against a full-context baseline. A Terminal-Bench
container is fresh with no prior conversation, so that denominator is zero. It is
90 % of a cost never paid, and it excludes the cost of *writing* memories, which
is paid.

The applicable mechanism is **exploration reduction**, whose honest published
range is 14–79 %. Against the best comparable published result (GenericAgent,
round 1 → 2 on Claude Opus 4.6):

| | output tokens | runtime |
|---|---|---|
| this system, attempt 1 → 2+ | −39.2 % | −42.5 % |
| GenericAgent, R1 → R2 | −36.4 % | −42.4 % |

Parity on the two axes that measure "the agent explored less".

---

## 7. Can we tell whether the agent follows the loop? Mostly not — and that is the finding

Three independent measurement designs were built for this section and **all three
were killed** under adversarial review before any number was published. The
reasons are structural, and they are more useful than the number would have been.

### 7a. The artifact ceiling: steps 1 and 3 are not recorded

Extended thinking is **redacted in every transcript**: 0 of 1,936 thinking blocks
in the Opus 5 corpus and 0 of 226 in the Sonnet 5 corpus carry any text.

*Hypothesis* (step 1) and *evaluate* (step 3) happen there. **No instrument
reading these artifacts can observe them.** What survives is the token *volume* of
that hidden reasoning (median 1,676 tokens/trial on Opus 5, 1,906 on Sonnet 5) —
and volume is not content. A trial with 20k hidden tokens may have run twenty
cycles or one long ramble.

### 7b. Why the obvious substitutes fail

**Reading the visible narration does not work.** The intuition — "text written
before a tool call is a prediction" — is empirically false. Measured over 1,373
pre-tool text blocks: **89.7 % of anchors sit in the *retrospective* clause**, and
only 10.1 % in the forward one. Claude Code's idiom is *report the last result,
then announce the next action*, in one block. Position does not establish
priority.

**Counting verification cycles from tool structure does not work either.** 51.7 %
of candidate verification events have a trivial head — `ls`, `tail`, `echo`,
`cat`. `echo` run twice is a closed cycle. And the instruction we just added asks
the agent to *state what it believes* and *say plainly whether it confirmed or
refuted*, which produces exactly more narration and re-orientation calls. The
metric would rise for the wrong reason and could not distinguish that from real
work.

**Keyword matching was never on the table**, and the redaction settles it: the
agent has now been taught the vocabulary, so any metric it can satisfy by saying
"I hypothesise" measures nothing.

### 7c. The accidental cohort is not a control

When the loop instruction landed twenty minutes into the campaign, it created two
cohorts. An earlier draft of this page called that "a same-model A/B obtained for
free". **That was wrong.** Measured from the prompt each trial actually received:

| cohort | wall-clock budget (minutes) | reward = 1.0 |
|---|---|---|
| OLD (pre-instruction) | 15 × 13, 20 × 5, 60 × 2 | 17/17 (100 %) |
| NEW (post-instruction) | 15 × 5, 60 × 5, 200 × 2 | 11/11 (100 %) |

Two independent kills. **Budget varies 4× inside each arm** — and wall-clock
budget is the direct determinant of trial length, which is the direct determinant
of every cycle-rate the instruction targets. And **both arms are at ceiling**: an
improvement is arithmetically undetectable. Restricted to matched
(model × task × budget) cells, the comparison is OLD n=3 against NEW n=10, whose
minimum detectable effect is **not reachable at any effect size**.

### 7d. What is machine-checkable, and is reported

Step 4 — *improve: write it to memory now* — is the one step that leaves a
receipt: a tool call returning an integer `memory_id`. That is structural, not
prose, and it is what `scientific-loop.py` reports:

- **80 % of trials wrote at least one lesson** (16/20, pre-instruction cohort).
- Median write payload 2,145 characters; median `version_count` after append 8 —
  i.e. entries being revised, not just accumulated.
- The artifact **cannot** say whether a revision *corrected* an entry or merely
  re-confirmed it. That needs the prose, which §7b disqualifies.

### 7e. And attempt 1 is not a clean control even within one corpus

**34.5 % of attempt-1 trials (19/55) retrieved a memory id written earlier in the
same corpus.** The measurement therefore reports an uncontaminated-groups-only
stratum alongside the full one, rather than treating attempt 1 as naive.

> **The honest summary of this section.** The loop is now *instructed*, and the
> instruction is purity-clean. Whether the agent *follows* it is not answerable
> from these artifacts, because the two steps that would prove it are redacted
> and every available proxy is either inflatable or confounded. Establishing it
> would need reasoning traces retained at capture time and a budget-matched
> design with failing trials in it — neither of which this campaign has.

---

## Provenance

Every figure on this page is measured, not estimated, and comes from artifacts on
disk: `benchmark/terminal-bench/jobs-opus5/` (89 tasks, Claude Opus 5, k=5) and
the in-flight `jobs-sonnet5/` (Claude Sonnet 5). Analysis tooling:
`attempt-uplift.sh`, `sweep-timing.py`, `brain-latency.py`, `scientific-loop.py`.

Model provenance is carried in each trial's own `config.json`; the two corpora are
kept in separate directories because `merge-sweep.sh` takes the best trial per
task, and a mixed directory would yield a score attributable to neither model.
