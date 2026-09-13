#!/usr/bin/env bash
# TBENCH-ADVISORY-LABEL-1: the verdict word must match what the CALLER does.
#
# ⛔ WHAT IT PINS. `trial-contamination-check.mjs` printed `-> REFUSING`
# unconditionally, but `run-dg.sh` only treats a non-zero exit as fatal under
# TB_SUBMITTABLE=1; otherwise it calls the checker with `|| true` and carries on.
# So a normal sweep logged a LOUD refusal that refused nothing, once per task —
# 64 times in the 2026-09-08 run.
#
# That is not cosmetic. `run-dg.sh:604` carries a comment recording that this
# exact line cost THREE RUNS of investigating innocent components, because it
# sat directly above an unrelated silent `exit 2` and read like the cause.
#
# The exit code is deliberately UNCHANGED (still 1, still informative); only the
# wording follows the caller's intent. `submittable_still_refuses` is the test
# that keeps this from quietly becoming a downgrade of the real gate.
#
# Hermetic: builds its own contaminated fixture, so it needs no corpus and
# cannot drift as the real jobs dir changes. Runs in ~1s.
#
# FAILS ON THE PRE-CHANGE TREE: there was no `--advisory` flag, so the advisory
# invocation printed `-> REFUSING` and `advisory_does_not_say_refusing` fails.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
TRIAL="$SANDBOX/jobs/job1/some-task__aaaaaaa/agent"
mkdir -p "$TRIAL"

# A transcript whose agent REQUESTED a benchmark-owned oracle URL via WebFetch.
# Request position is what the checker counts (a search RESULT does not), so the
# fixture has to be a real tool_use block or the checker correctly ignores it.
cat > "$TRIAL/claude-code.txt" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebFetch","input":{"url":"https://github.com/laude-institute/terminal-bench/tests/test_outputs.py"}}]}}
EOF

echo "contamination advisory label"

# ── 1. advisory mode must not claim to refuse ────────────────────────────────
out_adv="$(node "$HERE/trial-contamination-check.mjs" --jobs "$SANDBOX/jobs" --quiet --advisory 2>&1)"
if grep -q "REFUSING" <<<"$out_adv"; then
  no "advisory_does_not_say_refusing" "printed REFUSING in advisory mode: $out_adv"
else
  ok "advisory_does_not_say_refusing"
fi
if grep -q "advisory, not blocking" <<<"$out_adv"; then
  ok "advisory_says_it_is_not_blocking"
else
  no "advisory_says_it_is_not_blocking" "$out_adv"
fi

# ── 2. the fixture is actually detected (else test 1 passes vacuously) ───────
if grep -q "1 CONFIRMED" <<<"$out_adv"; then
  ok "fixture_is_detected_as_contaminated"
else
  no "fixture_is_detected_as_contaminated" "checker found nothing: $out_adv"
fi

# ── 3. the REAL gate is unchanged ────────────────────────────────────────────
out_sub="$(node "$HERE/trial-contamination-check.mjs" --jobs "$SANDBOX/jobs" --quiet 2>&1)"
if grep -q "REFUSING" <<<"$out_sub"; then
  ok "submittable_still_refuses"
else
  no "submittable_still_refuses" "the real gate lost its refusal: $out_sub"
fi

# ── 4. the exit code is unchanged in BOTH modes ──────────────────────────────
node "$HERE/trial-contamination-check.mjs" --jobs "$SANDBOX/jobs" --quiet --advisory >/dev/null 2>&1
adv_code=$?
node "$HERE/trial-contamination-check.mjs" --jobs "$SANDBOX/jobs" --quiet >/dev/null 2>&1
sub_code=$?
if [ "$adv_code" -eq 1 ] && [ "$sub_code" -eq 1 ]; then
  ok "exit_code_unchanged_in_both_modes"
else
  no "exit_code_unchanged_in_both_modes" "advisory=$adv_code submittable=$sub_code (both must stay 1)"
fi

# ── 5. a clean corpus is still clean in advisory mode ────────────────────────
CLEAN="$SANDBOX/clean/job1/some-task__bbbbbbb/agent"
mkdir -p "$CLEAN"
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"no fetches here"}]}}' > "$CLEAN/claude-code.txt"
out_clean="$(node "$HERE/trial-contamination-check.mjs" --jobs "$SANDBOX/clean" --quiet --advisory 2>&1)"
if grep -q -- "-> clean" <<<"$out_clean"; then
  ok "clean_corpus_still_reads_clean"
else
  no "clean_corpus_still_reads_clean" "$out_clean"
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
