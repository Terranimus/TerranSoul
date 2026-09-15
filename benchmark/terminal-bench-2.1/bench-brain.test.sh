#!/usr/bin/env bash
# start-bench-brain.sh / stop-bench-brain.sh
#
# FAILS ON THE PRE-CHANGE TREE: neither script existed, so every `bash "$START"`
# / `bash "$STOP"` below dies with "No such file or directory" and every
# assertion fails. Nothing in this directory started the isolated bench brain at
# all -- run-dg.sh only REFUSED when :7424 was missing, and the repair it named
# (`node scripts/copilot-start-mcp.mjs`) reuses the production tray on :7423 and
# exits 0 without ever binding :7424.
#
# WHAT THESE PIN:
#   * an already-ready, already-isolated brain is left ALONE (idempotence: one
#     MCP at a time is the standing rule);
#   * a brain that answers on :7424 while serving the PRODUCTION store is
#     REFUSED, not raced with a second launch -- learn mode writes, and that
#     exact state was measured on 2026-08-31;
#   * the launch command carries --mcp-tray, a hidden window, and the data dir
#     and idle-timeout the brain must have to outlive a 2-hour trial;
#   * stop never, under any circumstance, kills the production tray or a
#     stranger that merely holds the port.
#
# Hermetic: fake `curl`, `netstat`, `wmic` and `taskkill` on PATH decide every
# answer, so this needs no brain, no network and no MCP binary. Runs in ~1s.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START="$HERE/start-bench-brain.sh"
STOP="$HERE/stop-bench-brain.sh"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/repo/mcp-data-tbench-clean" "$SANDBOX/repo/target-mcp/release"
echo "bench-token-abc" > "$SANDBOX/repo/mcp-data-tbench-clean/mcp-token.txt"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SANDBOX/repo/target-mcp/release/terransoul.exe"
ACTIONS="$SANDBOX/actions.log"

# ⛔ HERMETIC FIRST. stop-bench-brain.sh reads netstat and taskkills the pid it finds,
# and cases 1-5 used to run before any netstat/taskkill fake existed here (they
# were only written for case 6). The fakes this file writes into $SANDBOX/bin
# still take precedence per invocation.
# hermetic-shims.sh puts logging shims for docker, netstat, ss and taskkill
# FIRST on PATH, and the guard ABORTS unless every one resolves inside this
# test's temp dir: on 2026-09-15 18:45 a real `docker rm -f` reached from
# two-workers.test.sh SIGKILLed two live trials of another sweep.
. "$HERE/hermetic-shims.sh" || { echo "ABORT: hermetic-shims.sh not found next to this test"; exit 2; }
hermetic_shims "$SANDBOX" || { echo "ABORT: could not create the hermetic shims"; exit 2; }
hermetic_guard "$SANDBOX" || exit 2

# $1 = memory_total on 7424, $2 = llm_provider_state on 7424,
# $3 = memory_total on 7423 (or the literal DOWN), $4 = /mcp http code.
make_curl() {
  cat > "$SANDBOX/bin/curl" <<EOF
#!/usr/bin/env bash
_url=""
for a in "\$@"; do case "\$a" in http*) _url="\$a" ;; esac; done
case "\$_url" in
  *:7424/health) printf '{"memory_total":$1,"llm_provider_state":"$2"}' ;;
  *:7423/health) [ "$3" = "DOWN" ] || printf '{"memory_total":$3,"llm_provider_state":"healthy"}' ;;
  *:7424/mcp)    printf '%s' "$4" ;;
  *:7423/mcp)    printf '%s' "000" ;;
esac
exit 0
EOF
  chmod +x "$SANDBOX/bin/curl"
}

run_start() { # extra env as KEY=VAL args
  env PATH="$SANDBOX/bin:$PATH" TB_REPO_OVERRIDE="$SANDBOX/repo" \
      TB_BENCH_BRAIN_PRINT_ONLY=1 "$@" bash "$START" > "$SANDBOX/start.out" 2>&1
}

echo "start-bench-brain / stop-bench-brain"

# 1. up + ready + isolated -> exits 0 and starts NOTHING ------------------------
make_curl 42 healthy 999999 200
run_start; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'already up' "$SANDBOX/start.out"; then
  ok "ready_and_isolated_brain_is_left_alone"
else
  no "ready_and_isolated_brain_is_left_alone" "rc=$rc :: $(cat "$SANDBOX/start.out")"
fi
if grep -q 'powershell:' "$SANDBOX/start.out"; then
  no "idempotent_start_launches_nothing" "built a launch command for a healthy brain"
else
  ok "idempotent_start_launches_nothing"
fi

# 2. healthy but NOT isolated -> refuse, never race a second launch -------------
# The measured 2026-08-31 state: a brain on the bench port serving production's
# store, reporting the same memory_total. Learn mode WRITES, so this must stop.
make_curl 123456 healthy 123456 200
run_start; rc=$?
if [ "$rc" -ne 0 ] && grep -q 'not ready+isolated' "$SANDBOX/start.out"; then
  ok "same_memory_total_as_production_is_refused"
else
  no "same_memory_total_as_production_is_refused" "rc=$rc :: $(cat "$SANDBOX/start.out")"
fi

# 3. degraded provider -> not treated as ready ---------------------------------
# /health 200 with llm_provider_state degraded let 2 of 3 trials run against a
# model that had not loaded (2026-08-30).
make_curl 42 degraded 999999 200
run_start; rc=$?
if [ "$rc" -ne 0 ] && grep -q "llm_provider_state is 'degraded'" "$SANDBOX/start.out"; then
  ok "degraded_provider_is_not_ready"
else
  no "degraded_provider_is_not_ready" "rc=$rc :: $(cat "$SANDBOX/start.out")"
fi

# 4. nothing listening -> the launch command is built, and carries the three
#    properties the brain cannot run without ---------------------------------
# A curl that answers NOTHING: no brain on either port, which is the state a
# real start has to act on.
cat > "$SANDBOX/bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SANDBOX/bin/curl"
run_start; rc=$?
cmd="$(grep -m1 '^\[bench-brain\] powershell: ' "$SANDBOX/start.out" | sed 's/^\[bench-brain\] powershell: //')"
[ "$rc" -eq 0 ] || no "print_only_start_exits_zero" "rc=$rc :: $(cat "$SANDBOX/start.out")"
for frag in "Start-Process" "--mcp-tray" "-WindowStyle Hidden" "-RedirectStandardOutput" "-RedirectStandardError"; do
  case "$cmd" in
    *"$frag"*) ok "launch_command_has [$frag]" ;;
    *) no "launch_command_has [$frag]" "cmd=[$cmd]" ;;
  esac
done
if grep -q 'TERRANSOUL_MCP_IDLE_TIMEOUT=0' "$SANDBOX/start.out"; then
  ok "idle_timeout_zero_is_announced"
else
  no "idle_timeout_zero_is_announced" "$(cat "$SANDBOX/start.out")"
fi
if grep -q 'mcp-data-tbench-clean' "$SANDBOX/start.out"; then
  ok "clean_data_dir_is_announced"
else
  no "clean_data_dir_is_announced" "$(cat "$SANDBOX/start.out")"
fi

# 5. the production port is refused outright, by BOTH scripts -------------------
env PATH="$SANDBOX/bin:$PATH" TB_REPO_OVERRIDE="$SANDBOX/repo" TB_BRAIN_PORT=7423 \
  bash "$START" > "$SANDBOX/p.out" 2>&1
rc=$?
if [ "$rc" -ne 0 ] && grep -q 'production' "$SANDBOX/p.out"; then
  ok "start_refuses_the_production_port"
else
  no "start_refuses_the_production_port" "rc=$rc :: $(cat "$SANDBOX/p.out")"
fi
env PATH="$SANDBOX/bin:$PATH" TB_REPO_OVERRIDE="$SANDBOX/repo" TB_BRAIN_PORT=7423 \
  bash "$STOP" > "$SANDBOX/p2.out" 2>&1
rc=$?
if [ "$rc" -ne 0 ] && grep -q 'PRODUCTION' "$SANDBOX/p2.out"; then
  ok "stop_refuses_the_production_port"
else
  no "stop_refuses_the_production_port" "rc=$rc :: $(cat "$SANDBOX/p2.out")"
fi

# ── stop: identity gate and the kill it does perform ─────────────────────────
# A netstat that reports 7424 held by pid 4242 and 7423 held by pid 7777, so a
# stop that reached the production tray would be visible in the kill log.
cat > "$SANDBOX/bin/netstat" <<'EOF'
#!/usr/bin/env bash
cat <<'ROWS'
  TCP    127.0.0.1:7424         0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:7423         0.0.0.0:0              LISTENING       7777
ROWS
exit 0
EOF
chmod +x "$SANDBOX/bin/netstat"
cat > "$SANDBOX/bin/taskkill" <<'EOF'
#!/usr/bin/env bash
echo "taskkill $*" >> "$ACTIONS_LOG"
exit 0
EOF
chmod +x "$SANDBOX/bin/taskkill"
make_wmic() { # $1 = the command line the fake process reports
  cat > "$SANDBOX/bin/wmic" <<EOF
#!/usr/bin/env bash
echo "CommandLine"
echo "$1"
exit 0
EOF
  chmod +x "$SANDBOX/bin/wmic"
}

# 6. a stranger on :7424 is never killed ---------------------------------------
make_wmic 'C:\\Windows\\notepad.exe'
: > "$ACTIONS"
env PATH="$SANDBOX/bin:$PATH" TB_REPO_OVERRIDE="$SANDBOX/repo" ACTIONS_LOG="$ACTIONS" \
  bash "$STOP" > "$SANDBOX/s.out" 2>&1
rc=$?
if [ "$rc" -ne 0 ] && [ ! -s "$ACTIONS" ]; then
  ok "stop_never_kills_a_stranger"
else
  no "stop_never_kills_a_stranger" "rc=$rc killed=[$(tr '\n' '|' < "$ACTIONS")]"
fi

# 7. the real bench brain IS stopped, and only it -------------------------------
# The fake netstat keeps reporting 4242 as LISTENING even after the kill, so the
# script's post-kill verification fails and it exits non-zero -- what is being
# pinned here is WHICH pid it asked to kill, not the exit code.
make_wmic 'D:\\Git\\TerranSoulApp\\target-mcp\\release\\terransoul.exe --mcp-tray'
: > "$ACTIONS"
env PATH="$SANDBOX/bin:$PATH" TB_REPO_OVERRIDE="$SANDBOX/repo" ACTIONS_LOG="$ACTIONS" \
  bash "$STOP" > "$SANDBOX/s2.out" 2>&1
if grep -q '4242' "$ACTIONS"; then
  ok "stop_kills_the_bench_listener"
else
  no "stop_kills_the_bench_listener" "killed=[$(tr '\n' '|' < "$ACTIONS")]"
fi
if grep -q '7777' "$ACTIONS"; then
  no "stop_never_touches_the_production_listener" "KILLED the :7423 pid: $(tr '\n' '|' < "$ACTIONS")"
else
  ok "stop_never_touches_the_production_listener"
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
