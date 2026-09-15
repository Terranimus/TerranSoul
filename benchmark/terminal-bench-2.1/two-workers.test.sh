#!/usr/bin/env bash
# Tests for run-two-workers.sh.
#
# FAILS ON THE PRE-CHANGE TREE: run-two-workers.sh did not exist, so every case
# below errors at invocation. The behaviour it encodes did not exist either —
# batches ran as one job at TB_CONCURRENCY=2, which is precisely the shape that
# makes a proxy log unattributable.
#
# The script is exercised with a STUB run-dg.sh that records the environment it
# was called with, so these assert what the launcher actually does rather than
# grepping its source for a literal (the shape that passes with the behaviour
# deleted — see reference_tests_that_cannot_fail_include_str).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fails=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: expected [$2] got [$3]"; fails=$((fails+1)); fi
}

# A sandbox laid out like the repo: <root>/benchmark/tb/ so the script's
# HERE/../.. resolves to <root> and the prefix file lands inside the sandbox.
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/benchmark/tb" "$SANDBOX/mcp-data"
cp "$HERE/run-two-workers.sh" "$SANDBOX/benchmark/tb/"
cp "$HERE/sweep-status.sh" "$SANDBOX/benchmark/tb/"
CALLS="$SANDBOX/calls.txt"
HOOKS="$SANDBOX/hooks.txt"
TB="$SANDBOX/benchmark/tb"

# ⛔ THE STUB MUST CREATE A JOB DIR, because "did this task produce a new job
# dir" is now how a PREFLIGHT REFUSAL is told apart from a task result. A stub
# that only records its environment would look like a driver refusing before
# harbor, which is exactly the case the refusal branch below drives deliberately
# with STUB_REFUSE=1.
cat > "$TB/run-dg.sh" <<'STUB'
#!/usr/bin/env bash
echo "$TB_JOB_PREFIX|$TB_PROXY_PORT|$TB_TASKS|$TB_CONCURRENCY|$TB_ATTEMPTS|$TB_AGENT" >> "$CALLS"
# What the worker still OWED at the moment this task was dealt, read from the
# ledger the launcher maintains -- so "the ledger follows the task actually run"
# is answered by the file itself rather than by reasoning about the order.
if [ -n "${STUB_LEDGER_LOG:-}" ]; then
  printf '%s %s: %s\n' "$TB_JOB_PREFIX" "$TB_TASKS" \
    "$(tr '\n' ' ' < "$TB_DRIVER_HOME/jobs/$TB_JOB_PREFIX.remaining" 2>/dev/null | sed 's/ *$//')" \
    >> "$STUB_LEDGER_LOG"
fi
if [ "${STUB_REFUSE:-0}" = "1" ]; then exit 2; fi
case "$TB_TASKS" in slow*) sleep "${STUB_SLOW_S:-25}" ;; esac
d="$TB_DRIVER_HOME/jobs/$TB_JOB_PREFIX-$(date +%s)$RANDOM"
mkdir -p "$d/${TB_TASKS}__x"
if [ "${STUB_QUOTA_TASK:-}" = "$TB_TASKS" ]; then
  printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"session limit"},"agent_result":{"n_input_tokens":0,"n_output_tokens":0}}' > "$d/${TB_TASKS}__x/result.json"
else
  printf '%s' '{"exception_info":null,"agent_result":{"n_input_tokens":900,"n_output_tokens":120},"verifier_result":{"rewards":{"reward":1}}}' > "$d/${TB_TASKS}__x/result.json"
fi
# The host CLI rotating the credential, simulated: the headroom JUMPS once this
# task is done, which is what makes a deferred long task runnable later.
if [ -n "${STUB_BUMP_AFTER:-}" ] && [ "$TB_TASKS" = "$STUB_BUMP_AFTER" ] && [ -n "${TB_HEADROOM_MIN_OVERRIDE:-}" ]; then
  printf '%s' "${STUB_BUMP_TO:-0}" > "$TB_HEADROOM_MIN_OVERRIDE"
fi
exit 0
STUB

# Recording stubs for the three scripts the launcher must now invoke. Each logs
# its own name and argv, so "was it called" is answered by evidence rather than
# by grepping run-two-workers.sh for the string — advertisement is not use.
for h in preflight brain-start brain-stop; do
  cat > "$SANDBOX/$h.sh" <<STUBH
#!/usr/bin/env bash
echo "$h \$*" >> "$HOOKS"
exit \${${h//-/_}_RC:-0}
STUBH
  chmod +x "$SANDBOX/$h.sh"
done

sweep() { # sweep <tasks-file> [extra env...]
  local tasks="$1"; shift
  env CALLS="$CALLS" \
      TB_PREFLIGHT_CMD="$SANDBOX/preflight.sh" \
      TB_BENCH_BRAIN_START_CMD="$SANDBOX/brain-start.sh" \
      TB_BENCH_BRAIN_STOP_CMD="$SANDBOX/brain-stop.sh" \
      TB_LOCK_FILE="$SANDBOX/mcp-data/.tb-sweep.lock" \
      TB_SWEEP_POLL_S=1 \
      "$@" bash "$TB/run-two-workers.sh" "$tasks"
}

echo "== refuses an empty task list =="
: > "$SANDBOX/empty.txt"
sweep "$SANDBOX/empty.txt" >/dev/null 2>&1
check "empty file exits 2" "2" "$?"
sweep "$SANDBOX/nope.txt" >/dev/null 2>&1
check "missing file exits 2" "2" "$?"
check "no prefixes registered on refusal" "0" \
  "$(if [ -f "$SANDBOX/mcp-data/.tb-sweep-prefixes.txt" ]; then wc -l < "$SANDBOX/mcp-data/.tb-sweep-prefixes.txt" | tr -d ' '; else echo 0; fi)"

echo "== runs every task, ONE PER JOB =="
: > "$CALLS"; : > "$HOOKS"
printf 'alpha bravo charlie delta echo\n' > "$SANDBOX/tasks.txt"
sweep "$SANDBOX/tasks.txt" >"$SANDBOX/run1.log" 2>&1
check "one run-dg call per task" "5" "$(wc -l < "$CALLS" | tr -d ' ')"
# ⛔ THE POINT OF THE SCRIPT. One task per invocation means one job, one proxy,
# one log and one TRIAL_SCOPE per trial. A call carrying two tasks would restore
# the shared-log defect that makes credit unattributable.
check "no call carries more than one task" "0" "$(cut -d'|' -f3 "$CALLS" | grep -c ' ' || true)"
check "every task ran exactly once" "alpha bravo charlie delta echo" \
  "$(cut -d'|' -f3 "$CALLS" | sort | tr '\n' ' ' | sed 's/ $//')"

echo "== two workers, two ports, alternating deal =="
check "exactly two distinct ports" "2" "$(cut -d'|' -f2 "$CALLS" | sort -u | wc -l | tr -d ' ')"
check "ports are 7425 and 7426" "7425 7426" "$(cut -d'|' -f2 "$CALLS" | sort -u | tr '\n' ' ' | sed 's/ $//')"
# Alternating rather than halving: a run of slow tasks must not all land on one
# worker. With 5 tasks the split is 3/2, never 5/0.
check "worker0 got 3 tasks" "3" "$(cut -d'|' -f2 "$CALLS" | grep -c 7425)"
check "worker1 got 2 tasks" "2" "$(cut -d'|' -f2 "$CALLS" | grep -c 7426)"
check "each port has its own job prefix" "2" "$(cut -d'|' -f1,2 "$CALLS" | sort -u | wc -l | tr -d ' ')"

echo "== concurrency is 1 per worker, so trials never overlap in a log =="
# ⛔ TB_CONCURRENCY=2 inside one job is exactly what made the windows overlap
# and forced attribution to refuse. Two workers x 1 = the same two containers.
check "every call is concurrency 1" "1" "$(cut -d'|' -f4 "$CALLS" | sort -u | tr -d '\n')"
check "every call is 1 attempt (k=1)" "1" "$(cut -d'|' -f5 "$CALLS" | sort -u | tr -d '\n')"
# The identity error that cost 60 trials: run-dg.sh's fallback is `claude-code`,
# so an unset TB_AGENT silently measures baseline Claude Code.
check "agent identity is always set" "terransoul_hook:TerranSoulHook" "$(cut -d'|' -f6 "$CALLS" | sort -u | tr -d '\n')"

echo "== both prefixes registered BEFORE the run, not after =="
# A prefix appended only on success is invisible to merge-sweep.sh when a worker
# dies mid-run, and that worker's results vanish from the total.
check "two prefixes registered" "2" "$(grep -c "^ts" "$SANDBOX/mcp-data/.tb-sweep-prefixes.txt")"
check "registered prefixes match the ones used" "" \
  "$(comm -23 <(cut -d'|' -f1 "$CALLS" | sort -u) <(sort -u "$SANDBOX/mcp-data/.tb-sweep-prefixes.txt") | tr -d '\n')"

echo "== the preflight and the bench brain are actually INVOKED =="
# ⛔ FAILS ON THE PRE-CHANGE TREE: run-two-workers.sh called neither. Nothing
# started the isolated bench brain on :7424 at all, and no pre-launch checklist
# existed — so a sweep launched against a missing brain refused 89 times in a
# few seconds and reported "both workers finished".
check "preflight ran once, with the tasks file" "1" "$(grep -c "^preflight .*tasks.txt" "$HOOKS")"
check "bench brain start ran once at launch" "1" "$(grep -c '^brain-start *$' "$HOOKS")"
# ⛔ FAILS ON THE PRE-CHANGE TREE: the brain was started once at launch and
# never looked at again, so an external kill mid-sweep (both brains died at
# the same minute on 2026-09-14, no crash trace) cost two preflight refusals
# and a halted worker instead of a relaunch before the next task.
check "bench brain re-checked before each task" "5" "$(grep -c '^brain-start --per-task ' "$HOOKS")"
check "bench brain stop ran once" "1" "$(grep -c '^brain-stop' "$HOOKS")"
# ORDER MATTERS: a brain started after the first trial is a brain the first
# trial did not have.
# FAILS ON THE PRE-CHANGE TREE: the launcher ran the checklist first, and the
# checklist's first item is the bench brain -- so a resume after a halt (whose
# halt path stops the brain) refused itself at 03:07 on 2026-09-15.
check "the brain start precedes the preflight" "brain-start preflight" \
  "$(awk '{print $1}' "$HOOKS" | grep -E '^(preflight|brain-start)$' | head -2 | tr '\n' ' ' | sed 's/ $//')"

echo "== a FAILING preflight refuses before anything is spent =="
: > "$CALLS"; : > "$HOOKS"
sweep "$SANDBOX/tasks.txt" preflight_RC=2 >"$SANDBOX/pf.log" 2>&1
check "a failed preflight exits non-zero" "2" "$?"
check "a failed preflight runs no task" "0" "$(wc -l < "$CALLS" | tr -d ' ')"
check "a failed preflight still started the brain the checklist inspects" "1" "$(grep -c '^brain-start' "$HOOKS")"

echo "== a FAILING bench-brain start refuses too =="
: > "$CALLS"; : > "$HOOKS"
sweep "$SANDBOX/tasks.txt" brain_start_RC=2 >"$SANDBOX/bb.log" 2>&1
check "an unusable bench brain exits non-zero" "2" "$?"
check "an unusable bench brain runs no task" "0" "$(wc -l < "$CALLS" | tr -d ' ')"

echo "== the sweep LOCK is held while running and released after =="
# ⛔ FAILS ON THE PRE-CHANGE TREE: `.tb-sweep.lock` was written only by
# run-sweep*.sh and redo-task.sh, never by this launcher — so a redo launched
# during a two-worker sweep saw no lock, took the default port 7425, and
# collided with worker 0. That is the exact hazard both readers of the lock
# already refuse for.
check "the lock is released when the sweep ends" "0" \
  "$(if [ -f "$SANDBOX/mcp-data/.tb-sweep.lock" ]; then echo 1; else echo 0; fi)"
printf '%s\n' "$$" > "$SANDBOX/mcp-data/.tb-sweep.lock"
: > "$CALLS"
sweep "$SANDBOX/tasks.txt" >"$SANDBOX/lock.log" 2>&1
check "a LIVE foreign lock refuses the launch" "2" "$?"
check "a refused launch runs no task" "0" "$(wc -l < "$CALLS" | tr -d ' ')"
printf '999999\n' > "$SANDBOX/mcp-data/.tb-sweep.lock"
: > "$CALLS"
sweep "$SANDBOX/tasks.txt" >"$SANDBOX/lock2.log" 2>&1
check "a STALE lock is cleared, not fatal" "5" "$(wc -l < "$CALLS" | tr -d ' ')"

echo "== the watchdog/status contract: per-worker lock + log + anchor =="
# ⛔ FAILS ON THE PRE-CHANGE TREE: this launcher wrote neither file, so
# halt-on-outage.sh saw no live workers and stood down immediately, and
# sweep-status.sh / tick.sh reported "no worker logs found" for a running sweep.
for w in 0 1; do
  check "worker $w log exists" "1" \
    "$(if [ -f "$SANDBOX/mcp-data/logs/tbench-par${w}.log" ]; then echo 1; else echo 0; fi)"
  # The logs are APPENDED across launches on purpose (that is exactly why
  # sweep-status.sh anchors on the LAST marker), so this asserts the last marker
  # belongs to THIS worker's prefix, not that there is exactly one.
  check "worker $w log carries the [sweep] job prefix anchor" "yes" \
    "$(if grep '^\[sweep\] job prefix: ts' "$SANDBOX/mcp-data/logs/tbench-par${w}.log" | tail -1 | grep -q "w${w}\$"; then echo yes; else echo no; fi)"
done
check "worker locks are removed when the worker ends" "0" \
  "$(ls "$SANDBOX"/mcp-data/.tb-par[0-9].lock 2>/dev/null | wc -l | tr -d ' ')"
# THE CONTRACT IS ONLY REAL IF THE READER PARSES IT. sweep-status.sh anchors on
# the last `[sweep] job prefix:` line and reports per-worker progress from it.
STATUS="$(cd "$TB" && bash sweep-status.sh 2>&1)"
check "sweep-status.sh finds the worker logs" "0" \
  "$(printf '%s' "$STATUS" | grep -c 'no worker logs found')"
check "sweep-status.sh finds a launch marker" "0" \
  "$(printf '%s' "$STATUS" | grep -c 'no launch marker')"
check "sweep-status.sh reports both workers by prefix" "2" \
  "$(printf '%s' "$STATUS" | grep -cE '^  worker [01] \[(alive|dead)\] ts')"

echo "== a PREFLIGHT REFUSAL is not read as a task result =="
# ⛔ MEASURED SHAPE, FAILS ON THE PRE-CHANGE TREE. All of run-dg.sh's preflights
# run BEFORE it invokes harbor, so a refusal exits with no job dir created. The
# old code then read `ls -1dt jobs/<prefix>-*/ | head -1`, which returns the
# PREVIOUS task's job (or nothing), and asked `job_was_infra_failure` about a
# trial that never happened. With the bench brain missing every task exits in
# seconds, no halt fires, and the worker sprints through 45 tasks and prints
# "worker finished".
: > "$CALLS"; : > "$HOOKS"
rm -rf "$TB/jobs"
printf 'r1 r2 r3 r4 r5 r6\n' > "$SANDBOX/refuse.txt"
sweep "$SANDBOX/refuse.txt" STUB_REFUSE=1 >"$SANDBOX/refuse.log" 2>&1
rc=$?
check "a refusing driver halts the sweep non-zero" "4" "$rc"
check "the halt names the worker and the reason" "2" \
  "$(grep -c '^\[sweep\] HALT worker [01]: preflight refused twice' "$SANDBOX/refuse.log")"
check "it does NOT claim both workers finished" "0" \
  "$(grep -c 'both workers finished' "$SANDBOX/refuse.log")"
# Two refusals per worker, then stop — NOT all six tasks sprinted through.
check "each worker stopped after 2 refusals" "4" "$(wc -l < "$CALLS" | tr -d ' ')"
REMAIN="$SANDBOX/benchmark/tb/jobs/ts$(grep -m1 -oE 'ts[0-9]{8}' "$SANDBOX/refuse.log" | sed 's/^ts//').remaining"
check "a .remaining file lists the unrun tasks" "r1 r2 r3 r4 r5 r6" \
  "$(sort "$REMAIN" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
check "the resume command is printed" "1" \
  "$(grep -c 'resume with: bash run-two-workers.sh' "$SANDBOX/refuse.log")"

echo "== a QUOTA halt stops the SIBLING too =="
# ⛔ FAILS ON THE PRE-CHANGE TREE: the quota branch returned 3 from ONE worker,
# `wait "$PID0" "$PID1"` discarded both exit codes, and the sibling kept feeding
# tasks into the same spent session — one zero-token failure every ~15 minutes
# until its own list ran out. The launcher then printed "both workers finished".
: > "$CALLS"; : > "$HOOKS"
rm -rf "$TB/jobs"
printf 'quota-task slow-a slow-b\n' > "$SANDBOX/quota.txt"
start=$(date +%s)
sweep "$SANDBOX/quota.txt" STUB_QUOTA_TASK=quota-task STUB_SLOW_S=25 TB_SIBLING_GRACE_S=2 >"$SANDBOX/quota.log" 2>&1
rc=$?
elapsed=$(( $(date +%s) - start ))
check "a quota halt exits non-zero" "3" "$rc"
check "the halt is announced as quota" "1" "$(grep -c '^\[sweep\] HALTED: quota' "$SANDBOX/quota.log")"
check "it does NOT claim both workers finished" "0" "$(grep -c 'both workers finished' "$SANDBOX/quota.log")"
# The sibling was mid-task (25 s stub sleep) and must have been stopped well
# before it could finish. A launcher that merely waited would take >= 25 s.
check "the sibling was killed, not waited out" "yes" \
  "$(if [ "$elapsed" -lt 22 ]; then echo yes; else echo "no (${elapsed}s)"; fi)"
QREMAIN="$SANDBOX/benchmark/tb/jobs/ts$(grep -m1 -oE 'ts[0-9]{8}' "$SANDBOX/quota.log" | sed 's/^ts//').remaining"
# BOTH workers' unfinished tasks, in the ORIGINAL order, so the resume file is a
# drop-in replacement for the launch list.
check "the merged .remaining holds both workers' unrun tasks, in order" "quota-task slow-a slow-b" \
  "$(tr '\n' ' ' < "$QREMAIN" 2>/dev/null | sed 's/ $//')"
check "the bench brain is stopped on the halt path too" "1" "$(grep -c '^brain-stop' "$HOOKS")"

echo "== the run-dg env matches redo-task.sh =="
# ⛔ THE SWEEP MUST BE THE SAME HARNESS AS THE REDO. The last five sam-cell-seg
# conversions were measured through redo-task.sh, which pins TB_MODEL,
# TB_DATASET, TB_DEFER_WRITES and PYTHONIOENCODING/PYTHONUTF8 and runs a
# BYTE-FROZEN SNAPSHOT of run-dg.sh. This launcher pinned none of them and ran
# the live file — a 40-hour sweep is the run most likely to overlap an edit,
# and an edit mid-run makes bash resume at a shifted byte offset.
for v in TB_MODEL TB_DATASET TB_DEFER_WRITES PYTHONIOENCODING PYTHONUTF8; do
  check "run-dg is given $v" "yes" \
    "$(if grep -q "${v}=" "$HERE/run-two-workers.sh"; then echo yes; else echo no; fi)"
done
check "the driver is a snapshot, not the repo file" "1" \
  "$(grep -c 'cp "\$HERE/run-dg.sh" "\$DRIVER"' "$HERE/run-two-workers.sh")"
check "the non-independence disclosure is printed once" "1" \
  "$(grep -c 'NOT INDEPENDENT: TB_REFUTE_WATCH' "$HERE/run-two-workers.sh")"

echo "== a QUOTA failure stops the worker instead of retrying =="
# ⛔ MEASURED 2026-09-04. Six tasks died with ApiRateLimitError and zero tokens
# ("You've hit your session limit - resets 4:50am UTC"). The zero-token retry
# fired on all six and every retry hit the same wall ~13 min later. A transient
# fault clears on its own; a SESSION CAP clears at a fixed wall-clock time, so
# retrying spends the one retry when it cannot possibly help.
source <(sed -n '/^job_hit_quota() {/,/^}/p' "$HERE/run-two-workers.sh")
QJOB="$SANDBOX/quotajob"; mkdir -p "$QJOB/t__x"
cat > "$QJOB/t__x/result.json" <<'JSON'
{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"session limit"},
 "agent_result":{"n_input_tokens":0,"n_output_tokens":0}}
JSON
job_hit_quota "$QJOB" && q=1 || q=0
check "a rate-limited job is detected as quota" "1" "$q"

# Must NOT fire on the wall-clock timeout: that is a real capability 0 and the
# worker should carry on to the next task.
TJOB="$SANDBOX/timeoutjob"; mkdir -p "$TJOB/t__x"
cat > "$TJOB/t__x/result.json" <<'JSON'
{"exception_info":{"exception_type":"AgentTimeoutError","exception_message":"timed out after 3600.0 seconds"},
 "agent_result":{"n_input_tokens":900,"n_output_tokens":120}}
JSON
job_hit_quota "$TJOB" && q2=1 || q2=0
check "a wall-clock timeout is NOT quota" "0" "$q2"

# And not on a clean pass.
PJOB="$SANDBOX/passjob"; mkdir -p "$PJOB/t__x"
echo '{"exception_info":null,"verifier_result":{"rewards":{"reward":1}}}' > "$PJOB/t__x/result.json"
job_hit_quota "$PJOB" && q3=1 || q3=0
check "a clean pass is NOT quota" "0" "$q3"

check "the worker stops on quota rather than retrying" "1"   "$(grep -c 'QUOTA EXHAUSTED' "$HERE/run-two-workers.sh")"

echo "== a SECOND zero-token result halts instead of banking a 0 =="
# MEASURED 2026-09-04, re-derived from the whole corpus 2026-09-07: 10 trials
# across five tasks landed as reward 0 with ZERO completion tokens IN PAIRS --
# attempt 1 broke, the zero-token retry fired exactly as designed, and the retry
# broke identically. `job_hit_quota` missed it because that outage surfaced no
# ApiRateLimitError. Accepting the second result marks the task DONE, so the
# resume skips it and the sweep banks a 0 nobody earned.
#
# Cost, over each task's last 6 trials: 81.2/89 expected passes counting these
# as failures vs 83.2/89 excluding runs that never happened -- five tasks are
# imperfect ONLY because of trials that never ran.
#
# FAILS ON THE PRE-CHANGE TREE: the loop fell straight through to `break` on
# attempt 2, so no halt existed and both greps below returned 0.
source <(sed -n '/^job_was_infra_failure() {/,/^}/p' "$HERE/run-two-workers.sh")
ZJOB="$SANDBOX/zerotokjob"; mkdir -p "$ZJOB/t__x"
cat > "$ZJOB/t__x/result.json" <<'JSON'
{"exception_info":{"exception_type":"UnknownApiError","exception_message":"API Error"},
 "agent_result":{"n_input_tokens":0,"n_output_tokens":0}}
JSON
job_was_infra_failure "$ZJOB" && z=1 || z=0
check "a zero-token job is detected as infra" "1" "$z"

# A real capability failure must NOT be read as infra, or the worker would halt
# on an ordinary 0 and the sweep would never finish.
RJOB="$SANDBOX/realfailjob"; mkdir -p "$RJOB/t__x"
cat > "$RJOB/t__x/result.json" <<'JSON'
{"exception_info":null,"agent_result":{"n_input_tokens":90000,"n_output_tokens":4200},
 "verifier_result":{"rewards":{"reward":0}}}
JSON
job_was_infra_failure "$RJOB" && z2=1 || z2=0
check "a graded capability failure is NOT infra" "0" "$z2"

check "the second zero-token attempt halts the worker" "1"   "$(grep -c 'broke around the agent TWICE' "$HERE/run-two-workers.sh")"
# TWO, not one: the quota branch already chose this wording, and the outage
# branch deliberately matches it. Both leave the remaining tasks unmeasured
# rather than failed, which is the property being pinned.
check "both halt paths leave the rest UNMEASURED, not failed" "2"   "$(grep -c 'stay UNMEASURED' "$HERE/run-two-workers.sh")"

echo "== an ORPHANED proxy port is reclaimed, a LIVE one is never touched =="
# FAILS ON THE PRE-CHANGE TREE: reclaim_port did not exist, so the `source`
# below binds nothing and every case errors "command not found".
#
# ⛔ MEASURED 2026-09-04/05: two mcp-auth-proxy processes from a sweep that ended
# ~12 h earlier still held 7425/7426. run-dg.sh correctly REFUSED, which is the
# safe outcome but also a dead stop — the loop could not launch until a human
# killed them. The danger in fixing it is the opposite error: freeing a port a
# live sibling worker is using pulls the brain out from under a running trial
# (run-dg.sh:946). So these cases pin BOTH directions.
source <(sed -n '/^reclaim_port() {/,/^}/p' "$HERE/run-two-workers.sh")
OWNER_DIR="$SANDBOX/owner"; mkdir -p "$OWNER_DIR"
KILLED="$SANDBOX/killed.txt"; : > "$KILLED"
STATE="$SANDBOX/portstate.txt"

# Stubs replace only the four primitives that touch the real OS.
port_listener_pid() { cat "$STATE" 2>/dev/null; }
pid_is_alive()      { [ "$1" = "999001" ]; }            # only 999001 is "running"
pid_is_auth_proxy() { [ "$1" != "555000" ]; }           # 555000 is a stranger
kill_pid()          { echo "$1" >> "$KILLED"; : > "$STATE"; }

# 1. Free port -> claimed, nothing killed.
: > "$STATE"; : > "$KILLED"; rm -f "$OWNER_DIR/.tb-port-owner-7425"
reclaim_port 7425 >/dev/null 2>&1 && r=0 || r=1
check "a free port is claimed" "0" "$r"
check "claim records our own pid" "$$" "$(cat "$OWNER_DIR/.tb-port-owner-7425" | tr -d '[:space:]')"
check "nothing was killed for a free port" "0" "$(wc -l < "$KILLED" | tr -d ' ')"

# 2. Held, and the owning launcher is ALIVE -> refuse, kill NOTHING.
# ⛔ THE DANGEROUS CASE. A sibling sweep owns this port and its trial is running.
echo "777111" > "$STATE"; echo "999001" > "$OWNER_DIR/.tb-port-owner-7425"; : > "$KILLED"
reclaim_port 7425 >/dev/null 2>&1 && r=0 || r=1
check "a LIVE sibling's port is refused" "1" "$r"
check "a LIVE sibling's proxy is NEVER killed" "0" "$(wc -l < "$KILLED" | tr -d ' ')"
check "a LIVE sibling's claim is left intact" "999001" \
  "$(cat "$OWNER_DIR/.tb-port-owner-7425" | tr -d '[:space:]')"

# 3. Held, owner DEAD, holder is a proxy -> orphan, reclaimed.
echo "777111" > "$STATE"; echo "999999" > "$OWNER_DIR/.tb-port-owner-7425"; : > "$KILLED"
reclaim_port 7425 >/dev/null 2>&1 && r=0 || r=1
check "an orphaned proxy port is reclaimed" "0" "$r"
check "the orphan itself was the process killed" "777111" "$(tr -d '\n' < "$KILLED")"
check "the claim passes to us" "$$" "$(cat "$OWNER_DIR/.tb-port-owner-7425" | tr -d '[:space:]')"

# 4. Held by a NON-proxy -> refuse. Never kill an unrelated service that merely
# happens to own the port we want.
echo "555000" > "$STATE"; rm -f "$OWNER_DIR/.tb-port-owner-7425"; : > "$KILLED"
reclaim_port 7425 >/dev/null 2>&1 && r=0 || r=1
check "a stranger's port is refused" "1" "$r"
check "a stranger's process is NEVER killed" "0" "$(wc -l < "$KILLED" | tr -d ' ')"

# 5. Owner file missing but holder IS a proxy -> still an orphan (this is the
# exact 2026-09-04 state: the launcher predated claim files entirely).
echo "777111" > "$STATE"; rm -f "$OWNER_DIR/.tb-port-owner-7425"; : > "$KILLED"
reclaim_port 7425 >/dev/null 2>&1 && r=0 || r=1
check "an unclaimed orphan is reclaimed" "0" "$r"
check "the unclaimed orphan was killed" "777111" "$(tr -d '\n' < "$KILLED")"

echo "== the reclaim runs BEFORE prefixes are registered =="
# A refusal must cost nothing. If prefixes were registered first, an aborted
# launch would leave them in .tb-sweep-prefixes.txt and merge-sweep.sh would
# later look for jobs that never existed.
rc_line=$(grep -n 'reclaim_port "$_port"' "$HERE/run-two-workers.sh" | head -1 | cut -d: -f1)
pf_line=$(grep -n 'Register both prefixes' "$HERE/run-two-workers.sh" | head -1 | cut -d: -f1)
check "reclaim precedes prefix registration" "yes" \
  "$(if [ -n "$rc_line" ] && [ -n "$pf_line" ] && [ "$rc_line" -lt "$pf_line" ]; then echo yes; else echo no; fi)"

echo "== a SINGLE task does not silently half-launch =="
# FAILS ON THE PRE-CHANGE TREE: `declare -a W0 W1` leaves W1 UNSET, so under
# `set -u` worker 1 aborted with "W1: unbound variable" -- while the script
# still exited 0, having already registered a w1 prefix. merge-sweep would then
# look for jobs that never existed. An odd task count is the common case for a
# targeted diagnostic re-run, which is exactly when this fires.
: > "$CALLS"
printf 'solo
' > "$SANDBOX/one.txt"
out1="$(sweep "$SANDBOX/one.txt" 2>&1)"
check "single task still runs" "solo" "$(cut -d'|' -f3 "$CALLS" | tr -d '
')"
check "no unbound-variable abort" "0" "$(printf '%s' "$out1" | grep -c 'unbound variable')"
check "both workers report finishing" "2" "$(printf '%s' "$out1" | grep -c 'worker finished')"


# ── HEADROOM-AWARE TASK SELECTION (TBENCH-HEADROOM-ORDER-1) ──────────────────
#
# ⛔ MEASURED 2026-09-15 00:13 on the live ts09142020 sweep: BOTH workers parked
# in run-dg.sh's credential gate with 70 tasks owed. Worker 0's next task had a
# 3600 s ceiling (gate 90 min) against 84 min of token; worker 1's was
# build-pov-ray, 12000 s (gate 230 min) against 117 min. token-refresh.sh only
# rotates a token that has actually EXPIRED, so each worker sat out the token's
# whole remaining life -- "waiting 5067s" and "waiting 7089s" -- while 48 of the
# 89 tasks have a 900 s ceiling whose gate is max(40, 15+30) = 45 min and would
# have fitted in the very headroom being waited out.
#
# A sandbox task set with REAL task.toml files (a [verifier] section first, so
# the section-aware read is exercised the way the 3.0 layout exercises it).
mk_task() { # <name> <agent timeout_sec>
  mkdir -p "$SANDBOX/tb21/tasks/$1"
  printf '[verifier]\ntimeout_sec = 120.0\n\n[agent]\ntimeout_sec = %s\n' "$2" \
    > "$SANDBOX/tb21/tasks/$1/task.toml"
}
mk_task big 3600.0                                  # gate max(40, 60+30) = 90 min
for t in s1 s2 s3 s4; do mk_task "$t" 900.0; done    # gate max(40, 15+30) = 45 min

HFILE="$SANDBOX/headroom.txt"
LEDGER="$SANDBOX/ledger.txt"
# The alternating deal puts big, s2, s4 on worker 0 -- exactly the measured
# shape: a 3600 s task at the head of a list whose other members are 900 s.
printf 'big s1 s2 s3 s4\n' > "$SANDBOX/headroom-tasks.txt"

echo "== a task whose gate exceeds the headroom is DEFERRED, not waited out =="
# ⛔ FAILS ON THE PRE-CHANGE TREE: the worker dealt strictly by position
# (`for i in "${!tasks[@]}"`), so worker 0's order was big, s2, s4 -- the long
# task first, which is the park. Both order checks and both announcement checks
# below read the pre-change values (big s2 s4, and zero announcements).
: > "$CALLS"; : > "$HOOKS"; : > "$LEDGER"
rm -rf "$TB/jobs"; rm -f "$SANDBOX/mcp-data/logs/"*.log
printf '84' > "$HFILE"
sweep "$SANDBOX/headroom-tasks.txt" \
      TB21_DIR="$SANDBOX/tb21" \
      TB_HEADROOM_MIN_OVERRIDE="$HFILE" \
      STUB_LEDGER_LOG="$LEDGER" \
      STUB_BUMP_AFTER=s4 STUB_BUMP_TO=200 >"$SANDBOX/headroom.log" 2>&1
check "the sweep still finishes clean" "0" "$?"
# THE PROPERTY: the 3600 s task runs LAST, once the rotation made it fit -- and
# it is not dropped, which is the failure a naive skip would introduce.
check "worker 0 ran the fitting tasks first, the long one last" "s2 s4 big" \
  "$(grep '|7425|' "$CALLS" | cut -d'|' -f3 | tr '\n' ' ' | sed 's/ $//')"
check "worker 1, whose head always fitted, is untouched" "s1 s3" \
  "$(grep '|7426|' "$CALLS" | cut -d'|' -f3 | tr '\n' ' ' | sed 's/ $//')"
check "every task still ran exactly once" "5" "$(wc -l < "$CALLS" | tr -d ' ')"
# ONE LINE PER REORDER, naming both tasks and both gates, so an operator can see
# why the order they launched is not the order they are reading.
check "the reorder is announced for s2" "1" \
  "$(grep -c 'headroom 84 min < gate 90 min for big; running s2 (gate 45 min) first' "$SANDBOX/headroom.log")"
check "the reorder is announced for s4" "1" \
  "$(grep -c 'headroom 84 min < gate 90 min for big; running s4 (gate 45 min) first' "$SANDBOX/headroom.log")"
check "nothing is announced once the long task fits" "2" \
  "$(grep -c 'headroom .* min < gate .* min for ' "$SANDBOX/headroom.log")"

echo "== the .remaining ledger and the [sweep] task line follow the REAL task =="
# ⛔ FAILS ON THE PRE-CHANGE TREE for the same reason: with positional dealing
# the ledger snapshots read big:"big s2 s4", s2:"s2 s4", s4:"s4". What is pinned
# is that a DEFERRED task stays owed (big is still in the ledger while s2 and s4
# run) and a RUN task leaves it, whatever order they ran in.
check "the ledger tracks the task actually run, not its position" \
  "s2:big s2 s4|s4:big s4|big:big" \
  "$(grep 'w0 ' "$LEDGER" | sed 's/^[^ ]* //; s/: /:/' | tr '\n' '|' | sed 's/|$//')"
check "the [sweep] task line names the task actually run, in order" "s2 s4 big" \
  "$(sed -n 's/^\[sweep\]   task \([^ ]*\) (worker 0.*/\1/p' "$SANDBOX/mcp-data/logs/tbench-par0.log" \
     | tr '\n' ' ' | sed 's/ $//')"
check "the worker still cleaned its ledger at the end" "0" \
  "$(ls "$TB"/jobs/*.remaining 2>/dev/null | wc -l | tr -d ' ')"

echo "== headroom below EVERY gate falls through to the existing park =="
# ⛔ The fix must not invent a third behaviour. When nothing in the list fits,
# waiting for the rotation IS the work and run-dg.sh's own ladder is what does
# it -- so the driver must still be handed the ORIGINAL head task. These pin the
# UNCHANGED path, so a later reorder cannot quietly grow into a skip.
: > "$CALLS"; : > "$HOOKS"
rm -rf "$TB/jobs"
sweep "$SANDBOX/headroom-tasks.txt" \
      TB21_DIR="$SANDBOX/tb21" \
      TB_HEADROOM_MIN_OVERRIDE=10 >"$SANDBOX/headroom-low.log" 2>&1
check "the sweep still finishes clean" "0" "$?"
check "the ORIGINAL head task is what run-dg is handed" "big" \
  "$(grep -m1 '|7425|' "$CALLS" | cut -d'|' -f3)"
check "worker 0 keeps the original order" "big s2 s4" \
  "$(grep '|7425|' "$CALLS" | cut -d'|' -f3 | tr '\n' ' ' | sed 's/ $//')"
check "nothing is announced when nothing fits" "0" \
  "$(grep -c 'headroom .* min < gate .* min for ' "$SANDBOX/headroom-low.log")"
check "no task is dropped when nothing fits" "5" "$(wc -l < "$CALLS" | tr -d ' ')"

echo "== an UNREADABLE headroom reorders nothing =="
# A sweep on a long-lived token (TB_TOKEN_STATIC=1) is not gated on
# .credentials.json at all, so reordering against it would act on a constraint
# that does not exist. Same for a host with no credential to read.
: > "$CALLS"; : > "$HOOKS"
rm -rf "$TB/jobs"
sweep "$SANDBOX/headroom-tasks.txt" \
      TB21_DIR="$SANDBOX/tb21" TB_TOKEN_STATIC=1 >"$SANDBOX/headroom-static.log" 2>&1
check "a static-token sweep keeps the original order" "big s2 s4" \
  "$(grep '|7425|' "$CALLS" | cut -d'|' -f3 | tr '\n' ' ' | sed 's/ $//')"
check "a static-token sweep announces no reorder" "0" \
  "$(grep -c 'headroom .* min < gate .* min for ' "$SANDBOX/headroom-static.log")"

echo "== the per-task ceiling IS run-dg.sh's own derivation, task for task =="
# ⛔ FAILS ON THE PRE-CHANGE TREE: `_task_ceiling_s` did not exist, so the
# `source` below binds nothing, every call errors "command not found" and every
# comparison is an empty string against run-dg.sh's 900 / 3600 / 7200.
#
# NOT A REIMPLEMENTATION COMPARED TO ITSELF: run-dg.sh's OWN lines are located
# by their anchors and eval'd, so this compares two executions rather than two
# hand-written literals (reference_tests_that_cannot_fail_include_str).
source <(sed -n '/^_task_ceiling_s() {/,/^}/p' "$HERE/run-two-workers.sh" | tr -d '\r')
source <(sed -n '/^_task_gate_min() {/,/^}/p' "$HERE/run-two-workers.sh" | tr -d '\r')
declare -A _GATE_MIN_CACHE=()
# The gate formula token-refresh.sh applies, on the ceilings just derived: a
# 900 s task must gate at 45, not at the 40-minute floor that admitted a
# 47-minute token to a 7200 s task on 2026-09-13.
check "a 900 s task gates at 45 min, not the 40 min floor" "45" \
  "$(TB21_DIR="$SANDBOX/tb21" _task_gate_min s1)"
check "a 3600 s task gates at 90 min" "90" \
  "$(TB21_DIR="$SANDBOX/tb21" _task_gate_min big)"
check "an unknown task falls back to the 40 min floor" "40" \
  "$(TB21_DIR="$SANDBOX/tb21" _task_gate_min no-such-task-anywhere)"

TB21_DIR="${TB21_DIR:-/d/Git/terminal-bench-2-1}"
if [ ! -d "$TB21_DIR/tasks" ]; then
  echo "  SKIP no local task set at $TB21_DIR/tasks — nothing to compare against"
else
  _s=$(grep -nF '_first_task="${_first_task#*/}"' "$HERE/run-dg.sh" | head -1 | cut -d: -f1)
  _e=$(grep -nF '_sec="${_sec%%.*}"' "$HERE/run-dg.sh" | head -1 | cut -d: -f1)
  check "run-dg.sh's own ceiling block was located" "yes" \
    "$(if [ -n "$_s" ] && [ -n "$_e" ] && [ "$_e" -gt "$_s" ]; then echo yes; else echo no; fi)"
  # The extracted region opens `if [ -n "$_first_task" ] ...; then` whose `fi`
  # sits below the range, so the closer is supplied here. Nothing else is added.
  RUNDG_BLOCK="$(sed -n "${_s},${_e}p" "$HERE/run-dg.sh" | tr -d '\r')
fi"
  rundg_ceiling() { # <task> -> what run-dg.sh's own bytes compute
    local _first_task="$1" _task_toml="" _sec=""
    eval "$RUNDG_BLOCK"
    printf '%s' "$_sec"
  }
  mismatch=0; compared=0; blank=0; firstbad=""
  : > "$SANDBOX/ceilings.txt"
  for _d in "$TB21_DIR"/tasks/*/; do
    _t="$(basename "$_d")"
    [ -f "$_d/task.toml" ] || continue
    compared=$((compared+1))
    _a="$(_task_ceiling_s "$_t")"; _b="$(rundg_ceiling "$_t")"
    [ -n "$_a" ] || blank=$((blank+1))
    printf '%s\n' "$_a" >> "$SANDBOX/ceilings.txt"
    if [ "$_a" != "$_b" ]; then
      mismatch=$((mismatch+1))
      [ -n "$firstbad" ] || firstbad="$_t ours=[$_a] run-dg=[$_b]"
    fi
  done
  check "the real task set was actually compared" "yes" \
    "$(if [ "$compared" -ge 80 ]; then echo yes; else echo "no ($compared tasks)"; fi)"
  check "ceiling matches run-dg.sh on all $compared local tasks" "0" \
    "$mismatch${firstbad:+ ($firstbad)}"
  # ⛔ TWO BLANKS ARE ALSO EQUAL. A derivation that returned nothing for every
  # task would pass the equality above while telling the scheduler nothing --
  # the fixture-not-the-assertion shape. So the values themselves are pinned:
  # every task must yield a number, and the set must hold the real spread
  # (900 s is 48 of the 89; 3600 s and longer exist).
  check "no task derived a blank ceiling" "0" "$blank"
  check "the ceilings carry a real spread, not one constant" "yes" \
    "$(if [ "$(sort -u "$SANDBOX/ceilings.txt" | grep -c .)" -ge 3 ]; then echo yes; else echo no; fi)"
  check "the 900 s majority is present" "yes" \
    "$(if [ "$(grep -cx 900 "$SANDBOX/ceilings.txt")" -ge 20 ]; then echo yes; else echo no; fi)"
fi


echo
if [ "$fails" -eq 0 ]; then echo "two-workers.test.sh: ALL PASS"; else echo "two-workers.test.sh: $fails FAILURE(S)"; fi
exit "$fails"
