#!/usr/bin/env bash
# Launch run-two-workers.sh into its OWN hidden Windows console, so a 20-40 h
# unattended sweep survives whatever happens to the console that started it.
#
#   usage: bash launch-sweep-detached.sh <tasks-file>
#          TB_LAUNCH_SWEEP_PRINT_ONLY=1 bash launch-sweep-detached.sh <tasks-file>
#
# WHY THIS EXISTS. launch-detached.sh already does this for ONE redo, for a
# measured reason (2026-09-11 18:53:25: a trial sharing the Claude Code Bash
# tool's Windows console died the instant a CONCURRENT tool call hit that tool's
# ~120 s auto-background point -- harbor, the :7425 proxy and both bash
# snapshots exited 1 with no traceback and no result.json, while the task
# container kept running healthily underneath). The full sweep, which is the run
# that actually costs 20-40 hours, had no such launcher: it could only be
# started in a shared console, where the same event destroys not one trial but
# every trial still owed.
#
# THE STAMP IS EXPORTED, NOT JUST PRINTED. run-two-workers.sh derives its job
# prefixes from `date +%m%d%H%M` at the moment IT starts, so a launcher that
# printed its own stamp would name prefixes that do not exist whenever the
# launch crosses a minute boundary -- and those prefixes are what the operator
# greps for, and what merge-sweep.sh is later pointed at. TB_SWEEP_STAMP makes
# the announced pair the real one.
#
# NO COMPLETION NOTIFICATION, by construction: a detached Start-Process is
# fire-and-forget. Watch it with `bash sweep-status.sh` / `bash tick.sh`, or
# read detached-sweep-<stamp>.out.
#
# WINDOWS-ONLY, like launch-detached.sh: a non-Windows host gets a one-line
# refusal rather than a half-working launch.
set -uo pipefail

# NEVER NEST inside a redo's snapshot re-exec -- same guard, same reason, as
# launch-detached.sh: it can only double-launch or race the lock check below.
if [ -n "${TB_REDO_SNAPSHOT:-}" ]; then
  echo "REFUSING: TB_REDO_SNAPSHOT is already set -- refusing to launch a sweep from" >&2
  echo "  inside redo-task.sh's snapshot re-exec. Run this from an ordinary shell." >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TASKS_FILE="${1:-}"

if [ -z "$TASKS_FILE" ] || [ ! -f "$TASKS_FILE" ]; then
  echo "usage: bash launch-sweep-detached.sh <tasks-file>" >&2
  exit 2
fi
TASKS_ABS="$(cd "$(dirname "$TASKS_FILE")" && pwd)/$(basename "$TASKS_FILE")"
N_TASKS="$(tr '\n' ' ' < "$TASKS_ABS" | wc -w | tr -d ' ')"
if [ "$N_TASKS" -eq 0 ]; then
  echo "REFUSING: $TASKS_ABS lists no tasks." >&2
  exit 2
fi

if [ "${OS:-}" != "Windows_NT" ]; then
  echo "REFUSING: launch-sweep-detached.sh is Windows-only (no Start-Process/-WindowStyle Hidden equivalent here)." >&2
  exit 1
fi

# Refuse to race a live sweep. Same lock path and same "is the pid alive" test
# redo-task.sh and launch-detached.sh use, so all three agree on when it is safe
# to start. run-two-workers.sh takes this lock itself; refusing here as well
# means a doomed launch costs nothing rather than a hidden console that exits.
LOCK="${TB_LOCK_FILE:-$REPO/mcp-data/.tb-sweep.lock}"
if [ -f "$LOCK" ]; then
  pid="$(cat "$LOCK" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$pid" ] && ps -W 2>/dev/null | awk -v p="$pid" '$1==p{f=1} END{exit !f}'; then
    echo "REFUSING: a sweep or redo is already running as pid $pid (lock: $LOCK)." >&2
    echo "  One bench at a time is the standing limit, and two sweeps fight over" >&2
    echo "  proxy ports 7425/7426." >&2
    exit 3
  fi
  echo "[launch-sweep] stale lock for dead pid ${pid:-?} -- run-two-workers.sh will clear it."
fi

STAMP="${TB_SWEEP_STAMP:-$(date +%m%d%H%M)}"
export TB_SWEEP_STAMP="$STAMP"
OUT="$HERE/detached-sweep-$STAMP.out"
ERR="$HERE/detached-sweep-$STAMP.err"

# The exact bash.exe the detached shape was measured against, with the same
# PATH fallback launch-detached.sh uses for a differently-laid-out install.
GIT_BASH_WIN="C:\\Program Files\\Git\\bin\\bash.exe"
if [ ! -f "$(cygpath -u "$GIT_BASH_WIN" 2>/dev/null)" ]; then
  GIT_BASH_WIN="$(cygpath -w "$(command -v bash)")"
fi

SCRIPT="${TB_LAUNCH_SWEEP_CMD:-$HERE/run-two-workers.sh}"
SCRIPT_WIN="$(cygpath -w "$SCRIPT")"
OUT_WIN="$(cygpath -w "$OUT")"
ERR_WIN="$(cygpath -w "$ERR")"

# The tasks file stays a POSIX path: it is read by bash (`[ -f "$TASKS_FILE" ]`
# in run-two-workers.sh), not by Win32, and a backslash path reaching a bash
# test is the kind of quiet nothing-matched failure that reads as an empty task
# list. The script and the two redirect targets are consumed by Start-Process
# itself, so those are converted.
PS_ARGS="'$SCRIPT_WIN','$TASKS_ABS'"
PS_CMD="Start-Process -FilePath '$GIT_BASH_WIN' -ArgumentList @($PS_ARGS) -WindowStyle Hidden -RedirectStandardOutput '$OUT_WIN' -RedirectStandardError '$ERR_WIN'"

echo "[launch-sweep] tasks     : $N_TASKS from $TASKS_ABS"
echo "[launch-sweep] prefixes  : ts${STAMP}w0 (:7425)  ts${STAMP}w1 (:7426)"
echo "[launch-sweep] stdout    : $OUT"
echo "[launch-sweep] stderr    : $ERR"
echo "[launch-sweep] watch with: bash $HERE/sweep-status.sh"
echo "[launch-sweep] merge with: bash $HERE/merge-sweep.sh $HERE/jobs ts${STAMP}w0 && bash $HERE/merge-sweep.sh $HERE/jobs ts${STAMP}w1"
echo "[launch-sweep] powershell: $PS_CMD"
echo "[launch-sweep] no completion notification will follow -- read the .out log at your own cadence."

if [ "${TB_LAUNCH_SWEEP_PRINT_ONLY:-0}" = "1" ]; then
  echo "[launch-sweep] PRINT-ONLY -- nothing was launched."
  exit 0
fi

powershell.exe -NoProfile -Command "$PS_CMD"
rc=$?
if [ $rc -ne 0 ]; then
  echo "REFUSING: Start-Process itself failed (exit $rc) -- nothing was launched." >&2
  exit $rc
fi

# A SHORT, BOUNDED convenience wait -- never a completion signal, exactly as
# launch-detached.sh documents. The sweep's first line is its disclosure banner;
# seeing it means the hidden console really came up.
echo "[launch-sweep] waiting up to 30s for the sweep to announce itself..."
for _ in $(seq 1 30); do
  if [ -f "$OUT" ] && grep -q '^\[2w\]' "$OUT" 2>/dev/null; then
    head -n 12 "$OUT"
    exit 0
  fi
  sleep 1
done
echo "[launch-sweep] no banner yet after 30s -- NOT a failure; the detached sweep continues."
echo "[launch-sweep] check $OUT and $ERR directly when you next look."
