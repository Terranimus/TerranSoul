#!/usr/bin/env bash
# THE SELF-IMPROVE LOOP, END TO END, WITH THE LLM MOCKED OUT.
#
# WHAT THIS COVERS AND WHY IT IS WORTH A TEST. Every real run of this loop costs
# a container, an API call and ~10 minutes, so the loop's own control flow — the
# part that decides WHAT the next attempt is told — has historically only ever
# been exercised by spending money, one attempt at a time, and judged by reading
# prose afterwards. That is why three separate defects in it shipped:
#
#   * the escalation detector counted the string "WebSearch" appearing in its
#     OWN feedback text as evidence that a predecessor had searched, so it told
#     10 attempts that escalation was already exhausted when the true count was
#     ZERO (2026-08-09);
#   * a feedback clause ended in "\n\n", and because that string reaches the
#     container as an ENV VAR, nine consecutive runs died in preflight producing
#     no trial at all — while a sibling task kept passing, because it took a
#     different branch and never rendered the newline (2026-08-12);
#   * the stuck-streak and escalation clauses were assembled LAST, so the one
#     instruction never yet tried receded from 37% to 74% of the way into the
#     message exactly as the attempt history grew (2026-08-12).
#
# None of those needed an LLM to catch. They are properties of a pure function
# over trial artifacts. So this test fabricates the artifacts an LLM would have
# produced — ctrf.json check results and result.json rewards — and asserts the
# loop's decisions directly. No container, no token, no network, deterministic.
#
# WHAT IT DELIBERATELY DOES NOT TEST: whether the agent OBEYS the feedback.
# That is not knowable from artifacts and is measured separately (and, measured
# 2026-08-12, it frequently does not — twenty stuck attempts produced zero web
# calls). This file pins what the harness SAYS, which is the half that is
# deterministic and the half that kept breaking.
#
# WHY IT CAN FAIL (rules/tests-must-be-able-to-fail.md): case 4 asserts the
# escalate-first directive LEADS once a stuck streak coincides with a
# never-searched history — on the pre-2026-08-12 tree that clause is appended
# last and the message opens with "You are on **attempt N**", so case 4 fails.
# Case 5 asserts single-line output, which fails against the "\n\n" draft.
# Case 2 asserts the stuck-streak clause appears at all, which fails on any
# tree predating it.
set -uo pipefail
HERE_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${TB_SWEEP_SCRIPT:-$HERE_T/run-sweep.par.sh}"
pass=0; fail=0
ok()  { echo "  ok   - $1"; pass=$((pass+1)); }
bad() { echo "  FAIL - $1" >&2; fail=$((fail+1)); }

echo "selfimprove-loop (LLM mocked):"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
JOBS="$WORK/jobs"

# ── THE MOCK ──────────────────────────────────────────────────────────────
# Stands in for one LLM attempt: writes exactly the artifacts a real trial
# leaves behind (per-check verdicts + the job's reward roll-up), and nothing
# else. `which_failed` lets a caller vary WHICH checks fail, so "same score,
# different halves" is expressible — the shape that made two half-solutions
# look identical for 28 attempts.
mock_attempt() {
  local task="$1" reward="$2" passed="$3" total="$4" job="$5" salt="${6:-a}"
  local trial="${task}__T${salt}"
  mkdir -p "$JOBS/$job/$trial/verifier"
  python - "$JOBS/$job/$trial/verifier/ctrf.json" "$passed" "$total" <<'PY'
import json, sys
p, t = int(sys.argv[2]), int(sys.argv[3])
tests = [{"name": "test_outputs.py::check_%d" % i,
          "status": "passed" if i < p else "failed"} for i in range(t)]
json.dump({"results": {"tests": tests}}, open(sys.argv[1], "w"))
PY
  python - "$JOBS/$job/result.json" "$trial" "$reward" <<'PY'
import json, sys
json.dump({"stats": {"evals": {"e": {
    "reward_stats": {"reward": {sys.argv[3]: [sys.argv[2]]}},
    "exception_stats": {}}}}}, open(sys.argv[1], "w"))
PY
  # Distinct mtimes: the loop orders predecessors by job mtime, and same-second
  # writes made attempt order nondeterministic in an earlier version of this
  # fixture.
  sleep 1
}

feedback() {  # $1 = task, $2 = attempt number
  bash -c "HERE='$HERE_T'
$(awk '/^attempt_feedback_text\(\) \{/,/^\}/' "$SRC")
TB_JOBS_DIR='$JOBS' attempt_feedback_text \"\$1\" \"\$2\"" _ "$1" "$2"
}

# ── case 1: a first attempt is told it has no history ─────────────────────
f="$(feedback filter-js-from-html 1)"
if printf '%s' "$f" | grep -q "first attempt"; then
  ok "attempt 1 is told it is the control, with no predecessors"
else
  bad "attempt 1 did not identify itself as the first attempt: ${f:0:90}"
fi

# ── case 2: three identical scores raise the stuck-streak signal ──────────
# The real shape: same reward, same failing checks, three times running.
mock_attempt filter-js-from-html 0.0 0 2 j001 a
mock_attempt filter-js-from-html 0.0 0 2 j002 b
mock_attempt filter-js-from-html 0.0 0 2 j003 c
f="$(feedback filter-js-from-html 4)"
if printf '%s' "$f" | grep -qi "EXACTLY the same checks"; then
  ok "three identical outcomes raise the stuck-streak signal"
else
  bad "no stuck-streak signal after three identical scores"
fi

# ── case 3: the per-check decomposition survives, not just the total ──────
# "0 of 2" alone cannot distinguish which half is already solved; the names
# are what stopped attempts throwing away a working half.
if printf '%s' "$f" | grep -q "check_0"; then
  ok "feedback names WHICH checks failed, not only how many"
else
  bad "feedback lost the per-check decomposition"
fi

# ── case 4: stuck + never-searched puts the untried instruction FIRST ─────
if printf '%s' "$f" | head -c 64 | grep -qi "DO THIS FIRST"; then
  ok "the never-tried escalation leads the message once the loop is stuck"
else
  bad "the escalate-first directive is buried behind the attempt roster: ${f:0:80}"
fi

# ── case 5: every rendered branch stays on ONE line ───────────────────────
# This string is passed to the container as an env var; a newline kills the
# run in preflight and produces no trial at all.
multi=""
for n in 1 2 4 7; do
  t="$(feedback filter-js-from-html "$n")"
  [ "$(printf '%s' "$t" | wc -l | tr -d ' ')" = "0" ] || multi="$multi attempt$n"
done
if [ -z "$multi" ]; then
  ok "every rendered branch is single-line (env-var safe)"
else
  bad "multi-line feedback would produce NO trial:$multi"
fi

# ── case 6: a PASS is reported as a pass, and stops claiming failure ──────
mock_attempt dna-insert 1.0 1 1 j010 p
f2="$(feedback dna-insert 2)"
if printf '%s' "$f2" | grep -q "PASSED" && ! printf '%s' "$f2" | grep -qi "two or more attempts have now failed"; then
  ok "a successful predecessor is reported as PASSED, with no failure escalation"
else
  bad "a passing attempt was misreported: ${f2:0:100}"
fi

# ── case 7: the narrow-defect signal fires only when nearly everything passes
mock_attempt pytorch-model-cli 0.0 5 6 j020 x
mock_attempt pytorch-model-cli 0.0 5 6 j021 y
f3="$(feedback pytorch-model-cli 3)"
if printf '%s' "$f3" | grep -qi "checks already PASS"; then
  ok "5-of-6 raises the narrow-defect signal (the defect is not where you are looking)"
else
  bad "no narrow-defect signal when 5 of 6 checks pass"
fi

echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
