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

# The stamp is INHERITED when a launcher supplies one. launch-sweep-detached.sh
# announces the job-prefix pair before this script has started, and the operator
# greps for exactly those prefixes; deriving a second stamp here would make that
# announcement wrong whenever the launch crosses a minute boundary.
STAMP="${TB_SWEEP_STAMP:-$(date +%m%d%H%M)}"
P0="ts${STAMP}w0"
P1="ts${STAMP}w1"
LOGS="$REPO/mcp-data/logs"
JOBS_ROOT="${TB_JOBS_DIR:-$HERE/jobs}"
HALT_FILE="$REPO/mcp-data/.tb-sweep-halt-$STAMP"
SWEEP_LOCK="${TB_LOCK_FILE:-$REPO/mcp-data/.tb-sweep.lock}"
mkdir -p "$LOGS" "$JOBS_ROOT" "$REPO/mcp-data"
rm -f "$HALT_FILE"

# ── NON-INDEPENDENCE, DISCLOSED ONCE, AT THE TOP ─────────────────────────────
# TB_REFUTE_WATCH defaults to 1 and the online audit is wanted, but that means a
# recount applied after one trial changes what LATER trials of the same task are
# served. run-dg.sh says this per trial, where it scrolls past; a 20-40 h sweep
# needs it said once where the operator reads it, because it is a property of
# the NUMBER this run produces.
echo "[2w] NOT INDEPENDENT: TB_REFUTE_WATCH=${TB_REFUTE_WATCH:-1} (online refutation watch is ON)."
echo "[2w] A recount applied after one trial changes what later trials of the same task"
echo "[2w] are served, and cross-trial learning is on by design in learn mode. Label any"
echo "[2w] published number. TB_REFUTE_WATCH=observe records without writing; 0 disables."

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

# A WORKER'S PID IS AN MSYS PID, AND taskkill CANNOT SEE IT.
# `ps -W` prints both: column 1 is the msys pid (what `kill` and the
# `.tb-par<w>.lock` watchdog protocol use) and column 4 is the WINPID (what
# taskkill, and therefore any kill that must reach a native python/docker child,
# needs). Confusing the two is how a "kill the sibling" ends up killing nothing
# and leaking its containers.
_msys_pid_alive() { # <msys pid>
  local pid="$1"; [ -n "$pid" ] || return 1
  ps -W 2>/dev/null | awk -v p="$pid" '$1==p{f=1} END{exit !f}'
}
_msys_to_winpid() { # <msys pid> -> WINPID on stdout
  local pid="$1"; [ -n "$pid" ] || return 0
  ps -W 2>/dev/null | awk -v p="$pid" '$1==p{print $4; exit}'
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

# ── THE SWEEP LOCK, WHICH THIS LAUNCHER NEVER TOOK ───────────────────────────
#
# ⛔ `.tb-sweep.lock` is the interlock redo-task.sh and launch-detached.sh both
# check before starting ("Two runs fight over proxy port 7425 and both die").
# Only run-sweep*.sh ever WROTE it. So a redo launched during a two-worker sweep
# saw no lock, started on the default port 7425, and collided with worker 0 —
# the exact hazard the lock exists to prevent, unguarded for the one launcher
# that runs for 40 hours. The protocol is the file's PID, tested for liveness
# with `ps -W`, exactly as the readers test it.
_take_sweep_lock() {
  if [ -f "$SWEEP_LOCK" ]; then
    local pid
    pid="$(cat "$SWEEP_LOCK" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$pid" ] && [ "$pid" != "$$" ] && _msys_pid_alive "$pid"; then
      echo "[2w] REFUSING: a sweep or redo is already running as pid $pid (lock: $SWEEP_LOCK)." >&2
      echo "[2w] One bench at a time is the standing limit. Stop it, or wait for it." >&2
      return 1
    fi
    echo "[2w] stale sweep lock for dead pid ${pid:-?} — clearing"
  fi
  printf '%s\n' "$$" > "$SWEEP_LOCK"
  return 0
}
_release_sweep_lock() {
  [ "$(cat "$SWEEP_LOCK" 2>/dev/null | tr -d '[:space:]')" = "$$" ] && rm -f "$SWEEP_LOCK"
  return 0
}

# The bench brain exists only for the duration of a bench and is torn down after
# it (the standing one-MCP rule), so the teardown belongs on the EXIT path where
# it also covers the halt branches — not at the bottom of the happy path.
_stop_bench_brain() {
  [ "${TB_BENCH_BRAIN_STARTED:-0}" = "1" ] || return 0
  bash "$BENCH_BRAIN_STOP" 2>&1 | sed 's/^/[2w] /' || true
  return 0
}

_sweep_cleanup() {
  _stop_bench_brain
  _release_sweep_lock
  _release_port_claims
  [ -n "${DRIVER:-}" ] && rm -f "$DRIVER"
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

# Overridable so the regression tests can stand a recording stub in for each
# one and assert it was really invoked. Production never sets them.
PREFLIGHT_CMD="${TB_PREFLIGHT_CMD:-$HERE/preflight-sweep.sh}"
BENCH_BRAIN_START="${TB_BENCH_BRAIN_START_CMD:-$HERE/start-bench-brain.sh}"
BENCH_BRAIN_STOP="${TB_BENCH_BRAIN_STOP_CMD:-$HERE/stop-bench-brain.sh}"

# Reclaim both ports BEFORE anything else happens. Placed above the prefix
# registration deliberately: a refusal here must cost nothing -- no proxy
# started, no prefix registered, no container created, nothing to unwind.
trap _sweep_cleanup EXIT
_take_sweep_lock || { echo "[2w] aborting before any trial ran." >&2; exit 2; }
for _port in 7425 7426; do
  reclaim_port "$_port" || { echo "[2w] aborting before any trial ran." >&2; exit 2; }
done

# ── THE PRE-LAUNCH CHECKLIST, RUN BEFORE ANYTHING IS SPENT ───────────────────
# Every item it checks has already cost measured trials, and all of them are
# cheap to check and expensive to discover 20 hours in. A missing checklist
# script is itself a refusal: a sweep that cannot verify its own preconditions
# is the failure mode this whole file is being hardened against.
if [ ! -f "$PREFLIGHT_CMD" ]; then
  echo "[2w] REFUSING: no preflight at $PREFLIGHT_CMD." >&2
  exit 2
fi
# ORDER: the brain is started BEFORE the checklist because the checklist's first
# item verifies it. Measured 2026-09-15 03:07: a resume after a quota halt (whose
# halt path had stopped the bench brain, correctly) refused itself with
# "bench brain :7424 no /health answer" -- the launcher's own start step sat
# AFTER the check that needed it. The first launch only worked because an
# operator had started the brain by hand.
# ── THE ISOLATED BENCH BRAIN ─────────────────────────────────────────────────
# Nothing in this directory used to start it, and run-dg.sh's repair instruction
# (`node scripts/copilot-start-mcp.mjs`) reuses the PRODUCTION tray on :7423 and
# exits 0 having bound nothing on :7424 — so the documented fix for a missing
# bench brain silently succeeds while leaving it missing. Idempotent: a brain
# already up, ready and isolated is left strictly alone.
if [ "${TB_SKIP_BENCH_BRAIN:-0}" != "1" ]; then
  if ! bash "$BENCH_BRAIN_START"; then
    echo "[2w] REFUSING: the isolated bench brain is not usable — see above." >&2
    exit 2
  fi
  TB_BENCH_BRAIN_STARTED=1
fi

echo "[2w] running the pre-launch checklist ($PREFLIGHT_CMD)"
if ! TB_SWEEP_LOCK_OWNER="$$" bash "$PREFLIGHT_CMD" "$TASKS_FILE"; then
  echo "[2w] REFUSING: the pre-launch checklist failed — see the FAIL lines above." >&2
  echo "[2w] Nothing was started, no prefix was registered, nothing to unwind." >&2
  exit 2
fi

# Register both prefixes with the merge NOW, not at the end. A prefix that is
# only appended on success is invisible to `merge-sweep.sh` when a worker dies
# mid-run, and the whole worker's results silently vanish from the total — the
# failure that hid 60 trials from an earlier merge.
for p in "$P0" "$P1"; do
  echo "$p" >> "$REPO/mcp-data/.tb-sweep-prefixes.txt"
done
sort -u -o "$REPO/mcp-data/.tb-sweep-prefixes.txt" "$REPO/mcp-data/.tb-sweep-prefixes.txt"

# ── COHORT IDENTITY, PINNED THE WAY redo-task.sh PINS IT ─────────────────────
#
# ⛔ THE SWEEP AND THE REDO MUST BE THE SAME HARNESS, because the last five
# sam-cell-seg conversions were measured through redo-task.sh. That script reads
# TB_MODEL / TB_DATASET from the cohort's own launch file and REFUSES when the
# environment disagrees, after an exported TB_AGENT beat the launch file on all
# 10 runs of one session and merged 1.0s into a cohort they did not belong to
# (2026-08-12 forensics). This launcher set neither, and relied on run-dg.sh's
# internal fallbacks instead — which happen to agree today (`claude-opus-5`) and
# are one edit away from not agreeing, silently, in the direction that
# invalidates a whole task's history.
#
# TB_AGENT stays HARDCODED here rather than inherited: this launcher exists to
# measure one agent, and "keep what the caller exported" is precisely the
# default that lost those trials.
LAUNCH_REF="${TB_LAUNCH_REF:-$REPO/mcp-data/.tb-par0.launch}"
TB_MODEL="${TB_MODEL:-claude-opus-5}"
TB_DATASET="${TB_DATASET:-}"
if [ -f "$LAUNCH_REF" ]; then
  for _pair in "TB_MODEL:$(tr ' ' '\n' < "$LAUNCH_REF" | sed -n 's/^TB_MODEL=//p' | head -1)" \
               "TB_AGENT:$(tr ' ' '\n' < "$LAUNCH_REF" | sed -n 's/^TB_AGENT=//p' | head -1)"; do
    _var="${_pair%%:*}"; _want="${_pair#*:}"
    [ -n "$_want" ] || continue
    eval "_have=\"\${$_var:-}\""
    [ "$_var" = "TB_AGENT" ] && _have="terransoul_hook:TerranSoulHook"
    if [ "$_have" != "$_want" ] && [ "${TB_IDENTITY_OVERRIDE:-0}" != "1" ]; then
      echo "[2w] REFUSING: $_var=$_have, but the cohort's launch file says $_want." >&2
      echo "[2w] $LAUNCH_REF is the single source of truth for which eval bucket these" >&2
      echo "[2w] trials join. A sweep under a different agent/model is silently excluded" >&2
      echo "[2w] from the number, or pooled in by an identity-blind merge as a result the" >&2
      echo "[2w] cohort never earned. Set TB_IDENTITY_OVERRIDE=1 to state otherwise." >&2
      exit 2
    fi
  done
fi
echo "[2w] identity : agent=terransoul_hook:TerranSoulHook model=$TB_MODEL dataset=${TB_DATASET:-<local path>}"

# ── RUN A SNAPSHOT OF THE DRIVER, NOT THE REPO FILE ──────────────────────────
# redo-task.sh already does this and states why: bash reads a script by BYTE
# OFFSET as it executes, so editing run-dg.sh mid-run makes the running shell
# resume at a shifted position and die minutes later with a fragment of a word
# ("line 1323: ncy: command not found"). That cost a trial twice in one session.
# A 40-hour sweep is the run most likely to overlap an edit, and it was the one
# entry point still reading the live file. ONE snapshot for the whole sweep, so
# both workers measure the same driver.
export TB_DRIVER_HOME="$HERE"
DRIVER="$(mktemp -t run-dg-sweep.XXXXXX 2>/dev/null || mktemp)"
cp "$HERE/run-dg.sh" "$DRIVER"
echo "[2w] driver snapshot: $DRIVER (edits to run-dg.sh during this sweep are safe)"

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
#
# ⛔ BUT THE LABEL IS NOT THE EVIDENCE. MEASURED 2026-09-15 18:45:47 (sweep
# ts09151819): pytorch-model-cli (16,125 output tokens) and winning-avg-corewars
# (11,402) were SIGKILLed in the same second, harbor wrote
# `ApiRateLimitError: Command failed (exit 137)`, and this function -- which
# returned true on `exc=='ApiRateLimitError'` alone -- halted BOTH workers on a
# spent session that was not spent: the account's own last rate_limit_event in each
# transcript said five_hour utilization 0.22. harbor's first ERROR_PATTERN is
# `rate.?limit` over the whole stdout, and every Claude Code transcript carries
# routine `"type":"rate_limit_event"` records, so ANY failed agent command wears
# that label. The same mislabel had already turned an owner-pause halt kill into
# a fake quota earlier that day.
#
# So a quota now needs POSITIVE evidence -- a 429 api_error_status, the CLI's own
# limit wording, or a last rate_limit_event whose status is not allowed /
# allowed_warning or whose window is at utilization >= 1.0 -- judged by
# rate-limit-evidence.py, the same file sweep-until-done.sh reads the reset time
# from. Both real quotas on disk (2026-09-04: zero tokens + 429 + "session
# limit"; 2026-09-15 02:35: 673 tokens + 429 + a `rejected` event) still halt.
#
# FAIL-SAFE: if the helper cannot answer (missing, or it crashed -- exit 3), this
# falls back to the OLD label rule. Halting on a doubtful quota costs an hour;
# banking a spent session's tasks as zeros costs the measurement.
RATE_LIMIT_EVIDENCE="${TB_RATE_LIMIT_EVIDENCE:-$HERE/rate-limit-evidence.py}"
job_hit_quota() {
  local job_dir="$1" helper rc
  [ -n "$job_dir" ] && [ -d "$job_dir" ] || return 1
  helper="${RATE_LIMIT_EVIDENCE:-$HERE/rate-limit-evidence.py}"
  # A GLOBAL, not a local: the worker prints it next to the halt line.
  QUOTA_EVIDENCE="$(python "$helper" quota "$job_dir" 2>/dev/null)"
  rc=$?
  case "$rc" in
    0) return 0 ;;
    1) QUOTA_EVIDENCE=""; return 1 ;;
  esac
  QUOTA_EVIDENCE="harbor label only (rate-limit-evidence.py exit $rc)"
  echo "[2w] rate-limit-evidence.py could not judge $job_dir (exit $rc) -- falling back to the harbor label" >&2
  python -c "
import json,glob,os,sys
for p in glob.glob(os.path.join(sys.argv[1],'*','result.json')):
    try:
        d=json.load(open(p))
    except Exception:
        continue
    info=d.get('exception_info') or {}
    # No double quote anywhere in this literal: it sits inside a bash
    # double-quoted python -c string, and an escaped quote here closed the
    # shell string early -- a syntax error 50 lines further down.
    if (info.get('exception_type') or '')=='ApiRateLimitError' or 'session limit' in (info.get('exception_message') or ''):
        sys.exit(0)
sys.exit(1)
" "$job_dir" 2>/dev/null
}

# Was the newest job's agent KILLED MID-WORK (exit 137, labelled
# ApiRateLimitError) with NO quota evidence? Prints "<trial>\t<work evidence>".
#
# The sibling of job_was_infra_failure, for the opposite case: that one catches
# a run that never happened (zero tokens), this one a run that DID happen and
# was cut off from outside. Neither is a capability result. Work is read from
# the same three sources, in the same order, as merge-sweep.sh's
# trial_agent_produced_work, so the sweep and the merge cannot disagree about
# whether this trial ran.
job_was_killed_with_work() {
  local job_dir="$1" helper
  [ -n "$job_dir" ] && [ -d "$job_dir" ] || return 1
  helper="${RATE_LIMIT_EVIDENCE:-$HERE/rate-limit-evidence.py}"
  python "$helper" killed-with-work "$job_dir" 2>/dev/null
}

# ── THE ONE-REQUEUE MARKER, WHICH MUST OUTLIVE A RELAUNCH ────────────────────
# A killed task is requeued ONCE. The marker is a ledger on disk, not a shell
# variable, because sweep-until-done.sh relaunches this script after every wall
# as a fresh process: an in-memory marker would let a task whose own workload
# gets it OOM-killed be requeued once per launch, up to the wall budget. Each
# worker appends to jobs/<prefix>.requeued (task, killed trial, job dir, work
# evidence); a halt merges both into jobs/ts<stamp>.requeued beside the merged
# .remaining, and a launch handed `X.remaining` inherits `X.requeued` as tasks
# that already had their requeue. merge-sweep.sh reads the per-prefix ledgers to
# disclose the k=2 they cause.
REQUEUE_LINEAGE=""
case "$TASKS_FILE" in
  *.remaining)
    if [ -s "${TASKS_FILE%.remaining}.requeued" ]; then
      REQUEUE_LINEAGE="${TASKS_FILE%.remaining}.requeued"
      echo "[2w] requeue lineage: $REQUEUE_LINEAGE ($(grep -c . "$REQUEUE_LINEAGE") task(s) already had their one requeue)"
    fi
    ;;
esac

_task_was_requeued() { # <prefix> <task>
  local f
  for f in "$JOBS_ROOT/$1.requeued" ${REQUEUE_LINEAGE:+"$REQUEUE_LINEAGE"}; do
    # awk, not `cut | grep -q`: under pipefail an early-exiting grep SIGPIPEs
    # cut and the pipeline reports 141 -- a match read as "never requeued".
    [ -f "$f" ] && awk -F'\t' -v t="$2" '$1==t{f=1} END{exit !f}' "$f" && return 0
  done
  return 1
}

# The newest job dir this prefix has produced, or empty. Scoped to the prefix so
# the OTHER worker's concurrent job is never inspected.
_newest_job_dir() { # <prefix>
  ls -1dt "$JOBS_ROOT/$1"-*/ 2>/dev/null | head -1
}

# --- HEADROOM-AWARE TASK SELECTION (TBENCH-HEADROOM-ORDER-1) -----------------
#
# MEASURED 2026-09-15 00:13 ON THE LIVE ts09142020 SWEEP: BOTH WORKERS IDLE,
# 70 TASKS OWED, AND NEITHER WAS BLOCKED ON ANYTHING IT COULD NOT HAVE RUN.
#
# run-dg.sh gates every trial on the credential outliving it -- max(40,
# ceiling/60 + 30) minutes -- and that gate is CORRECT: a trial that outlives
# its token dies mid-run with the agent already 98 turns in (sam-cell-seg,
# 2026-09-13, TBENCH-TOKEN-CEILING-1). Nothing here relaxes it.
#
# What was wrong is the SCHEDULING. The gate was applied to whatever task the
# deal happened to put at the head of the list:
#
#   worker 0  next task ceiling 3600 s -> gate  90 min, credential  84 min left
#             "waiting 5067s for the credential to reach expiry, then re-poking"
#   worker 1  next task build-pov-ray, 12000 s -> gate 230 min, 117 min left
#             "waiting 7089s ..."
#
# token-refresh.sh pokes the host CLI, which rotates ONLY once the token has
# actually expired, so the park is the token's whole remaining life: 1.5-2 h of
# both containers idle per ~8 h token cycle. Meanwhile 48 of the 89 tasks here
# have a 900 s ceiling whose gate is only max(40, 15+30) = 45 min -- every one
# of them fit in the headroom that was being waited out.
#
# So the worker deals by FIT, not by position: if the head task's gate exceeds
# the current headroom, the first remaining task whose gate DOES fit runs
# instead, and the skipped task stays at the head of the owed list for a later
# pass (its ledger entry is untouched -- it is unmeasured, not done). Only when
# NOTHING in the list fits does the worker fall through to run-dg's park-and-
# repoke, which is then the right behaviour: there is genuinely no work it can
# start before the rotation.
#
# PURITY: this is a property of the RUNNER -- a task's declared timeout and a
# credential's expiry. No task name is special-cased, no ordering is hardcoded,
# and the list a worker owes is unchanged; only the order it is drained in
# adapts. A sweep whose credential is long-lived (TB_TOKEN_STATIC=1) or whose
# headroom is unreadable reorders NOTHING and behaves exactly as before.

# `_token_mins_left` lives in token-refresh.sh, which is the ONE place the
# credential is read (its own header records the cost of copy-pasting it: three
# redo attempts died on a 2-day-stale token because a second copy was never
# wired in). Sourced, never reimplemented.
TOKEN_REFRESH_LIB="${TB_TOKEN_REFRESH_LIB:-$HERE/token-refresh.sh}"
# shellcheck source=/dev/null
[ -r "$TOKEN_REFRESH_LIB" ] && . "$TOKEN_REFRESH_LIB"

# A task's own wall-clock ceiling, derived the way run-dg.sh derives it -- same
# two lookup paths (local clone, then harbor's content-hash cache) and the same
# SECTION-AWARE awk, because a bare `grep -m1 timeout_sec` reads `[verifier]`
# first and answers 120 for a task the agent has 7200 s on. two-workers.test.sh
# proves this byte-equal against run-dg.sh's own block on every local task.
_task_ceiling_s() { # <task> -> ceiling seconds, or empty when unknown
  local task="$1" toml sec
  task="${task#*/}"                 # registry ids arrive namespaced: `org/name`
  [ -n "$task" ] || return 0
  toml="${TB21_DIR:-/d/Git/terminal-bench-2-1}/tasks/$task/task.toml"
  if [ ! -f "$toml" ]; then
    toml="$(ls -1 "$HOME/.cache/harbor/tasks/packages"/*/"$task"/*/task.toml 2>/dev/null | head -1)"
  fi
  [ -n "$toml" ] && [ -f "$toml" ] || return 0
  sec="$(awk '
    /^[[:space:]]*\[/ { section = $0 }
    section ~ /\[agent\]/ && /timeout_sec/ {
      if (match($0, /[0-9]+(\.[0-9]+)?/)) { print substr($0, RSTART, RLENGTH); exit }
    }' "$toml" 2>/dev/null)"
  [ -n "$sec" ] || sec="$(grep -m1 -oE 'timeout_sec[[:space:]]*=[[:space:]]*[0-9.]+' \
          "$toml" 2>/dev/null | grep -oE '[0-9.]+' | head -1)"
  sec="${sec%%.*}"
  case "$sec" in ''|*[!0-9]*) return 0 ;; esac
  [ "$sec" -gt 0 ] || return 0
  printf '%s' "$sec"
}

# Memoised: the same task.toml files are consulted once per selection, and a
# selection happens before every task for the whole sweep.
declare -A _GATE_MIN_CACHE=()

# The credential gate run-dg.sh will actually apply to this task, in minutes.
# EXACTLY token-refresh.sh's `_token_min_minutes`: max(40, ceiling/60 + 30),
# with TB_TOKEN_MIN_MINUTES overriding all of it. A different formula here would
# make the worker reorder against a gate nothing enforces.
_task_gate_min() { # <task> -> gate minutes
  local task="$1" gate ceiling want
  if [ -n "${TB_TOKEN_MIN_MINUTES:-}" ]; then printf '%s' "$TB_TOKEN_MIN_MINUTES"; return 0; fi
  gate="${_GATE_MIN_CACHE[$task]:-}"
  if [ -z "$gate" ]; then
    gate=40
    ceiling="$(_task_ceiling_s "$task")"
    if [ -n "$ceiling" ]; then
      want=$(( ceiling / 60 + 30 ))
      [ "$want" -gt "$gate" ] && gate="$want"
    fi
    _GATE_MIN_CACHE["$task"]="$gate"
  fi
  printf '%s' "$gate"
}

# Whole minutes of life left on the host credential, or empty when that cannot
# be answered -- and EMPTY MEANS DO NOT REORDER. An expired token reads negative
# and lands here too, which is correct: nothing fits, and poking rotates it
# immediately, so the existing path is already the fast one.
_credential_headroom_min() { # -> minutes, or empty
  local mins
  # TEST HOOK. Production NEVER sets TB_HEADROOM_MIN_OVERRIDE -- a real headroom
  # comes from the host credential and nothing else. Accepts a literal number of
  # minutes or a path to a file holding one; the file is re-read before every
  # task so a test can make the headroom RISE the way a real rotation does,
  # without a credential.
  if [ -n "${TB_HEADROOM_MIN_OVERRIDE:-}" ]; then
    if [ -r "$TB_HEADROOM_MIN_OVERRIDE" ]; then
      mins="$(tr -d '[:space:]' < "$TB_HEADROOM_MIN_OVERRIDE")"
    else
      mins="$TB_HEADROOM_MIN_OVERRIDE"
    fi
  else
    # A long-lived token (TB_TOKEN_STATIC=1) is not gated on .credentials.json
    # at all, so reordering against that file would be noise about a constraint
    # that does not exist. Same for a sweep that skips the refresh entirely.
    [ "${TB_TOKEN_STATIC:-0}" = "1" ] && return 0
    [ "${TB_SKIP_TOKEN_REFRESH:-0}" = "1" ] && return 0
    command -v _token_mins_left >/dev/null 2>&1 || return 0
    mins="$(_token_mins_left)"          # "unreadable" when there is no credential
  fi
  mins="${mins%%.*}"
  case "$mins" in ''|*[!0-9]*) return 0 ;; esac
  printf '%s' "$mins"
}

# Which of the owed tasks to deal NEXT: the head, unless its gate cannot fit in
# the headroom and some later task's can. Prints an index into the list it was
# given; announces a reorder on stderr (stdout is the return channel, and the
# worker's stderr is tee'd into the same log).
_headroom_pick_index() { # <prefix> <task...> -> index
  local prefix="$1"; shift
  local headroom head_gate gate j
  local args=("$@")
  [ "${#args[@]}" -gt 1 ] || { printf '0'; return 0; }
  headroom="$(_credential_headroom_min)"
  [ -n "$headroom" ] || { printf '0'; return 0; }
  head_gate="$(_task_gate_min "${args[0]}")"
  [ "$head_gate" -gt "$headroom" ] || { printf '0'; return 0; }
  for j in "${!args[@]}"; do
    [ "$j" -eq 0 ] && continue
    gate="$(_task_gate_min "${args[$j]}")"
    if [ "$gate" -le "$headroom" ]; then
      echo "[2w:$prefix] headroom $headroom min < gate $head_gate min for ${args[0]}; running ${args[$j]} (gate $gate min) first" >&2
      printf '%s' "$j"
      return 0
    fi
  done
  # NOTHING fits. Fall through to the head and let run-dg.sh park and re-poke:
  # with no runnable work left, waiting for the rotation IS the work.
  printf '0'
  return 0
}

# Rewrite <file> with exactly the tasks still owed. Called after EVERY task, not
# only on a halt: a worker killed by its sibling (or by the watchdog, or by a
# closed console) cannot write anything at that moment, so the resume list has
# to be correct on disk BEFORE the kill arrives.
#
# ⛔ AN EXPLICIT LIST, NOT A SUFFIX INDEX. A refused task leaves a HOLE: refusing
# r1 and then measuring r3 owes {r1, r5}, which no "from index N" can express.
# Writing the suffix would silently drop the one task the refusal branch exists
# to protect — it is unmeasured, and a resume that skips it banks a 0 nobody
# earned, which is the same defect one level up.
_write_remaining() { # <file> <task...>
  local f="$1"; shift
  if [ "$#" -gt 0 ]; then printf '%s\n' "$@" > "$f"; else : > "$f"; fi
  return 0
}

# One file, read by the parent, that says a worker has stopped for a reason the
# SIBLING must also stop for. A return code cannot carry this: `wait` on two
# background jobs in bash 4.4 gives no way to learn which one ended or why while
# the other is still burning tasks into the same wall.
_signal_halt() { # <kind> <detail>
  printf '%s|%s\n' "$1" "$2" > "$HALT_FILE"
  return 0
}

_worker_body() {
  local port="$1" prefix="$2" w="$3"; shift 3
  local remaining="$JOBS_ROOT/$prefix.remaining"
  local idx j t x attempt job_dir before_dir rc refusals=0
  # Everything this worker still owes. A task leaves it only once a job dir
  # proves it was really run.
  local unrun=("$@") keep=()
  # The tasks not yet DEALT, in list order. Deliberately separate from `unrun`:
  # a task is dealt exactly once (a refusal does not re-deal it, precisely as
  # the positional loop never revisited an index), while `unrun` holds what is
  # still OWED -- which a refused or deferred task remains.
  local queue=("$@") qkeep=()

  # sweep-status.sh anchors on this exact line ("everything after it belongs to
  # the current run"), and the logs are APPENDED across launches, so without it
  # every status read reports a previous sweep's numbers as if they were live.
  echo "[sweep] job prefix: $prefix"
  _write_remaining "$remaining" ${unrun[@]+"${unrun[@]}"}

  while [ "${#queue[@]}" -gt 0 ]; do
    # DEAL BY FIT, NOT BY POSITION (TBENCH-HEADROOM-ORDER-1). Re-evaluated
    # before every task because the headroom moves under us: it falls as the
    # sweep runs and jumps back to ~473 min the moment the host CLI rotates the
    # credential. The task this defers keeps its place at the head of the OWED
    # list -- it is unmeasured, not done.
    idx="$(_headroom_pick_index "$prefix" ${queue[@]+"${queue[@]}"})"
    t="${queue[$idx]}"
    qkeep=()
    for j in "${!queue[@]}"; do [ "$j" = "$idx" ] || qkeep+=("${queue[$j]}"); done
    queue=(${qkeep[@]+"${qkeep[@]}"})
    for attempt in 1 2; do
      echo "[2w:$prefix] --> $t (attempt $attempt)"
      # The shape sweep-status.sh counts as a started task and reads back as
      # "now: <task>".
      echo "[sweep]   task $t (worker $w, attempt $attempt)"
      before_dir="$(_newest_job_dir "$prefix")"
      # The bench brain can be killed from OUTSIDE the sweep: on 2026-09-14 both
      # brains (:7423 and :7424) vanished at the same minute with no crash trace
      # while no trial was running. start-bench-brain.sh is idempotent -- a
      # healthy :7424 costs one health probe -- so a dead brain is relaunched
      # BEFORE this task rather than after two preflight refusals have halted
      # the worker. Its exit code is advisory here; run-dg's own cold-brain
      # gate is what decides whether the trial may start.
      bash "$BENCH_BRAIN_START" --per-task "$t" >/dev/null 2>&1         || echo "[2w:$prefix] bench brain not restartable before $t (start-bench-brain.sh failed); run-dg's gate decides" >&2
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
      #
      # ⛔ THE ENV BLOCK MATCHES redo-task.sh's, VARIABLE FOR VARIABLE. The last
      # five sam-cell-seg conversions were measured through the redo path, so a
      # sweep that composes a different environment is not re-measuring the same
      # harness. TB_MODEL/TB_DATASET are pinned above from the cohort's launch
      # file; PYTHONIOENCODING/PYTHONUTF8 are set because the redo sets them and
      # a UTF-8 mismatch surfaces as a python traceback in post-processing, not
      # as anything that looks like an encoding problem.
      TB_AGENT="terransoul_hook:TerranSoulHook" \
      TB_TASKS="$t" \
      TB_CONCURRENCY=1 \
      TB_ATTEMPTS=1 \
      TB_STOP_HOOK=1 \
      TB_PROXY_PORT="$port" \
      TB_JOB_PREFIX="$prefix" \
      TB_PROXY_MODE=learn \
      TB_DEFER_WRITES="${TB_DEFER_WRITES:-0}" \
      TB_MODEL="$TB_MODEL" \
      TB_DATASET="$TB_DATASET" \
      PYTHONIOENCODING=utf-8 PYTHONUTF8=1 \
        bash "$DRIVER" ""
      # The exit code is CAPTURED, not discarded. `|| true` used to sit here, on
      # the correct reasoning that a single task's non-zero exit must not abandon
      # the list -- but it also threw away the only signal that separates "the
      # task failed" from "the driver refused before it started", and this shell
      # runs without `set -e`, so nothing is abandoned by reading it. The reward
      # still comes from result.json, per the playbook; this code only ever
      # classifies a run that produced no result at all.
      rc=$?

      job_dir="$(_newest_job_dir "$prefix")"

      # ── PREFLIGHT REFUSAL: NO NEW JOB DIR AT ALL ─────────────────────────────
      #
      # ⛔ EVERY GUARD BELOW READS THE PREVIOUS TASK'S JOB DIR WHEN THIS ONE
      # NEVER PRODUCED ONE. All of run-dg.sh's preflights (brain health, MCP
      # token, container TLS, credential) run BEFORE it invokes harbor, so a
      # refusal exits without harbor ever creating `jobs/<prefix>-<stamp>/`.
      # `ls -1dt ... | head -1` then returns the job from the LAST task, or
      # nothing at all on the first one, and `job_was_infra_failure` answers a
      # question about a trial that did not happen. With the bench brain missing
      # or a token dead, all 45 tasks refuse in seconds and the worker prints
      # "worker finished" having measured nothing.
      #
      # Comparing against the newest dir taken BEFORE the call is what
      # distinguishes them: same dir (or still none) means harbor was never
      # reached. Two in a row is a broken environment, not a flake -- retrying
      # the same instant refusal cannot help, and neither can the next task.
      if [ "$job_dir" = "$before_dir" ]; then
        refusals=$((refusals+1))
        echo "[2w:$prefix] $t produced NO job dir — run-dg.sh exited $rc before harbor ran." >&2
        echo "[2w:$prefix] That is a PREFLIGHT REFUSAL (brain/MCP token/credential/TLS), not a" >&2
        echo "[2w:$prefix] task result. Nothing was measured; the task stays UNMEASURED." >&2
        if [ "$refusals" -ge 2 ]; then
          echo "[sweep] HALT worker $w: preflight refused twice (run-dg.sh exit $rc)" >&2
          echo "[2w:$prefix] Two consecutive refusals is a broken environment, not a flake." >&2
          echo "[2w:$prefix] Read the run-dg.sh REFUSING line above, fix it, and resume." >&2
          _signal_halt "preflight" "worker $w: run-dg.sh exit $rc, no job dir, twice in a row"
          return 4
        fi
        break
      fi
      refusals=0
      # QUOTA FIRST. It is a subset of the zero-token condition below, and
      # retrying it cannot succeed -- so it must be tested before the retry.
      if job_hit_quota "$job_dir"; then
        echo "[2w:$prefix] QUOTA EXHAUSTED on $t — the account session limit is spent." >&2
        echo "[2w:$prefix] evidence: ${QUOTA_EVIDENCE:-unrecorded}" >&2
        echo "[2w:$prefix] Retrying now cannot succeed: a session cap clears at a fixed" >&2
        echo "[2w:$prefix] wall-clock time, not after a delay. STOPPING this worker so the" >&2
        echo "[2w:$prefix] remaining tasks stay UNMEASURED rather than being marked failed." >&2
        echo "[2w:$prefix] Re-run the remaining list after the reset." >&2
        _signal_halt "quota" "worker $w: quota evidence on $t (${QUOTA_EVIDENCE:-unrecorded})"
        return 3
      fi
      # ── KILLED MID-WORK, WEARING THE QUOTA LABEL ───────────────────────────
      #
      # ⛔ MEASURED 2026-09-15 18:45:47 (sweep ts09151819). pytorch-model-cli had
      # printed its own "CONTRACT FAILURES: NONE" 16,125 output tokens in, and
      # winning-avg-corewars was 11,402 tokens in, when both containers' agent
      # commands died with exit 137 in the same second. With the account at 22 %
      # of its five-hour window this was neither a quota nor the agent's result:
      # something outside the trial killed it (the same shape as that morning's
      # owner-pause halt kill). The old quota branch halted the sweep on it; with
      # quota now requiring evidence, the checks below would instead have BANKED
      # it -- not zero-token, not a RETRYABLE name -- as a measured 0.
      #
      # So it is requeued ONCE, at the END of this worker's list, and it stays
      # owed. Not retried in place: whatever killed two trials at once may still
      # be happening, and the rest of the list is the cheaper probe of that. The
      # killed trial stays on disk and scores 0 in merge-sweep.sh, so the task
      # carries k=2 -- recorded in jobs/<prefix>.requeued and on a `[sweep]
      # REQUEUED` line so merge-sweep and the report disclose it.
      #
      # A SECOND kill of the same task is NOT requeued again (the ledger is the
      # marker, and it outlives a relaunch): it falls through to the existing
      # outage/halt checks below unchanged. A task that is killed every time it
      # runs is a property of that task, and a loop would only spend the sweep
      # proving it.
      local killed_info="" killed_trial="" killed_evidence=""
      if killed_info="$(job_was_killed_with_work "$job_dir")"; then
        killed_trial="${killed_info%%$'\t'*}"
        killed_evidence="${killed_info#*$'\t'}"
        if _task_was_requeued "$prefix" "$t"; then
          echo "[2w:$prefix] AGENT KILLED AGAIN (exit 137, no quota evidence) on $t — trial $killed_trial ($killed_evidence)." >&2
          echo "[2w:$prefix] It already had its ONE requeue, so it is not requeued again; the existing" >&2
          echo "[2w:$prefix] outage/halt checks decide what this trial is." >&2
          echo "[sweep] KILLED AGAIN worker $w: $t (trial $killed_trial) — already requeued once, not again"
        else
          echo "[2w:$prefix] AGENT KILLED (exit 137, no quota evidence) on $t — trial $killed_trial ($killed_evidence)." >&2
          echo "[2w:$prefix] The agent was mid-work and the account was not spent, so this is neither a" >&2
          echo "[2w:$prefix] quota nor a task result. NOT halting and NOT marking it done: requeued ONCE" >&2
          echo "[2w:$prefix] at the end of this worker's list. The killed trial still scores 0 (k=2)." >&2
          printf '%s\t%s\t%s\t%s\n' "$t" "$killed_trial" "$(basename "$job_dir")" "$killed_evidence" \
            >> "$JOBS_ROOT/$prefix.requeued"
          echo "[sweep] REQUEUED worker $w: $t (killed trial $killed_trial, exit 137, no quota evidence) — k=2 for this task"
          queue+=("$t")
          keep=()
          for x in ${unrun[@]+"${unrun[@]}"}; do [ "$x" = "$t" ] || keep+=("$x"); done
          unrun=(${keep[@]+"${keep[@]}"} "$t")
          _write_remaining "$remaining" ${unrun[@]+"${unrun[@]}"}
          break
        fi
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
        _signal_halt "outage" "worker $w: zero-token on both attempts of $t"
        return 3
      fi
      # MEASURED: this task produced a job dir and was neither quota nor a
      # double outage, so it leaves the owed list. Recorded here rather than
      # after the inner loop so a `break` out of a REFUSAL never reaches it.
      keep=()
      for x in ${unrun[@]+"${unrun[@]}"}; do [ "$x" = "$t" ] || keep+=("$x"); done
      unrun=(${keep[@]+"${keep[@]}"})
      _write_remaining "$remaining" ${unrun[@]+"${unrun[@]}"}
      break
    done
  done
  rm -f "$remaining"
  echo "[2w:$prefix] worker finished"
  return 0
}

# The watchdog/status contract, which this launcher wrote NONE of.
# halt-on-outage.sh polls `mcp-data/.tb-par<w>.lock` for a live pid and greps
# `mcp-data/logs/tbench-par<w>.log` for outage signatures; sweep-status.sh and
# tick.sh read the same two paths. Every one of them was silently inert against
# a two-worker sweep -- "no live workers, standing down" on a sweep that was
# running, and "no worker logs found" on a sweep that was logging to a console.
# The lock holds $BASHPID (this subshell's MSYS pid) because that is the pid
# `ps -W`'s first column shows, which is what both readers compare against.
run_worker() {
  local port="$1" prefix="$2" w="$3"; shift 3
  local log="$LOGS/tbench-par${w}.log"
  local lock="$REPO/mcp-data/.tb-par${w}.lock"
  local rc
  printf '%s\n' "$BASHPID" > "$lock"
  # PIPESTATUS, not $?: `| tee` would otherwise report tee's success as the
  # worker's verdict and every halt would read as a clean finish.
  _worker_body "$port" "$prefix" "$w" "$@" 2>&1 | tee -a "$log"
  rc="${PIPESTATUS[0]}"
  rm -f "$lock"
  printf '%s\n' "$rc" > "$JOBS_ROOT/$prefix.rc"
  return "$rc"
}

# ── KILLING THE SIBLING, WITH ITS CONTAINERS ─────────────────────────────────
#
# ⛔ A HALT THAT STOPS ONE WORKER IS HALF A HALT. The quota branch stops the
# worker that hit the wall; the SIBLING keeps taking tasks into the same spent
# session, and every one of them lands as a zero-token failure at a rate of one
# per ~15 minutes until its own list runs out.
#
# Windows cannot deliver a real SIGTERM, so `docker compose down` will not run
# by itself the way a POSIX teardown would: harbor's own reaper
# (TBENCH-TEARDOWN-REAP-1 in terransoul_hook.py) only fires when ITS teardown
# command fails, not when the process is killed out from under it. So teardown
# here is EXPLICIT: taskkill the tree (politely first, then forced), then remove
# the trial containers directly.
#
# ⛔ THE `__` IS THE SAFETY PROPERTY. Every harbor trial container carries the
# trial session id, which always contains a DOUBLE underscore; none of the
# owner's own long-lived containers (`tl-mariadb-test`,
# `richardle-mariadb-local`, `shopee-crawler-mariadb-local`) do. A blunt sweep
# by status killed two LIVE trials on 2026-09-07 and would delete the owner's
# data here.
_kill_worker_tree() { # <msys pid> <label>
  local pid="$1" label="$2" win i
  [ -n "$pid" ] || return 0
  _msys_pid_alive "$pid" || return 0
  win="$(_msys_to_winpid "$pid")"
  echo "[sweep] stopping $label (msys pid $pid, winpid ${win:-unknown})"
  if [ -n "$win" ] && command -v taskkill >/dev/null 2>&1; then
    taskkill //PID "$win" //T >/dev/null 2>&1 || true
    # A SHORT grace, deliberately. A polite taskkill posts WM_CLOSE, which a
    # windowless bash/python tree ignores, so waiting long for a cooperative
    # exit buys nothing and costs the sibling another minute of burning tasks
    # into the wall that caused the halt. The explicit container reap below is
    # what actually guarantees teardown here, not the grace period.
    for i in $(seq 1 "${TB_SIBLING_GRACE_S:-8}"); do
      _msys_pid_alive "$pid" || break
      sleep 1
    done
    _msys_pid_alive "$pid" && taskkill //PID "$win" //T //F >/dev/null 2>&1 || true
  fi
  kill -9 "$pid" 2>/dev/null || true
  return 0
}

_reap_sweep_containers() {
  command -v docker >/dev/null 2>&1 || return 0
  local dead
  dead="$(docker ps -a --format '{{.ID}} {{.Names}}' 2>/dev/null | grep '__' || true)"
  [ -n "$dead" ] || { echo "[sweep] no trial containers left to reap"; return 0; }
  echo "[sweep] reaping $(printf '%s\n' "$dead" | wc -l | tr -d ' ') trial container(s):"
  printf '%s\n' "$dead" | sed 's/^/[sweep]   /'
  # shellcheck disable=SC2046
  docker rm -f $(printf '%s\n' "$dead" | awk '{print $1}') >/dev/null 2>&1 || true
  return 0
}

# Both workers' unfinished tasks, in the ORIGINAL list order, so the resume
# command is a drop-in for the original launch.
_merge_remaining() {
  local out="$JOBS_ROOT/ts${STAMP}.remaining" t
  local left=()
  for t in "${ALL_TASKS[@]}"; do
    if grep -qxF "$t" "$JOBS_ROOT/$P0.remaining" 2>/dev/null \
    || grep -qxF "$t" "$JOBS_ROOT/$P1.remaining" 2>/dev/null; then
      left+=("$t")
    fi
  done
  if [ "${#left[@]}" -gt 0 ]; then printf '%s\n' "${left[@]}" > "$out"; else : > "$out"; fi
  _merge_requeued
  printf '%s' "$out"
}

# The one-requeue ledger travels WITH the merged .remaining (same basename,
# `.requeued`), because that pair is exactly what sweep-until-done.sh hands the
# next launch. Inherited lines are carried forward so a task killed on launch 1
# is still "already requeued" on launch 3. Silent on stdout: _merge_remaining's
# stdout is the path its callers capture.
_merge_requeued() {
  local out="$JOBS_ROOT/ts${STAMP}.requeued" merged
  merged="$(cat ${REQUEUE_LINEAGE:+"$REQUEUE_LINEAGE"} "$JOBS_ROOT/$P0.requeued" "$JOBS_ROOT/$P1.requeued" 2>/dev/null \
            | awk 'NF && !seen[$0]++')"
  [ -n "$merged" ] && printf '%s\n' "$merged" > "$out"
  return 0
}

# One line per requeued task at the END of the run, where the operator reads,
# so a k=2 is never discovered only inside a merge report.
_disclose_requeues() {
  local p
  for p in "$P0" "$P1"; do
    [ -s "$JOBS_ROOT/$p.requeued" ] || continue
    echo "[2w] k=2 DISCLOSURE ($p): $(cut -f1 "$JOBS_ROOT/$p.requeued" | tr '\n' ' ')— requeued once after an exit-137 kill with no quota evidence; ledger $JOBS_ROOT/$p.requeued, listed by merge-sweep.sh"
  done
  return 0
}

rm -f "$JOBS_ROOT/$P0.rc" "$JOBS_ROOT/$P1.rc"
run_worker 7425 "$P0" 0 "${W0[@]}" &
PID0=$!
run_worker 7426 "$P1" 1 "${W1[@]}" &
PID1=$!

# ⛔ NOT `wait "$PID0" "$PID1"`. That waits for BOTH and discards both exit
# codes, so a worker that halted on a spent session was indistinguishable from
# one that finished its list -- and the next line printed "both workers
# finished" either way, which is how an outage gets reported as a completed
# sweep. bash 4.4 has no `wait -n -p`, so the workers publish their verdict as
# files and this polls them.
HALT_KIND=""
HALT_DETAIL=""
while :; do
  if [ -f "$HALT_FILE" ]; then
    HALT_KIND="$(cut -d'|' -f1 < "$HALT_FILE")"
    HALT_DETAIL="$(cut -d'|' -f2- < "$HALT_FILE")"
    break
  fi
  [ -f "$JOBS_ROOT/$P0.rc" ] && [ -f "$JOBS_ROOT/$P1.rc" ] && break
  # A worker killed hard (closed console, SIGKILL, the watchdog) writes neither
  # a halt file nor an .rc. Waiting on a file that will never appear is how a
  # supervisor hangs for the rest of the night, so liveness is the backstop.
  if ! _msys_pid_alive "$PID0" && ! _msys_pid_alive "$PID1"; then
    echo "[sweep] both worker processes are gone; stopping the wait." >&2
    break
  fi
  sleep "${TB_SWEEP_POLL_S:-2}"
done

if [ -n "$HALT_KIND" ]; then
  echo "[sweep] HALT signalled: $HALT_KIND — $HALT_DETAIL" >&2
  _kill_worker_tree "$PID0" "worker 0"
  _kill_worker_tree "$PID1" "worker 1"
  _reap_sweep_containers
  rm -f "$REPO/mcp-data/.tb-par0.lock" "$REPO/mcp-data/.tb-par1.lock"
fi

wait "$PID0" 2>/dev/null || true
wait "$PID1" 2>/dev/null || true

RC0="$(cat "$JOBS_ROOT/$P0.rc" 2>/dev/null | tr -d '[:space:]')"
RC1="$(cat "$JOBS_ROOT/$P1.rc" 2>/dev/null | tr -d '[:space:]')"

if [ -n "$HALT_KIND" ]; then
  REMAIN="$(_merge_remaining)"
  n="$(grep -c . "$REMAIN" 2>/dev/null)"; n="${n:-0}"
  echo "[sweep] HALTED: $HALT_KIND — resume with: bash run-two-workers.sh $REMAIN" >&2
  echo "[sweep] $n task(s) stayed UNMEASURED; nothing already scored was dropped." >&2
  _disclose_requeues >&2
  echo "[sweep] partial results still merge: bash merge-sweep.sh $JOBS_ROOT $P0 && bash merge-sweep.sh $JOBS_ROOT $P1" >&2
  case "$HALT_KIND" in preflight) exit 4 ;; *) exit 3 ;; esac
fi

if [ "${RC0:-1}" != "0" ] || [ "${RC1:-1}" != "0" ]; then
  REMAIN="$(_merge_remaining)"
  _disclose_requeues >&2
  echo "[sweep] a worker exited non-zero (w0=$RC0 w1=$RC1) — resume with: bash run-two-workers.sh $REMAIN" >&2
  exit 3
fi

_disclose_requeues
echo "[2w] both workers finished — merge with: bash merge-sweep.sh jobs $P0 && bash merge-sweep.sh jobs $P1"
