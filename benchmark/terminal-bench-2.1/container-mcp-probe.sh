#!/usr/bin/env bash
# container-mcp-probe.sh — F1 of TBENCH-K1-100-LOOP-1's brain-connectivity
# fixes: an in-container MCP `initialize` probe.
#
# ⛔ WHY THIS EXISTS. Forensics over the 2026-09 corpus found 22 trials
# corpus-wide that started with the in-container MCP connection NEVER
# established: Claude Code, running inside the trial container, got
# ConnectionRefused talking to mcp-auth-proxy.mjs at `host.docker.internal`
# and never retries. Every check that ran before those trials -- run-dg.sh's
# own readiness loop included -- only ever proved the proxy answers on
# 127.0.0.1, i.e. from the HOST. That is a DIFFERENT network path: Docker
# Desktop's `host.docker.internal` is not the loopback interface, and a proxy
# reachable from the host can still be unreachable, or reachable only after a
# delay, from inside a container. A listening port with a dead or
# misconfigured MCP layer behind it, or a proxy whose listener has not
# settled yet, passed every pre-existing check.
#
# This closes that gap the same way preflight-sweep.sh's "container TLS"
# check already proves a real handshake rather than a status code (see its
# own header comment): a THROWAWAY CONTAINER, not the host, sends the probe --
# so what is measured is the exact path Claude Code will use. It sends the
# real MCP `initialize` method (not `tools/list`; router.rs answers
# `initialize` with `protocolVersion` + `serverInfo`, which is what is
# checked for) and retries, because the whole point is that Claude Code
# itself does not: this probe absorbs a transient refusal (the proxy's
# listener not fully bound yet, the container's network path still settling)
# so it never reaches the agent as a silent, permanent ConnectionRefused.
#
# FAILS CLOSED ON WHAT IT CAN DECIDE, FAILS OPEN ON WHAT IT CANNOT, matching
# preflight-sweep.sh's stated policy: no docker on PATH means this cannot be
# checked, and refusing every trial because docker is momentarily absent from
# PATH would be worse than not checking.
#
#   probe_container_mcp_initialize <port> [retries] [image]
#   returns 0  = handshake confirmed (or docker unavailable to check with)
#   returns 1  = REFUSE the trial: never confirmed after every retry
probe_container_mcp_initialize() {
  local port="$1" retries="${2:-6}" img="${3:-${TB_NET_PREFLIGHT_IMAGE:-curlimages/curl:latest}}"
  if [ -z "$port" ]; then
    echo "[mcp-probe] usage: probe_container_mcp_initialize <port> [retries] [image]" >&2
    return 1
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "[mcp-probe] SKIP: no docker on PATH -- cannot check the container network path" >&2
    return 0
  fi
  local body='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"tb-container-mcp-probe","version":"1"}}}'
  local i out rc
  for i in $(seq 1 "$retries"); do
    out="$(docker run --rm "$img" -sS -m 8 -X POST "http://host.docker.internal:$port/mcp" \
      -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -d "$body" 2>/dev/null)"
    rc=$?
    if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '"protocolVersion"'; then
      echo "[mcp-probe] OK: container-network MCP initialize confirmed on attempt $i/$retries (host.docker.internal:$port)"
      return 0
    fi
    sleep 0.5
  done
  echo "[mcp-probe] REFUSING: host.docker.internal:$port never completed a real MCP initialize" >&2
  echo "[mcp-probe] handshake from inside a throwaway container, after $retries attempt(s)." >&2
  echo "[mcp-probe] The host-side proxy check passing does NOT prove this path works --" >&2
  echo "[mcp-probe] host.docker.internal is not the loopback interface. Last response: ${out:-<none>}" >&2
  return 1
}
