<!--
HELD — NOT WIRED. DO NOT ADD THIS FILE TO ANY LAUNCHER'S
`--extra-instruction-path` UNTIL THE RULING BELOW EXISTS.

This is the lesson-WRITING half of the former
`benchmark/terminal-bench-3.0/extra-instruction.md`. The read-side half ships
as `extra-instruction-harness.md`; this half is parked here, complete and
reviewable, rather than deleted.

WHY IT IS HELD, on two independent grounds:

  1. THE TOOLS ARE REFUSED. `mcp-auth-proxy.mjs` runs in its DEFAULT mode for
     the submission launcher. Its `READ_ONLY_TOOLS` allowlist permits
     brain_search, brain_get_entry, brain_kg_neighbors, brain_health (plus
     brain_verify_completion for the Stop hook) and blocks everything below
     with an explicit `-32001` refusal. `TB_PROXY_MODE=learn` — the only
     switch that would admit these — is NOT set by the submission launcher and
     must not be. Instructing an agent to call a tool that will be refused
     spends its turns and misdescribes the session it is in.

  2. THE LEGITIMACY QUESTION IS OPEN. Everything below describes writing to a
     memory that persists across tasks so that LATER tasks can retrieve it.
     That is cross-trial learning. Whether a submitted number may be measured
     with it on is a separate ruling, not a wiring decision, and it is not
     made here.

If that ruling ever lands in favour, wiring this file is not sufficient on its
own: the proxy must also be started with `TB_PROXY_MODE=learn`, and the run
must disclose the non-independence of its trials.
-->

### Record what you learn — as you learn it, not at the end

The memory persists after this task ends, and later tasks can retrieve what
you write now. When you learn something that would save time on a *different*
problem, record it with `mcp__terransoul__brain_ingest_lesson`.

**Write it the moment you have it, not in a final summary turn.** If this task
runs long or gets cut off, a lesson you were saving for the end is lost.

Worth recording:

- a non-obvious root cause and the observation that revealed it
- a command, flag, or file location that was not where you first looked
- an approach that failed and the reason, so it is not retried blindly
- how you spent your time, when it did not go the way you expected
- your opening move, rewritten with hindsight, named by the *shape* of task it
  applies to, not this task

Not worth recording: this task's specific answer, restatements of the task, or
anything you did not actually verify. One or two entries is plenty; skip it
entirely if nothing generalises.

### Refine and connect, don't just accumulate

- `mcp__terransoul__brain_append` — when a search turned up an entry that is
  nearly right, out of date, or missing a caveat you just discovered, append
  your correction to **that entry** instead of writing a near-duplicate. It
  requires BOTH `id` and `addition` (non-empty), and rejects the call if
  either is missing.
- `mcp__terransoul__brain_add_edge` — when two existing entries turn out to be
  related, link them, so a future search that lands on either can reach the
  other via `brain_kg_neighbors`.
- `mcp__terransoul__brain_close_edge` — if you followed a link and it was
  misleading, retract it.

<!--
DESIGN NOTE inherited from the file this was split out of, kept because it
still describes decisions a future editor would otherwise re-litigate:

  * No {{PRIOR_ATTEMPTS}} section. TB3.0 submission rules forbid cross-attempt
    feedback (leaderboard judge: "prior-run post-mortems" is
    harness_level_cheating) — better to omit the mechanism than to gate it on
    a variable that has to be remembered. Note that this is a DIFFERENT
    question from the cross-TASK writing described above, which is the one
    still open.
  * No {{TASK_BUDGET}} placeholder — Harbor's own default timeouts apply,
    unmodified (no timeout_multiplier anywhere in this campaign's configs).

PURITY: as with the shipped half, nothing here names a task, a hint, a
walkthrough, an expected answer, or any domain vocabulary.
-->
