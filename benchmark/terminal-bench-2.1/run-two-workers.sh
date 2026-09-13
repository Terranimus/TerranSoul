#!/usr/bin/env bash
# run-two-workers.sh — run a task list across TWO workers with ATTRIBUTABLE logs.
#
#   usage: bash run-two-workers.sh <tasks-file>      # one task per line, or space-separated
#
# ⛔ WHY THIS EXISTS, AND WHY IT IS NOT JUST `TB_CONCURRENCY=2`.
#
# Running one `run-dg.sh` with TB_CONCURRENCY=2 gives ONE proxy, ONE log and ONE
# `TRIAL_SCOPE` shared by every trial in the job. Two things break:
#
#   1. CREDIT. `run-dg.sh` hands that job-wide log to `credit-trial-outcome.mjs`
#      for every trial, so each trial credited its graded reward to every memory
#      served to ANY trial in the batch. MEASURED across three 10-task batches:
#      30 distinct ids attributed to each of 10 trials — 300 credit operations,
#      at most 30 of them right. In a mixed batch one failure debits the whole
#      job's memories, and `confidence_buckets` needs `failure_count == 0` for
#      the clean-success bucket, so a single loss evicts them all.
#
#   2. THE VERIFICATION LEDGER, keyed on (session_id, root). `TRIAL_SCOPE` is
#      job-wide and `root` is always /app, so every trial in the job shares one
#      ledger: trial B's recorded evidence answers trial A's stop-time `status`,
#      and B's `mark_edited` stales A's proof.
#
# THE PEER ADDRESS CANNOT FIX EITHER. Two containers on two separate compose
# networks reaching the host through `host.docker.internal` BOTH arrive as
# 127.0.0.1 — Docker Desktop NATs every container to loopback (measured with two
# throwaway containers, 2026-09-03). There is no offline way to split concurrent
# trials sharing one proxy.
#
# So the fix is the RUN SHAPE: one job per task, two workers on separate proxy
# ports. Each job gets its own proxy, its own log and its own `TRIAL_SCOPE`, and
# every log holds exactly one trial — attribution is then exact by construction
# rather than inferred. `run-dg.sh` already names the principle: "the proxy port
# is already unique per worker (7425+w), so it is the natural discriminator."
#
# Throughput is unchanged: still two containers at a time, which is the standing
# limit (two workers, never three). The cost is one proxy start-up and preflight
# per task instead of per batch.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

TASKS_FILE="${1:-}"
if [ -z "$TASKS_FILE" ] || [ ! -f "$TASKS_FILE" ]; then
  echo "usage: bash run-two-workers.sh <tasks-file>" >&2
  exit 2
fi

# Accept either one-per-line or space-separated; `read -ra` on the whole file
# handles both and drops blank lines.
read -ra ALL_TASKS <<< "$(tr '\n' ' ' < "$TASKS_FILE")"
if [ "${#ALL_TASKS[@]}" -eq 0 ]; then
  echo "[2w] REFUSING: no tasks in $TASKS_FILE" >&2
  exit 2
fi

STAMP="$(date +%m%d%H%M)"

# --- reclaiming a port from an ORPHANED proxy ---------------------------------
#
# ⛔ MEASURED 2026-09-04/05. Two `mcp-auth-proxy.mjs` processes from a sweep that
# ended ~12 hours earlier were still LISTENING on 7425 and 7426. run-dg.sh's
# guard is correct and fires (it asks whether OUR child is alive, not whether the
# socket answers), so nothing silently ran against a stale proxy — but every
# subsequent launch then exits 2 and the loop stops until a human kills them by
# hand. A harness that cannot recover from its own crash debris is a harness that
# gives up on iteration 1.
#
# The proxies were orphaned because the EXIT trap that kills them does not run on
# SIGKILL or on a closed terminal. That cannot be prevented from inside; it has
# to be recovered from at the next start.
#
# ⛔ WHY THIS IS NOT `npx kill-port 7425`. Blindly freeing the port is the more
# dangerous bug. run-dg.sh:946 records what happens when one worker tears down a
# proxy another worker is using: "brain access disappears mid-task", and the
# victim keeps running and reports a result. So reclamation must distinguish an
# orphan from a live sibling, and it refuses whenever it cannot:
#
#   * port free                        -> claim it
#   * held, owning launcher ALIVE      -> REFUSE (a sibling sweep owns it)
#   * held, owner dead/unknown, and the
#     holder IS an mcp-auth-proxy      -> orphan, reclaim
#   * held by anything else            -> REFUSE (never kill a stranger's process
#                                         that merely happens to want this port)
#
# The claim is this launcher's own pid, so "is the owner alive" is answerable
# after a crash without any cooperation from the dead process.
OWNER_DIR="$REPO/mcp-data"

port_listener_pid() { # <port> -> pid on stdout, empty if free
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
  else
    # Windows netstat. Match the LOCAL address column ending in :<port> so that
    # :74250 or a remote port never matches, and take LISTENING rows only.
    netstat -ano 2>/dev/null | tr -d '\r' \
      | awk -v suf=":$port" '$1=="TCP" && $4=="LISTENING" && index($2, suf) == length($2)-length(suf)+1 {print $5; exit}'
  fi
}

pid_is_alive() { # <pid>
  local pid="$1"; [ -n "$pid" ] || return 1
  if command -v tasklist >/dev/null 2>&1; then
    tasklist //FI "PID eq $pid" //NH 2>/dev/null | grep -qE "[[:space:]]$pid[[:space:]]"
  else
    kill -0 "$pid" 2>/dev/null
  fi
}

pid_is_auth_proxy() { # <pid> — identity gate before any kill
  local pid="$1"; [ -n "$pid" ] || return 1
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'mcp-auth-proxy'
  elif command -v wmic >/dev/null 2>&1; then
    wmic process where "ProcessId=$pid" get CommandLine 2>/dev/null | tr -d '\r' | grep -q 'mcp-auth-proxy'
  else
    return 1
  fi
}

kill_pid() { # <pid>
  local pid="$1"
  if command -v taskkill >/dev/null 2>&1; then taskkill //PID "$pid" //F >/dev/null 2>&1
  else kill -9 "$pid" 2>/dev/null; fi
}

reclaim_port() { # <port> -> 0 if the port is ours to use, 1 if we must refuse
  local port="$1"
  # NOT one `local port=... owner_file=...$port` statement: under `set -u`
  # bash expands every initializer in the statement before any of them is
  # assigned, so $port is still unbound and the whole launcher dies with
  # "port: unbound variable" before a single trial runs.
  local owner_file="$OWNER_DIR/.tb-port-owner-$port"
  local pid owner
  pid="$(port_listener_pid "$port")"
  if [ -z "$pid" ]; then printf '%s\n' "$$" > "$owner_file"; return 0; fi

  owner="$(cat "$owner_file" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$owner" ] && [ "$owner" != "$$" ] && pid_is_alive "$owner"; then
    echo "[2w] REFUSING: :$port is held and its owning launcher (pid $owner) is STILL ALIVE." >&2
    echo "[2w] Another sweep is running. One bench at a time is the standing limit, and" >&2
    echo "[2w] freeing this port would pull the brain out from under a live trial." >&2
    return 1
  fi

  if ! pid_is_auth_proxy "$pid"; then
    echo "[2w] REFUSING: :$port is held by pid $pid, which is NOT an mcp-auth-proxy." >&2
    echo "[2w] Some unrelated service owns this port. Refusing to kill it; change ports" >&2
    echo "[2w] or stop that service deliberately." >&2
    return 1
  fi

  echo "[2w] :$port held by an ORPHANED proxy (pid $pid, owning launcher ${owner:-unknown} is gone) — reclaiming."
  kill_pid "$pid"
  local i
  for i in $(seq 1 20); do
    [ -z "$(port_listener_pid "$port")" ] && break
    sleep 0.25
  done
  if [ -n "$(port_listener_pid "$port")" ]; then
    echo "[2w] REFUSING: :$port is STILL held after killing pid $pid." >&2
    return 1
  fi
  printf '%s\n' "$$" > "$owner_file"
  return 0
}

# Drop our own claims on the way out. Guarded on the pid so a crashed-and-
# restarted launcher never deletes the claim of whoever holds the port now.
_release_port_claims() {
  local port f
  for port in 7425 7426; do
    f="$OWNER_DIR/.tb-port-owner-$port"
    [ "$(cat "$f" 2>/dev/null | tr -d '[:space:]')" = "$$" ] && rm -f "$f"
  done
  return 0
}

# One worker per proxy port. Tasks are dealt ALTERNATELY rather than split down
# the middle so a run of slow tasks cannot land entirely on one worker and leave
# the other idle for the second half of the sweep.
# Declared EMPTY, not merely declared. `declare -a W0 W1` leaves them UNSET,
# and under `set -u` the expansion "${W1[@]}" of an unset array aborts the
# subshell. With an ODD single task W1 gets no entries, so worker 1 died with
# "W1: unbound variable" while the script still exited 0 -- having already
# registered a w1 prefix that merge-sweep would then hunt for jobs that never
# existed. A silent half-launch is worse than a loud refusal.
declare -a W0=() W1=()
for i in "${!ALL_TASKS[@]}"; do
  if [ $((i % 2)) -eq 0 ]; then W0+=("${ALL_TASKS[$i]}"); else W1+=("${ALL_TASKS[$i]}"); fi
done

echo "[2w] ${#ALL_TASKS[@]} task(s): worker0=${#W0[@]} on :7425, worker1=${#W1[@]} on :7426"

# Scope the agent install cache to THIS launch. terransoul_hook.py restores a
# cached ~/.local before the stock install, which short-circuits harbor's
# 297 MB per-trial download; keying it to the launch stamp means the first
# trial pays the download and the rest reuse it, while a later launch starts
# clean. Unset, the hook falls back to a per-DAY key, which is looser than
# this but still bounded.
#
# ⛔ THE STALENESS THIS BOUNDS IS A MEASUREMENT PROBLEM, NOT A DISK ONE.
# With no version pinned, harbor only checks that `claude` EXISTS, so a
# permanent cache would freeze whatever build it first captured and the
# campaign would quietly stop measuring the agent it claims to measure.
# Respect a value the caller already set: a sweep stopped by a quota cap and
# resumed later is ONE sweep, and should reuse its cache rather than paying
# the download again.
export TB_AGENT_CACHE_ID="${TB_AGENT_CACHE_ID:-$STAMP}"

# Reclaim both ports BEFORE anything else happens. Placed above the prefix
# registration deliberately: a refusal here must cost nothing -- no proxy
# started, no prefix registered, no container created, nothing to unwind.
trap _release_port_claims EXIT
for _port in 7425 7426; do
  reclaim_port "$_port" || { echo "[2w] aborting before any trial ran." >&2; exit 2; }
done

# Register both prefixes with the merge NOW, not at the end. A prefix that is
# only appended on success is invisible to `merge-sweep.sh` when a worker dies
# mid-run, and the whole worker's results silently vanish from the total — the
# failure that hid 60 trials from an earlier merge.
for p in "ts${STAMP}w0" "ts${STAMP}w1"; do
  echo "$p" >> "$REPO/mcp-data/.tb-sweep-prefixes.txt"
done
sort -u -o "$REPO/mcp-data/.tb-sweep-prefixes.txt" "$REPO/mcp-data/.tb-sweep-prefixes.txt"

# Did the job just written for THIS worker break around the agent rather than
# fail on the task?
#
# ⛔ THE DISTINCTION IS MEASURED, NOT GUESSED, and run-sweep.sh already acts on
# it: `UnknownApiError` / `AgentSetupTimeoutError` mean the run broke and a
# retry recovers, while `AgentTimeoutError` means the AGENT ran out of time —
# a legitimate 0.0 that reproduces (caffe-cifar-10 went 42m -> 1h06 -> 1h02,
# never once succeeding, so retrying it buys nothing but hours).
#
# ZERO TOKENS overrides the error name, because it is the more general signal:
# a trial that consumed no tokens never got its turn at all. MEASURED
# 2026-09-04 on rstan-to-pystan — an API 529 surfaced as a shell exit 1 with
# n_input_tokens 0 / n_output_tokens 0, and reading that as a capability
# failure would be exactly the mistake
# `reference_run_that_never_happened_is_not_a_failure` records.
#
# Retrying a run that never happened is NOT a second attempt at the task, so it
# does not turn k=1 into best-of-N. Retrying a graded failure would, which is
# why only this class is retried and the bound is one.
job_was_infra_failure() {
  local job_dir="$1"
  [ -n "$job_dir" ] && [ -d "$job_dir" ] || return 1
  python -c "
import json,glob,os,sys
RETRYABLE={'UnknownApiError','AgentSetupTimeoutError'}
for p in glob.glob(os.path.join(sys.argv[1],'*','result.json')):
    try:
        d=json.load(open(p))
    except Exception:
        continue
    a=d.get('agent_result') or {}
    never_ran=(a.get('n_input_tokens') or 0)==0 and (a.get('n_output_tokens') or 0)==0
    exc=((d.get('exception_info') or {}).get('exception_type'))
    if exc and (never_ran or exc in RETRYABLE):
        sys.exit(0)
sys.exit(1)
" "$job_dir" 2>/dev/null
}

# Is the newest job's failure a QUOTA exhaustion rather than a transient fault?
#
# ⛔ RETRYING A QUOTA IS GUARANTEED TO FAIL, AND IT BURNS THE ONE RETRY.
#
# MEASURED 2026-09-04. Six tasks died with `ApiRateLimitError`, zero tokens,
# and the body carried:
#     api_error_status: 429
#     "You've hit your session limit - resets 4:50am (UTC)"
# The retry above fired on all six -- correctly, by the zero-token rule -- and
# every retry hit the same wall roughly 13 minutes later:
#     00:48 polyglot-rust-c 429   ->  01:01 polyglot-rust-c 429
#     00:50 regex-chess     429   ->  01:00 regex-chess     429
#     01:13 protein-assembly 429  ->  01:28 protein-assembly 429
#
# A transient network fault clears on its own; a SESSION CAP clears at a fixed
# wall-clock time. Treating them alike spends the retry when it cannot possibly
# help and then marks the task failed. The two need different handling, and
# only the caller can wait hours -- so this reports the condition and the
# worker stops rather than pretending a retry is available.
job_hit_quota() {
  local job_dir="$1"
  [ -n "$job_dir" ] && [ -d "$job_dir" ] || return 1
  python -c "
import json,glob,os,sys
for p in glob.glob(os.path.join(sys.argv[1],'*','result.json')):
    try:
        d=json.load(open(p))
    except Exception:
        continue
    info=d.get('exception_info') or {}
    exc=info.get('exception_type') or ''
    msg=info.get('exception_message') or ''
    # No double quote anywhere in this literal: it sits inside a bash
    # double-quoted `python -c "..."`, and an escaped quote here closed the
    # shell string early -- a syntax error 50 lines further down.
    if exc=='ApiRateLimitError' or 'session limit' in msg or 'rate_limit' in msg:
        sys.exit(0)
sys.exit(1)
" "$job_dir" 2>/dev/null
}

run_worker() {
  local port="$1" prefix="$2"; shift 2
  local t attempt job_dir
  for t in "$@"; do
    for attempt in 1 2; do
      echo "[2w:$prefix] --> $t (attempt $attempt)"
      # ONE TASK PER JOB. This is the whole point: one job = one proxy = one log
      # = one TRIAL_SCOPE = one trial.
      #
      # TB_STOP_HOOK=1 IS NOT OPTIONAL HERE. run-dg.sh defaults it to 0, so
      # every trial of the previous campaign ran with the Stop hook and the
      # wall-clock guards absent while still reporting the TerranSoul identity.
      # Setting it explicitly is what makes this launcher measure the whole
      # stack; run-dg.sh now refuses an UNSET value for this agent, so the
      # omission cannot recur silently.
      #
      # `|| true` because a single task's non-zero exit must not abandon the
      # rest of the list. The exit code is not the verdict anyway — the reward
      # is read from result.json, per the playbook.
      TB_AGENT="terransoul_hook:TerranSoulHook" \
      TB_TASKS="$t" \
      TB_CONCURRENCY=1 \
      TB_ATTEMPTS=1 \
      TB_STOP_HOOK=1 \
      TB_PROXY_PORT="$port" \
      TB_JOB_PREFIX="$prefix" \
      TB_PROXY_MODE=learn \
        bash "$HERE/run-dg.sh" "" || true

      # The newest job this worker's prefix produced. Scoped to the prefix so
      # the OTHER worker's concurrent job is never inspected.
      job_dir="$(ls -1dt "$HERE/jobs/$prefix"-*/ 2>/dev/null | head -1)"
      # QUOTA FIRST. It is a subset of the zero-token condition below, and
      # retrying it cannot succeed -- so it must be tested before the retry.
      if job_hit_quota "$job_dir"; then
        echo "[2w:$prefix] QUOTA EXHAUSTED on $t — the account session limit is spent." >&2
        echo "[2w:$prefix] Retrying now cannot succeed: a session cap clears at a fixed" >&2
        echo "[2w:$prefix] wall-clock time, not after a delay. STOPPING this worker so the" >&2
        echo "[2w:$prefix] remaining tasks stay UNMEASURED rather than being marked failed." >&2
        echo "[2w:$prefix] Re-run the remaining list after the reset." >&2
        return 3
      fi
      if [ "$attempt" -eq 1 ] && job_was_infra_failure "$job_dir"; then
        echo "[2w:$prefix] $t broke around the agent (zero-token / transient) — retrying ONCE"
        continue
      fi
      # ⛔ TWICE IN A ROW IS NOT TRANSIENT — IT IS AN OUTAGE.
      #
      # MEASURED 2026-09-04 and re-derived from the corpus 2026-09-07: 10 trials
      # across five tasks (polyglot-rust-c, protein-assembly, regex-chess,
      # reshard-c4-data, sam-cell-seg) landed as reward 0 with ZERO completion
      # tokens, IN PAIRS — attempt 1 broke, this retry fired exactly as designed,
      # and the retry broke the same way. The account session was spent, and
      # `job_hit_quota` above did not catch it because that outage never
      # surfaced an ApiRateLimitError; it just returned nothing.
      #
      # The retry is therefore not wrong, it is INSUFFICIENT: a spent session
      # clears at a fixed wall-clock time, not after a delay (the same reasoning
      # the quota branch above already acts on). Accepting the second zero-token
      # result marks the task DONE, so the resume skips it and the sweep records
      # a 0 the agent never earned.
      #
      # COST, measured over the last 6 trials per task: counting these as
      # failures puts expected k=1 passes at 81.2/89 (91.2%) with 21 imperfect
      # tasks; excluding runs that never happened it is 83.2/89 (93.4%) with 16.
      # Five tasks are imperfect ONLY because of trials that never ran.
      #
      # Halting leaves them UNMEASURED rather than failed, which is the honest
      # state and the one the quota branch already chose. It is NOT an exclusion
      # rule: nothing already scored is dropped, and a re-run still has to earn
      # its reward.
      if job_was_infra_failure "$job_dir"; then
        echo "[2w:$prefix] $t broke around the agent TWICE (zero-token on both attempts)." >&2
        echo "[2w:$prefix] That is an outage, not a transient fault — a retry cannot fix it." >&2
        echo "[2w:$prefix] STOPPING this worker so the remaining tasks stay UNMEASURED" >&2
        echo "[2w:$prefix] rather than being recorded as failures nobody earned." >&2
        echo "[2w:$prefix] Re-run the remaining list once the account/session recovers." >&2
        return 3
      fi
      break
    done
  done
  echo "[2w:$prefix] worker finished"
}

run_worker 7425 "ts${STAMP}w0" "${W0[@]}" &
PID0=$!
run_worker 7426 "ts${STAMP}w1" "${W1[@]}" &
PID1=$!

wait "$PID0" "$PID1"
echo "[2w] both workers finished — merge with: bash merge-sweep.sh jobs ts${STAMP}w0 && bash merge-sweep.sh jobs ts${STAMP}w1"
