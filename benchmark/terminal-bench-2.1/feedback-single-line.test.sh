#!/usr/bin/env bash
# THE ATTEMPT FEEDBACK MUST BE A SINGLE LINE, FOR EVERY BRANCH IT CAN TAKE.
#
# WHY — self-inflicted and measured 2026-08-12. `attempt_feedback_text`'s output
# travels to the container as an ENVIRONMENT VARIABLE
# (TB_PRIOR_OUTCOMES -> run-dg.sh -> harbor `--ae KEY=value`). A newline in that
# value kills the run in preflight: no job dir, no trial, exit 1. A new
# escalation clause was added ending "...write your solution.\n\n" and every
# subsequent filter-js-from-html run exited 1 having produced NO trial — nine
# consecutively — while video-processing kept passing, because it has prior
# tainted attempts and takes a branch that never reaches that string. That
# asymmetry made a one-character bug look task-specific and structural, and it
# cost several diagnostic cycles.
#
# A single grep of the source cannot catch this: the clauses are assembled
# conditionally, so the only honest check is to RENDER each branch and inspect
# the bytes. This test therefore drives the real function against the real
# corpus and asserts the rendered output, per branch.
#
# WHY IT CAN FAIL (rules/tests-must-be-able-to-fail.md): re-introduce a "\n" in
# any clause of `attempt_feedback_text` and case 2 fails immediately. Verified
# against the pre-fix tree, where filter-js-from-html rendered 2 newlines.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${TB_SWEEP_SCRIPT:-$HERE/run-sweep.par.sh}"
JOBS="${TB_JOBS_DIR:-$HERE/jobs-sonnet5}"
pass=0; fail=0
ok()  { echo "  ok   - $1"; pass=$((pass+1)); }
bad() { echo "  FAIL - $1" >&2; fail=$((fail+1)); }

echo "feedback-single-line:"

# shellcheck disable=SC1090
eval "$(awk '/^attempt_feedback_text\(\) \{/,/^\}/' "$SRC")"

if ! declare -f attempt_feedback_text >/dev/null; then
  bad "could not extract attempt_feedback_text from $SRC"
  echo "  0 passed, 1 failed"; exit 1
fi

# ── case 1: the extraction itself is intact ───────────────────────────────
# A top-level `}` at column 0 inside the embedded python would truncate the awk
# range mid-function — which has also happened once. If the render is empty or
# trivially short for a task with real history, the extraction is broken.
probe="$(TB_JOBS_DIR="$JOBS" attempt_feedback_text filter-js-from-html 5 2>/dev/null)"
if [ "${#probe}" -gt 80 ]; then
  ok "attempt_feedback_text extracted and renders (${#probe} chars)"
else
  bad "extraction looks truncated — rendered only ${#probe} chars"
fi

# ── case 2: EVERY branch renders on one line ──────────────────────────────
# Sample tasks whose histories exercise different branches: a never-searched
# stuck task, a task with tainted prior attempts, a solved task, and an early
# attempt with almost no history.
offenders=""
for task in filter-js-from-html video-processing dna-insert pytorch-model-cli build-pov-ray; do
  for n in 1 2 3 5 9 17; do
    txt="$(TB_JOBS_DIR="$JOBS" attempt_feedback_text "$task" "$n" 2>/dev/null)"
    [ -n "$txt" ] || continue
    nl="$(printf '%s' "$txt" | wc -l | tr -d ' ')"
    [ "$nl" = "0" ] || offenders="$offenders $task@$n(${nl}nl)"
  done
done
if [ -z "$offenders" ]; then
  ok "all sampled (task x attempt) renders are single-line"
else
  bad "multi-line feedback would break the env-var handoff and produce NO trial:$offenders"
fi

echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
