#!/usr/bin/env bash
# Tests for sweep-until-done.sh — the supervisor that carries a sweep ACROSS
# quota walls.
#
# ⛔ FAILS ON THE PRE-CHANGE TREE. sweep-until-done.sh did not exist, so every
# `bash "$SUT"` below dies with "No such file or directory" and the parser cases
# cannot even source it. The BEHAVIOUR did not exist either: a quota halt ended
# the campaign at run-two-workers.sh's exit 3 and waited for a human to notice
# the reset time, wait it out, and relaunch by hand.
#
# ⛔ NOTHING REAL IS LAUNCHED, SLEPT OR MEASURED. A stubbed
# launch-sweep-detached.sh records its argv, prints the prefix line the real one
# prints, and writes the evidence files (detached-sweep-<stamp>.err, the merged
# `.remaining`, a trial transcript carrying the account's reset string) that
# drive the state machine. A stub `sleep` records the seconds it was asked for
# instead of spending them, and TB_UNTIL_DONE_NOW_EPOCH pins the clock so the
# reset arithmetic is checkable without waiting until 4:50pm UTC.
set -uo pipefail
HERE_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT_SRC="$HERE_T/sweep-until-done.sh"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "expected [$2] got [$3]"; fi; }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
TB="$SANDBOX/benchmark/tb"
mkdir -p "$TB/jobs" "$SANDBOX/mcp-data/logs"
cp "$SUT_SRC" "$TB/sweep-until-done.sh"
# The production layout: the reset scheduler reads the same judge as the
# launcher. Absent on the pre-change tree, where this cp fails loudly and the
# supervisor has only its free-text parser.
cp "$HERE_T/rate-limit-evidence.py" "$TB/"
SUT="$TB/sweep-until-done.sh"

# 2026-09-14 17:08:39 UTC — the real halt happened minutes after this, and every
# expected epoch below is reconstructed from an ABSOLUTE date string rather than
# by re-running the script's own "today + rollover" arithmetic.
NOW=1789405719

PLAN="$SANDBOX/plan.txt"          # one line per launch: <stamp> <verdict> <n-remaining>
COUNTER="$SANDBOX/counter.txt"
LAUNCHES="$SANDBOX/launches.txt"  # argv of every launch
SLEEPS="$SANDBOX/sleeps.txt"      # seconds every sleep was asked for

cat > "$SANDBOX/launch-stub.sh" <<'STUB'
#!/usr/bin/env bash
# Stands in for launch-sweep-detached.sh: records its argv, announces the prefix
# pair exactly as the real launcher does, and writes the artefacts the sweep
# would have written for the verdict this launch is scripted to reach.
set -uo pipefail
n=$(( $(cat "$COUNTER" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$n" > "$COUNTER"
printf '%s\n' "$*" >> "$LAUNCHES"
line="$(sed -n "${n}p" "$PLAN")"
stamp="$(printf '%s' "$line" | awk '{print $1}')"
verdict="$(printf '%s' "$line" | awk '{print $2}')"
nleft="$(printf '%s' "$line" | awk '{print $3+0}')"
[ -n "$stamp" ] || { echo "stub: no plan line $n" >&2; exit 9; }

echo "[launch-sweep] tasks     : 61 from $1"
echo "[launch-sweep] prefixes  : ts${stamp}w0 (:7425)  ts${stamp}w1 (:7426)"

case "$verdict" in
  quota)
    echo "[sweep] HALT signalled: quota" >> "$TB/detached-sweep-$stamp.err"
    echo "[sweep] HALTED: quota — resume with: bash run-two-workers.sh $TB/jobs/ts${stamp}.remaining" >> "$TB/detached-sweep-$stamp.err"
    ;;
  preflight)
    echo "[sweep] HALT worker 0: preflight refused twice (run-dg.sh exit 2)" >> "$TB/detached-sweep-$stamp.err"
    echo "[sweep] HALTED: preflight — resume with: bash run-two-workers.sh $TB/jobs/ts${stamp}.remaining" >> "$TB/detached-sweep-$stamp.err"
    ;;
  done)
    echo "[2w] both workers finished — merge with: bash merge-sweep.sh jobs ts${stamp}w0 && bash merge-sweep.sh jobs ts${stamp}w1" >> "$TB/detached-sweep-$stamp.out"
    ;;
esac

# The merged remaining list run-two-workers.sh writes on a halt.
: > "$TB/jobs/ts${stamp}.remaining"
i=0; while [ "$i" -lt "$nleft" ]; do echo "task$i" >> "$TB/jobs/ts${stamp}.remaining"; i=$((i+1)); done

# The halted trial's transcript, with the account's own words. Written only when
# STUB_RESET_TEXT is set, so the "no usable reset time" path is reachable too.
if [ -n "${STUB_RESET_TEXT:-}" ] && [ "$verdict" = "quota" ]; then
  d="$TB/jobs/ts${stamp}w0-2026091${n}-030000/crack-7z-hash__x"
  mkdir -p "$d"
  printf '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"api_error_status: 429 %s"}}' \
    "$STUB_RESET_TEXT" > "$d/result.json"
fi

# The tripping trial's stream-json transcript: its LAST rate_limit_event is
# STUB_RATE_EVENT, verbatim. A result.json is written only if the text block
# above did not already write one, so both evidence kinds can sit in ONE trial --
# which is what makes "structured wins over free text" observable.
if [ -n "${STUB_RATE_EVENT:-}" ] && [ "$verdict" = "quota" ]; then
  d="$TB/jobs/ts${stamp}w0-2026091${n}-030000/crack-7z-hash__x"
  mkdir -p "$d/agent"
  [ -f "$d/result.json" ] || printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 1): claude --verbose --output-format=stream-json --print"},"agent_result":{"n_output_tokens":673}}' > "$d/result.json"
  printf '%s\n' '{"type":"system","subtype":"init","cwd":"/app"}' "$STUB_RATE_EVENT" > "$d/agent/claude-code.txt"
fi

# The SIBLING worker's trial, killed in the same halt with the 2026-09-15
# 18:45:47 shape: exit 137, 11,402 tokens, harbor's ApiRateLimitError label, and
# an allowed_warning event whose top-level resetsAt is the SEVEN-DAY window's.
# Stamped NEWER than the tripping trial so it is the first dir the supervisor
# reads -- reading its event as "the reset" would park the sweep for days.
if [ -n "${STUB_KILLED_SIBLING:-}" ] && [ "$verdict" = "quota" ]; then
  s="$TB/jobs/ts${stamp}w1-2026091${n}-030500"
  mkdir -p "$s/winning-avg-corewars__y/agent"
  printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 137): claude --verbose --output-format=stream-json --print"},"agent_result":{"n_output_tokens":11402}}' > "$s/winning-avg-corewars__y/result.json"
  printf '%s\n' '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1789956000,"rateLimitType":"seven_day","utilization":0.67,"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.22,"resetsAt":1789476600},"seven_day":{"utilization":0.67,"resetsAt":1789956000}}}}' \
    > "$s/winning-avg-corewars__y/agent/claude-code.txt"
  touch -d "@$(( $(date +%s) + 120 ))" "$s"
fi
exit 0
STUB

cat > "$SANDBOX/sleep-stub.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$SLEEPS"
exit 0
STUB
chmod +x "$SANDBOX/launch-stub.sh" "$SANDBOX/sleep-stub.sh"

run_supervisor() { # run_supervisor <tasks-file> [extra env...]
  local tasks="$1"; shift
  : > "$COUNTER"; : > "$LAUNCHES"; : > "$SLEEPS"
  rm -rf "$TB/jobs" "$TB"/detached-sweep-*.out "$TB"/detached-sweep-*.err
  mkdir -p "$TB/jobs"
  env PLAN="$PLAN" COUNTER="$COUNTER" LAUNCHES="$LAUNCHES" SLEEPS="$SLEEPS" TB="$TB" \
      TB_UNTIL_DONE_LAUNCH_CMD="$SANDBOX/launch-stub.sh" \
      TB_UNTIL_DONE_SLEEP_CMD="$SANDBOX/sleep-stub.sh" \
      TB_UNTIL_DONE_NOW_EPOCH="$NOW" \
      TB_UNTIL_DONE_WAIT_CHUNK_S=9999999 \
      TB_JOBS_DIR="$TB/jobs" \
      TB_UNTIL_DONE_LOGS_DIR="$SANDBOX/mcp-data/logs" \
      TB_LOCK_FILE="$SANDBOX/mcp-data/.tb-sweep.lock" \
      TB_UNTIL_DONE_POLL_S=1 TB_UNTIL_DONE_START_GRACE_S=1 \
      "$@" bash "$SUT" "$tasks"
}

TASKS="$SANDBOX/tasks.txt"
printf 'alpha\nbravo\ncharlie\n' > "$TASKS"

# ── (a) the reset-time parser ────────────────────────────────────────────────
# Sourced library-only, so the arithmetic is asserted directly rather than
# inferred from how long the supervisor slept.
echo "== (a) reset-time parser =="
parse() { # parse <text> -> epoch or empty
  ( TB_UNTIL_DONE_LIB_ONLY=1 TB_UNTIL_DONE_NOW_EPOCH="$NOW" . "$SUT" >/dev/null 2>&1
    _reset_epoch_from_text "$1" )
}
WANT_450PM="$(date -d '2026-09-15 16:50 UTC' +%s)"
WANT_1205AM="$(date -d '2026-09-15 00:05 UTC' +%s)"
WANT_3PM="$(date -d '2026-09-15 15:00 UTC' +%s)"
WANT_1230PM="$(date -d '2026-09-15 12:30 UTC' +%s)"
WANT_1AM="$(date -d '2026-09-15 01:00 UTC' +%s)"

# The EXACT string observed on the halted trial, middle dot and all.
got="$(parse "You've hit your session limit · resets 4:50pm (UTC)")"
check "4:50pm (UTC) parses to tomorrow 16:50 UTC" "$WANT_450PM" "$got"
if [ -n "$got" ] && [ "$got" -gt "$NOW" ]; then ok "the parsed epoch is in the FUTURE"
else no "the parsed epoch is in the FUTURE" "got=$got now=$NOW"; fi

# 12am is 00, not 12 — a plain +12/-0 rule is half a day wrong here, in the
# direction that resumes into a still-spent session.
check "12:05am (UTC)" "$WANT_1205AM" "$(parse 'resets 12:05am (UTC)')"
check "12:30pm (UTC) stays at noon"  "$WANT_1230PM" "$(parse 'resets 12:30pm (UTC)')"
# The hour-only form the cap prints on the hour.
check "3pm (UTC) with no minutes" "$WANT_3PM" "$(parse 'resets 3pm (UTC)')"
# Past-time rollover: 01:00 UTC is already behind NOW (17:08 UTC), so it is
# tomorrow's — never a negative wait that resumes immediately into the cap.
check "a past time rolls over to tomorrow" "$WANT_1AM" "$(parse 'resets 1am (UTC)')"
check "unparseable yields nothing (caller falls back)" "" "$(parse 'resets soon, probably')"
check "an absent reset string yields nothing" "" "$(parse 'ApiRateLimitError: 429')"

# ── (b) a quota halt leads to EXACTLY ONE relaunch, after sleeping to reset ──
echo "== (b) quota halt -> one relaunch with the merged .remaining =="
printf '09150300 quota 61\n09150900 done 0\n' > "$PLAN"
out="$SANDBOX/b.log"
STUB_RESET_TEXT="You've hit your session limit · resets 4:50pm (UTC)" \
  run_supervisor "$TASKS" > "$out" 2>&1
check "exits 0 once the resumed sweep completes" "0" "$?"
check "exactly two launches" "2" "$(grep -c . "$LAUNCHES")"
check "launch 1 got the original list" "$TASKS" "$(sed -n 1p "$LAUNCHES")"
# ⛔ THE RESUME MUST USE THE MERGED `.remaining`, not the original list: re-running
# already-measured tasks turns k=1 into best-of-N and doubles the cost of every wall.
check "launch 2 got the merged .remaining" "$TB/jobs/ts09150300.remaining" "$(sed -n 2p "$LAUNCHES")"
check "exactly one sleep (the wait to reset, not a poll)" "1" "$(grep -c . "$SLEEPS")"
check "slept until reset + grace" "$(( WANT_450PM + 180 - NOW ))" "$(sed -n 1p "$SLEEPS")"
grep -q '^\[until-done\] .* wall 1/' "$out" && ok "the wall is announced with a timestamped line" \
  || no "the wall is announced with a timestamped line" "$(cat "$out")"

# ── (d) normal completion names EVERY stamp in the merge command ─────────────
echo "== (d) completion prints the merge command for all stamps =="
# merge-sweep.sh: merging one prefix once published a number computed from 1 job
# out of 56, so the supervisor must name both pairs it launched.
want_merge="bash $TB/merge-sweep.sh $TB/jobs ts09150300w0 ts09150300w1 ts09150900w0 ts09150900w1"
if grep -qF "$want_merge" "$out"; then ok "the merge command names all four prefixes"
else no "the merge command names all four prefixes" "want [$want_merge] in:
$(grep -i merge "$out")"; fi
check "stamps file recorded both stamps" "09150300 09150900" \
  "$(tr '\n' ' ' < "$TB/jobs/ts09150300.stamps" | sed 's/ $//')"

printf '09151500 done 0\n' > "$PLAN"
run_supervisor "$TASKS" > "$SANDBOX/d2.log" 2>&1
check "a clean single-launch sweep exits 0" "0" "$?"
check "and launches exactly once" "1" "$(grep -c . "$LAUNCHES")"
check "and never sleeps" "0" "$(grep -c . "$SLEEPS")"

# ── (c) a preflight halt does NOT relaunch ───────────────────────────────────
echo "== (c) preflight halt -> no relaunch, non-zero exit =="
printf '09151700 preflight 61\n09151800 done 0\n' > "$PLAN"
run_supervisor "$TASKS" > "$SANDBOX/c.log" 2>&1
rc=$?
check "exits 4 (preflight), not 0" "4" "$rc"
# ⛔ THE WHOLE POINT. Two consecutive refusals is a broken environment; a
# relaunch spends the session without measuring anything and hides the fault.
check "exactly one launch — nothing was relaunched" "1" "$(grep -c . "$LAUNCHES")"
check "never slept waiting for a reset" "0" "$(grep -c . "$SLEEPS")"
grep -qi 'PREFLIGHT HALT' "$SANDBOX/c.log" && ok "says why it stopped" \
  || no "says why it stopped" "$(cat "$SANDBOX/c.log")"

# ── (e) the tight-loop guard, and the wall budget ────────────────────────────
echo "== (e) tight-loop guard =="
printf '09152000 quota 61\n09152100 quota 55\n09152200 done 0\n' > "$PLAN"
STUB_RESET_TEXT="You've hit your session limit · resets 4:50pm (UTC)" \
  TB_QUOTA_FALLBACK_WAIT_S=7200 run_supervisor "$TASKS" > "$SANDBOX/e.log" 2>&1
check "still completes" "0" "$?"
check "three launches" "3" "$(grep -c . "$LAUNCHES")"
check "two waits" "2" "$(grep -c . "$SLEEPS")"
check "wall 1 believes the printed reset time" "$(( WANT_450PM + 180 - NOW ))" "$(sed -n 1p "$SLEEPS")"
# ⛔ A relaunch that hits the wall again within minutes means the reset time is
# not the constraint. Believing it twice is a launch storm against a spent
# session — the six 429s ~13 min apart, in a loop.
check "wall 2 ignores it and waits the fallback + grace" "7380" "$(sed -n 2p "$SLEEPS")"
grep -qi 'ignoring the' "$SANDBOX/e.log" && ok "the tight loop is announced" \
  || no "the tight loop is announced" "$(cat "$SANDBOX/e.log")"

echo "== (e2) the wall budget stops the loop =="
printf '09152300 quota 61\n09152400 quota 55\n09152500 quota 50\n' > "$PLAN"
STUB_RESET_TEXT="resets 4:50pm (UTC)" TB_QUOTA_MAX_WALLS=2 \
  run_supervisor "$TASKS" > "$SANDBOX/e2.log" 2>&1
check "exits 3 once the wall budget is spent" "3" "$?"
check "launched at most MAX_WALLS times" "2" "$(grep -c . "$LAUNCHES")"
grep -q 'resume with: bash .*sweep-until-done.sh .*remaining' "$SANDBOX/e2.log" \
  && ok "prints a resume command a human can paste" \
  || no "prints a resume command a human can paste" "$(cat "$SANDBOX/e2.log")"

# ── (f) the STRUCTURED reset: the tripping trial's own rate_limit_event ─────
echo "== (f) structured reset from the tripping trial's last rate_limit_event =="
# ⛔ MEASURED 2026-09-15 18:46:10 (sweep ts09151819): "no usable reset time
# (quota) — waiting the fallback 3600s". And a REAL quota's transcript already
# holds an absolute epoch: the 2026-09-15 02:35 halt ended with
#   {"type":"rate_limit_event","rate_limit_info":{"status":"rejected",
#    "resetsAt":1789404600,"rateLimitType":"five_hour",...
#
# FAILS ON THE PRE-CHANGE TREE: _reset_epoch_structured_for_stamp did not exist,
# so the unit checks get "command not found" and an empty answer; the supervisor
# read only the free text, so (f) slept to 4:50pm UTC (85,861 s, not 4,180 s),
# (f2) had no text at all and slept the 3,780 s fallback instead of the 180 s
# grace, and (f3)'s source line was never printed.
R_FUT=$(( NOW + 4000 ))
ev_rejected() { # <five_hour resetsAt> [seven_day utilization] [seven_day resetsAt]
  printf '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":%s,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":%s},"seven_day":{"utilization":%s,"resetsAt":%s}}}}' \
    "$1" "$1" "${2:-0.31}" "${3:-1789956000}"
}
EV_WARN='{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1789956000,"rateLimitType":"seven_day","utilization":0.67,"unifiedWindows":{"five_hour":{"utilization":0.22,"resetsAt":1789476600},"seven_day":{"utilization":0.67,"resetsAt":1789956000}}}}'
structured() { # structured <stamp> -> what the supervisor's own function answers
  ( TB_UNTIL_DONE_LIB_ONLY=1 TB_UNTIL_DONE_NOW_EPOCH="$NOW" TB_JOBS_DIR="$SANDBOX/sjobs" . "$SUT" >/dev/null 2>&1
    _reset_epoch_structured_for_stamp "$1" )
}
mk_trip() { # mk_trip <stamp> <last event line>
  local d="$SANDBOX/sjobs/ts$1w0-20260916-010000/crack-7z-hash__x"
  mkdir -p "$d/agent"
  printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 1): claude --print"},"agent_result":{"n_output_tokens":673}}' > "$d/result.json"
  printf '%s\n' '{"type":"system","subtype":"init"}' "$2" > "$d/agent/claude-code.txt"
}
rm -rf "$SANDBOX/sjobs"
mk_trip 09160100 "$(ev_rejected "$R_FUT")"
check "the exhausted five_hour window's resetsAt is returned" "$R_FUT" "$(structured 09160100)"
mk_trip 09160110 "$(ev_rejected "$R_FUT" 1.02 $(( NOW + 90000 )))"
check "two spent windows return the LATER reset" "$(( NOW + 90000 ))" "$(structured 09160110)"
# A GUARD, not a new-vs-old check (the old tree also answers empty): the
# allowed_warning event's top-level resetsAt is the SEVEN-DAY window's, and a
# parser that read it as the reset would park a sweep for days.
mk_trip 09160120 "$EV_WARN"
check "an allowed_warning event yields NO structured reset" "" "$(structured 09160120)"

printf '09160100 quota 2\n09160700 done 0\n' > "$PLAN"
STUB_RESET_TEXT="You've hit your session limit · resets 4:50pm (UTC)" \
STUB_RATE_EVENT="$(ev_rejected "$R_FUT")" STUB_KILLED_SIBLING=1 \
  run_supervisor "$TASKS" > "$SANDBOX/f.log" 2>&1
check "the structured-reset sweep completes" "0" "$?"
check "exactly one wait" "1" "$(grep -c . "$SLEEPS")"
# The newer, killed sibling is read FIRST and skipped: its allowed_warning event
# would give 1789956000 + 180 - NOW = 550,461 s.
check "sleeps to the STRUCTURED resetsAt + grace, not the free-text 4:50pm nor the sibling's seven-day epoch" \
  "4180" "$(sed -n 1p "$SLEEPS")"
grep -q "reset read from the tripping trial's last rate_limit_event" "$SANDBOX/f.log" \
  && ok "the log names the structured source" || no "the log names the structured source" "$(grep until-done "$SANDBOX/f.log" | tail -8)"

echo "== (f2) a structured reset already in the past resumes after the grace alone =="
printf '09160200 quota 2\n09160800 done 0\n' > "$PLAN"
STUB_RATE_EVENT="$(ev_rejected $(( NOW - 600 )))" run_supervisor "$TASKS" > "$SANDBOX/f2.log" 2>&1
check "the past-reset sweep completes" "0" "$?"
# ⛔ NEVER A PAST TARGET, AND NEVER ROLLED A DAY FORWARD: the epoch carries its
# own date, so a window that has already cleared is resumed into now.
check "the wait is the grace only" "180" "$(sed -n 1p "$SLEEPS")"
grep -q 'already 600s in the past' "$SANDBOX/f2.log" \
  && ok "the past reset is announced" || no "the past reset is announced" "$(grep until-done "$SANDBOX/f2.log" | tail -8)"

echo "== (f3) with no exhausted window the free-text parser still decides =="
printf '09160300 quota 2\n09160900 done 0\n' > "$PLAN"
STUB_RESET_TEXT="You've hit your session limit · resets 4:50pm (UTC)" STUB_RATE_EVENT="$EV_WARN" \
  run_supervisor "$TASKS" > "$SANDBOX/f3.log" 2>&1
check "the free-text sweep completes" "0" "$?"
check "sleeps to the free-text reset + grace" "$(( WANT_450PM + 180 - NOW ))" "$(sed -n 1p "$SLEEPS")"
grep -q "reset read from the halted trial's free-text reset string" "$SANDBOX/f3.log" \
  && ok "the log names the free-text source" || no "the log names the free-text source" "$(grep until-done "$SANDBOX/f3.log" | tail -8)"

# ── refusals ─────────────────────────────────────────────────────────────────
echo "== refusals =="
if run_supervisor "$SANDBOX/does-not-exist.txt" >/dev/null 2>&1; then
  no "a missing tasks file is refused" "exited 0"
else ok "a missing tasks file is refused"; fi
: > "$SANDBOX/empty.txt"
if run_supervisor "$SANDBOX/empty.txt" >"$SANDBOX/r.log" 2>&1; then
  no "an empty tasks file is refused" "exited 0"
else
  grep -qi 'REFUSING' "$SANDBOX/r.log" && ok "an empty tasks file is refused, with a reason" \
    || no "an empty tasks file is refused, with a reason" "$(cat "$SANDBOX/r.log")"
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
