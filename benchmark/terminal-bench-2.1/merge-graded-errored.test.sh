#!/usr/bin/env bash
# GRADED-DESPITE-THE-EXCEPTION TRIALS NEED A READER, NOT JUST A SCORE.
#
# WHY THIS FAILS ON THE PRE-CHANGE TREE: before TBENCH-LATE-API-RETRY-1 /
# TBENCH-HOST-SPAWN-WAIT-1 got a reader here, merge-sweep.sh's "errored
# trials" line printed a single bare number (`len(errored_rows)`) and there
# was no "graded despite the exception" or "errored, no grade" text anywhere
# in its output — grepping for either string below finds nothing on the
# pre-change tree and this test fails at assertion 1. Worse, a trial named
# only in exception_stats with NO matching reward_stats entry (the
# TBENCH-HOST-SPAWN-WAIT-1 case: the verifier never ran) was invisible to the
# report altogether, not merely folded into the count — assertion 2 pins that
# it is now counted and listed.
#
# THE SHAPE, copied from a real result.json (exception_stats and reward_stats
# are sibling maps under one eval key, not derived from each other): one eval
# key carries two exception_stats entries, only ONE of which also appears in
# reward_stats. That is exactly what TBENCH-LATE-API-RETRY-1 produces (the
# agent's already-graded trial, exception kept as provenance) sitting next to
# what TBENCH-HOST-SPAWN-WAIT-1 or a stock-install failure produces (an
# exception with nothing to grade).
#
# ⛔ SECOND LAYER, added when the reader above exposed a further gap: an
# ungraded-exception trial with NO reward_stats entry was ALSO absent from
# `trials`/`per_task_official` even when it was that task's ONLY trial — the
# task vanished from the denominator instead of scoring 0 (SUBMIT.md: an
# errored trial is a 0 that STAYS in the denominator). But
# root-cause-findings-2026-09-07.md §26 (commit f9dccd98) proved one such
# trial was a genuine NON-RUN (zero tokens, no agent step) and correctly
# excluded it BY HAND. `trial_agent_produced_work` makes that same call in
# code: WHY THIS FAILS ON THE PRE-SPLIT TREE -- `trial_agent_produced_work`,
# `errored_ran_ungraded` and `non_run_exceptions` did not exist, every
# ungraded exception was one undifferentiated bucket, and the
# "excluded non-runs" section below did not exist at all, so assertions 5-7
# fail immediately (grep finds nothing) and assertion 2's exact summary-line
# text does not match either (it lacked the K1/K2 breakdown).
#
# Hermetic: fabricated job dir and launch file. No harbor, no brain, no docker.
set -uo pipefail
HERE_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE="$HERE_T/merge-sweep.sh"
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
JOBS="$TMP/jobs"; mkdir -p "$JOBS/zz01-20260911-000000/task-alpha__t1/verifier"
mkdir -p "$JOBS/zz01-20260911-000000/task-beta__t2/verifier"

# No launch file at this path -> the identity filter never engages (mirrors
# merge-identity-normalisation.test.sh's own hermetic setup, just pointed at
# a path that does not exist rather than one that does).
LAUNCH="$TMP/no-launch-here"

cat > "$JOBS/zz01-20260911-000000/result.json" <<'JSON'
{"stats":{"n_completed_trials":3,"n_errored_trials":2,
"evals":{"terransoul-hook__claude-opus-5__tasks":{"n_trials":3,"n_errors":2,
"exception_stats":{"UnknownApiError":["task-alpha__t1"],"AddTestsDirError":["task-beta__t2"]},
"reward_stats":{"reward":{"1.0":["task-alpha__t1","task-gamma__t3"]}}}}}}
JSON

OUT="$(TB_LAUNCH_REF="$LAUNCH" TB_TASKS_EXPECTED=3 bash "$MERGE" "$JOBS" zz01 2>&1)"

# 1. The summary line splits the total into graded-vs-not, reward-1.0 counted.
case "$OUT" in
  *"errored trials     : 2 (graded despite the exception: 1, of which reward 1.0: 1)"*)
    ok "summary line splits graded vs ungraded exceptions" ;;
  *) no "summary line splits graded vs ungraded exceptions" "$(printf '%s' "$OUT" | grep 'errored trials' | head -1)" ;;
esac

# 2. The ungraded one (exception_stats only, no reward_stats entry) is
#    counted -- pre-change it was invisible, not just uncounted. task-beta has
#    a trial DIRECTORY (mkdir'd above) but no result.json, no agent dir at all
#    -- zero evidence the agent ran, so it classifies as a NON-RUN (K2=1),
#    not an errored-ran trial (K1=0).
case "$OUT" in
  *"errored, no grade (exception_stats only, never reached reward_stats): 1 (K1=0 counted as 0, K2=1 excluded as non-runs)"*)
    ok "the never-graded exception is counted AND split into K1 (errored-ran)/K2 (non-run)" ;;
  *) no "the never-graded exception is counted AND split into K1 (errored-ran)/K2 (non-run)" "$(printf '%s' "$OUT" | grep 'errored, no grade' | head -1)" ;;
esac

# 5. task-beta, having zero evidence of ever running, is listed in the
#    DEDICATED non-run section -- not silently merged into the generic
#    errored-trials list, and not scored.
case "$OUT" in
  *"excluded non-runs"*) ok "a dedicated 'excluded non-runs' section exists" ;;
  *) no "a dedicated 'excluded non-runs' section exists" "no such section header" ;;
esac
case "$OUT" in
  *"AddTestsDirError"*"task-beta"*"task-beta__t2"*) ok "the non-run row names its task, exception AND trial id" ;;
  *) no "the non-run row names its task, exception AND trial id" "AddTestsDirError/task-beta/task-beta__t2 not found together" ;;
esac
case "$OUT" in
  *"DISCLOSURE REQUIRED"*) ok "the non-run section carries a disclosure reminder (root-cause-findings-2026-09-07.md §26)" ;;
  *) no "the non-run section carries a disclosure reminder" "no 'DISCLOSURE REQUIRED' line" ;;
esac
# 6. task-beta must NOT appear in the generic "errored trials (re-run or
#    exclude...)" list -- that list is now `trials`-backed, and a non-run
#    never enters `trials` at all. Extract just that section (header to the
#    next blank line) rather than a whole-output glob, which would match
#    "task-beta" wherever it appears later in the output (e.g. its OWN
#    dedicated non-run section) regardless of order.
SECTION_ERRORED_TRIALS="$(printf '%s\n' "$OUT" | sed -n '/errored trials (re-run or exclude/,/^$/p')"
case "$SECTION_ERRORED_TRIALS" in
  *"task-beta"*) no "a non-run does not pollute the generic errored-trials list" "task-beta appeared there: $SECTION_ERRORED_TRIALS" ;;
  *) ok "a non-run does not pollute the generic errored-trials list" ;;
esac

# 3. The graded one is listed WITH its reward, not just its exception name --
#    the whole point being that reward 1.0 despite an exception is what
#    TBENCH-LATE-API-RETRY-1 exists to preserve rather than discard.
case "$OUT" in
  *"graded despite the exception"*) ok "a dedicated section lists graded-despite-exception rows" ;;
  *) no "a dedicated section lists graded-despite-exception rows" "no such section header" ;;
esac
case "$OUT" in
  *"UnknownApiError"*"task-alpha"*"reward=1.0"*) ok "the graded row carries task, exception AND reward" ;;
  *) no "the graded row carries task, exception AND reward" "$(printf '%s' "$OUT" | grep 'UnknownApiError' | head -1)" ;;
esac

# 4. OFFICIAL SCORING IS UNCHANGED: task-alpha errored (its only trial is the
#    UnknownApiError one) and stays a 0 in the denominator exactly as before
#    this change -- task-gamma is the one clean pass.
case "$OUT" in
  *"tasks solved       : 1/2"*) ok "official per-task scoring is unaffected by the new reader" ;;
  *) no "official per-task scoring is unaffected by the new reader" "$(printf '%s' "$OUT" | grep 'tasks solved' | head -1)" ;;
esac

# ── scenario (a): an ERRORED-RAN ungraded trial is a solo task's ONLY trial ─
#
# WHY THIS FAILS ON THE PRE-SPLIT TREE: `task-solo` had exactly one trial, its
# exception was never graded, and the old code never added it to `trials` at
# all -- `distinct tasks` read 1/2 (task-solo silently absent) instead of 2/2,
# and `tasks solved` read 1/1 (100%) instead of 1/2 (50%): the exact inflation
# the coordinator's report describes ("n_tasks drops... the official
# percentage is computed over 88, i.e. inflated" -- here 88 is standing in
# for "1" at this fixture's scale). task-solo's trial-level result.json below
# carries real output tokens, so `trial_agent_produced_work` finds evidence on
# its FIRST check and this is classified errored-RAN, not a non-run.
mkdir -p "$JOBS/zz02-20260911-000000/task-solo__t1"
mkdir -p "$JOBS/zz02-20260911-000000/task-other__t2/verifier"
cat > "$JOBS/zz02-20260911-000000/task-solo__t1/result.json" <<'JSON'
{"agent_result":{"n_output_tokens":500}}
JSON
cat > "$JOBS/zz02-20260911-000000/result.json" <<'JSON'
{"stats":{"evals":{"terransoul-hook__claude-opus-5__tasks":{
"exception_stats":{"UnknownApiError":["task-solo__t1"]},
"reward_stats":{"reward":{"1.0":["task-other__t2"]}}}}}}
JSON
OUT_A="$(TB_LAUNCH_REF="$LAUNCH" TB_TASKS_EXPECTED=2 bash "$MERGE" "$JOBS" zz02 2>&1)"

case "$OUT_A" in
  *"distinct tasks     : 2 / 2 expected"*) ok "(a) the errored-RAN solo task stays in the denominator (distinct tasks 2/2)" ;;
  *) no "(a) the errored-RAN solo task stays in the denominator (distinct tasks 2/2)" "$(printf '%s' "$OUT_A" | grep 'distinct tasks' | head -1)" ;;
esac
case "$OUT_A" in
  *"tasks solved       : 1/2 (0.5000)"*) ok "(a) the official percentage reflects the solo task scoring 0, not vanishing" ;;
  *) no "(a) the official percentage reflects the solo task scoring 0, not vanishing" "$(printf '%s' "$OUT_A" | grep 'tasks solved' | head -1)" ;;
esac
case "$OUT_A" in
  *"errored, no grade"*"K1=1 counted as 0, K2=0 excluded as non-runs"*) ok "(a) counted in K1, not K2" ;;
  *) no "(a) counted in K1, not K2" "$(printf '%s' "$OUT_A" | grep 'errored, no grade' | head -1)" ;;
esac
SECTION_A_ERRORED="$(printf '%s\n' "$OUT_A" | sed -n '/errored trials (re-run or exclude/,/^$/p')"
case "$SECTION_A_ERRORED" in
  *"task-solo"*) ok "(a) also appears in the generic errored-trials list (it IS in \`trials\` now)" ;;
  *) no "(a) also appears in the generic errored-trials list" "task-solo missing from: $SECTION_A_ERRORED" ;;
esac

# ── scenario (b): a NON-RUN with no other trial is excluded from the count ──
#
# WHY THIS FAILS ON THE PRE-SPLIT TREE: same absence bug as (a), but here the
# CORRECT answer is exclusion (root-cause-findings-2026-09-07.md §26), so the
# pre-split tree got the right number (task-norun absent) for the wrong
# reason (it never classified anything -- everything ungraded was just
# dropped) and produced no disclosure at all. This scenario pins that the
# exclusion is now an explicit, disclosed decision, not an accidental gap.
mkdir -p "$JOBS/zz03-20260911-000000/task-norun__t9"   # dir exists; nothing inside it
mkdir -p "$JOBS/zz03-20260911-000000/task-graded__t2/verifier"
cat > "$JOBS/zz03-20260911-000000/result.json" <<'JSON'
{"stats":{"evals":{"terransoul-hook__claude-opus-5__tasks":{
"exception_stats":{"AddTestsDirError":["task-norun__t9"]},
"reward_stats":{"reward":{"1.0":["task-graded__t2"]}}}}}}
JSON
OUT_B="$(TB_LAUNCH_REF="$LAUNCH" TB_TASKS_EXPECTED=1 bash "$MERGE" "$JOBS" zz03 2>&1)"

case "$OUT_B" in
  *"distinct tasks     : 1 / 1 expected"*) ok "(b) the non-run task does NOT enter the denominator (distinct tasks 1/1, task-graded only)" ;;
  *) no "(b) the non-run task does NOT enter the denominator" "$(printf '%s' "$OUT_B" | grep 'distinct tasks' | head -1)" ;;
esac
case "$OUT_B" in
  *"tasks solved       : 1/1 (1.0000)"*) ok "(b) the official percentage is NOT dragged down by a trial that never ran" ;;
  *) no "(b) the official percentage is NOT dragged down by a trial that never ran" "$(printf '%s' "$OUT_B" | grep 'tasks solved' | head -1)" ;;
esac
case "$OUT_B" in
  *"AddTestsDirError"*"task-norun"*"task-norun__t9"*) ok "(b) is listed in the excluded non-runs section with task, exception AND trial id" ;;
  *) no "(b) is listed in the excluded non-runs section" "$(printf '%s' "$OUT_B" | grep 'task-norun' | head -1)" ;;
esac

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
