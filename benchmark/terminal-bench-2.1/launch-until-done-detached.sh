#!/usr/bin/env bash
# Launch sweep-until-done.sh into its OWN hidden Windows console, so the
# supervisor that carries a sweep ACROSS quota walls outlives the console that
# started it.
#
#   usage: bash launch-until-done-detached.sh <tasks-file> [--stamps-file <path>]
#          TB_LAUNCH_UNTIL_DONE_PRINT_ONLY=1 bash launch-until-done-detached.sh <tasks-file>
#
# WHY THIS EXISTS, given launch-sweep-detached.sh already detaches the sweep.
# The SWEEP is detached; the supervisor was not. sweep-until-done.sh sleeps for
# hours waiting out a session cap, and a supervisor living in the Claude Code
# Bash tool's shared Windows console dies at that tool's ~120 s auto-background
# point (measured 2026-09-11 18:53:25) — leaving the current sweep running and
# NOBODY to relaunch it at the reset. Detaching the sweep but not its supervisor
# buys exactly one wall's worth of autonomy.
#
# Same Start-Process shape, same bash.exe, same PRINT_ONLY test hook as
# launch-sweep-detached.sh — deliberately, because that shape is the measured
# one. Output lands in detached-until-done-<MMDDHHMM>.out/.err.
#
# WINDOWS-ONLY, like its sibling: a non-Windows host gets a one-line refusal.
set -uo pipefail

if [ -n "${TB_REDO_SNAPSHOT:-}" ]; then
  echo "REFUSING: TB_REDO_SNAPSHOT is already set -- refusing to launch a sweep supervisor" >&2
  echo "  from inside redo-task.sh's snapshot re-exec. Run this from an ordinary shell." >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TASKS_FILE="${1:-}"

if [ -z "$TASKS_FILE" ] || [ ! -f "$TASKS_FILE" ]; then
  echo "usage: bash launch-until-done-detached.sh <tasks-file> [--stamps-file <path>]" >&2
  exit 2
fi
shift
EXTRA_ARGS=("$@")
TASKS_ABS="$(cd "$(dirname "$TASKS_FILE")" && pwd)/$(basename "$TASKS_FILE")"
N_TASKS="$(tr '\n' ' ' < "$TASKS_ABS" | wc -w | tr -d ' ')"
if [ "$N_TASKS" -eq 0 ]; then
  echo "REFUSING: $TASKS_ABS lists no tasks." >&2
  exit 2
fi

if [ "${OS:-}" != "Windows_NT" ]; then
  echo "REFUSING: launch-until-done-detached.sh is Windows-only (no Start-Process/-WindowStyle Hidden equivalent here)." >&2
  exit 1
fi

# Refuse to race a live sweep, for the same reason and with the same protocol as
# launch-sweep-detached.sh: the supervisor's first act is to launch a sweep, and
# two sweeps fight over proxy ports 7425/7426. Refusing here costs nothing;
# refusing inside the hidden console costs a console nobody is watching.
LOCK="${TB_LOCK_FILE:-$REPO/mcp-data/.tb-sweep.lock}"
if [ -f "$LOCK" ]; then
  pid="$(cat "$LOCK" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$pid" ] && ps -W 2>/dev/null | awk -v p="$pid" '$1==p{f=1} END{exit !f}'; then
    echo "REFUSING: a sweep or redo is already running as pid $pid (lock: $LOCK)." >&2
    echo "  One bench at a time is the standing limit." >&2
    exit 3
  fi
  echo "[launch-until-done] stale lock for dead pid ${pid:-?} -- run-two-workers.sh will clear it."
fi

STAMP="${TB_UNTIL_DONE_LAUNCH_STAMP:-$(date +%m%d%H%M)}"
OUT="$HERE/detached-until-done-$STAMP.out"
ERR="$HERE/detached-until-done-$STAMP.err"

GIT_BASH_WIN="C:\\Program Files\\Git\\bin\\bash.exe"
if [ ! -f "$(cygpath -u "$GIT_BASH_WIN" 2>/dev/null)" ]; then
  GIT_BASH_WIN="$(cygpath -w "$(command -v bash)")"
fi

SCRIPT="${TB_LAUNCH_UNTIL_DONE_CMD:-$HERE/sweep-until-done.sh}"
SCRIPT_WIN="$(cygpath -w "$SCRIPT")"
OUT_WIN="$(cygpath -w "$OUT")"
ERR_WIN="$(cygpath -w "$ERR")"

# The tasks file (and any --stamps-file) stay POSIX paths: they are read by
# bash, not by Win32, and a backslash path reaching a bash `[ -f ]` is the kind
# of quiet nothing-matched failure that reads as an empty task list. Only the
# script and the two redirect targets are consumed by Start-Process itself.
PS_ARGS="'$SCRIPT_WIN','$TASKS_ABS'"
for a in ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}; do PS_ARGS="$PS_ARGS,'$a'"; done
PS_CMD="Start-Process -FilePath '$GIT_BASH_WIN' -ArgumentList @($PS_ARGS) -WindowStyle Hidden -RedirectStandardOutput '$OUT_WIN' -RedirectStandardError '$ERR_WIN'"

echo "[launch-until-done] tasks     : $N_TASKS from $TASKS_ABS"
echo "[launch-until-done] supervisor: $SCRIPT"
echo "[launch-until-done] stdout    : $OUT"
echo "[launch-until-done] stderr    : $ERR"
echo "[launch-until-done] watch with: tail -f $OUT   (every state transition prints one [until-done] line)"
echo "[launch-until-done] powershell: $PS_CMD"
echo "[launch-until-done] no completion notification will follow -- read the .out log at your own cadence."

if [ "${TB_LAUNCH_UNTIL_DONE_PRINT_ONLY:-0}" = "1" ]; then
  echo "[launch-until-done] PRINT-ONLY -- nothing was launched."
  exit 0
fi

powershell.exe -NoProfile -Command "$PS_CMD"
rc=$?
if [ $rc -ne 0 ]; then
  echo "REFUSING: Start-Process itself failed (exit $rc) -- nothing was launched." >&2
  exit $rc
fi

# A SHORT, BOUNDED convenience wait -- never a completion signal. The
# supervisor's first line is its own banner; seeing it means the hidden console
# really came up.
echo "[launch-until-done] waiting up to 30s for the supervisor to announce itself..."
for _ in $(seq 1 30); do
  if [ -f "$OUT" ] && grep -q '^\[until-done\]' "$OUT" 2>/dev/null; then
    head -n 8 "$OUT"
    exit 0
  fi
  sleep 1
done
echo "[launch-until-done] no banner yet after 30s -- NOT a failure; the detached supervisor continues."
echo "[launch-until-done] check $OUT and $ERR directly when you next look."
