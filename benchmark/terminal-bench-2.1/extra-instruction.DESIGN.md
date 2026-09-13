# extra-instruction.md — design note (maintainers)

> Moved out of `extra-instruction.md` on 2026-09-02. It was 8,177 bytes of an
> 29,200-byte file, and every byte of that file is shipped to the container as
> an env var ON the `docker compose exec` command line. Windows caps a command
> line at 32,767 chars; crossing it makes the trial ERROR ungraded (reward 0)
> rather than fail loudly — see the ceiling guard in `run-dg.sh`. This text is
> for maintainers and was never a rule the agent was meant to follow, so it has
> no business consuming that budget.
>
> Nothing here is edited; it is the note verbatim.

DESIGN NOTE (not shown as a rule to the agent, kept for maintainers).

This file exists because the first real D-G run (job dg-20260804-160416)
PASSED fix-git with reward 1.0 and made ZERO brain calls. Attaching an MCP
server does not make an agent use it: nothing in a Terminal-Bench task
instruction points at memory, so the tools sat there unused and the run was
Claude Code's score with TerranSoul as decoration.

PURITY CONSTRAINTS this file is written to satisfy — see
rules/bench-agi-purity.md. It contains:
  * NO task names, task hints, walkthroughs, or expected answers
  * NO domain vocabulary, verb lists, or curated term sets
  * NO claim that the memory holds anything about the current task
It says only what tools exist and when consulting a memory is generally
sensible — the same thing any MCP-equipped product tells its agent. It is
harness wiring, not a seed.

CORRECTED 2026-08-04, after auditing this file against what the server actually
serves and against the published capability spec
(https://terranimus.github.io/TerranSoul/LLM-Brain-Design-Research-Paper/memory-evolution.html):

  * `brain_suggest_context` was named three times here and is NOT ON THE WIRE.
    The MCP surface is `tools.rs::EXPOSED_TOOLS`, an owner-approved nine-tool
    product API (2026-08-01); suggest_context was cut as a near-synonym of
    brain_search. The agent was being told to call a tool Claude Code was never
    advertised — wasted turns and an error, every time it obeyed.
  * The `thinking_mode` section described the ladder and then said "escalate
    deliberately, not reflexively". Measured across every recorded job
    trajectory: 46 brain_search calls, ZERO carrying thinking_mode. So the
    bench measured the CHEAPEST rung of a product whose headline result is the
    most expensive one. Owner instruction 2026-08-04 is "thinking is max", and
    it is now enforced host-side in mcp-auth-proxy.mjs rather than requested
    here — an instruction the agent may decline is not a configuration.
  * The `rerank: true` recommendation was REMOVED. Stage 7 of the spec records
    the LLM-judge rerank as measured NET-NEGATIVE (0.52 NDCG@10 below chat at
    7.1x latency) and removed from think's path on 2026-08-02. Recommending it
    here was recommending a regression.

It also deliberately tells the agent to VERIFY what it retrieves and to move on
when retrieval is unhelpful, so a bad memory cannot become an instruction and
retrieval cannot become a stall.

ADDED 2026-08-07 — THE SCIENTIFIC LOOP (owner instruction: "hypothesis → run
experiment → evaluate results → self-improve → repeat").

Everything above this section concerned MEMORY: consult it, write to it, refine
it. The file never told the agent HOW TO REASON between those calls, so the
loop it described was consult → solve → record. That is a memory loop, not an
experimental one — there was no hypothesis to test, no requirement that a
command discriminate between explanations, and no explicit confirm/refute step
whose outcome could be recorded. "Record what you learn" presupposes a process
that produces learnings; nothing here specified one.

PURITY: the added section is a reasoning discipline, not domain content. It
names no task, tool, command, file, error, or vocabulary — it would read
identically for a benchmark of any subject. It is the same standard any
scientific-method prompt states, which is what keeps it inside
rules/bench-agi-purity.md. Check any future addition against that test: if it
would have to change for a different benchmark, it is a seed, not wiring.

COHORT SPLIT. 7 jobs of the Sonnet 5 campaign ran under the PREVIOUS text;
listed in mcp-data/.tb-oldprompt-sonnet5.txt. Applied ~20 min into an 89-task
campaign because that is the cheapest boundary available.

⛔ IT IS NOT A CONTROL ARM. An earlier version of this note called it "a genuine
same-model A/B on this instruction, obtained for free". That was WRONG and is
corrected here rather than deleted, because the mistake is an easy one to make
again.

Measured by scientific-loop.py from the prompt each trial actually received:

  COHORT OLD  budget minutes 15:13, 20:5, 60:2      reward==1.0  17/17 (100%)
  COHORT NEW  budget minutes 15:5,  60:5,  200:2    reward==1.0  11/11 (100%)

Two independent things kill the comparison:

* **BUDGET VARIES 4x INSIDE EACH ARM.** `{{TASK_BUDGET}}` is injected per task,
  and wall-clock budget is the direct determinant of trial length — which is the
  direct determinant of every cycle-count, cycle-rate and window-based measure
  the instruction targets. "Same model, same brain, same harness" was true and
  beside the point; the arms differ in the resource that produces the behaviour
  being measured. Comparisons are licensed only inside matched
  (model x task x budget) cells.
* **BOTH ARMS ARE AT CEILING.** 100% pass on both. An improvement is
  arithmetically undetectable, and the matched-cell inventory (OLD n=3 vs NEW
  n=10 across 2 cells) reports its own MDE as NOT REACHABLE AT ANY EFFECT SIZE.

So: keep them, label them, never average them — but do not present them as
evidence about the instruction. If a real A/B is wanted it has to be designed as
one, with budget held fixed and enough failing trials to have headroom.

CORRECTED 2026-08-06 — NAMING ONE REQUIRED PARAMETER MOVED THE FAILURE RATHER
THAN CLOSING IT. An earlier round of refusals was all `brain_append` calls
missing `id`, so this file gained: "**It takes that entry's `id`** ... without it
the call is rejected and the correction is lost", plus a parenthetical naming
which two calls had been rejected. The refusals then became, without exception,
`missing required param: addition` — the OTHER required parameter. Measured on
the clean run: brain_append 5 accepted / 3 refused, a 37.5 % failure rate, while
brain_search (11/11), brain_ingest_lesson (4/4) and brain_add_edge (1/1) were
untouched. The defect was isolated to the one tool the guidance singled out.

The schema was never at fault — `tools/list` reports `required: ['id',
'addition']` and documents `addition` as "must be non-empty". Naming ONE member
of a required set appears to make the model treat that member AS the
requirement, and the worked example of a past mistake sharpened the effect. So
the text now states the requirement as a SET and does not enumerate which
argument was forgotten last time. Generalise before adding another "remember to
pass X" line anywhere in this file: the fix for a missing argument is to state
the contract, not to nominate a favourite argument.

ADDED 2026-08-30 — A REGRESSION TRACED TO A SELF-REINFORCING WRONG MEMORY, NOT
TASK DIFFICULTY. One task's per-trial history (27 attempts) shows 12 passes
through 2026-08-28, then 11 STRAIGHT FAILURES from 2026-08-28 onward, with zero
passes since. `memory_versions` for the memory entry created in response to the
first of those failures shows 12 revisions, one timestamped within a minute of
each subsequent failing trial — every failure "confirmed" the entry (extended
it, called itself the Nth confirmation) rather than re-deriving its core claim.
That claim was an unstated conforming assumption the entry inferred from the
task's own illustrative prompt text; the historically-passing solution
(recovered from an earlier trial's own transcript, not from any grading
reference) used no such assumption at all. Eleven agents in a row read "ten
prior confirmations" as settled precedent rather than as ten un-refuted
re-applications of a premise nothing had actually re-checked.

This is now covered generically, in the numbered convention-fork sequence above
(rank the artifact's own structure over the task's prose when they disagree)
and in `tools::SERVER_INSTRUCTIONS` (a memory's confirmation count is not its
success count; an independent tool fed the same unverified parameter as your
own code cannot disagree with you on that parameter). PURITY: neither addition
names a task, format, or convention value — the fix is to the EPISTEMICS of
using memory and cross-checking, not to this task's answer, and it would read
identically for any other ambiguous-convention task that regresses the same
way.
