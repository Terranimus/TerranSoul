#!/usr/bin/env bash
# Bring up the ISOLATED bench brain on :7424 against mcp-data-tbench-clean, and
# do not return until it is actually usable.
#
#   usage: bash start-bench-brain.sh
#          TB_BENCH_BRAIN_PRINT_ONLY=1 bash start-bench-brain.sh   # dry, for tests
#
# WHY THIS EXISTS: NOTHING STARTED THE BENCH BRAIN, AND THE ONE INSTRUCTION THAT
# LOOKED LIKE IT DID STARTS THE WRONG ONE.
#
# run-dg.sh refuses when :7424 is not healthy and tells the operator to run
# `node scripts/copilot-start-mcp.mjs`. Followed verbatim that script probes the
# PRODUCTION tray first (findExistingMcpServer), finds :7423 healthy, prints
# "reusing it" and EXITS 0 -- having started nothing on :7424. So the documented
# repair for a missing bench brain silently succeeds while leaving the bench
# brain missing, and the next 45 tasks each refuse in seconds (which is the
# preflight halt run-two-workers.sh now carries, added for exactly this shape).
#
# The two variables that matter are named here rather than left to a default:
#   TERRANSOUL_MCP_DATA_DIR   the CLEAN store. Without it the bench brain serves
#                             the product's memories, and learn mode WRITES.
#   TERRANSOUL_MCP_IDLE_TIMEOUT=0
#                             the server's 300 s default idle timeout shuts the
#                             brain down MID-TRIAL: an agent editing code in its
#                             container sends the MCP server nothing for half an
#                             hour, and the Stop hook then files its verification
#                             against `upstream unreachable` (measured
#                             2026-09-01, filter-js-from-html).
#
# 200 FROM /health IS NOT READY, AND HEALTHY IS NOT ISOLATED. Both have cost
# trials here: a brain answering 200 with llm_provider_state "degraded" let two
# of three trials run against a model that had not loaded (2026-08-30), and a
# brain started through copilot-start-mcp.mjs reported the SAME memory_total as
# production (2026-08-31) -- isolation that existed only in the operator's
# intention. So this waits for all three properties and says which one it is
# still waiting on.
#
# IDEMPOTENT by design: a brain that is already up, ready and isolated is left
# strictly alone and this exits 0. One MCP at a time is the standing rule; this
# script must never be the thing that starts a second one.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${TB_REPO_OVERRIDE:-$(cd "$HERE/../.." && pwd)}"

PORT="${TB_BRAIN_PORT:-7424}"
PROD_PORT="${TB_PROD_BRAIN_PORT:-7423}"
DATA="${TB_BRAIN_DATA:-$REPO/mcp-data-tbench-clean}"
BIN="${TB_BENCH_BRAIN_BIN:-$REPO/target-mcp/release/terransoul.exe}"
WAIT_S="${TB_BENCH_BRAIN_WAIT_S:-300}"
TOKEN_FILE="$DATA/mcp-token.txt"

# THE PRODUCTION TRAY IS NEVER THIS SCRIPT'S TARGET. A TB_BRAIN_PORT of 7423
# would make every "start" -- and every later stop-bench-brain.sh -- act on the
# brain the product uses. Refuse rather than trust the caller.
if [ "$PORT" = "$PROD_PORT" ]; then
  echo "[bench-brain] REFUSING: TB_BRAIN_PORT=$PORT is the production brain's port." >&2
  echo "[bench-brain] The bench brain is a SEPARATE instance on its own port and store." >&2
  exit 2
fi

_health_body() { # <port> -> body on stdout (empty when unreachable)
  curl -s -m 5 "http://127.0.0.1:$1/health" 2>/dev/null || true
}

_json_field() { # <field> ; body on stdin -> value or empty
  node -e 'let d="";const f=process.argv[1];process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d)[f];console.log(v===undefined||v===null?"":String(v))}catch(e){console.log("")}});' "$1" 2>/dev/null || echo ""
}

_tools_list_code() { # <port> <token> -> http code
  curl -s -m 8 -o /dev/null -w '%{http_code}' \
    -X POST "http://127.0.0.1:$1/mcp" \
    -H "Authorization: Bearer $2" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 2>/dev/null || echo "000"
}

# Returns 0 when :$PORT is up, READY and ISOLATED, printing a one-line state.
# The three conditions are reported separately on purpose: "brain not ready" and
# "brain is serving the production store" need completely different responses,
# and a single boolean hides which one happened.
bench_brain_is_usable() {
  local body state total prod_body prod_total token code
  body="$(_health_body "$PORT")"
  if [ -z "$body" ]; then echo "no /health answer on :$PORT"; return 1; fi

  state="$(printf '%s' "$body" | _json_field llm_provider_state)"
  case "$state" in
    ready|ok|healthy) ;;
    ""|null|unknown)
      # A CLI-backed brain publishes no provider state at all (the tray only
      # probes Ollama), so for that configuration the honest readiness proof is
      # that it SERVES tool calls -- which is also what run-dg.sh falls back to.
      token="$(tr -d '\r\n' < "$TOKEN_FILE" 2>/dev/null || true)"
      if [ -z "$token" ]; then echo "llm_provider_state '$state' and no token at $TOKEN_FILE"; return 1; fi
      code="$(_tools_list_code "$PORT" "$token")"
      if [ "$code" != "200" ]; then echo "llm_provider_state '$state' and tools/list returned $code"; return 1; fi
      ;;
    *) echo "llm_provider_state is '$state' (not ready)"; return 1 ;;
  esac

  # ISOLATION, PROVED TWO WAYS.
  # (1) The token that authenticates :$PORT lives in the CLEAN store. A brain
  #     started against the production data dir writes its token into mcp-data/
  #     instead, so this check still fires when :7423 is down -- which the
  #     memory_total comparison alone cannot do.
  token="$(tr -d '\r\n' < "$TOKEN_FILE" 2>/dev/null || true)"
  if [ -z "$token" ]; then echo "no bench token at $TOKEN_FILE"; return 1; fi
  code="$(_tools_list_code "$PORT" "$token")"
  if [ "$code" != "200" ]; then
    echo "tools/list on :$PORT returned $code with the CLEAN store's token -- this brain is not serving $DATA"
    return 1
  fi

  # (2) memory_total differs from production's. Only checkable when :$PROD_PORT
  #     answers; a silent skip would be the failure this block exists to stop,
  #     so the skip is stated in the line this prints.
  total="$(printf '%s' "$body" | _json_field memory_total)"
  prod_body="$(_health_body "$PROD_PORT")"
  if [ -n "$prod_body" ]; then
    prod_total="$(printf '%s' "$prod_body" | _json_field memory_total)"
    if [ -n "$total" ] && [ -n "$prod_total" ] && [ "$total" = "$prod_total" ]; then
      echo "memory_total $total is IDENTICAL to the production brain's on :$PROD_PORT -- not isolated"
      return 1
    fi
    echo "ready; memory_total=$total (production :$PROD_PORT=$prod_total)"
  else
    echo "ready; memory_total=$total (production :$PROD_PORT unreachable, so only the token proves isolation)"
  fi
  return 0
}

reason="$(bench_brain_is_usable)"
usable=$?

# CHECK-ONLY is how preflight-sweep.sh asks this question, so that the sweep's
# pre-launch checklist and the sweep's own start-up agree on what "the bench
# brain is usable" means by calling the SAME code rather than a second copy of
# it that can drift.
if [ "${TB_BENCH_BRAIN_CHECK_ONLY:-0}" = "1" ]; then
  echo "[bench-brain] :$PORT $reason"
  exit "$usable"
fi

if [ "$usable" -eq 0 ]; then
  echo "[bench-brain] :$PORT already up -- $reason"
  echo "[bench-brain] nothing started (one MCP at a time is the standing rule)."
  exit 0
fi
echo "[bench-brain] :$PORT not usable yet -- $reason"

# SOMETHING IS ALREADY ON THE PORT AND IT IS NOT THE BRAIN WE WANT.
# Launching anyway cannot help: the second process loses the bind, exits, and
# the sweep then runs against whatever is answering -- which in the case this
# guards (a brain started through copilot-start-mcp.mjs, serving the PRODUCTION
# store on the bench port, measured 2026-08-31) is the one outcome learn mode
# exists to prevent, because learn mode WRITES. Refuse and name the repair.
if [ -n "$(_health_body "$PORT")" ]; then
  echo "[bench-brain] REFUSING: :$PORT already answers /health but is not ready+isolated." >&2
  echo "[bench-brain] Starting a second process cannot take the port from the first one," >&2
  echo "[bench-brain] so the sweep would run against THIS brain. Stop it first:" >&2
  echo "[bench-brain]   bash $HERE/stop-bench-brain.sh" >&2
  echo "[bench-brain] then re-run this script." >&2
  exit 2
fi

if [ ! -f "$BIN" ]; then
  echo "[bench-brain] REFUSING: no MCP binary at $BIN" >&2
  echo "[bench-brain] build it with:" >&2
  echo "[bench-brain]   cargo build --release --no-default-features --features headless-mcp \\" >&2
  echo "[bench-brain]     --manifest-path src-tauri/Cargo.toml --target-dir target-mcp" >&2
  exit 2
fi
mkdir -p "$DATA"

# HIDDEN + DETACHED, for the same measured reason launch-detached.sh is.
# A brain started from a shell that shares a Windows console with a tool call
# dies when that console does. This one has to outlive a 20-40 h sweep, so it
# gets its own hidden console via Start-Process, exactly as launch-detached.sh
# does for a trial. Environment inheritance across bash -> powershell -> child is
# automatic (Start-Process is used without -UseNewEnvironment), which is why the
# three variables are EXPORTED here rather than spliced into the command line.
export TERRANSOUL_MCP_PORT="$PORT"
export TERRANSOUL_MCP_DATA_DIR="$DATA"
export TERRANSOUL_MCP_IDLE_TIMEOUT=0

OUT="$DATA/bench-brain.out"
ERR="$DATA/bench-brain.err"

BIN_WIN="$(cygpath -w "$BIN" 2>/dev/null || printf '%s' "$BIN")"
OUT_WIN="$(cygpath -w "$OUT" 2>/dev/null || printf '%s' "$OUT")"
ERR_WIN="$(cygpath -w "$ERR" 2>/dev/null || printf '%s' "$ERR")"
REPO_WIN="$(cygpath -w "$REPO" 2>/dev/null || printf '%s' "$REPO")"

# `--mcp-tray` is the flag scripts/copilot-start-mcp.mjs passes to this same
# binary (its `childArgs = ['--mcp-tray']`); mirrored rather than guessed.
PS_CMD="Start-Process -FilePath '$BIN_WIN' -ArgumentList @('--mcp-tray') -WorkingDirectory '$REPO_WIN' -WindowStyle Hidden -RedirectStandardOutput '$OUT_WIN' -RedirectStandardError '$ERR_WIN'"

echo "[bench-brain] port      : $PORT"
echo "[bench-brain] data dir  : $DATA"
echo "[bench-brain] idle      : TERRANSOUL_MCP_IDLE_TIMEOUT=0 (must outlive the longest trial)"
echo "[bench-brain] binary    : $BIN"
echo "[bench-brain] powershell: $PS_CMD"

if [ "${TB_BENCH_BRAIN_PRINT_ONLY:-0}" = "1" ]; then
  echo "[bench-brain] PRINT-ONLY -- nothing was launched."
  exit 0
fi

powershell.exe -NoProfile -Command "$PS_CMD"
rc=$?
if [ $rc -ne 0 ]; then
  echo "[bench-brain] REFUSING: Start-Process failed (exit $rc); nothing was launched." >&2
  exit $rc
fi

deadline=$(( $(date +%s) + WAIT_S ))
last=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 2
  last="$(bench_brain_is_usable)"
  if [ $? -eq 0 ]; then
    echo "[bench-brain] UP on :$PORT -- $last"
    exit 0
  fi
done

echo "[bench-brain] REFUSING: :$PORT did not become usable within ${WAIT_S}s." >&2
echo "[bench-brain] last state: $last" >&2
echo "[bench-brain] log tail ($ERR):" >&2
tail -n 20 "$ERR" 2>/dev/null >&2 || true
exit 2
