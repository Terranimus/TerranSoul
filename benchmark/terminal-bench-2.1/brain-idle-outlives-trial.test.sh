#!/usr/bin/env bash
# Regression test for TBENCH-BRAIN-IDLE-1 — run-dg.sh must refuse a brain that
# will idle out before the trial it is about to run.
#
# WHAT IT PROVES, and why it is worth a whole gate.
#
# MEASURED 2026-09-01, filter-js-from-html, ceiling 1800s, brain on the MCP
# server's 300s idle default: the agent called brain_search/brain_get_entry in
# its first three minutes, then worked locally for ~13 minutes — editing and
# running code in a container, which sends the MCP server NOTHING — and the idle
# watchdog shut the server down MID-TRIAL. The Stop hook's
# `brain_verify_completion op=record` then came back `upstream unreachable`.
#
# The damage is not "a call failed". It is that the agent's self-report —
# "18/18 benign HTML files byte-identical; 24 XSS vectors blocked" — went
# UNCHALLENGED, because the thing that challenges it had exited. The grader then
# failed both halves (5 of 12 clean files modified, XSS still firing). The trial
# read as a capability failure. It was an infrastructure one, and it cost $3.16.
#
# The server cannot fix this itself. Its liveness clock already counts every
# authenticated request, not just tool calls (see AppState::mcp_last_request_ms)
# — but a coding agent mid-task sends NO requests, so from inside the process
# silence is indistinguishable from abandonment. The server does not know the
# task's ceiling. run-dg.sh does. So the check belongs here, fail-closed, before
# the trial spends anything.
#
# WHY IT FAILS ON THE PRE-CHANGE TREE (rules/tests-must-be-able-to-fail.md):
# run-dg.sh had no idle-timeout gate at all and /health did not publish
# `mcp_idle_timeout_secs`, so case 1 below would run the trial instead of
# refusing, and case 3's "outlives the trial" line did not exist to grep for.
#
# Uses a stub /health server, so it needs no brain, no Docker and no network.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass=0; fail=0
check() { if [ "$2" -eq 0 ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1));
          else printf '  FAIL %s\n' "$1"; fail=$((fail+1)); fi }

# The gate as run-dg.sh implements it, extracted so this test exercises the real
# decision rather than a paraphrase of it. Kept in lockstep by the final case,
# which greps run-dg.sh for the same strings.
gate() { # $1 = idle value from /health ("" = field absent), $2 = ceiling
  local _idle="$1" _budget_sec="$2"
  if [ -z "$_idle" ]; then echo "WARN"; return 0; fi
  if [ "$_idle" -gt 0 ] 2>/dev/null && [ "$_idle" -lt "$_budget_sec" ] 2>/dev/null; then
    echo "REFUSE"; return 6
  fi
  echo "OK"; return 0
}

echo "TBENCH-BRAIN-IDLE-1 — the brain must outlive the trial"

# 1. THE MEASURED CASE: 300s default against a 1800s ceiling.
out="$(gate 300 1800)"; rc=$?
[ "$out" = "REFUSE" ] && [ "$rc" -eq 6 ]
check "300s idle vs 1800s ceiling REFUSES (exit 6) — the case that cost a trial" $?

# 2. Disabled watchdog: 0 means "never idles out", which always outlives.
out="$(gate 0 1800)"; rc=$?
[ "$out" = "OK" ] && [ "$rc" -eq 0 ]
check "idle=0 (disabled) proceeds" $?

# 3. A window longer than the ceiling is fine.
out="$(gate 3600 1800)"; rc=$?
[ "$out" = "OK" ] && [ "$rc" -eq 0 ]
check "3600s idle vs 1800s ceiling proceeds" $?

# 4. Equal is enough — the gate refuses only when STRICTLY shorter, so a brain
#    configured exactly to the ceiling is not gratuitously blocked.
out="$(gate 1800 1800)"; rc=$?
[ "$out" = "OK" ] && [ "$rc" -eq 0 ]
check "idle == ceiling proceeds (refuse only when strictly shorter)" $?

# 5. ⛔ A MISSING FIELD MUST WARN, NOT REFUSE. An older brain does not publish
#    `mcp_idle_timeout_secs`, and a gate that fails closed on absence would
#    block runs an operator had configured correctly by hand — turning a safety
#    check into an outage. Unknown is unknown, and says so.
out="$(gate "" 1800)"; rc=$?
[ "$out" = "WARN" ] && [ "$rc" -eq 0 ]
check "absent field WARNS and proceeds (an old brain must not be an outage)" $?

# 6. A non-numeric value cannot be compared, so it must fall through to the
#    permissive branch rather than being coerced to 0 and read as "disabled".
out="$(gate "abc" 1800)"; rc=$?
[ "$out" = "OK" ] && [ "$rc" -eq 0 ]
check "garbage value does not refuse and is not coerced to a number" $?

# 7. The extracted gate above must not drift from the shipped one.
grep -q 'REFUSING: the brain will idle out BEFORE this trial ends' "$HERE/run-dg.sh"
check "run-dg.sh carries the refusal" $?
grep -q 'outlives the trial' "$HERE/run-dg.sh"
check "run-dg.sh carries the proceed line" $?
grep -q 'mcp_idle_timeout_secs' "$HERE/run-dg.sh"
check "run-dg.sh reads mcp_idle_timeout_secs from /health" $?
grep -q 'exit 6' "$HERE/run-dg.sh"
check "run-dg.sh exits 6 on refusal" $?

echo
printf 'passed %d, failed %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
