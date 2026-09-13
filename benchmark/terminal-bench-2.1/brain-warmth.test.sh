#!/usr/bin/env bash
# Regression test for TBENCH-COLD-BRAIN-1 (measured 2026-08-30).
#
# WHY THIS FAILS ON THE PRE-CHANGE TREE (rules/tests-must-be-able-to-fail.md):
# run-dg.sh's brain preflight was exactly one line --
#     [ "$code" = "200" ] || { echo "brain not healthy..."; exit 2; }
# -- so a brain whose HTTP server is up but whose LLM provider is still cold
# passed the gate. Case 1 stands up a server returning HTTP 200 with
# `llm_provider_state: "degraded"` and asserts run-dg.sh REFUSES; pre-change it
# sails past that check and goes on to start a container. Case 2 asserts a
# healthy payload is still accepted, so the gate is not simply always-refusing.
#
# What the defect cost: brain restarted 01:48, run launched 01:49 on a 200.
# mteb-retrieve made ZERO MCP calls, filter-js 2 (down from 11 on the same task
# 40 min before), and only extract-elf -- 25 min in, model finally loaded --
# behaved normally. Two of three trials measured plain Claude Code.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
fails=0
ok()  { echo "  PASS  $1"; }
bad() { echo "  FAIL  $1"; fails=$((fails+1)); }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"; [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null' EXIT

PORT="${TB_TEST_PORT:-7433}"
start_fake_brain() {
  # STATE = the Ollama-style llm_provider_state; PROVIDER=claude_cli switches
  # the persona to a CLI-backed brain (llm_provider_state null, as the real tray
  # reports it) whose POST /mcp answers a judge call with VERDICT=verdict (a
  # real boolean verdict, JSON-escaped inside the MCP text block exactly as the
  # gateway wraps it) or VERDICT=none (a non-verdict, the fail-open shape).
  STATE="$1" PROVIDER="${2:-ollama}" VERDICT="${3:-verdict}" node -e '
const http=require("http");
const state=process.env.STATE, provider=process.env.PROVIDER, verdict=process.env.VERDICT;
http.createServer((req,res)=>{
  if (req.method==="POST" && req.url==="/mcp") {
    let body=""; req.on("data",c=>body+=c).on("end",()=>{
      const judge = verdict==="verdict"
        ? {method:"llm_judge",verified:true,reason:"probe ok",verdict_absent:false}
        : {method:"llm_judge",verdict_absent:true,note:"judge returned no verdict"};
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify({jsonrpc:"2.0",id:1,result:{content:[{type:"text",text:JSON.stringify(judge)}]}}));
    });
    return;
  }
  res.writeHead(200,{"content-type":"application/json"});
  const payload = provider==="claude_cli"
    ? {status:"ok",brain_provider:"claude_cli",brain_model:null,llm_provider_state:null,llm_provider_detail:null,memory_total:0,port:Number(process.env.PORT)}
    : {status:"ok",brain_provider:"ollama",llm_provider_state:state,
       llm_provider_detail:state==="degraded"?"model not in /api/ps (cold start)":"/api/tags ok",
       memory_total:0,port:Number(process.env.PORT)};
  res.end(JSON.stringify(payload));
}).listen(Number(process.env.PORT),"127.0.0.1");
' &
  SRV=$!
  for _ in 1 2 3 4 5 6 7 8; do
    curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

run_gate() {
  TB_BRAIN_PORT="$PORT" TB_BRAIN_DATA="$REPO/mcp-data-tbench-clean" \
  TB_JOBS_DIR="$TMP/jobs" TB_AGENT="terransoul_hook:TerranSoulHook" \
  TB_TASKS_DIR="C:/Users/DevStar/.cache/harbor/tasks/packages/terminal-bench" \
  TB_STOP_HOOK=1 \
  TB_PREFLIGHT_ONLY=1 TB_SKIP_TOKEN_REFRESH=1 TB_SKIP_TOKEN_PROBE=1 TB_TOKEN_STATIC=1 \
  TB_TOKEN_FILE="$TMP/tok.env" TB_WARMTH_MAX_S="${1:-30}" \
    timeout 180 bash "$HERE/run-dg.sh" mteb-retrieve 2>&1
}
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "test-token-not-used-probe-skipped" > "$TMP/tok.env"

echo "case 1: a COLD brain (200 + degraded) is refused before any trial starts"
PORT="$PORT" start_fake_brain degraded || { echo "  SKIP  could not start fake brain"; }
out="$(run_gate 30)"; rc=$?
kill "$SRV" 2>/dev/null; SRV=""
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "still 'degraded'"; then
  ok "cold brain refused with exit 2"
elif printf '%s' "$out" | grep -q "preflight-only: credential is live"; then
  bad "a COLD brain was accepted (rc=$rc) -- this is the pre-change behaviour"
else
  bad "unexpected outcome rc=$rc"; printf '%s\n' "$out" | sed -n '1,6p' | sed 's/^/        /'
fi

echo "case 2: a WARM brain is still accepted"
PORT="$PORT" start_fake_brain healthy || echo "  SKIP  could not start fake brain"
out2="$(run_gate 30)"; rc2=$?
kill "$SRV" 2>/dev/null; SRV=""
if printf '%s' "$out2" | grep -q "brain LLM provider: healthy"; then
  ok "warm brain accepted by the warmth gate"
else
  bad "a healthy brain was not accepted (rc=$rc2)"; printf '%s\n' "$out2" | sed -n '1,6p' | sed 's/^/        /'
fi

# ── TBENCH-TEACHER-REVIEW-1 (2026-09-11): a CLI-backed brain ────────────────
# WHY THESE FAIL ON THE PRE-CHANGE TREE: the gate read only llm_provider_state,
# which the tray leaves null in claude_cli mode, so case 3's brain -- one that
# answers a REAL judge call -- was refused after the warmth deadline with
# "still 'unknown'" (measured live 2026-09-11 20:48 on the first teacher-student
# launch). Case 4 guards the other direction: a claude_cli brain whose judge
# returns no verdict must still be refused, so the new branch is not a bypass.
echo "case 3: a claude_cli brain (llm_provider_state null) that answers a judge call is accepted"
PORT="$PORT" start_fake_brain healthy claude_cli verdict || echo "  SKIP  could not start fake brain"
out3="$(run_gate 30)"; rc3=$?
kill "$SRV" 2>/dev/null; SRV=""
if printf '%s' "$out3" | grep -q "claude_cli answered a real judge call"; then
  ok "claude_cli brain accepted on a real judge verdict"
else
  bad "claude_cli brain with a working judge was not accepted (rc=$rc3)"; printf '%s\n' "$out3" | grep -E "warm|provider|STOPPING" | sed -n '1,6p' | sed 's/^/        /'
fi

echo "case 4: a claude_cli brain whose judge returns NO verdict is still refused"
PORT="$PORT" start_fake_brain healthy claude_cli none || echo "  SKIP  could not start fake brain"
out4="$(run_gate 20)"; rc4=$?
kill "$SRV" 2>/dev/null; SRV=""
if [ "$rc4" -eq 2 ] && printf '%s' "$out4" | grep -q "no judge verdict yet" && printf '%s' "$out4" | grep -q "STOPPING"; then
  ok "claude_cli brain without a verdict refused with exit 2"
else
  bad "a claude_cli brain with a non-verdict judge was not refused (rc=$rc4)"; printf '%s\n' "$out4" | grep -E "warm|provider|STOPPING|verdict" | sed -n '1,6p' | sed 's/^/        /'
fi

echo
if [ "$fails" -eq 0 ]; then echo "brain-warmth: ALL PASS"; exit 0; fi
echo "brain-warmth: $fails FAILURE(S)"; exit 1
