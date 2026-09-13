#!/usr/bin/env bash
# `triage_failed_trials` must fire on FAILURES and stay silent on PASSES.
#
# WHY THIS FAILS ON THE PRE-CHANGE TREE: the function did not exist, so the
# extraction below finds nothing and the suite exits 1. Beyond that, each case
# pins a routing decision that decides whether a human is pointed at the right
# layer after a failed trial.
#
# THE CASE THAT MATTERS MOST is the ERRORED trial — no verifier/reward.txt at
# all. Measured 2026-09-01: 120 of 457 trial directories were in that state and
# 80 of them died in the agent INSTALL, before the agent ran. Skipping those
# would hide the largest single failure class in the campaign behind a silent
# `continue`, so the missing-reward case is asserted explicitly.
#
# Hermetic: fabricated job dirs, a stub triage script. No harbor, no brain, no
# docker, no network.
set -uo pipefail
HERE_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE_T/run-dg.sh"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

FN="$(awk '/^triage_failed_trials\(\) \{/,/^\}/' "$SRC")"
if [ -z "$FN" ]; then
  echo "  FAIL triage_failed_trials not found in run-dg.sh" >&2
  exit 1
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# Stub standing in for triage-trial.mjs: records which trial dirs it was asked
# about. Asserting on the ARGUMENT rather than on triage's own output keeps this
# test about routing, which is the only thing the function decides.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/triage-trial.mjs" <<'STUB'
console.log(`TRIAGED ${process.argv[2]}`)
STUB

mk_trial() { # <job dir> <name> <reward|NONE>
  mkdir -p "$1/$2/verifier"
  [ "$3" = "NONE" ] || printf '%s\n' "$3" > "$1/$2/verifier/reward.txt"
}

run_fn() { # <job dir>
  bash -c "$FN
triage_failed_trials \"\$1\" \"\$2\"" _ "$1" "$WORK/bin" 2>&1
}

JOBS="$WORK/job"
mk_trial "$JOBS" "failed__aaa"   "0"
mk_trial "$JOBS" "passed__bbb"   "1"
mk_trial "$JOBS" "errored__ccc"  "NONE"
mk_trial "$JOBS" "floatzero__ddd" "0.0"
mk_trial "$JOBS" "floatone__eee"  "1.0"
OUT="$(run_fn "$JOBS")"

case "$OUT" in *failed__aaa*) ok "a scored-0 trial is triaged" ;; *) no "a scored-0 trial is triaged" "not in output" ;; esac
case "$OUT" in *floatzero__ddd*) ok "reward '0.0' counts as a failure" ;; *) no "reward '0.0' counts as a failure" "not in output" ;; esac
# ⛔ The largest failure class in the campaign. A `continue` here would hide it.
case "$OUT" in *errored__ccc*) ok "an ERRORED trial (no reward.txt) is triaged" ;; *) no "an ERRORED trial (no reward.txt) is triaged" "not in output" ;; esac
case "$OUT" in *passed__bbb*) no "a passing trial is NOT triaged" "passed__bbb was triaged" ;; *) ok "a passing trial is NOT triaged" ;; esac
case "$OUT" in *floatone__eee*) no "reward '1.0' is NOT triaged" "floatone__eee was triaged" ;; *) ok "reward '1.0' is NOT triaged" ;; esac

# The escape hatch must actually escape: a bench run that cannot afford the
# extra node invocations has to be able to turn this off.
OUT_SKIP="$(TB_SKIP_TRIAGE=1 run_fn "$JOBS")"
case "$OUT_SKIP" in *TRIAGED*) no "TB_SKIP_TRIAGE=1 suppresses triage" "still ran" ;; *) ok "TB_SKIP_TRIAGE=1 suppresses triage" ;; esac

# Advisory only: it must never fail the run. A missing job dir is the shape a
# run takes when it dies before producing one, and that must not add a second
# failure on top of the first.
run_fn "$WORK/does-not-exist" >/dev/null 2>&1
case "$?" in 0) ok "a missing job dir returns success (advisory, never gates)" ;; *) no "a missing job dir returns success" "rc=$?" ;; esac

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
