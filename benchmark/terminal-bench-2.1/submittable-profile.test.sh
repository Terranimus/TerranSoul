#!/usr/bin/env bash
# TB_SUBMITTABLE=1 must suppress prior-attempt outcome injection.
#
# WHY THIS MATTERS. run-dg.sh's own comment argues that passing a prior
# attempt's SCORE seeds no ANSWER and therefore satisfies
# rules/bench-agi-purity.md. That is true, and it is not the standard a
# leaderboard submission is judged against. The Terminal-Bench judge defines
# harness_level_cheating as "harness gave privileged info the agent should not
# have" and names PRIOR-RUN POST-MORTEMS explicitly; the instruction file pairs
# the injected outcome with "search memory for what the last attempt tried".
# A positive verdict renders the submission invalid, so a submittable run must
# render the first-attempt text no matter what the sweep driver passes in.
#
# WHY IT CAN FAIL (rules/tests-must-be-able-to-fail.md): delete the
# TB_SUBMITTABLE branch from run-dg.sh and case 2 renders the injected feedback
# instead of the first-attempt line. Verified against the pre-change tree on
# 2026-08-23, where every case 2 assertion failed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${TB_RUN_DG:-$HERE/run-dg.sh}"
pass=0; fail=0
ok()  { echo "  ok   - $1"; pass=$((pass+1)); }
bad() { echo "  FAIL - $1" >&2; fail=$((fail+1)); }

echo "submittable-profile:"

# Render the _prior block exactly as run-dg.sh would, without running the
# driver (which needs harbor, docker and a brain). Extract from the assignment
# through the end of the first-attempt fallback.
FRAG="$(awk '/^_prior="\$\{TB_PRIOR_OUTCOMES:-\}"/{f=1} f{print; if (/^fi$/) {n++; if (n==2) exit}}' "$SRC")"
if [ -z "$FRAG" ]; then
  bad "could not extract the _prior block from $SRC"
  echo "  0 passed, 1 failed"; exit 1
fi

render() { # render <TB_SUBMITTABLE> <TB_PRIOR_OUTCOMES>
  TB_SUBMITTABLE="$1" TB_PRIOR_OUTCOMES="$2" bash -c "
    set -u
    $FRAG
    printf '%s' \"\$_prior\"
  " 2>/dev/null
}

FEEDBACK="Attempt 1 scored 0.0. Attempt 2 scored 0.0."

# ── case 1: default behaviour is UNCHANGED (this is the product setting) ────
out="$(render 0 "$FEEDBACK")"
[ "$out" = "$FEEDBACK" ] && ok "default run still receives prior outcomes" \
  || bad "default run lost its feedback: '$out'"

# ── case 2: TB_SUBMITTABLE=1 suppresses it ─────────────────────────────────
out="$(render 1 "$FEEDBACK")"
case "$out" in
  *"first attempt"*) ok "submittable run renders the first-attempt text" ;;
  *) bad "submittable run leaked prior outcomes: '$out'" ;;
esac
case "$out" in
  *"scored 0.0"*) bad "submittable run still contains a prior score" ;;
  *) ok "submittable run contains no prior score" ;;
esac

# ── case 3: no feedback at all is identical under both settings ────────────
a="$(render 0 "")"; b="$(render 1 "")"
[ "$a" = "$b" ] && ok "with no prior outcomes both modes render identically" \
  || bad "modes diverge on an empty feedback string"

echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
