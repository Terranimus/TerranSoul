#!/usr/bin/env bash
# run-dg.sh must stamp every job it launches with the harness identity it
# launched under — and a failing stamp must never be able to fail a trial.
#
# WHY THIS FAILS ON THE PRE-CHANGE TREE: neither `harness_stamp_capture` nor
# `harness_stamp_place` existed in run-dg.sh, so the extraction below finds
# nothing and the suite exits 1.
#
# THE GAP (measured 2026-09-15): every failure cluster in a 102-trial taxonomy
# already had a shipped harness fix, and nothing in the corpus recorded which
# commit a trial ran under, so the "after the fix" counts were rebuilt by hand
# from git-log dates. harness-stamp.mjs records it; this test pins WHERE
# run-dg.sh calls it, because the placement is the correctness argument:
#
#   * CAPTURE BEFORE HARBOR LAUNCHES. run-two-workers.sh runs a SNAPSHOT of
#     run-dg.sh taken at sweep start while everything else is read live, so the
#     identity that matters is the live tree at this job's launch.
#   * PLACE AFTER HARBOR, INTO THE DIRECTORY HARBOR CREATED. run-two-workers.sh
#     reads "no job dir" as "run-dg.sh refused before harbor ran"; a stamp that
#     created the directory first would change that verdict.
#   * PLACE BEFORE FORENSICS, which joins each new record to the stamp.
#
# Hermetic: a throwaway git repo, fabricated job dirs, a stub stamp script for
# the failure path. No harbor, no docker, no brain, no network.
set -uo pipefail
HERE_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${TB_RUN_DG:-$HERE_T/run-dg.sh}"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

echo "harness-stamp-wiring:"

FN_CAPTURE="$(awk '/^harness_stamp_capture\(\) \{/,/^\}/' "$SRC")"
FN_PLACE="$(awk '/^harness_stamp_place\(\) \{/,/^\}/' "$SRC")"
if [ -z "$FN_CAPTURE" ] || [ -z "$FN_PLACE" ]; then
  echo "  FAIL harness_stamp_capture / harness_stamp_place not found in run-dg.sh" >&2
  exit 1
fi

# ── ordering ────────────────────────────────────────────────────────────────
CAPTURE_LINE="$(grep -n '^HARNESS_CAPTURED="\$(harness_stamp_capture ' "$SRC" | head -1 | cut -d: -f1)"
HARBOR_LINE="$(grep -n '^"\$HARBOR" "\${args\[@\]}"' "$SRC" | head -1 | cut -d: -f1)"
JOBDIR_LINE="$(grep -n '^JOB_DIR="\${TB_JOBS_DIR:-\$HERE/jobs}/\$JOB"' "$SRC" | head -1 | cut -d: -f1)"
PLACE_LINE="$(grep -n '^harness_stamp_place "\$HERE" "\$HARNESS_CAPTURED" "\$JOB_DIR"' "$SRC" | head -1 | cut -d: -f1)"
FORENSICS_LINE="$(grep -n '^forensics_for_trials "\$JOB_DIR" "\$HERE"' "$SRC" | tail -1 | cut -d: -f1)"

if [ -n "$CAPTURE_LINE" ] && [ -n "$HARBOR_LINE" ] && [ "$CAPTURE_LINE" -lt "$HARBOR_LINE" ]; then
  ok "the identity is captured BEFORE harbor launches"
else
  no "the identity is captured BEFORE harbor launches" "capture=$CAPTURE_LINE harbor=$HARBOR_LINE"
fi
if [ -n "$PLACE_LINE" ] && [ -n "$JOBDIR_LINE" ] && [ "$PLACE_LINE" -gt "$JOBDIR_LINE" ] && [ "$PLACE_LINE" -gt "${HARBOR_LINE:-0}" ]; then
  ok "the stamp is placed AFTER harbor, into \$JOB_DIR"
else
  no "the stamp is placed AFTER harbor, into \$JOB_DIR" "place=$PLACE_LINE jobdir=$JOBDIR_LINE harbor=$HARBOR_LINE"
fi
if [ -n "$PLACE_LINE" ] && [ -n "$FORENSICS_LINE" ] && [ "$PLACE_LINE" -lt "$FORENSICS_LINE" ]; then
  ok "the stamp is placed BEFORE forensics reads it"
else
  no "the stamp is placed BEFORE forensics reads it" "place=$PLACE_LINE forensics=$FORENSICS_LINE"
fi
if grep -q 'TB_SKIP_HARNESS_STAMP' "$SRC"; then
  ok "the TB_SKIP_HARNESS_STAMP guard is present"
else
  no "the TB_SKIP_HARNESS_STAMP guard is present" "not found"
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# run the two functions exactly as run-dg.sh runs: under `set -euo pipefail`,
# capture into a variable, place into a job dir, then prove the script went on.
run_pair() { # <here> <home> <job dir>
  bash -c "set -euo pipefail
$FN_CAPTURE
$FN_PLACE
HARNESS_CAPTURED=\"\$(harness_stamp_capture \"\$1\" \"\$2\" \"\$0\" demo-job)\"
harness_stamp_place \"\$1\" \"\$HARNESS_CAPTURED\" \"\$3\"
[ -z \"\$HARNESS_CAPTURED\" ] || [ ! -e \"\$HARNESS_CAPTURED\" ] || echo LEAKED \"\$HARNESS_CAPTURED\"
echo REACHED" "$SRC" "$1" "$2" "$3" 2>&1
}

# ── 1. a real repo: harness.json carries its exact commit ───────────────────
if command -v git >/dev/null 2>&1; then
  REPO="$WORK/repo"; HOME_D="$REPO/benchmark/terminal-bench-2.1"
  mkdir -p "$HOME_D" "$REPO/packages/terransoul-cli"
  cp "$HERE_T/harness-stamp.mjs" "$HOME_D/harness-stamp.mjs" 2>/dev/null || true
  printf 'echo driver\n' > "$HOME_D/run-dg.sh"
  (cd "$REPO" && git init -q && git config user.email t@example.invalid && git config user.name t \
    && git config core.autocrlf false && git add -A && git commit -q -m init) >/dev/null 2>&1
  EXPECT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)"
  JOB="$WORK/jobs/demo-job"; mkdir -p "$JOB"
  OUT="$(run_pair "$HOME_D" "$HOME_D" "$JOB")"
  GOT="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).commit)}catch{console.log("NOFILE")}' "$JOB/harness.json")"
  if [ -n "$EXPECT" ] && [ "$GOT" = "$EXPECT" ]; then
    ok "harness.json carries the exact launch commit"
  else
    no "harness.json carries the exact launch commit" "expected=$EXPECT got=$GOT out=$OUT"
  fi
  printf '%s\n' "$OUT" | grep -q '^REACHED$' && ok "the driver continues after a successful stamp" \
    || no "the driver continues after a successful stamp" "$OUT"
  printf '%s\n' "$OUT" | grep -q 'LEAKED' && no "the launch capture temp file is removed" "$OUT" \
    || ok "the launch capture temp file is removed"
else
  echo "  skip real-repo case: git is not installed"
fi

# ── 2. git unavailable: commit:null plus a reason, and the trial goes on ────
NOGIT_HOME="$WORK/nogit-home"; mkdir -p "$NOGIT_HOME"
cp "$HERE_T/harness-stamp.mjs" "$NOGIT_HOME/harness-stamp.mjs"
JOB2="$WORK/jobs/nogit-job"; mkdir -p "$JOB2"
OUT="$(TB_HARNESS_GIT="$WORK/no-such-dir/git" run_pair "$NOGIT_HOME" "$NOGIT_HOME" "$JOB2")"
STAMP="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(`${j.commit}|${j.reason}`)}catch{console.log("NOFILE")}' "$JOB2/harness.json")"
case "$STAMP" in
  null\|*git*) ok "git unavailable -> commit:null with a reason" ;;
  *) no "git unavailable -> commit:null with a reason" "stamp=$STAMP out=$OUT" ;;
esac
printf '%s\n' "$OUT" | grep -q '^REACHED$' && ok "git unavailable does not stop the driver" \
  || no "git unavailable does not stop the driver" "$OUT"

# ── 3. the stamp script itself blows up: still never fatal ──────────────────
mkdir -p "$WORK/stub"
cat > "$WORK/stub/harness-stamp.mjs" <<'STUB'
console.error('stamp blew up')
process.exit(9)
STUB
JOB3="$WORK/jobs/stub-job"; mkdir -p "$JOB3"
OUT="$(run_pair "$WORK/stub" "$WORK/stub" "$JOB3")"
printf '%s\n' "$OUT" | grep -q '^REACHED$' && ok "a crashing stamp script cannot fail the trial" \
  || no "a crashing stamp script cannot fail the trial" "$OUT"

# ── 4. harbor never created the job dir: nothing is invented ────────────────
MISSING="$WORK/jobs/never-created"
OUT="$(TB_HARNESS_GIT="$WORK/no-such-dir/git" run_pair "$NOGIT_HOME" "$NOGIT_HOME" "$MISSING")"
[ ! -e "$MISSING" ] && ok "no job directory is created when harbor made none" \
  || no "no job directory is created when harbor made none" "$(ls -la "$MISSING" 2>&1)"
printf '%s\n' "$OUT" | grep -q '^REACHED$' && ok "a missing job dir does not stop the driver" \
  || no "a missing job dir does not stop the driver" "$OUT"

# ── 5. the skip guard really skips ──────────────────────────────────────────
JOB5="$WORK/jobs/skip-job"; mkdir -p "$JOB5"
OUT="$(TB_SKIP_HARNESS_STAMP=1 run_pair "$NOGIT_HOME" "$NOGIT_HOME" "$JOB5")"
[ ! -e "$JOB5/harness.json" ] && ok "TB_SKIP_HARNESS_STAMP=1 writes nothing" \
  || no "TB_SKIP_HARNESS_STAMP=1 writes nothing" "$(cat "$JOB5/harness.json")"

echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
