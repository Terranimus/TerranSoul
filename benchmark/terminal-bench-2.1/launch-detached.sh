#!/usr/bin/env bash
# Launch redo-task.sh into its OWN hidden Windows console, so it survives a
# concurrent tool call killing the console it would otherwise share.
#
#   usage: launch-detached.sh <task-id> [attempts]
#
#   env passthrough (unchanged, automatic -- see below): TB_REDO_EXPERIMENT,
#   TB_PROXY_PORT, TB_STOP_HOOK, TB_ATTEMPTS, and anything else already
#   exported in the calling shell.
#
#   test/override hooks (never used in production):
#     TB_LAUNCH_DETACHED_CMD   run this script instead of redo-task.sh, with
#                              the SAME calling convention (task, [attempts]).
#     TB_LOCK_FILE             check this path instead of the real sweep lock.
#
# ⛔ WHY THIS EXISTS. MEASURED 2026-09-11 18:53:25. A trial launched through
# the Claude Code Bash tool with `run_in_background` shares that tool's
# Windows console. A CONCURRENT subagent's Bash call hit the tool's ~120s
# auto-background point at that exact second, and harbor (python), the :7425
# auth proxy, and the run-dg/redo bash snapshots all died with exit 1 -- no
# traceback, no cancel path, no result.json -- while the task CONTAINER kept
# running with a healthy agent inside. The measurement was never that the
# container died; it was that the HOST-SIDE HARNESS died because it shared a
# console with a tool call that had nothing to do with it.
#
# THE FIX, measured working for 40+ minutes of concurrent tool calls since:
# give the run its own hidden console via PowerShell's `Start-Process`, so
# nothing any other tool call does to ITS console can reach this one.
#
#     powershell -NoProfile -Command "Start-Process -FilePath '<bash.exe>' `
#       -ArgumentList @('<redo-task.sh>','<task>','<attempts>') `
#       -WindowStyle Hidden -RedirectStandardOutput '<out>' -RedirectStandardError '<err>'"
#
# See launch-detached.test.sh for the exact command this script builds.
#
# NO COMPLETION NOTIFICATION. A detached Start-Process is fire-and-forget from
# this script's point of view: there is no callback, no exit code this shell
# ever observes, nothing to await. THE CALLER READS jobs/<prefix>*/result.json
# (or the .out log) AT ITS OWN CADENCE, exactly like any other redo. The
# bounded wait below is a CONVENIENCE (surface the job prefix quickly when the
# launch is healthy) — it is capped at 20s and never becomes a completion
# signal, because a trial takes far longer than that to finish.
#
# ENVIRONMENT PASSTHROUGH IS AUTOMATIC, NOT SPECIAL-CASED HERE. Windows
# process creation inherits the parent's environment block by default, and
# PowerShell's `Start-Process` does not override that unless its own
# `-Environment` / `-UseNewEnvironment` switch is used (this script uses
# neither). So a variable exported in the shell that calls launch-detached.sh
# reaches powershell.exe, then bash.exe, then redo-task.sh unchanged, across
# three process hops, with zero re-exporting needed in this file.
# launch-detached.test.sh VERIFIES this rather than assuming it: it sets a
# marker env var before launch and checks the detached child actually saw it.
#
# WINDOWS-ONLY. Start-Process and -WindowStyle Hidden have no equivalent used
# here; a non-Windows host gets a one-line refusal, not a half-working launch.
set -uo pipefail

# ── (1) NEVER NEST. redo-task.sh sets TB_REDO_SNAPSHOT=1 when it re-execs
# itself from a byte-frozen snapshot (see its own header comment on why). If
# THIS script were invoked with that already set, it would mean a detached
# launch is being requested from inside an already-running redo, which can
# only double-launch or race the very lock check below.
if [ -n "${TB_REDO_SNAPSHOT:-}" ]; then
  echo "REFUSING: TB_REDO_SNAPSHOT is already set -- refusing to nest a detached" >&2
  echo "  launch inside redo-task.sh's own snapshot re-exec. Run launch-detached.sh" >&2
  echo "  from an ordinary shell, not from inside a redo-task.sh run." >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TASK="${1:-}"
ATTEMPTS="${2:-}"

if [ -z "$TASK" ]; then
  echo "usage: launch-detached.sh <task-id> [attempts]" >&2
  exit 2
fi

# Windows-only: `$OS` is the standard Windows environment variable (set by
# the OS itself, not by this script), present under Git Bash / MSYS / cmd /
# PowerShell alike. A one-line refusal elsewhere is honest -- there is no
# Start-Process / hidden-console equivalent implemented here.
if [ "${OS:-}" != "Windows_NT" ]; then
  echo "REFUSING: launch-detached.sh is Windows-only (no Start-Process/-WindowStyle Hidden equivalent here)." >&2
  exit 1
fi

# ── (6) refuse to race a live sweep. MIRRORS redo-task.sh's LOCK check
# (same lock path, same "is the lockfile's PID actually alive" test via
# `ps -W`) so the two scripts agree on when it is safe to run. The PORT logic
# itself is deliberately NOT re-implemented here: if a sweep is live on a
# non-default TB_PROXY_PORT, this script lets the launch proceed and leaves
# the actual `/dev/tcp/127.0.0.1/<port>` probe to redo-task.sh, which already
# does it once it starts inside the detached process -- duplicating that
# probe here would just be a second, driftable copy of the same check.
LOCK="${TB_LOCK_FILE:-$REPO/mcp-data/.tb-sweep.lock}"
if [ -f "$LOCK" ]; then
  pid="$(cat "$LOCK" 2>/dev/null)"
  if [ -n "$pid" ] && ps -W 2>/dev/null | awk -v p="$pid" '$1==p{f=1} END{exit !f}'; then
    if [ -n "${TB_PROXY_PORT:-}" ] && [ "${TB_PROXY_PORT}" != "7425" ]; then
      echo "[launch-detached] a sweep is live (pid $pid), but TB_PROXY_PORT=$TB_PROXY_PORT is set -- launching alongside it."
      echo "[launch-detached] redo-task.sh will refuse on its own, inside the detached process, if that port turns out to be taken."
    else
      echo "REFUSING: a sweep is running as pid $pid (lock: $LOCK)." >&2
      echo "  Two runs fight over proxy port 7425 and both die -- same reason redo-task.sh refuses." >&2
      echo "  Either stop the sweep, or set TB_PROXY_PORT to a free port (workers hold 7425+w)." >&2
      exit 3
    fi
  fi
  # A stale lock (dead pid) is not this script's business to clear --
  # redo-task.sh does that itself, once, inside the detached process.
fi

# ── (2) Windows paths, via cygpath. `Start-Process -FilePath` and the two
# -RedirectStandard* paths are consumed by a native Win32 process, not by
# bash, so they need Windows-style paths regardless of which path style this
# script itself was invoked with.
STAMP="$(date +%m%d%H%M)"
OUT="$HERE/detached-$TASK-$STAMP.out"
ERR="$HERE/detached-$TASK-$STAMP.err"

# The exact bash.exe this shape was measured against. Fall back to whatever
# `bash` resolves to on PATH if that specific binary is not present (e.g. a
# differently-laid-out Git for Windows install) rather than hard-failing.
GIT_BASH_WIN="C:\\Program Files\\Git\\bin\\bash.exe"
if [ ! -f "$(cygpath -u "$GIT_BASH_WIN" 2>/dev/null)" ]; then
  GIT_BASH_WIN="$(cygpath -w "$(command -v bash)")"
fi

SCRIPT="${TB_LAUNCH_DETACHED_CMD:-$HERE/redo-task.sh}"
SCRIPT_WIN="$(cygpath -w "$SCRIPT")"
OUT_WIN="$(cygpath -w "$OUT")"
ERR_WIN="$(cygpath -w "$ERR")"

# ── (3) build the PowerShell ArgumentList. Only include `attempts` when the
# caller actually passed one -- redo-task.sh has its own default
# (`${TB_ATTEMPTS:-1}`) and re-stating it here would be a second copy of that
# default that can drift from the real one.
PS_ARGS="'$SCRIPT_WIN','$TASK'"
[ -n "$ATTEMPTS" ] && PS_ARGS="$PS_ARGS,'$ATTEMPTS'"

PS_CMD="Start-Process -FilePath '$GIT_BASH_WIN' -ArgumentList @($PS_ARGS) -WindowStyle Hidden -RedirectStandardOutput '$OUT_WIN' -RedirectStandardError '$ERR_WIN'"

echo "[launch-detached] launching : bash $SCRIPT $TASK ${ATTEMPTS:-}"
echo "[launch-detached] stdout    : $OUT"
echo "[launch-detached] stderr    : $ERR"
echo "[launch-detached] no completion notification will follow -- read jobs/<prefix>*/result.json at your own cadence."

powershell.exe -NoProfile -Command "$PS_CMD"
rc=$?
if [ $rc -ne 0 ]; then
  echo "REFUSING: Start-Process itself failed (exit $rc) -- see stderr above; nothing was launched." >&2
  exit $rc
fi

# ── (4) a SHORT, BOUNDED convenience wait -- never a completion signal. 20
# one-second checks, then stop for good: a trial takes far longer than 20s,
# so this is purely "surface the prefix quickly when the launch is healthy",
# not a proxy for "is it done".
echo "[launch-detached] waiting up to 20s for the job prefix to appear in the log..."
prefix_line=""
for _ in $(seq 1 20); do
  if [ -f "$OUT" ]; then
    prefix_line="$(grep -m1 '^\[redo\] prefix' "$OUT" 2>/dev/null || true)"
    [ -n "$prefix_line" ] && break
  fi
  sleep 1
done

if [ -n "$prefix_line" ]; then
  echo "$prefix_line"
else
  echo "[launch-detached] no prefix line yet after 20s -- NOT a failure, the detached run continues regardless."
  echo "[launch-detached] check $OUT directly when you next look."
fi
