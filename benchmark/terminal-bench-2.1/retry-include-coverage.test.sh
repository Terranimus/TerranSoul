#!/usr/bin/env bash
# The --retry-include list must cover the transient failures that ACTUALLY
# occur, and must still refuse the ones that would be cheating.
#
# WHY THIS EXISTS. run-dg.sh states the honest principle for retries in its own
# words: the list stays limited to "failures that precede the agent's work",
# because re-attempting an API call that never produced a turn hands the agent
# no second attempt, no extra thinking and no knowledge it did not have. It then
# correctly refuses AgentTimeoutError, where the agent RAN and spent its budget.
#
# The principle is right. The list built from it was aimed at the wrong target.
#
# MEASURED 2026-08-28 over every trial in benchmark/terminal-bench-2.1/jobs-*
# (113 errored trials of 1155):
#
#     ApiRateLimitError          28   <-- largest class, was NOT retried
#     AgentSetupTimeoutError     23       retried
#     AgentTimeoutError          21       correctly refused (agent ran)
#     NonZeroAgentExitCodeError  20       ambiguous, deliberately not added
#     UnknownApiError            14       retried
#     ApiInternalServerError      1       retried
#
# TBENCH-API-RETRY-1 was written to rescue "six 529 Overloaded" trials and added
# ApiInternalServerError, which has fired ONCE in the entire corpus. Meanwhile
# rate limits -- 28 trials, a quarter of all errored trials, and the single
# example harbor's own docstring gives for this flag
# (agents/installed/base.py:33: ``harbor run --max-retries 3 --retry-include
# ApiRateLimitError``) -- were banked as hard zeros. The leaderboard counts an
# errored trial as reward 0 and does not exclude it, so each one is a lost task.
#
# A 429 is returned BEFORE the model produces a turn, exactly like the 529 the
# driver already justifies retrying. It is the same principle, applied to the
# class that actually occurs.
#
# WHY IT CAN FAIL (rules/tests-must-be-able-to-fail.md): on the pre-change tree
# run-dg.sh carries --retry-include for AgentSetupTimeoutError,
# ApiInternalServerError and UnknownApiError only, so case 1 FAILS. Verified red
# on 2026-08-28 before the fix. Case 2 fails if anyone adds AgentTimeoutError
# (or AgentSetupTimeoutError is dropped); case 3 fails on a typo'd class name.
#
# Case 3 matters because harbor does NOT validate these strings --
# cli/jobs.py:1228 does `config.retry.include_exceptions = set(...)` and a name
# that matches no exception class silently never fires. That is precisely the
# shape this repo keeps getting burned by: a gate whose disabled state is
# indistinguishable from its passing state.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${TB_RUN_DG:-$HERE/run-dg.sh}"
pass=0; fail=0
ok()  { echo "  ok   - $1"; pass=$((pass+1)); }
bad() { echo "  FAIL - $1" >&2; fail=$((fail+1)); }

echo "retry-include-coverage:"

mapfile -t INCLUDED < <(grep -oE '^[[:space:]]*--retry-include[[:space:]]+[A-Za-z]+' "$SRC" \
                        | awk '{print $2}' | sort -u)
if [ "${#INCLUDED[@]}" -eq 0 ]; then
  bad "no --retry-include entries found in $SRC"
  echo "  0 passed, 1 failed"; exit 1
fi
echo "  retry list: ${INCLUDED[*]}"

has() { printf '%s\n' "${INCLUDED[@]}" | grep -qxF "$1"; }

# ── case 1: the transient classes that actually occur ARE retried ───────────
for want in ApiRateLimitError AgentSetupTimeoutError; do
  has "$want" && ok "$want is retried" || bad "$want is NOT retried (measured transient, precedes the agent's turn)"
done

# ── case 2: classes where the agent already ran are NOT retried ─────────────
# Retrying these buys a second attempt at the task. That is cheating, and the
# driver's own comment says so. This half of the test must keep passing forever.
for deny in AgentTimeoutError ApiUsageLimitError; do
  has "$deny" && bad "$deny is retried — the agent spent its budget; this buys a second attempt" \
              || ok "$deny is correctly refused"
done

# ── case 3: every name resolves to a real harbor exception class ────────────
# A typo'd name is accepted by harbor and then never matches anything.
#
# Search the whole harbor PACKAGE, not one module: these classes are split
# across at least two homes -- the Api* family lives in
# agents/installed/base.py, but AgentSetupTimeoutError lives in
# trial/errors.py. Scoping this check to base.py alone reports a real,
# correctly-configured entry as a typo (observed while writing this test).
HARBOR_PKG="${TB_HARBOR_PKG:-/d/Git/terminal-bench-2-1/leaderboard/.venv/Lib/site-packages/harbor}"
if [ -d "$HARBOR_PKG" ]; then
  for name in "${INCLUDED[@]}"; do
    if grep -rqE "^class ${name}\b" "$HARBOR_PKG" 2>/dev/null; then
      ok "$name is a real harbor exception class"
    else
      bad "$name matches no 'class $name' in harbor — it will silently never fire"
    fi
  done
else
  echo "  skip - harbor package not found at $HARBOR_PKG (set TB_HARBOR_PKG)"
fi

echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
