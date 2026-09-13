#!/usr/bin/env bash
# A REDO MUST NOT SILENTLY JOIN A DIFFERENT COHORT THAN THE ONE IT CLAIMS.
#
# WHY THIS TEST EXISTS — measured, not hypothetical. Forensics on 2026-08-12,
# reconstructed from session transcripts after the job dirs were deleted, found
# that ten consecutive redo runs printed
#   [redo] identity  : agent=claude-code model=claude-opus-5
# while `mcp-data/.tb-par0.launch` held the cohort's real identity
#   TB_AGENT=terransoul:TerranSoul TB_MODEL=claude-sonnet-5
# because a stray exported TB_AGENT in that shell won the
# `[ -n "${TB_AGENT:-}" ] ||` default, and run-dg.sh's own fallback for an unset
# TB_AGENT is `claude-code`. Three of those runs scored reward 1.0 and were
# merged into the cohort by a then-identity-blind merge-sweep, publishing
# "filter-js-from-html: 3 consecutive passes, EXIT CONDITION MET" for a task
# whose record under the cohort's OWN identity was 0-for-6. Nothing in the
# pipeline warned at any point.
#
# WHY IT CAN FAIL (rules/tests-must-be-able-to-fail.md): case 1 exports a
# conflicting TB_AGENT and asserts a NON-ZERO exit. On the pre-change tree
# redo-task.sh accepted that value silently and proceeded (exit 0 / reaching the
# run), so case 1 fails there by construction. Case 2 pins the escape hatch so
# the guard cannot be "fixed" by making every override impossible, and case 3
# pins the no-conflict path so the guard does not break ordinary redos.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${TB_REDO_SCRIPT:-$HERE/redo-task.sh}"
pass=0; fail=0
ok()  { echo "  ok   - $1"; pass=$((pass+1)); }
bad() { echo "  FAIL - $1" >&2; fail=$((fail+1)); }

echo "redo-identity-guard:"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
LAUNCH="$TMP/.tb-par0.launch"
printf 'TB_AGENT=terransoul:TerranSoul TB_MODEL=claude-sonnet-5 TB_DATASET=terminal-bench/terminal-bench-2-1\n' > "$LAUNCH"

# DRY=1 stops before any container work, so these cases cost nothing and cannot
# touch the cohort. The guard runs BEFORE the DRY early-exit, which is the whole
# point: identity is validated before anything is launched or checkpointed.
run_redo() {  # env assignments come from the caller
  DRY=1 TB_LAUNCH_REF="$LAUNCH" TB21_DIR="${TB21_DIR:-/d/Git/terminal-bench-2-1}" \
    bash "$SCRIPT" filter-js-from-html 1 >"$TMP/out.txt" 2>"$TMP/err.txt"
  echo $?
}

# ── case 1: a conflicting inherited identity is FATAL ─────────────────────
rc="$(TB_AGENT=claude-code TB_MODEL=claude-opus-5 run_redo)"
if [ "$rc" != "0" ] && grep -qi "REFUSING" "$TMP/err.txt"; then
  ok "a stray TB_AGENT/TB_MODEL that disagrees with the launch file is refused (exit $rc)"
else
  bad "a conflicting inherited identity was ACCEPTED (exit $rc) — the exact defect that published a cohort's unearned pass"
  head -3 "$TMP/err.txt" >&2
fi

# ── case 2: the override is explicit, greppable, and works ────────────────
rc="$(TB_AGENT=claude-code TB_MODEL=claude-opus-5 TB_IDENTITY_OVERRIDE=1 run_redo)"
if [ "$rc" = "0" ]; then
  ok "TB_IDENTITY_OVERRIDE=1 permits a deliberate different-identity run"
else
  bad "the override does not work (exit $rc) — a guard with no escape hatch gets disabled wholesale instead"
  head -3 "$TMP/err.txt" >&2
fi

# ── case 3: the ordinary path still works, and adopts the cohort identity ──
rc="$(run_redo)"
if [ "$rc" = "0" ] && grep -q "agent=terransoul:TerranSoul" "$TMP/out.txt"; then
  ok "with no conflicting env, the launch file's identity is adopted"
else
  bad "the normal no-conflict redo broke (exit $rc)"
  head -5 "$TMP/out.txt" >&2
fi

echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
