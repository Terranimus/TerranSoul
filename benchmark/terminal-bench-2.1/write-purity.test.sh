#!/usr/bin/env bash
# Regression test for TBENCH-WRITE-PURITY-1, run against BOTH bench proxies.
#
# WHAT IT PROVES. In learn mode the agent may write lessons, and with
# TB_DEFER_WRITES=0 those lessons are retrievable by LATER ATTEMPTS OF THE SAME
# TASK. That is the product's real self-improvement behaviour and it is what we
# want to measure. But the Terminal-Bench leaderboard judge defines
# harness_level_cheating to include "prior-run post-mortems", and that verdict
# RENDERS A SUBMISSION INVALID (leaderboard/src/leaderboard/ci/judge.py and its
# analysis-task-template/instruction.md).
#
# The line that keeps both is the one rules/bench-agi-purity.md already draws:
# generic transferable technique may persist, task-specific knowledge may not.
# This proves the proxy enforces that line AT WRITE TIME -- the only place it
# can be enforced honestly, because once a task-identifying lesson is stored it
# is retrievable, and the brain's own PURITY-AUDIT-1 lesson records that a
# search-based purity check FAILS OPEN and silently certifies a dirty store.
#
# WHY IT FAILS ON THE PRE-CHANGE TREE (rules/tests-must-be-able-to-fail.md):
# gate() contained
#     if (LEARN_MODE && LEARN_TOOLS.has(name)) return null
# with no inspection of the payload, so a lesson naming a benchmark task was
# forwarded verbatim. Cases 1 and 3 would be STORED rather than refused, the
# stub would record 3 forwarded writes instead of 1, and no -32002 would ever
# be returned. Verified against both proxies on 2026-08-23.
#
# BOTH PROXIES ARE COVERED DELIBERATELY. benchmark/terminal-bench-2.1/ and
# benchmark/terminal-bench-3.0/ each carry their own copy of mcp-auth-proxy.mjs
# and they have ALREADY drifted (3.0 grew a production-upstream guard 2.1 never
# got). A guard added to one copy and not the other is the same class of defect
# this file exists to catch, so the test iterates over both.
#
# Uses a stub upstream, so it needs no brain and no network.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

pass=0; fail=0
check() { if [ "$2" -eq 0 ]; then printf '  ok   %s\n' "$1"; pass=$((pass+1));
          else printf '  FAIL %s\n' "$1"; fail=$((fail+1)); fi }

ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

run_against() { # run_against <label> <proxy-path> <base-port>
  local label="$1" proxy="$2" base="$3"
  local TMP STUB_PID PROXY_PID
  TMP="$(mktemp -d)"
  local STUB_PORT=$((base)) PROXY_PORT=$((base+1))
  local STUB_LOG="$TMP/stub.jsonl"
  : > "$STUB_LOG"
  printf '\n[%s] %s\n' "$label" "$proxy"

  # A dataset whose task names appear NOWHERE in any proxy source.
  mkdir -p "$TMP/tasks/zzz-fake-taskname" "$TMP/tasks/another-fake-task"
  # A non-directory entry must NOT become a task term (it would match any
  # lesson mentioning a readme and make the gate cry wolf).
  echo "notes" > "$TMP/tasks/README.md"

  cat > "$TMP/stub.mjs" <<'STUB'
import http from 'node:http'
import fs from 'node:fs'
const log = process.argv[2]
http.createServer((req, res) => {
  let b = ''
  req.on('data', c => (b += c))
  req.on('end', () => {
    try {
      const j = JSON.parse(b)
      if (j.method === 'tools/call') fs.appendFileSync(log, JSON.stringify({ tool: j.params?.name, args: j.params?.arguments }) + '\n')
    } catch {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }))
  })
}).listen(Number(process.argv[3]), '127.0.0.1')
STUB
  node "$TMP/stub.mjs" "$STUB_LOG" "$STUB_PORT" & STUB_PID=$!

  TERRANSOUL_MCP_TOKEN=stub-token \
  TB_PROXY_PORT="$PROXY_PORT" \
  TB_PROXY_UPSTREAM_PORT="$STUB_PORT" \
  TB_PROXY_MODE=learn \
  TB_TASKS_DIR="$TMP/tasks" \
  TB_PROXY_LOG="$TMP/proxy.jsonl" \
    node "$proxy" > "$TMP/proxy.out" 2>&1 & PROXY_PID=$!

  local ready=1
  for _ in $(seq 1 60); do
    if curl -s -m 1 -o /dev/null "http://127.0.0.1:$PROXY_PORT/mcp" -X POST -d '{}'; then ready=0; break; fi
    sleep 0.25
  done
  check "$label proxy came up" $ready
  if [ "$ready" -ne 0 ]; then
    sed -n '1,15p' "$TMP/proxy.out"
    kill "$STUB_PID" "$PROXY_PID" 2>/dev/null; rm -rf "$TMP"; return
  fi

  post() {
    curl -s -m 10 -X POST "http://127.0.0.1:$PROXY_PORT/mcp" \
      -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"brain_ingest_lesson\",\"arguments\":{\"content\":$1,\"tags\":\"technique\"}}}"
  }

  # THE OTHER WRITE TOOL. brain_ingest_lesson calls its prose `content`;
  # brain_append calls it `addition`. The gate used to scan a hardcoded list of
  # field names, so brain_append matched NOTHING and was allowed through --
  # while the agent instruction file explicitly tells the agent to PREFER
  # brain_append for corrections. Covering only the tool whose field name
  # happened to be on the list is how that survived a whole sweep.
  post_append() {
    curl -s -m 10 -X POST "http://127.0.0.1:$PROXY_PORT/mcp" \
      -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"brain_append\",\"arguments\":{\"id\":4242,\"addition\":$1}}}"
  }

  local r1 r2 r3 n rc
  r1="$(post '"While solving zzz-fake-taskname I found the fix is in main.c line 42."')"
  echo "$r1" | grep -q -- '-32002'; check "$label task-naming lesson refused (-32002)" $?

  r2="$(post '"SYMPTOM: a build fails with a linker error. CAUSE: object order. RULE: put libraries after objects."')"
  if echo "$r2" | grep -q -- '-32002'; then rc=1; else rc=0; fi
  check "$label generic lesson allowed through" $rc

  r3="$(post '"Notes from zzz_fake_taskname and another fake task runs."')"
  echo "$r3" | grep -q -- '-32002'; check "$label normalised variant refused" $?

  # A lesson mentioning a README must NOT be refused: README.md is a file in the
  # dataset dir, not a task, and treating it as one makes the gate useless noise.
  local r4
  r4="$(post '"RULE: read the README.md in an unfamiliar repo before editing."')"
  if echo "$r4" | grep -q -- '-32002'; then rc=1; else rc=0; fi
  check "$label non-directory dataset entry is not a task term" $rc

  # ── brain_append must be gated too (its prose field is `addition`) ────────
  # FAILS ON THE PRE-CHANGE TREE: the field-name allowlist never looked at
  # `addition`, so this task-naming append was forwarded and stored.
  local r5 r6
  r5="$(post_append '"On zzz-fake-taskname the fix was in main.c line 42."')"
  echo "$r5" | grep -q -- '-32002'; check "$label task-naming brain_append refused" $?

  r6="$(post_append '"RULE: prefer a checked exception over a sentinel return value."')"
  if echo "$r6" | grep -q -- '-32002'; then rc=1; else rc=0; fi
  check "$label generic brain_append allowed through" $rc

  # ── THE EXIT GATE MUST BE REACHABLE (TBENCH-EXIT-GATE-1) ─────────────────
  # brain_verify_completion is the pre-stop check and brain_observe_outcome is
  # the dead-end detector. Both were exposed by the server and absent from every
  # allowlist here, so both were refused as "write/mutating" tools -- a gate
  # that cannot be called is a gate that does not exist. FAILS ON THE PRE-CHANGE
  # TREE: each of these returned -32001 (blocked) instead of reaching upstream.
  #
  # They are deliberately NOT subject to the task-identity gate: they record the
  # agent's own commands, which routinely contain task paths, and gating them
  # would refuse nearly every call. So the task-shaped payload below must be
  # FORWARDED, not refused -- that is the intended asymmetry, asserted here so
  # nobody "fixes" it later by routing them through the lesson gate.
  local rv ro
  rv="$(curl -s -m 10 -X POST "http://127.0.0.1:$PROXY_PORT/mcp" \
        -H 'content-type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"brain_verify_completion\",\"arguments\":{\"op\":\"status\",\"session_id\":\"t\",\"changed_paths\":[\"/app/zzz-fake-taskname/main.c\"]}}}")"
  if echo "$rv" | grep -qE -- '-32001|-32002'; then rc=1; else rc=0; fi
  check "$label brain_verify_completion reaches upstream (exit gate callable)" $rc

  ro="$(curl -s -m 10 -X POST "http://127.0.0.1:$PROXY_PORT/mcp" \
        -H 'content-type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"brain_observe_outcome\",\"arguments\":{\"session_id\":\"t\",\"context\":\"c\",\"action\":\"a\",\"response\":\"r\"}}}")"
  if echo "$ro" | grep -qE -- '-32001|-32002'; then rc=1; else rc=0; fi
  check "$label brain_observe_outcome reaches upstream (dead-end detector callable)" $rc

  # ── THE VERIFICATION LEDGER MUST BE SCOPED PER TRIAL ─────────────────────
  # The ledger is keyed by (session_id, root); every task container works in
  # /app, so an agent sending session_id "default" reads ANOTHER concurrently
  # running trial's evidence. Measured 2026-08-24: a curve-fitting trial was
  # handed an XSS-filter run's PASS from its sibling 8 minutes earlier, and a
  # retrieval trial got a primer/plasmid check. Both noticed; a less careful
  # agent stops on the false pass.
  # FAILS ON THE PRE-CHANGE TREE: "default" was forwarded verbatim.
  curl -s -m 10 -X POST "http://127.0.0.1:$PROXY_PORT/mcp"     -H 'content-type: application/json'     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"brain_verify_completion","arguments":{"op":"status","session_id":"default","root":"/app"}}}' > /dev/null
  if grep -q '"session_id":"default"' "$STUB_LOG" 2>/dev/null; then rc=1; else rc=0; fi
  check "$label session_id=default is NOT forwarded (scoped per trial)" $rc


  n="$(wc -l < "$STUB_LOG" | tr -d ' ')"
  # 6 = 2 lessons + 1 append + verify + observe + the scope-probe verify above.
  [ "$n" = "6" ]; check "$label exactly 6 writes forwarded upstream (got $n)" $?

  grep -q 'task-identity' "$TMP/proxy.jsonl"; check "$label refusal recorded as reason=task-identity" $?

  # ── ANSWER FINGERPRINTS (TBENCH-WRITE-PURITY-2) ────────────────────────────
  #
  # PROVEN LIVE 2026-09-01: purging the poisoned row does not help, because the
  # loop rewrites it. Memory 26496 tagged `0x400000` and correlated with 0/15
  # passes on its task against 14/19 without it. It was deleted; the very next
  # trial of that task failed and wrote it back as row 26629 with the same tag.
  # Only a WRITE-time refusal breaks that cycle.
  fp="$(curl -s -m 10 -X POST "http://127.0.0.1:$PROXY_PORT/mcp"     -H 'content-type: application/json'     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"brain_ingest_lesson","arguments":{"content":"General technique for parsing images.","tags":"elf,load-base,0x400000,p_vaddr"}}}')"
  printf '%s' "$fp" | grep -q '32002'; check "$label a lesson TAGGING a magic constant is refused" $?
  printf '%s' "$fp" | grep -q '0x400000'; check "$label the refusal names the offending constant" $?
  grep -q 'answer-fingerprint' "$TMP/proxy.jsonl"; check "$label refusal recorded as reason=answer-fingerprint" $?

  # A constant is only a fingerprint if no prompt states it. Prose that merely
  # MENTIONS a number must still be storable, or the gate blocks ordinary
  # technique lessons and gets waved through.
  ok2="$(curl -s -m 10 -X POST "http://127.0.0.1:$PROXY_PORT/mcp"     -H 'content-type: application/json'     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"brain_ingest_lesson","arguments":{"content":"Some images load at 0x400000; derive it, do not assume it.","tags":"technique,derivation"}}}')"
  printf '%s' "$ok2" | grep -q '32002'; if [ $? -eq 0 ]; then check "$label prose mentioning a constant is still allowed" 1; else check "$label prose mentioning a constant is still allowed" 0; fi

  kill "$STUB_PID" "$PROXY_PID" 2>/dev/null
  rm -rf "$TMP"
}

# ── THE GATE MUST BE WIRED, NOT MERELY CORRECT ──────────────────────────────
#
# WHY THIS EXISTS, and why the cases above were not enough. Every check above
# passes TB_TASKS_DIR explicitly, so they prove the gate FUNCTION works. On
# 2026-08-23 the gate was nonetheless inert for an entire 89-task sweep:
# run-dg.sh set TB21_DIR as a plain shell assignment instead of exporting it,
# the proxy child saw no tasks dir, the term list was empty, and every lesson
# was allowed through while the log showed zero refusals. A passing suite and a
# disarmed guard looked identical.
#
# So these two cases test the WIRING: that an unwired gate refuses to run, and
# that the real launcher actually hands the proxy its task list.
wiring_pass=0
echo ""
echo "[wiring] gate must be wired, not merely correct"

# 1. With no task list at all, learn mode must REFUSE to start.
#    FAILS ON THE PRE-CHANGE TREE: the proxy started happily and allowed writes.
for proxy in "$REPO/benchmark/terminal-bench-2.1/mcp-auth-proxy.mjs" \
             "$REPO/benchmark/terminal-bench-3.0/mcp-auth-proxy.mjs"; do
  out="$(TERRANSOUL_MCP_TOKEN=stub TB_PROXY_PORT=18991 TB_PROXY_UPSTREAM_PORT=18999 \
         TB_PROXY_MODE=learn TB_TASKS_DIR= TB21_DIR= \
         timeout 20 node "$proxy" 2>&1 | head -3)"
  case "$out" in
    *"NO task list"*) ok "$(basename "$(dirname "$proxy")") refuses to run with an empty term list" ;;
    *) bad "$(basename "$(dirname "$proxy")") started with an INERT purity gate: $out" ;;
  esac
done

# 2. The launcher must hand the proxy a tasks dir. A static check, because
#    running run-dg.sh for real needs harbor, docker and a brain -- but the
#    defect was entirely in this one line, so this is exactly the right grain.
if grep -qE 'TB_TASKS_DIR=.*\\$' "$REPO/benchmark/terminal-bench-2.1/run-dg.sh" &&
   grep -qE '^export TB21_DIR=' "$REPO/benchmark/terminal-bench-2.1/run-dg.sh"; then
  ok "run-dg.sh passes TB_TASKS_DIR to the proxy and exports TB21_DIR"
else
  bad "run-dg.sh does not hand the proxy a task list -- the gate would be inert"
fi

run_against "tb2.1" "$REPO/benchmark/terminal-bench-2.1/mcp-auth-proxy.mjs" 18841
run_against "tb3.0" "$REPO/benchmark/terminal-bench-3.0/mcp-auth-proxy.mjs" 18851

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
