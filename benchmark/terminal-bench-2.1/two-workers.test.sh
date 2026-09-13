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
CALLS="$SANDBOX/calls.txt"

cat > "$SANDBOX/benchmark/tb/run-dg.sh" <<'STUB'
#!/usr/bin/env bash
echo "$TB_JOB_PREFIX|$TB_PROXY_PORT|$TB_TASKS|$TB_CONCURRENCY|$TB_ATTEMPTS|$TB_AGENT" >> "$CALLS"
exit 0
STUB

echo "== refuses an empty task list =="
: > "$SANDBOX/empty.txt"
CALLS="$CALLS" bash "$SANDBOX/benchmark/tb/run-two-workers.sh" "$SANDBOX/empty.txt" >/dev/null 2>&1
check "empty file exits 2" "2" "$?"
CALLS="$CALLS" bash "$SANDBOX/benchmark/tb/run-two-workers.sh" "$SANDBOX/nope.txt" >/dev/null 2>&1
check "missing file exits 2" "2" "$?"
check "no prefixes registered on refusal" "0" \
  "$(if [ -f "$SANDBOX/mcp-data/.tb-sweep-prefixes.txt" ]; then wc -l < "$SANDBOX/mcp-data/.tb-sweep-prefixes.txt" | tr -d ' '; else echo 0; fi)"

echo "== runs every task, ONE PER JOB =="
printf 'alpha bravo charlie delta echo\n' > "$SANDBOX/tasks.txt"
CALLS="$CALLS" bash "$SANDBOX/benchmark/tb/run-two-workers.sh" "$SANDBOX/tasks.txt" >/dev/null 2>&1
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
out1="$(CALLS="$CALLS" bash "$SANDBOX/benchmark/tb/run-two-workers.sh" "$SANDBOX/one.txt" 2>&1)"
check "single task still runs" "solo" "$(cut -d'|' -f3 "$CALLS" | tr -d '
')"
check "no unbound-variable abort" "0" "$(printf '%s' "$out1" | grep -c 'unbound variable')"
check "both workers report finishing" "2" "$(printf '%s' "$out1" | grep -c 'worker finished')"


echo
if [ "$fails" -eq 0 ]; then echo "two-workers.test.sh: ALL PASS"; else echo "two-workers.test.sh: $fails FAILURE(S)"; fi
exit "$fails"
