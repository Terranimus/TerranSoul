#!/usr/bin/env bash
# Re-run ONE task without disturbing anything already measured.
#
#   usage: redo-task.sh <task-id> [attempts]
#          DRY=1 redo-task.sh <task-id>
#
# WHY THIS IS SAFE, and it is worth understanding rather than trusting:
# merge-sweep.sh collapses every prefix to ONE ROW PER TASK and counts a task
# solved if ANY trial scored 1.0. A redo therefore runs in its OWN prefix,
# appends that prefix to the campaign list, and can only RAISE the redone task's
# row. It cannot lower it, and it cannot touch any other task's row. That is the
# whole mechanism — there is no merge surgery and no editing of prior results.
#
# WHAT IT DELIBERATELY DOES NOT DO:
#   * it does not touch $STATE. State drives which tasks a SWEEP still owes; a
#     targeted redo is orthogonal to that, and clearing state is how a campaign
#     accidentally re-runs 89 tasks.
#   * it does not clear $ACCEPTED or $RETRIES for other tasks.
#   * it refuses to run while a sweep holds the lock, because two runs fight
#     over the proxy port (EADDRINUSE 7425) and both die.
#
# CHECKPOINT FIRST. Every redo snapshots the campaign before it runs, so the
# state that produced the current number is recoverable even if the redo is
# interrupted halfway.
set -uo pipefail

# ⛔ RE-EXEC FROM A SNAPSHOT OF THIS FILE, for the same reason it snapshots
# run-dg.sh below: bash reads a script by BYTE OFFSET as it executes, so editing
# this file while a trial is in flight makes the running shell resume mid-line.
# That cost two trials on 2026-09-02 (run-dg.sh: "line 1323: ncy: command not
# found", a fragment of "concurrency"). The run-dg.sh snapshot fixed the driver
# but left THIS file exposed -- and it is the one the operator actually edits.
#
# $HERE cannot be derived from BASH_SOURCE once we are running from /tmp, so it
# is passed forward. TB_REDO_SNAPSHOT also guards against re-exec looping.
if [ -z "${TB_REDO_SNAPSHOT:-}" ]; then
  _redo_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _redo_snap="$(mktemp -t redo-task.XXXXXX 2>/dev/null || mktemp)"
  if cp "${BASH_SOURCE[0]}" "$_redo_snap" 2>/dev/null; then
    export TB_REDO_SNAPSHOT=1 TB_REDO_HOME="$_redo_here"
    bash "$_redo_snap" "$@"
    _redo_rc=$?
    rm -f "$_redo_snap"
    exit $_redo_rc
  fi
  # Snapshot unavailable: run in place rather than refuse. The exposure is the
  # pre-existing behaviour, not a new failure mode.
  rm -f "$_redo_snap" 2>/dev/null
fi
HERE="${TB_REDO_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO="$(cd "$HERE/../.." && pwd)"
TASK="${1:-}"
ATTEMPTS="${2:-${TB_ATTEMPTS:-1}}"
DRY="${DRY:-0}"

if [ -z "$TASK" ]; then
  echo "usage: redo-task.sh <task-id> [attempts]" >&2
  echo "  candidates: bash redo-candidates.sh" >&2
  exit 2
fi

TASKS_DIR="${TB21_DIR:-/d/Git/terminal-bench-2-1}/tasks"
if [ ! -d "$TASKS_DIR/$TASK" ]; then
  echo "REFUSING: '$TASK' is not a task in $TASKS_DIR" >&2
  echo "  A typo here runs nothing and looks exactly like a task that scored 0." >&2
  exit 2
fi

# ── refuse to race a live sweep. Check the LOCKFILE PID, not a command-line
# pattern: `pkill -f run-sweep.sh` silently failed to match on 2026-08-06 and a
# driver kept running inside its 600s rate-limit sleep, invisible to every
# container/process count.
LOCK="$REPO/mcp-data/.tb-sweep.lock"
if [ -f "$LOCK" ]; then
  pid="$(cat "$LOCK" 2>/dev/null)"
  if [ -n "$pid" ] && ps -W 2>/dev/null | awk -v p="$pid" '$1==p{f=1} END{exit !f}'; then
    # The refusal exists for ONE reason: run-dg.sh defaults TB_PROXY_PORT to
    # 7425, which is also worker 0's port, so two runs bind the same socket and
    # both die. run-parallel.sh already proves distinct ports coexist — it hands
    # worker w port 7425+w. So an EXPLICIT free port removes the reason, and the
    # guard should not be stricter than the hazard it names.
    #
    # Everything else these runs share is safe concurrently: the bench brain is
    # shared by every worker BY DESIGN, the credential file is read-only here,
    # the container/network pool holds 4096, and redo-task deliberately never
    # touches $STATE (that is what drives which tasks a SWEEP still owes).
    if [ -n "${TB_PROXY_PORT:-}" ] && [ "${TB_PROXY_PORT}" != "7425" ]; then
      if (exec 3<>"/dev/tcp/127.0.0.1/${TB_PROXY_PORT}") 2>/dev/null; then
        exec 3<&- 2>/dev/null
        echo "REFUSING: TB_PROXY_PORT=$TB_PROXY_PORT is already in use." >&2
        echo "  Pick a port no worker holds (workers use 7425+w)." >&2
        exit 3
      fi
      echo "[redo] a sweep is live (pid $pid), but TB_PROXY_PORT=$TB_PROXY_PORT is free — running alongside it"
    else
      echo "REFUSING: a sweep is running as pid $pid (lock: $LOCK)." >&2
      echo "  Two runs fight over proxy port 7425 and both die." >&2
      echo "  Either stop the sweep, or set TB_PROXY_PORT to a free port" >&2
      echo "  (workers hold 7425+w) to run this redo alongside it." >&2
      exit 3
    fi
  else
    echo "[redo] stale lock for dead pid ${pid:-?} — clearing"
    [ "$DRY" = "1" ] || rm -f "$LOCK"
  fi
fi

ceiling="$(grep -m1 -oE 'timeout_sec[[:space:]]*=[[:space:]]*[0-9.]+' "$TASKS_DIR/$TASK/task.toml" 2>/dev/null | grep -oE '[0-9.]+' || echo '?')"
PREFIX="redo$(date +%m%d%H%M)"

# ⛔ INHERIT THE COHORT'S IDENTITY, OR THE REDO LANDS IN A DIFFERENT BUCKET AND
# VANISHES. harbor keys every eval as `<agent>__<model>__<dataset>`, and the
# leaderboard's `lb filter` selects trials by (agent, agent version, model,
# reasoning effort) with the dataset pinned repo-wide. This script passed
# NEITHER TB_AGENT NOR TB_DATASET, so it produced:
#
#     claude-code__claude-sonnet-5__tasks
#   vs the cohort's
#     terransoul__claude-sonnet-5__terminal-bench/terminal-bench-2-1
#
# Both differences are fatal and SILENT. Wrong agent -> the filter never selects
# those trials, so a task "topped up" by a redo still reads below 5 trials to CI.
# Wrong dataset -> CI rejects anything not on the pinned DATASET@DATASET_REF
# outright. Measured 2026-08-08 by comparing eval keys across jobs-sonnet5 and
# the attempt-6 redo; the redo was excluded from the number for other reasons, so
# nothing was published, but the topping-up pass would have hit it squarely.
#
# The worker launch file is the single source of truth for what the cohort
# ACTUALLY ran, so read the identity from there rather than restating it.
LAUNCH="${TB_LAUNCH_REF:-$REPO/mcp-data/.tb-par0.launch}"

# ⛔ AN INHERITED ENV VAR USED TO WIN THIS SILENTLY, AND IT COST THE CAMPAIGN
# ITS ENTIRE filter-js-from-html HISTORY. The `[ -n "${TB_AGENT:-}" ] ||`
# below is a "keep what the caller exported" default — reasonable-looking, and
# wrong here, because the ONE thing a redo must not choose for itself is which
# cohort its trials join. Forensics 2026-08-12, reproduced from the session
# transcripts: every redo in one long session printed
# `agent=claude-code model=claude-opus-5` while `.tb-par0.launch` held the
# correct `terransoul:TerranSoul` / `claude-sonnet-5` — a stray exported
# TB_AGENT in that shell beat the launch file on all 10 runs, and
# `run-dg.sh`'s own fallback for an unset TB_AGENT is literally `claude-code`.
# Nothing warned. Those trials scored 1.0 and were merged by an identity-blind
# merge-sweep into a cohort they did not belong to, which is how a
# "3 consecutive passes, EXIT CONDITION MET" result got published for a task
# whose real record under the cohort's own identity was 0-for-6.
#
# So a MISMATCH is now fatal rather than silent. The launch file is the single
# source of truth; an explicit override must say so out loud via
# TB_IDENTITY_OVERRIDE=1, which is greppable in a transcript afterwards in a
# way an exported variable never was.
if [ -f "$LAUNCH" ]; then
  _launch_agent="$(tr ' ' '\n' < "$LAUNCH" | sed -n 's/^TB_AGENT=//p'   | head -1)"
  _launch_dataset="$(tr ' ' '\n' < "$LAUNCH" | sed -n 's/^TB_DATASET=//p' | head -1)"
  _launch_model="$(tr ' ' '\n' < "$LAUNCH" | sed -n 's/^TB_MODEL=//p'   | head -1)"
  for _pair in "TB_AGENT:$_launch_agent" "TB_DATASET:$_launch_dataset" "TB_MODEL:$_launch_model"; do
    _var="${_pair%%:*}"; _want="${_pair#*:}"
    [ -n "$_want" ] || continue
    eval "_have=\"\${$_var:-}\""
    if [ -z "$_have" ]; then
      eval "$_var=\"\$_want\""
    elif [ "$_have" != "$_want" ] && [ "${TB_IDENTITY_OVERRIDE:-0}" != "1" ]; then
      echo "REFUSING: $_var=$_have from the environment, but the cohort's launch file says $_want." >&2
      echo "  $LAUNCH is the single source of truth for which cohort these trials join." >&2
      echo "  A redo that runs under a different agent/model produces trials harbor keys" >&2
      echo "  under a DIFFERENT eval bucket — they are silently excluded from the" >&2
      echo "  submission (or, worse, pooled in by an identity-blind merge and published" >&2
      echo "  as a result the cohort never earned). This exact defect invalidated a" >&2
      echo "  whole task's pass history on 2026-08-11." >&2
      echo "  Fix the environment (unset $_var), or set TB_IDENTITY_OVERRIDE=1 to state" >&2
      echo "  on the record that a different-identity run is intended." >&2
      exit 2
    fi
  done
fi
# ⛔ THIS GUARD REFUSED A COHORT IT WAS NEVER MEANT TO BLOCK, AND THAT MADE
# THE MEASURED CAMPAIGN UN-REDOABLE.
#
# It demanded a non-empty TB_DATASET unconditionally. But an EMPTY TB_DATASET
# is a legitimate, deliberate configuration: `run-dg.sh` runs from the local
# `TB21_DIR/tasks` path in that case, and the entire 89-task campaign on disk
# was measured that way (`mcp-data/.tb-par0.launch`: `TB_DATASET=` with
# `TB_SUBMITTABLE=0`, `TB_PROXY_MODE=learn`). So every redo against the actual
# measured cohort hit this refusal — the one operation the never-regress loop
# depends on.
#
# `run-dg.sh` already states the correct rule at its own dataset check: a
# dataset is REQUIRED ONLY WHEN SUBMITTING. Two scripts in one harness
# disagreeing about the same precondition is the divergence
# `rules/one-path-three-surfaces.md` exists to catch; this aligns the redo with
# the driver rather than inventing a third rule.
#
# TB_AGENT stays unconditionally required: it is what keys trials into an eval
# bucket, and getting it wrong is what invalidated a whole task's pass history
# on 2026-08-11 (see the identity block above).
if [ -z "${TB_AGENT:-}" ]; then
  echo "REFUSING: cannot determine the cohort's agent identity." >&2
  echo "  Without it this redo is keyed differently from the sweep and its" >&2
  echo "  trials silently drop out of the submission. Set TB_AGENT explicitly," >&2
  echo "  or point TB_LAUNCH_REF at a worker .launch file." >&2
  exit 2
fi
if [ "${TB_SUBMITTABLE:-0}" = "1" ] && [ -z "${TB_DATASET:-}" ]; then
  echo "REFUSING: TB_SUBMITTABLE=1 but TB_DATASET is empty." >&2
  echo "  A submittable run MUST come from the pinned registry, not a local" >&2
  echo "  path — same rule run-dg.sh enforces for the sweep itself. Set" >&2
  echo "  TB_DATASET, or drop TB_SUBMITTABLE for a local-path re-measure." >&2
  exit 2
fi
echo "[redo] identity  : agent=$TB_AGENT model=${TB_MODEL:-?}"
# `${:-}` because TB_DATASET is now legitimately optional (local-path
# cohort) and this script runs under `set -u`.
echo "[redo] dataset   : ${TB_DATASET:-<local path: $TASKS_DIR>}"

echo "[redo] task      : $TASK"
echo "[redo] ceiling   : ${ceiling}s"
echo "[redo] attempts  : $ATTEMPTS"
echo "[redo] prefix    : $PREFIX  (its own; merge takes the best trial per task)"

if [ "$DRY" = "1" ]; then
  echo "  would: checkpoint, then run run-dg.sh with TB_TASKS=$TASK TB_JOB_PREFIX=$PREFIX"
  exit 0
fi

# ⛔ THIS SCRIPT HAD NO CREDENTIAL REFRESH AT ALL until 2026-08-12. Only the
# two full-sweep drivers (run-sweep.next.sh, run-sweep.par.sh) called this —
# a single-task redo just trusted whatever was already in $TB_TOKEN_FILE, with
# no verification. Measured the same day: the file was 2 days 8 hours stale
# and three consecutive redo attempts died on "401 OAuth access token has been
# revoked" with 0 completion tokens each — a solved problem that simply was
# not wired into this entry point. See token-refresh.sh for the mechanism.
source "$HERE/token-refresh.sh"
refresh_token || {
  echo "REFUSING: no usable credential (see messages above)." >&2
  echo "  If the refresh token itself is dead: run 'claude setup-token'," >&2
  echo "  write it to mcp-data/.tb-token.env, and relaunch with TB_TOKEN_STATIC=1." >&2
  exit 5
}

bash "$HERE/checkpoint.sh" "pre-redo-$TASK-$PREFIX" >/dev/null 2>&1 && \
  echo "[redo] checkpoint: pre-redo-$TASK-$PREFIX"

# Register the prefix so merge-sweep.sh includes this run. Without it the redo
# is invisible to the number and the whole exercise is wasted compute.
#
# TB_REDO_EXPERIMENT=1 deliberately SKIPS that, because some redos are questions,
# not attempts to raise a score. A cohort is k=5 for every task; quietly giving
# ONE task a 6th attempt makes the run non-uniform, and if that task then passes,
# the headline number moves for a reason no other task was offered. An experiment
# stays out of the number until its finding is applied to every task equally.
if [ "${TB_REDO_EXPERIMENT:-0}" = "1" ]; then
  echo "[redo] EXPERIMENT mode — prefix NOT registered, this run cannot move the number"
else
  echo "$PREFIX" >> "$REPO/mcp-data/.tb-sweep-prefixes.txt"
  sort -u -o "$REPO/mcp-data/.tb-sweep-prefixes.txt" "$REPO/mcp-data/.tb-sweep-prefixes.txt"
fi

# Deferral OFF by default: a single task has no cross-attempt leakage concern
# worth the risk of losing its lesson, and immediate writes mean attempt 2 can
# ⛔ EVERY REDO RAN WITH NO STOP HOOK, SO THE DISCOVERY LOOP COULD NEVER FIRE.
#
# This env block forwarded fifteen variables to run-dg.sh and TB_STOP_HOOK was
# not one of them, so it defaulted to 0 on every redo. The SWEEP sets
# TB_STOP_HOOK=1 (`mcp-data/.tb-par0.launch`); the redo silently dropped it.
#
# That is not a cosmetic difference. With no hook registered,
# `build_stop_decision` is never consulted at stop time, the discovery protocol
# (narrow / differential-compare / invert-the-claim) is unreachable, and the
# agent stops the moment it believes it is done with nothing to challenge it —
# "giving up on iteration 1" as a property of the harness, not the model. And
# the redo path is the mechanism every retry goes through, so the tasks that
# absorbed the most repeated attempts were precisely the ones running with the
# LEAST enforcement.
#
# MEASURED 2026-08-31 on an extract-elf redo: zero stop-hook mentions in
# `trial.log`, no `hooks` key in the container config, 11 proxy calls total
# (one brain_search, one brain_append), brain memory_total delta 0.
#
# run-dg.sh's own install block warns about exactly this shape — "a missing
# hook does not error, it silently never fires, which is exactly the failure
# that already cost this campaign one mechanism" — and it refuses when the hook
# is REQUESTED without its adapter. Nothing caught the hook simply never being
# requested. Defaulting to 1 here makes the redo match the sweep; an explicit
# TB_STOP_HOOK=0 still opts out.
# ⛔ THIS BLOCK MUST STAY ABOVE THE ENV PREFIX BELOW. That prefix is ONE
# command spanning many backslash-continued lines. Inserting anything into the
# middle of it severs the continuation, and TB_TASKS/TB_JOB_PREFIX silently
# become plain shell variables that never reach the child. MEASURED: the child
# ran with an EMPTY task list and died resolving "tasks//task.toml" (exit 2),
# with no error message of its own.
# ⛔ RUN A SNAPSHOT, NOT THE REPO FILE. Bash reads a script by BYTE OFFSET as it
# executes, so editing run-dg.sh while a trial is in flight makes the running
# shell resume mid-line at a shifted position. It does not error at the edit --
# it fails minutes later with something like
#
#     run-dg.sh: line 1323: ncy: command not found      (exit 127)
#
# a fragment of "concurrency", and the trial post-processing is lost.
#
# This has now cost a trial TWICE in one session, the second time while the
# author was editing the very guard that file contains. A note in memory did
# not prevent the repeat, so the fix belongs in code: copy the driver and run
# the copy, which makes an edit mid-run harmless by construction.
# The snapshot lives outside the repo, so run-dg.sh cannot derive its own
# directory from BASH_SOURCE any more. Hand it the real one or all 17 of its
# "$HERE/..." references resolve into /tmp.
export TB_DRIVER_HOME="$HERE"
RUN_DG_SNAPSHOT="$(mktemp -t run-dg.XXXXXX 2>/dev/null || mktemp)"
cp "$HERE/run-dg.sh" "$RUN_DG_SNAPSHOT"
trap 'rm -f "$RUN_DG_SNAPSHOT"' EXIT
echo "[redo] driver snapshot: $RUN_DG_SNAPSHOT (edits to run-dg.sh during this run are safe)"

TB_TASKS="$TASK" \
TB_JOB_PREFIX="$PREFIX" \
TB_ATTEMPTS="$ATTEMPTS" \
TB_CONCURRENCY=1 \
TB_DEFER_WRITES="${TB_DEFER_WRITES:-0}" \
TB_PROXY_MODE="${TB_PROXY_MODE:-learn}" \
TB_PROXY_PORT="${TB_PROXY_PORT:-7425}" \
TB_JOBS_DIR="${TB_JOBS_DIR:-}" \
TB_PRIOR_OUTCOMES="${TB_PRIOR_OUTCOMES:-}" \
TB_MODEL="${TB_MODEL:-claude-sonnet-5}" \
TB_AGENT="$TB_AGENT" \
TB_DATASET="${TB_DATASET:-}" \
TB_STOP_HOOK="${TB_STOP_HOOK:-1}" \
TB_STOP_HOOK_SETTINGS="${TB_STOP_HOOK_SETTINGS:-}" \
TB_UPLOAD="${TB_UPLOAD:-}" \
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 \
  bash "$RUN_DG_SNAPSHOT" ""
rc=$?
rm -f "$RUN_DG_SNAPSHOT"

echo
echo "[redo] run exited $rc — READ result.json, not this code (harbor exits 0 on a FAILED trial)."
echo "[redo] re-merge with:  bash $HERE/merge-sweep.sh $HERE/jobs"
echo "[redo] the redone task's row can only have gone UP; every other row is untouched."
exit $rc
