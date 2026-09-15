#!/usr/bin/env bash
# start-bench-brain.sh: a COLD model is LOADED, not waited out.
#
# WHY THIS FAILS ON THE PRE-CHANGE TREE (rules/tests-must-be-able-to-fail.md):
# start-bench-brain.sh never sent Ollama a load request. With the model unloaded
# the brain reports llm_provider_state "degraded" with "model '<id>' not in
# /api/ps (cold start)" for as long as anyone waits, so on the old script:
#   * case 1 (the measured launch) waits out TB_BENCH_BRAIN_WAIT_S and exits 2
#     with "did not become usable" instead of 0;
#   * case 2 (already up and cold, the per-task re-check) exits 2 at once with
#     "not ready+isolated" instead of loading the model;
#   * cases 4 and 5 find ZERO load requests where exactly one is required, and
#     no failure reason in the refusal;
#   * case 6 finds no PRINT-ONLY announcement of the request it withheld;
#   * case 8 finds run-dg.sh still sending its own inline copy of the request.
# Cases 3 and 7, and case 2's "starts no second brain" assertion, PASS on the
# old script by design. They pin that the new branch did not widen what is
# accepted: another degraded cause, a cold brain that is NOT isolated, and the
# check-only question all behave exactly as before, and a cold brain that is
# already up is never raced by a launch. Measured 2026-09-15 against the
# pre-change start-bench-brain.sh and run-dg.sh: 12 of 17 fail, 5 pass.
#
# MEASURED 2026-09-15 16:02: "[bench-brain] REFUSING: :7424 did not become
# usable within 300s. last state: llm_provider_state is 'degraded'", then
# "[2w] REFUSING: the isolated bench brain is not usable", and zero trials ran.
# One manual POST /api/generate {"model":...,"prompt":"","keep_alive":"3h"}
# made the brain healthy within 17 s.
#
# Hermetic: fake `curl` and `powershell.exe` on PATH answer every request, the
# brain ports are 17424/17423 (never the real :7424/:7423), and the test aborts
# before any case unless PATH really resolves both fakes. No brain, no Ollama,
# no network. About 30 s, most of it the script's own 2 s poll.
#
#   TB_START_BENCH_BRAIN_UNDER_TEST=<path>   run against another copy (red proof)
#   TB_RUN_DG_UNDER_TEST=<path>              the run-dg.sh case 8 reads
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START="${TB_START_BENCH_BRAIN_UNDER_TEST:-$HERE/start-bench-brain.sh}"
RUN_DG="${TB_RUN_DG_UNDER_TEST:-$HERE/run-dg.sh}"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
ST="$SANDBOX/state"
GEN="$SANDBOX/generate.log"
mkdir -p "$SANDBOX/bin" "$ST" "$SANDBOX/repo/mcp-data-tbench-clean" "$SANDBOX/repo/target-mcp/release"
echo "bench-token-abc" > "$SANDBOX/repo/mcp-data-tbench-clean/mcp-token.txt"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/repo/target-mcp/release/terransoul.exe"
# Deliberately NOT the bench's real model: the script must read the name from
# /health brain_model, never from a literal of its own.
MODEL="stub-model:7b-q4"

# Every answer is decided by files in $STUB_STATE:
#   up         the brain answers /health at all (the fake launch creates it)
#   mode       cold | slow  -- WHY a not-yet-loaded brain reports degraded
#   loaded     Ollama has the model resident (a successful load creates it)
#   ollama     ok | fail | noop -- how /api/generate behaves
#   prodsame   production reports the SAME memory_total (not isolated)
#   polls      one line per /health poll of the bench port
cat > "$SANDBOX/bin/curl" <<'EOF'
#!/usr/bin/env bash
_url=""; _body=""; _next=""
for a in "$@"; do
  if [ "$_next" = "d" ]; then _body="$a"; _next=""; continue; fi
  case "$a" in -d) _next="d" ;; http*) _url="$a" ;; esac
done
case "$_url" in
  *:17424/health)
    [ -f "$STUB_STATE/up" ] || exit 7
    echo poll >> "$STUB_STATE/polls"
    if [ -f "$STUB_STATE/loaded" ]; then
      printf '{"memory_total":42,"brain_provider":"ollama","brain_model":"%s","llm_provider_state":"healthy","llm_provider_detail":"/api/tags ok in 1ms"}' "$STUB_MODEL"
    elif [ "$(cat "$STUB_STATE/mode")" = "slow" ]; then
      printf '{"memory_total":42,"brain_provider":"ollama","brain_model":"%s","llm_provider_state":"degraded","llm_provider_detail":"/api/tags ok in 1500ms"}' "$STUB_MODEL"
    else
      printf '{"memory_total":42,"brain_provider":"ollama","brain_model":"%s","llm_provider_state":"degraded","llm_provider_detail":"/api/tags ok in 1ms; model \047%s\047 not in /api/ps (cold start)"}' "$STUB_MODEL" "$STUB_MODEL"
    fi ;;
  *:17423/health)
    if [ -f "$STUB_STATE/prodsame" ]; then
      printf '{"memory_total":42,"llm_provider_state":"healthy"}'
    else
      printf '{"memory_total":999999,"llm_provider_state":"healthy"}'
    fi ;;
  *:17424/mcp) printf '200' ;;
  */api/generate)
    echo "$_url $_body" >> "$STUB_GEN"
    case "$(cat "$STUB_STATE/ollama" 2>/dev/null)" in
      fail)
        echo "curl: (7) Failed to connect to 127.0.0.1 port 11434 after 0 ms: Could not connect to server" >&2
        printf '\n000'
        exit 7 ;;
      noop)
        printf '{"model":"%s","done":true,"done_reason":"load"}\n200' "$STUB_MODEL" ;;
      *)
        : > "$STUB_STATE/loaded"
        printf '{"model":"%s","done":true,"done_reason":"load"}\n200' "$STUB_MODEL" ;;
    esac ;;
esac
exit 0
EOF
cat > "$SANDBOX/bin/powershell.exe" <<'EOF'
#!/usr/bin/env bash
echo "launch $*" >> "$STUB_STATE/launches"
: > "$STUB_STATE/up"
exit 0
EOF
chmod +x "$SANDBOX/bin/curl" "$SANDBOX/bin/powershell.exe"

# A fake that PATH does not actually resolve would send these requests to a real
# brain or a real Ollama, so that is a hard stop, not a test failure.
for tool in curl powershell.exe; do
  got="$(export PATH="$SANDBOX/bin:$PATH"; command -v "$tool")"
  if [ "$got" != "$SANDBOX/bin/$tool" ]; then
    echo "  ABORT: PATH resolves $tool to '$got', not the fake -- refusing to run"
    exit 2
  fi
done

reset_state() { # $1 = up|down  $2 = cold|slow  $3 = ok|fail|noop
  rm -f "$ST"/* "$GEN"
  if [ "$1" = "up" ]; then : > "$ST/up"; fi
  printf '%s' "$2" > "$ST/mode"
  printf '%s' "$3" > "$ST/ollama"
}
gen_count() { if [ -f "$GEN" ]; then wc -l < "$GEN" | tr -d ' '; else echo 0; fi; }
poll_count() { if [ -f "$ST/polls" ]; then wc -l < "$ST/polls" | tr -d ' '; else echo 0; fi; }
tail_of() { tail -n 8 "$SANDBOX/$1.out" | tr '\n' '|'; }

run_start() { # $1 = output label; the rest are KEY=VAL overrides
  local label="$1"; shift
  env -u OLLAMA_HOST -u TB_OLLAMA_WARM_KEEP_ALIVE -u TB_OLLAMA_WARM_TIMEOUT_S \
      -u TB_BENCH_BRAIN_PRINT_ONLY -u TB_BENCH_BRAIN_CHECK_ONLY -u TB_BRAIN_DATA \
      PATH="$SANDBOX/bin:$PATH" STUB_STATE="$ST" STUB_GEN="$GEN" STUB_MODEL="$MODEL" \
      TB_REPO_OVERRIDE="$SANDBOX/repo" TB_BRAIN_PORT=17424 TB_PROD_BRAIN_PORT=17423 \
      TB_BENCH_BRAIN_BIN="$SANDBOX/repo/target-mcp/release/terransoul.exe" \
      "$@" timeout 120 bash "$START" > "$SANDBOX/$label.out" 2>&1
}

echo "start-bench-brain: cold model"

# 1. the measured launch: the brain comes up COLD ----------------------------
reset_state down cold ok
run_start c1 TB_BENCH_BRAIN_WAIT_S=15; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'UP on :17424' "$SANDBOX/c1.out"; then
  ok "cold_launch_is_loaded_and_comes_up"
else
  no "cold_launch_is_loaded_and_comes_up" "rc=$rc :: $(tail_of c1)"
fi
if [ "$(gen_count)" = "1" ]; then
  ok "cold_launch_sends_exactly_one_load_request"
else
  no "cold_launch_sends_exactly_one_load_request" "count=$(gen_count)"
fi
if grep -q '^http://127.0.0.1:11434/api/generate ' "$GEN" 2>/dev/null; then
  ok "default_ollama_url_is_loopback_11434"
else
  no "default_ollama_url_is_loopback_11434" "$(cat "$GEN" 2>/dev/null)"
fi
if grep -q "\"model\":\"$MODEL\"" "$GEN" 2>/dev/null && grep -q '"keep_alive":"2h"' "$GEN"; then
  ok "load_names_the_health_model_with_default_keep_alive"
else
  no "load_names_the_health_model_with_default_keep_alive" "$(cat "$GEN" 2>/dev/null)"
fi

# 2. already up and cold: the per-task re-check mid-sweep ----------------------
# Ollama-style schemeless OLLAMA_HOST on the bind-all address, and a keep_alive
# override, both of which the request must honour.
reset_state up cold ok
run_start c2 TB_BENCH_BRAIN_WAIT_S=15 OLLAMA_HOST=0.0.0.0:11999 TB_OLLAMA_WARM_KEEP_ALIVE=3h; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'UP on :17424' "$SANDBOX/c2.out"; then
  ok "running_cold_brain_is_loaded_not_refused"
else
  no "running_cold_brain_is_loaded_not_refused" "rc=$rc :: $(tail_of c2)"
fi
if [ ! -f "$ST/launches" ] && ! grep -q 'powershell:' "$SANDBOX/c2.out"; then
  ok "running_cold_brain_starts_no_second_brain"
else
  no "running_cold_brain_starts_no_second_brain" "$(cat "$ST/launches" 2>/dev/null) :: $(tail_of c2)"
fi
if [ "$(gen_count)" = "1" ] && grep -q '^http://127.0.0.1:11999/api/generate ' "$GEN" \
   && grep -q '"keep_alive":"3h"' "$GEN"; then
  ok "ollama_host_and_keep_alive_env_are_honoured"
else
  no "ollama_host_and_keep_alive_env_are_honoured" "count=$(gen_count) :: $(cat "$GEN" 2>/dev/null)"
fi

# 3. degraded for ANOTHER reason, or cold but not isolated: refused as before ---
# "/api/tags ok in 1500ms" is the other degraded shape the gateway produces.
reset_state up slow ok
run_start c3a TB_BENCH_BRAIN_WAIT_S=15; rc=$?
if [ "$rc" -eq 2 ] && grep -q 'not ready+isolated' "$SANDBOX/c3a.out" \
   && grep -q "llm_provider_state is 'degraded'" "$SANDBOX/c3a.out" && [ "$(gen_count)" = "0" ]; then
  ok "other_degraded_cause_is_refused_without_loading"
else
  no "other_degraded_cause_is_refused_without_loading" "rc=$rc count=$(gen_count) :: $(tail_of c3a)"
fi
reset_state down slow ok
run_start c3b TB_BENCH_BRAIN_WAIT_S=5; rc=$?
if [ "$rc" -eq 2 ] && grep -q 'did not become usable within 5s' "$SANDBOX/c3b.out" \
   && grep -q "last state: llm_provider_state is 'degraded'" "$SANDBOX/c3b.out" && [ "$(gen_count)" = "0" ]; then
  ok "other_degraded_cause_after_launch_times_out_as_before"
else
  no "other_degraded_cause_after_launch_times_out_as_before" "rc=$rc count=$(gen_count) :: $(tail_of c3b)"
fi
# A brain on the bench port serving production's store must be refused at
# once, not loaded and then waited on: learn mode WRITES (measured 2026-08-31).
reset_state up cold ok
: > "$ST/prodsame"
run_start c3c TB_BENCH_BRAIN_WAIT_S=15; rc=$?
if [ "$rc" -eq 2 ] && grep -q 'not ready+isolated' "$SANDBOX/c3c.out" && [ "$(gen_count)" = "0" ]; then
  ok "cold_but_not_isolated_is_refused_without_loading"
else
  no "cold_but_not_isolated_is_refused_without_loading" "rc=$rc count=$(gen_count) :: $(tail_of c3c)"
fi

# 4. the load request itself fails: refuse as before, WITH the reason ---------
reset_state up cold fail
run_start c4a TB_BENCH_BRAIN_WAIT_S=15; rc=$?
if [ "$rc" -eq 2 ] && grep -q 'not ready+isolated' "$SANDBOX/c4a.out" \
   && grep -q 'Failed to connect' "$SANDBOX/c4a.out" && [ "$(gen_count)" = "1" ]; then
  ok "failed_load_on_running_brain_refuses_with_reason"
else
  no "failed_load_on_running_brain_refuses_with_reason" "rc=$rc count=$(gen_count) :: $(tail_of c4a)"
fi
reset_state down cold fail
run_start c4b TB_BENCH_BRAIN_WAIT_S=7; rc=$?
if [ "$rc" -eq 2 ] && grep -q 'did not become usable within 7s' "$SANDBOX/c4b.out" \
   && grep -q 'Failed to connect' "$SANDBOX/c4b.out"; then
  ok "failed_load_after_launch_refuses_with_reason"
else
  no "failed_load_after_launch_refuses_with_reason" "rc=$rc :: $(tail_of c4b)"
fi
if [ "$(gen_count)" = "1" ] && [ "$(poll_count)" -ge 3 ]; then
  ok "failed_load_is_not_retried_across_polls"
else
  no "failed_load_is_not_retried_across_polls" "loads=$(gen_count) polls=$(poll_count)"
fi

# 5. Ollama says "loaded" but the brain stays cold: still ONE request ---------
# The shape that would loop-spam Ollama if the re-arm were per poll.
reset_state down cold noop
run_start c5 TB_BENCH_BRAIN_WAIT_S=7; rc=$?
if [ "$rc" -eq 2 ] && [ "$(gen_count)" = "1" ] && [ "$(poll_count)" -ge 3 ]; then
  ok "at_most_one_load_request_per_wait"
else
  no "at_most_one_load_request_per_wait" "rc=$rc loads=$(gen_count) polls=$(poll_count) :: $(tail_of c5)"
fi

# 6. PRINT-ONLY sends nothing, and says what it withheld -----------------------
reset_state up cold ok
run_start c6 TB_BENCH_BRAIN_PRINT_ONLY=1; rc=$?
if [ "$rc" -ne 0 ] && [ "$(gen_count)" = "0" ] && grep -q 'PRINT-ONLY' "$SANDBOX/c6.out"; then
  ok "print_only_announces_and_sends_no_load_request"
else
  no "print_only_announces_and_sends_no_load_request" "rc=$rc count=$(gen_count) :: $(tail_of c6)"
fi

# 7. CHECK-ONLY stays a pure question (preflight-sweep.sh asks it) ------------
reset_state up cold ok
run_start c7 TB_BENCH_BRAIN_CHECK_ONLY=1; rc=$?
if [ "$rc" -ne 0 ] && [ "$(gen_count)" = "0" ]; then
  ok "check_only_never_loads"
else
  no "check_only_never_loads" "rc=$rc count=$(gen_count) :: $(tail_of c7)"
fi

# 8. ONE loader: run-dg.sh's warmth gate calls the same function ---------------
if grep -q 'ollama_load_model "\$_warm_model"' "$RUN_DG" \
   && ! grep -q '\\"prompt\\":\\"ok\\"' "$RUN_DG"; then
  ok "run_dg_warmth_gate_uses_the_same_loader"
else
  no "run_dg_warmth_gate_uses_the_same_loader" "run-dg.sh still sends its own inline load request"
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
