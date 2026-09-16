#!/usr/bin/env bash
# The proxy's lifecycle status/death log (TBENCH-BRAIN-CONNECT-1, fix F2).
#
# WHY THIS EXISTS. Forensics over the 2026-09 corpus found 22 trials
# corpus-wide that started with the in-container MCP connection NEVER
# established: Claude Code got ConnectionRefused talking to this proxy and
# never retries. The proxy's own tool-call log (TB_PROXY_LOG) stayed
# completely empty for every one of them -- a connection that never happened
# produces nothing to log there -- so nothing on disk said WHY the trial had
# no brain. This test proves two things landed:
#
#   (a) the proxy logs READY only once it can actually serve a request (token
#       loaded AND the socket bound), not merely "the process started";
#   (b) the proxy writes a DEATH LOG entry on a crash it previously could not
#       even observe: EADDRINUSE from a stale sibling holding the port, which
#       run-dg.sh's own comments document by hand as unhandled ("the proxy
#       registers no 'error' handler on its server").
#
# FAILS ON THE PRE-CHANGE TREE: STATUS_LOG_PATH / writeStatus() did not exist,
# so no `*.status.jsonl` file is ever created and every check below reads a
# missing file. The EADDRINUSE case crashed via Node's default uncaught-error
# behaviour (an unhandled 'error' event on the server) with nothing recorded.
#
# Hermetic: no upstream brain, no docker, no network beyond 127.0.0.1. The
# proxy needs no live upstream to start -- it only ever contacts UPSTREAM when
# a request arrives, and this test sends none.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0
ok(){ echo "  ok   $1"; pass=$((pass+1)); }
no(){ echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

SANDBOX="$(mktemp -d)"
PROXY1_PID=""
PROXY2_PID=""
cleanup() {
  [ -n "$PROXY1_PID" ] && kill "$PROXY1_PID" 2>/dev/null
  [ -n "$PROXY2_PID" ] && kill "$PROXY2_PID" 2>/dev/null
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

PORT=$(( 17000 + (RANDOM % 2000) ))
LOG1="$SANDBOX/proxy1-calls.jsonl"
STATUS1="$LOG1.status.jsonl"
LOG2="$SANDBOX/proxy2-calls.jsonl"
STATUS2="$LOG2.status.jsonl"

echo "== proxy 1 logs READY once it can actually serve a request =="
TERRANSOUL_MCP_TOKEN="test-token-$$" \
TB_PROXY_PORT="$PORT" \
TB_PROXY_LOG="$LOG1" \
  node "$HERE/mcp-auth-proxy.mjs" > "$SANDBOX/proxy1.out" 2>&1 &
PROXY1_PID=$!

ready1=""
for _ in $(seq 1 40); do
  if [ -f "$STATUS1" ] && grep -q '"event":"ready"' "$STATUS1" 2>/dev/null; then
    ready1="1"
    break
  fi
  sleep 0.25
done
if [ -n "$ready1" ]; then
  ok "proxy 1 wrote a ready status event"
else
  no "proxy 1 wrote a ready status event" "no ready event in $STATUS1 after 10s :: $(cat "$SANDBOX/proxy1.out" 2>/dev/null | tail -5)"
fi

check_field() { # <file> <needle> <label>
  if [ -f "$1" ] && grep -q "$2" "$1" 2>/dev/null; then ok "$3"; else no "$3" "missing '$2' in $1"; fi
}
check_field "$STATUS1" '"ready":true' "the ready event's own 'ready' field is true"
check_field "$STATUS1" "\"port\":$PORT" "the ready event names the port actually bound"

echo "== proxy 2 dies on EADDRINUSE and records WHY =="
# Proxy 1 is still holding $PORT. Proxy 2 tries to bind the SAME port -- this
# is exactly the shape run-dg.sh's own comments describe: a proxy that "dies
# instantly on EADDRINUSE" with, pre-fix, no error handler and no record.
TERRANSOUL_MCP_TOKEN="test-token-$$" \
TB_PROXY_PORT="$PORT" \
TB_PROXY_LOG="$LOG2" \
  node "$HERE/mcp-auth-proxy.mjs" > "$SANDBOX/proxy2.out" 2>&1 &
PROXY2_PID=$!

crashed2=""
for _ in $(seq 1 40); do
  if [ -f "$STATUS2" ] && grep -q '"event":"crash"' "$STATUS2" 2>/dev/null; then
    crashed2="1"
    break
  fi
  # A live process that never crashed would also never exit; guard against an
  # infinite wait if the port happened to be free (extremely unlikely given
  # proxy 1 is still up, but a stuck loop must still terminate cleanly).
  kill -0 "$PROXY2_PID" 2>/dev/null || break
  sleep 0.25
done
if [ -n "$crashed2" ]; then
  ok "proxy 2 wrote a crash status event on port collision"
else
  no "proxy 2 wrote a crash status event on port collision" "no crash event in $STATUS2 :: $(cat "$SANDBOX/proxy2.out" 2>/dev/null | tail -5)"
fi
check_field "$STATUS2" 'listen error' "the crash reason names it as a listen error, not a generic message"
check_field "$STATUS2" "$PORT" "the crash reason names the port that collided"

echo "== proxy 1 was never touched by proxy 2's death =="
if kill -0 "$PROXY1_PID" 2>/dev/null; then
  ok "proxy 1 is still alive after proxy 2 crashed"
else
  no "proxy 1 is still alive after proxy 2 crashed" "proxy 1 (pid $PROXY1_PID) is gone"
fi
# Proxy 1 must not falsely report a crash of its own just because a sibling
# collided with it on the same port.
if grep -q '"event":"crash"' "$STATUS1" 2>/dev/null; then
  no "proxy 1's status log holds no crash of its own" "found a crash entry in $STATUS1"
else
  ok "proxy 1's status log holds no crash of its own"
fi

echo "  ---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ]
