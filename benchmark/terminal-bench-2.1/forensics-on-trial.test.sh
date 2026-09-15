#!/usr/bin/env bash
# `forensics_for_trials` must run for EVERY finished trial and stay out of the
# way of the run.
#
# WHY THIS FAILS ON THE PRE-CHANGE TREE: the function did not exist in
# run-dg.sh, so the extraction below finds nothing and the suite exits 1.
#
# THE CASES THAT MATTER. Unlike the triage step above it, this one runs on
# PASSES too — a pass is half of a side-by-side comparison and the baseline the
# regression column is measured against, so skipping passes would make the
# record set structurally unable to answer "is this a regression?". And the
# whole step is advisory: a bookkeeping write that can fail a measured trial is
# the defect this campaign has paid for repeatedly, so the guard, the discarded
# exit code and the missing-job-dir case are each asserted.
#
# Hermetic: fabricated job dirs, a stub forensics script. No harbor, no brain,
# no docker, no network.
set -uo pipefail
HERE_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE_T/run-dg.sh"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

FN="$(awk '/^forensics_for_trials\(\) \{/,/^\}/' "$SRC")"
if [ -z "$FN" ]; then
  echo "  FAIL forensics_for_trials not found in run-dg.sh" >&2
  exit 1
fi

# The call site has to exist too: a function nobody invokes is the writer with
# no reader one level up.
if grep -q '^forensics_for_trials "\$JOB_DIR" "\$HERE"' "$SRC"; then
  ok "run-dg.sh actually invokes forensics_for_trials"
else
  no "run-dg.sh actually invokes forensics_for_trials" "no call site"
fi

# ⛔ ORDERING IS LOAD-BEARING. The record names the memories this trial may be
# credited for, so it has to be taken AFTER the credit loop — reading them
# earlier describes a state that no longer exists by the time anyone reads it.
CREDIT_LINE="$(grep -n 'credit-trial-outcome.mjs' "$SRC" | tail -1 | cut -d: -f1)"
FORENSICS_LINE="$(grep -n '^forensics_for_trials "\$JOB_DIR"' "$SRC" | tail -1 | cut -d: -f1)"
if [ -n "$CREDIT_LINE" ] && [ -n "$FORENSICS_LINE" ] && [ "$FORENSICS_LINE" -gt "$CREDIT_LINE" ]; then
  ok "forensics runs AFTER the credit loop"
else
  no "forensics runs AFTER the credit loop" "credit=$CREDIT_LINE forensics=$FORENSICS_LINE"
fi

if grep -q 'TB_SKIP_FORENSICS' "$SRC"; then
  ok "the TB_SKIP_FORENSICS guard is present in run-dg.sh"
else
  no "the TB_SKIP_FORENSICS guard is present in run-dg.sh" "not found"
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# Stub standing in for post-trial-forensics.mjs: echoes the trial dir it was
# handed, and can be told to fail. Asserting on the ARGUMENT keeps this test
# about wiring, which is the only thing the function decides.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/post-trial-forensics.mjs" <<'STUB'
if (process.env.STUB_FAIL === '1') {
  console.error('forensics blew up')
  process.exit(9)
}
console.log(`FORENSICS ${process.argv[2]}`)
STUB

mk_trial() { # <job dir> <name> <reward|NONE>
  mkdir -p "$1/$2/verifier"
  [ "$3" = "NONE" ] || printf '%s\n' "$3" > "$1/$2/verifier/reward.txt"
}

run_fn() { # <job dir>
  bash -c "$FN
forensics_for_trials \"\$1\" \"\$2\"" _ "$1" "$WORK/bin" 2>&1
}

JOBS="$WORK/root/job"
mk_trial "$JOBS" "failed__aaa"  "0"
mk_trial "$JOBS" "passed__bbb"  "1"
mk_trial "$JOBS" "errored__ccc" "NONE"
OUT="$(run_fn "$JOBS")"

case "$OUT" in *failed__aaa*) ok "a scored-0 trial gets a record" ;; *) no "a scored-0 trial gets a record" "not in output" ;; esac
# ⛔ PASSES TOO. The baseline column is "the most recent SOUND pass", so a
# corpus of failure-only records cannot answer the regression question at all.
case "$OUT" in *passed__bbb*) ok "a PASSING trial also gets a record (it is the baseline)" ;; *) no "a PASSING trial also gets a record" "not in output" ;; esac
case "$OUT" in *errored__ccc*) ok "an ERRORED trial (no reward.txt) gets a record" ;; *) no "an ERRORED trial gets a record" "not in output" ;; esac
case "$OUT" in *'[forensics]'*) ok "output is prefixed so it is greppable in a run log" ;; *) no "output is prefixed" "no [forensics] prefix" ;; esac

# The escape hatch must actually escape.
OUT_SKIP="$(TB_SKIP_FORENSICS=1 run_fn "$JOBS")"
case "$OUT_SKIP" in *FORENSICS*) no "TB_SKIP_FORENSICS=1 suppresses the step" "still ran" ;; *) ok "TB_SKIP_FORENSICS=1 suppresses the step" ;; esac

# Advisory only, in both of the ways it can be asked to gate.
STUB_FAIL=1 run_fn "$JOBS" >/dev/null 2>&1
if [ "$?" -eq 0 ]; then ok "a FAILING forensics run still returns success"; else no "a failing forensics run still returns success" "rc=$?"; fi

run_fn "$WORK/does-not-exist" >/dev/null 2>&1
if [ "$?" -eq 0 ]; then ok "a missing job dir returns success (advisory, never gates)"; else no "a missing job dir returns success" "rc=$?"; fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
