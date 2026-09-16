#!/usr/bin/env bash
# Tests for container-mcp-probe.sh's probe_container_mcp_initialize.
#
# FAILS ON THE PRE-CHANGE TREE: container-mcp-probe.sh did not exist, so the
# `source` below binds nothing and every case errors "command not found".
# What it adds did not exist either: nothing checked the MCP path from INSIDE
# A CONTAINER before a trial started -- every existing readiness check
# (run-dg.sh's curl loop) only ever proved the HOST could reach the proxy on
# 127.0.0.1, which is a different network path from host.docker.internal.
#
# Hermetic: a fake `docker` on PATH decides every answer, driven by a counter
# file so "fails N times then succeeds" (the retry-recovers case, mirroring
# mcp-initialize-probe.test.mjs's own load-bearing case) is expressible
# without a real container or a real proxy.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin"

# shellcheck disable=SC1090
source "$HERE/container-mcp-probe.sh"

VALID_INITIALIZE='{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"terransoul-brain","version":"0.0.0"}}}'
MALFORMED='{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'

# $1 = how many `docker run` calls fail before succeeding (0 = always succeeds,
# a huge number = never succeeds). $2 = the body to print on the succeeding call.
make_docker() {
  local fail_first="$1" body="$2"
  cat > "$SANDBOX/bin/docker" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "run" ]; then
  n=\$(( \$(cat "$SANDBOX/calls" 2>/dev/null || echo 0) + 1 ))
  printf '%s' "\$n" > "$SANDBOX/calls"
  if [ "\$n" -le "$fail_first" ]; then
    echo "curl: (7) Failed to connect" >&2
    exit 7
  fi
  printf '%s' '$body'
  exit 0
fi
exit 0
EOF
  chmod +x "$SANDBOX/bin/docker"
}

echo "== docker unavailable: fails open, does not refuse the trial =="
rm -f "$SANDBOX/bin/docker"
# Strip any real docker's directory from PATH -- prepending an empty sandbox
# bin/ is not enough on a machine that actually has Docker Desktop installed,
# since `command -v docker` would still resolve it further down PATH.
NO_DOCKER_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -viE 'docker' | tr '\n' ':')"
out="$(PATH="$SANDBOX/bin:$NO_DOCKER_PATH" probe_container_mcp_initialize 7425 3 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "no docker on PATH returns 0 (fail-open)"; else no "no docker on PATH returns 0 (fail-open)" "rc=$rc"; fi
printf '%s' "$out" | grep -q 'SKIP' && ok "the fail-open case says SKIP, not silently" || no "the fail-open case says SKIP" "$out"

echo "== a working proxy is confirmed on the first attempt =="
: > "$SANDBOX/calls"
make_docker 0 "$VALID_INITIALIZE"
out="$(PATH="$SANDBOX/bin:$PATH" probe_container_mcp_initialize 7425 5 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "a real handshake returns 0"; else no "a real handshake returns 0" "rc=$rc :: $out"; fi
[ "$(cat "$SANDBOX/calls")" = "1" ] && ok "only ONE attempt was needed" || no "only ONE attempt was needed" "calls=$(cat "$SANDBOX/calls")"

echo "== retry recovers a transient refusal — the case this fix exists for =="
: > "$SANDBOX/calls"
make_docker 3 "$VALID_INITIALIZE"
out="$(PATH="$SANDBOX/bin:$PATH" probe_container_mcp_initialize 7425 6 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then ok "recovers after 3 refusals within budget"; else no "recovers after 3 refusals within budget" "rc=$rc :: $out"; fi
[ "$(cat "$SANDBOX/calls")" = "4" ] && ok "took exactly 4 attempts (3 refused + 1 that succeeded)" \
  || no "took exactly 4 attempts" "calls=$(cat "$SANDBOX/calls")"

echo "== a permanent refusal REFUSES the trial, not a silent pass =="
: > "$SANDBOX/calls"
make_docker 999 "$VALID_INITIALIZE"
out="$(PATH="$SANDBOX/bin:$PATH" probe_container_mcp_initialize 7425 4 2>&1)"; rc=$?
if [ "$rc" -eq 1 ]; then ok "an unreachable path returns 1 (refuse)"; else no "an unreachable path returns 1 (refuse)" "rc=$rc"; fi
[ "$(cat "$SANDBOX/calls")" = "4" ] && ok "exhausted exactly the configured retry budget" \
  || no "exhausted exactly the configured retry budget" "calls=$(cat "$SANDBOX/calls")"
printf '%s' "$out" | grep -q 'REFUSING' && ok "the refusal is explicit, not a bare non-zero exit" \
  || no "the refusal is explicit" "$out"

echo "== a malformed response (no protocolVersion) is treated as unconfirmed =="
: > "$SANDBOX/calls"
make_docker 0 "$MALFORMED"
out="$(PATH="$SANDBOX/bin:$PATH" probe_container_mcp_initialize 7425 2 2>&1)"; rc=$?
if [ "$rc" -eq 1 ]; then ok "a malformed body is never accepted as a real handshake"; else no "a malformed body is never accepted" "rc=$rc"; fi

echo "  ---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ]
