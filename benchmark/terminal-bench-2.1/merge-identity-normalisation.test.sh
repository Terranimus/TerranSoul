#!/usr/bin/env bash
# THE IDENTITY FILTER MUST NOT EXCLUDE THE COHORT IT IS FILTERING FOR.
#
# WHY THIS FAILS ON THE PRE-CHANGE TREE, and it is not hypothetical — it is the
# state the repo was in on 2026-09-01. `merge-sweep.sh` built its identity
# prefix straight from the launch file:
#
#     TB_AGENT=terransoul_hook:TerranSoulHook  ->  terransoul_hook__<model>__
#
# but harbor NORMALISES `_` to `-` when it writes the eval key:
#
#     terransoul-hook__claude-opus-5__tasks
#
# so `eval_key.startswith(prefix)` was false for EVERY trial the live launcher
# produced. Measured across the 266 job dirs under `jobs/`: 14 keys carried the
# hyphen form and ZERO carried the underscore form. The merge therefore printed
#
#     ACCURACY (per-trial): 0.00%   <- 0 of 0 trials passed
#
# which reads like an empty corpus rather than a filter that discarded
# everything. Running it on the real jobs-gate arm after the fix reports 88.76%
# (79 of 89) — a number that was simply unobtainable before.
#
# This is a RECURRENCE: merge-sweep.sh's own comment records the same shape
# being fixed once for the `:` separator, calling it "the exact kind of
# silent-in-the-wrong-direction failure this fix must not have". The colon was
# handled; the underscore was not.
#
# Hermetic: fabricated job dirs and launch file. No harbor, no brain, no docker.
set -uo pipefail
HERE_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE="$HERE_T/merge-sweep.sh"
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
JOBS="$TMP/jobs"; mkdir -p "$JOBS"
LAUNCH="$TMP/.tb-par0.launch"
# The launch file carries the UNDERSCORE form, exactly as the live one does.
printf 'env TB_JOB_PREFIX=zz01 TB_AGENT=terransoul_hook:TerranSoulHook TB_MODEL=claude-opus-5 bash run-sweep.par.sh\n' > "$LAUNCH"

mk_job() { # <prefix> <eval key> <task> <reward>
  local d="$JOBS/$1-20260901-000000"
  mkdir -p "$d/$3__t1/verifier"
  printf '%s' "$4" > "$d/$3__t1/verifier/reward.txt"
  cat > "$d/result.json" <<JSON
{"stats":{"n_completed_trials":1,"n_errored_trials":0,
"evals":{"$2":{"n_trials":1,"n_errors":0,
"reward_stats":{"reward":{"$4":["$3__t1"]}}}}}}
JSON
}

# The cohort's own trials, keyed the way harbor really writes them (HYPHEN).
mk_job zz01 "terransoul-hook__claude-opus-5__tasks" "task-alpha" "1.0"
mk_job zz02 "terransoul-hook__claude-opus-5__tasks" "task-beta"  "0.0"
# A genuinely foreign cohort that MUST still be excluded — the whole reason the
# filter exists (a claude-code run once made a task read SOLVED for a model
# that never solved it).
mk_job zz03 "claude-code__claude-opus-5__tasks" "task-alpha" "1.0"

OUT="$(TB_LAUNCH_REF="$LAUNCH" TB_TASKS_EXPECTED=2 bash "$MERGE" "$JOBS" zz01 zz02 zz03 2>&1)"

# 1. THE REGRESSION ITSELF. Pre-change this printed "0 of 0 trials".
case "$OUT" in
  *"0 of 0 trials"*) no "the cohort's own hyphenated trials are NOT excluded" "still reports 0 of 0 — the filter discarded everything" ;;
  *) ok "the cohort's own hyphenated trials are NOT excluded" ;;
esac

# 2. It found BOTH of the cohort's trials — not one, not three.
case "$OUT" in
  *"1 of 2 trials passed"*) ok "both cohort trials are pooled and scored (1 of 2)" ;;
  *) no "both cohort trials are pooled and scored (1 of 2)" "$(printf '%s' "$OUT" | grep -E 'of [0-9]+ trials passed' | head -1)" ;;
esac

# 3. The filter still does its job: the foreign cohort stays out. A "fix" that
#    simply disabled the filter would pass test 1 and fail this one.
case "$OUT" in
  *"OFF-IDENTITY excluded"*) ok "a genuinely foreign eval key is still excluded" ;;
  *) no "a genuinely foreign eval key is still excluded" "no OFF-IDENTITY line — filter may be disabled" ;;
esac

# 4. task-alpha must NOT read solved: only the FOREIGN trial passed it, and
#    pooling that in is the original 2026-08-12 defect this filter was added for.
case "$OUT" in
  *"tasks solved       : 1/2"*) ok "the foreign pass does not make its task read solved" ;;
  *) no "the foreign pass does not make its task read solved" "$(printf '%s' "$OUT" | grep 'tasks solved' | head -1)" ;;
esac

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
