#!/usr/bin/env bash
# Stop the ISOLATED bench brain on :7424, and NOTHING ELSE.
#
#   usage: bash stop-bench-brain.sh
#
# THE ONLY REQUIREMENT THAT MATTERS IS THE NEGATIVE ONE: this must never touch
# the production tray on :7423. A bench teardown that stops the product's brain
# is worse than a bench teardown that does nothing -- the operator's next coding
# session comes up with no memory and no warning, and the cause is a script that
# ran hours earlier. So there are three independent guards, and any one of them
# refusing means nothing is killed:
#
#   1. the port must not be the production port (checked before anything else);
#   2. the pid must actually be LISTENING on that port right now;
#   3. that pid's command line must be a terransoul binary -- never a stranger
#      that merely happens to hold the port (the same identity gate
#      run-two-workers.sh applies before reclaiming a proxy port, added after a
#      blunt kill on 2026-09-07 destroyed two live trials).
#
# netstat -ano reports WINDOWS pids, which is what taskkill consumes, so no
# msys/WINPID translation is needed here (unlike killing a bash worker).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${TB_REPO_OVERRIDE:-$(cd "$HERE/../.." && pwd)}"

PORT="${TB_BRAIN_PORT:-7424}"
PROD_PORT="${TB_PROD_BRAIN_PORT:-7423}"
DATA="${TB_BRAIN_DATA:-$REPO/mcp-data-tbench-clean}"

if [ "$PORT" = "$PROD_PORT" ]; then
  echo "[bench-brain] REFUSING: TB_BRAIN_PORT=$PORT is the PRODUCTION brain's port." >&2
  echo "[bench-brain] This script only ever stops the isolated bench brain." >&2
  exit 2
fi

_listener_pid() { # <port> -> WINDOWS pid, empty when free
  netstat -ano 2>/dev/null | tr -d '\r' \
    | awk -v suf=":$1" '$1=="TCP" && $4=="LISTENING" && index($2, suf) == length($2)-length(suf)+1 {print $5; exit}'
}

_is_terransoul() { # <windows pid>
  local pid="$1"; [ -n "$pid" ] || return 1
  if command -v wmic >/dev/null 2>&1; then
    wmic process where "ProcessId=$pid" get CommandLine 2>/dev/null | tr -d '\r' | grep -qi 'terransoul'
  elif command -v tasklist >/dev/null 2>&1; then
    tasklist //FI "PID eq $pid" //NH 2>/dev/null | grep -qi 'terransoul'
  else
    return 1
  fi
}

pid="$(_listener_pid "$PORT")"
if [ -z "$pid" ]; then
  echo "[bench-brain] :$PORT is already free -- nothing to stop."
  exit 0
fi

if ! _is_terransoul "$pid"; then
  echo "[bench-brain] REFUSING: :$PORT is held by pid $pid, which is NOT a terransoul process." >&2
  echo "[bench-brain] Refusing to kill an unrelated service that merely holds this port." >&2
  exit 2
fi

echo "[bench-brain] stopping bench brain pid $pid on :$PORT ($DATA)"
if command -v taskkill >/dev/null 2>&1; then
  taskkill //PID "$pid" //T //F >/dev/null 2>&1 || true
else
  kill -9 "$pid" 2>/dev/null || true
fi

for _ in $(seq 1 20); do
  [ -z "$(_listener_pid "$PORT")" ] && break
  sleep 0.5
done

if [ -n "$(_listener_pid "$PORT")" ]; then
  echo "[bench-brain] :$PORT is STILL held after killing pid $pid." >&2
  exit 2
fi

# The pidfile copilot-start-mcp.mjs would have written for an explicit data dir
# lives beside that data dir, so clearing it here cannot disturb the production
# tray's own pidfile under mcp-data/ (the 2026-09-01 clobber).
rm -f "$DATA/self_improve_mcp_process.pid" 2>/dev/null || true
echo "[bench-brain] stopped; production brain on :$PROD_PORT untouched."
