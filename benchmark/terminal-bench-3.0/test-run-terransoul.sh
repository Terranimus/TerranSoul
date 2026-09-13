#!/usr/bin/env bash
# Tests for the Terminal-Bench 3.0 launchers' argument construction and guards:
# `run-terransoul.sh` (tests 1-6), `run-terransoul-verifyhook.sh`, the
# SUBMISSION launcher (tests 7-17c, added 2026-08-19), and the MCP stack the
# submission launcher depends on — `start-bench-brain.mjs`,
# `mcp-auth-proxy.mjs`, `start-bench-stack.mjs` (tests 18-23, added 2026-08-19
# after four silent-failure incidents in a single day; see the block header
# above them), and the proxy's own CALL LOG — the sole host-side witness of how
# the agent used TerranSoul (tests 26-29, added 2026-08-19 after a whole
# campaign's log proved unable to say whether a single search returned
# anything; tests 30-32, added the same day after an adversarial verify pass
# found that the log's UTF-8 fix had been applied to only ONE of the proxy's two
# response tees, and that caller attribution still rested on an unverified
# assumption about TCP-connection reuse), and the stack launcher's PROXY
# LIFECYCLE (tests 40-42, added 2026-08-20 after a graded run went out through
# an eleven-hour-old proxy while the launcher printed "started" for a child that
# had crashed and "verified" for a process it had never started).
#
# `rules/tests-must-be-able-to-fail.md`: each test names the wrong implementation
# it catches, and says honestly whether it caught THIS change.
#
# Measured against a copy of the pre-change runner (git HEAD + the dry-run seam,
# placed in THIS directory so $REPO resolves the same):
#
#   FAIL pre-change, pass now:  1 (GPU exclusion), 3 (unknown task id), 6 (job-id race, TBENCH-ORCH-1),
#                               26/27/28 (call-log observability — falsified by running
#                               tests 26-29's own driver against `git show
#                               HEAD:benchmark/terminal-bench-3.0/mcp-auth-proxy.mjs`, which
#                               prints results/payloadChars/queryChars/conn/rpcId=MISSING),
#                               30/31 (falsified against TWO pre-change trees with tests
#                               30-32's own driver — see the measurements below),
#                               40/41/42 (proxy lifecycle — falsified by pointing
#                               TB_STACK_LAUNCHER at a pre-change copy of
#                               start-bench-stack.mjs placed in THIS directory. MEASURED
#                               2026-08-20 with the block's own driver: pre-change tree
#                               0 passed / 3 failed, this tree 3 passed / 0 failed. On the
#                               pre-change tree test 40 printed "proxy: started as pid <n>",
#                               then "verified: ... served 5 tool(s)" for a decoy it had
#                               never started, then "[stack] READY" and exit 0, while the
#                               child it DID start was writing
#                               "listen EADDRINUSE ... 0.0.0.0:18918" into its log.
#                               42 fails there too, but only on its pid-to-port clause: its
#                               exit-0/READY half passes on both trees, which is the half
#                               that stops 40/41 from being satisfiable by a gate that
#                               refuses every proxy.)
#   pass on BOTH trees:         2, 4, 5, 29, 32 — regression guards, not evidence here. 29 and
#                               32 are deliberately so: they pin that the logging change
#                               altered no existing record key and no byte on the wire.
#
# Falsification of 30/31, MEASURED 2026-08-19 by running the tests-30-32 driver
# against three proxies in turn (expectedPayloadChars = 63 in every run, and
# splitPoints = 8, so the mid-character chunk boundaries really happened):
#
#                        mainPayloadChars  deferredPayloadChars  caller fields
#   git HEAD                    MISSING              MISSING       all MISSING   -> 30 FAIL, 31 FAIL
#   one-sided-decoder tree           63                   70       all MISSING   -> 30 FAIL, 31 FAIL
#   this tree                        63                   63       populated     -> 30 pass, 31 pass
#
# The middle row IS the defect test 30 exists for: one body, two tees, two
# different answers, and the deferred one wrong by exactly one character per
# mid-character chunk boundary. 32 passed on all three rows, as intended.
#
# Note on 2/4/5: run them from another directory and they pass for the WRONG
# reason. A copy under a scratch path exits 2 at the CLI-package check before
# reaching anything under test, which reads as "refused correctly" on test 3 and
# as empty output on test 4. Same-directory placement is load-bearing.
#
#   bash benchmark/terminal-bench-3.0/test-run-terransoul.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# TB_RUNNER lets the falsification check point this at a deliberately-broken copy.
RUNNER="${TB_RUNNER:-$HERE/run-terransoul.sh}"
TASK_CACHE="$HOME/.cache/harbor/tasks/packages/terminal-bench"

# REFUSE TO RUN AGAINST A RUNNER WITHOUT THE DRY-RUN SEAM.
#
# Learned the expensive way: run this suite against a tree predating TB_DRY_RUN
# and every "test" invokes Harbor FOR REAL. It launched two live jobs — one of
# them the GPU task, one at the default k=5 — alongside a sweep that was already
# running, breaking the one-bench-at-a-time rule and leaving orphaned containers.
# A test suite that can start a benchmark is not a test suite.
if ! grep -q 'TB_DRY_RUN' "$RUNNER"; then
  echo "REFUSING: $RUNNER has no TB_DRY_RUN seam — this suite would invoke Harbor for real." >&2
  exit 2
fi

pass=0
fail=0
# ⚠️ NEVER PASS `$?` DIRECTLY WHEN THE DESCRIPTION CONTAINS `$(...)`.
#
# MEASURED 2026-08-19, and it had already shipped: bash expands a command's
# words LEFT TO RIGHT, and every command substitution it runs on the way
# OVERWRITES `$?`. So in
#
#     [ "$a" = "$b" ]                       # sets $? = 1, the real verdict
#     check "name" "... (got $(obs x))" $?  # $(obs x) runs, sets $? = 0
#
# the `$?` that reaches `check` is the exit status of `obs x` — a grep that
# succeeded — not the status of the test. Proof: `false; f "$(printf hi)" $?`
# passes 0. SEVEN checks in this file were written that way, including every
# one of the call-log observability tests, and they were structurally incapable
# of reporting a failure: run against a proxy that got the answer measurably
# wrong (deferred payload size 70 where 63 was correct) all three still printed
# `ok`. That is precisely the shape rules/tests-must-be-able-to-fail.md exists
# to catch, arrived at inside a suite written to enforce it.
#
# THE RULE: capture the verdict into `rc=$?` on the line immediately after the
# condition, and pass `"$rc"`. A variable expansion runs no commands, so nothing
# can clobber it. Checks whose description holds no `$(...)` are unaffected, but
# use `rc` anyway — the next person to add a "(got …)" to a description must not
# have to know this.
check() { # check <name> <condition-desc> <0|1 result>
  if [ "$3" -eq 0 ]; then
    printf '  ok   %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n       expected: %s\n' "$1" "$2"
    fail=$((fail + 1))
  fi
}

# The runner needs credentials present to reach the argument-building code, and
# a reachable endpoint for its preflight. Neither is under test here, so both are
# stubbed: a local HTTP server that answers the Messages API well enough to pass.
STUB_PORT=18787
node -e '
const { createServer } = require("http");
createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "stub", content: [{ type: "text", text: "ok" }] }));
  });
}).listen(Number(process.argv[1]), "127.0.0.1");
' "$STUB_PORT" &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null' EXIT
sleep 1

run_dry() { # run_dry <env assignments...> -> prints argv, one per line
  env TB_DRY_RUN=1 \
      ANTHROPIC_BASE_URL="http://127.0.0.1:$STUB_PORT" \
      ANTHROPIC_AUTH_TOKEN=stub \
      ANTHROPIC_MODEL=stub-model \
      "$@" bash "$RUNNER" 2>/dev/null
}

echo "run-terransoul.sh argument construction"

# ── 1. GPU exclusion actually excludes ──────────────────────────────────────
#
# FAILS on the shipped tree, which did `args=("${args[@]/-i terminal-bench\/$t/}")`.
# `-i` and its value are SEPARATE array elements, so that pattern matched no
# element and every task survived — the branch printed "EXCLUDING" and then ran
# the GPU task anyway, aborting the whole job at environment build.
if [ -d "$TASK_CACHE" ] && [ -d "$TASK_CACHE/fp8-rmsnorm-gemm" ]; then
  out="$(run_dry TB_ALLOW_SKIP_GPU=1 TB_TASK=terminal-bench/fp8-rmsnorm-gemm)"
  printf '%s\n' "$out" | grep -qx -- "-x" && \
    printf '%s\n' "$out" | grep -qx -- "terminal-bench/fp8-rmsnorm-gemm" && \
    printf '%s\n' "$out" | grep -A1 -x -- "-x" | grep -qx -- "terminal-bench/fp8-rmsnorm-gemm"
  check "a GPU task is excluded with -x, not merely announced" \
        "argv contains -x terminal-bench/fp8-rmsnorm-gemm" $?
else
  echo "  skip GPU exclusion (no task cache — run a sweep once to populate it)"
fi

# ── 2. A GPU task without the opt-out still refuses ──────────────────────────
#
# The exclusion must stay a deliberate, printed act. Fails on any tree that
# silently drops GPU tasks.
if [ -d "$TASK_CACHE/fp8-rmsnorm-gemm" ]; then
  run_dry TB_TASK=terminal-bench/fp8-rmsnorm-gemm >/dev/null 2>&1
  [ $? -eq 2 ]
  check "a GPU task without TB_ALLOW_SKIP_GPU refuses to start" "exit 2" $?
fi

# ── 3. A misspelled task id refuses instead of shrinking the sweep ───────────
#
# FAILS on the shipped tree, which passed the bad id straight to Harbor. Harbor
# matches nothing, raises nothing, runs the remainder, and reports an accuracy
# over a SMALLER task set than the operator asked for — the silent coverage cap
# `rules/bench-agi-purity.md` forbids.
if [ -d "$TASK_CACHE" ]; then
  run_dry TB_TASK=terminal-bench/mvcc-lsm-compation >/dev/null 2>&1
  [ $? -eq 2 ]
  check "a task id that matches nothing refuses to start" "exit 2" $?
fi

# ── 4. A correctly spelled selection still runs ──────────────────────────────
#
# The guard above must not be a blanket refusal. Fails on a validator that
# rejects valid registry-namespaced ids.
if [ -d "$TASK_CACHE/mvcc-lsm-compaction" ]; then
  out="$(run_dry TB_TASK=terminal-bench/mvcc-lsm-compaction)"
  printf '%s\n' "$out" | grep -qx -- "terminal-bench/mvcc-lsm-compaction"
  check "a valid task id is passed through to Harbor" "argv contains the id" $?
fi

# ── 5. No forbidden execution override is ever emitted ───────────────────────
#
# Leaderboard CI rejects a job carrying any timeout multiplier or cpu/gpu/memory
# override, on the job config AND every per-trial config. Fails the moment
# someone adds one for convenience.
out="$(run_dry TB_TASK=terminal-bench/mvcc-lsm-compaction 2>/dev/null || true)"
! printf '%s\n' "$out" | grep -qE -- "timeout.multiplier|override_timeout_sec|max_timeout_sec|override_(cpus|gpus|memory_mb|storage_mb)"
check "no forbidden timeout or resource override is emitted" "argv free of override flags" $?

# ── 6. Two same-second launches still get distinct job ids (TBENCH-ORCH-1) ───
#
# FAILS on the pre-fix runner, whose job id was `date +%Y%m%d-%H%M%S` alone —
# deterministic input to `date`, so two invocations resolving `date` to the
# IDENTICAL value produce byte-identical --job-name values, the exact
# CWE-367-class TOCTOU race that produced the 2026-08-10 v4 orchestration
# job-dir confabulation bug (memory_id 25958). A fake `date` on PATH makes the
# collision scenario deterministic instead of depending on wall-clock luck.
if [ -d "$TASK_CACHE/mvcc-lsm-compaction" ]; then
  fake_date_dir="$(mktemp -d)"
  trap 'rm -rf "$fake_date_dir"; kill "$STUB_PID" 2>/dev/null' EXIT
  cat > "$fake_date_dir/date" <<'FAKE_DATE'
#!/usr/bin/env bash
echo "20260101-000000"
FAKE_DATE
  chmod +x "$fake_date_dir/date"
  job1="$(run_dry PATH="$fake_date_dir:$PATH" TB_TASK=terminal-bench/mvcc-lsm-compaction | grep -A1 -x -- "--job-name" | tail -1)"
  job2="$(run_dry PATH="$fake_date_dir:$PATH" TB_TASK=terminal-bench/mvcc-lsm-compaction | grep -A1 -x -- "--job-name" | tail -1)"
  rm -rf "$fake_date_dir"
  [ -n "$job1" ] && [ -n "$job2" ] && [ "$job1" != "$job2" ]
  check "two launches with an identical (faked) timestamp still get distinct job ids" \
        "job-name differs even when date is forced identical (got '$job1' vs '$job2')" $?
fi

# ════════════════════════════════════════════════════════════════════════════
# run-terransoul-verifyhook.sh — THE SUBMISSION LAUNCHER
# ════════════════════════════════════════════════════════════════════════════
#
# WHY THESE EXIST. A primary-source trace on 2026-08-19 found the committed
# submission launcher handing Claude Code ZERO TerranSoul MCP tools, and
# measuring the wrong model. Every claim below was verified against a file in
# this repo before the test was written:
#
#   * jobs-terransoul/tsvh-shakedown-20260818-212303-30995/config.json —
#     Harbor's OWN resolved config for the 2026-08-18 run: "model":
#     "req/claude-fable-5", no `mcp_servers` on the agent, no
#     `extra_instruction_paths` key at all.
#   * proxy-logs/proxy-tsvh-20260818-210944.jsonl — 38 lines, and every tool
#     call in it is brain_verify_completion (19 of them, from the Stop hook).
#     No `initialize`, no `tools/list`: the agent never opened an MCP session.
#   * proxy-logs/proxy-judgefix-20260817-124232.jsonl — the SAME agent class
#     launched from a config that DID declare mcp_servers: initialize (6),
#     tools/list (3), brain_search (3), brain_kg_neighbors (1). The contrast is
#     what makes the diagnosis a regression rather than a limitation.
#
# Every test below states which of those it would have caught.

VH_RUNNER="${TB_VH_RUNNER:-$HERE/run-terransoul-verifyhook.sh}"

if ! grep -q 'TB_DRY_RUN' "$VH_RUNNER"; then
  echo "REFUSING: $VH_RUNNER has no TB_DRY_RUN seam — these tests would invoke Harbor for real." >&2
  exit 2
fi

echo
echo "run-terransoul-verifyhook.sh guards and MCP wiring"

# THE STUBS. Three processes stand in for a brain, a correctly-pointed proxy,
# and a proxy pointed at production. Each answers:
#   GET  /health -> {"status":"ok","port":<REPORTED>}  — router.rs::handle_health
#                   emits the SERVING brain's own listener port, which is what
#                   the launcher keys its safety check off.
#   POST /mcp    -> initialize / tools/list
#   anything else-> a Messages-API-shaped 200, for the credential preflight.
#
# `initialize` also carries `instructions`, taken from TB_STUB_INSTRUCTIONS,
# because a real server does (router.rs:165 serves tools::SERVER_INSTRUCTIONS
# there) and the launcher now REFUSES a brain serving the pre-de-suppression
# text. The two sample texts come from check-served-instructions.mjs itself
# rather than being retyped here — a fixture holding its own copy of the
# literals is the drift bug this campaign has already shipped once.
STUB_DIR="$(mktemp -d)"
cat > "$STUB_DIR/stub.js" <<'STUB'
const { createServer } = require("node:http");
const [listen, reported, mode] = process.argv.slice(2);
const TOOLS = mode === "no-tools"
  ? ["brain_health"]
  : ["brain_search", "brain_get_entry", "brain_kg_neighbors", "brain_health", "brain_verify_completion"];
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (o) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (req.url.startsWith("/health")) return json({ status: "ok", port: Number(reported), memory_total: 7 });
    if (req.url.startsWith("/mcp")) {
      let rpc = {};
      try { rpc = JSON.parse(body); } catch { /* fall through to a null id */ }
      if (rpc.method === "tools/list") {
        return json({ jsonrpc: "2.0", id: rpc.id ?? null, result: { tools: TOOLS.map((name) => ({ name })) } });
      }
      return json({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          instructions: process.env.TB_STUB_INSTRUCTIONS ?? "",
        },
      });
    }
    return json({ model: "stub", content: [{ type: "text", text: "ok" }] });
  });
// TB_STUB_BIND is load-bearing for tests 40-41, not a convenience. On Windows a
// bind probe sees a holder ONLY at the exact same address (matrix measured in
// start-bench-stack.mjs), and mcp-auth-proxy.mjs listens on 0.0.0.0 while the
// stack launcher probed 127.0.0.1. A decoy that binds the loopback is therefore
// INVISIBLE to the defect those tests exist for: it would be detected by the
// pre-change probe too, and the test would pass on both trees.
}).listen(Number(listen), process.env.TB_STUB_BIND || "127.0.0.1");
STUB

VH_BRAIN_PORT=18901      # the isolated bench brain itself
VH_PROXY_OK_PORT=18902   # a proxy serving that brain
VH_PROXY_PROD_PORT=18903 # a proxy serving the PRODUCTION brain (reports 7423)
VH_PROXY_OTHER_PORT=18904 # a proxy serving some third, unaudited store
VH_PROXY_BARE_PORT=18905 # serves the right brain but not the right tools
VH_PROXY_STALE_PORT=18909 # right brain, right tools, PRE-de-suppression instructions

# The two instruction texts, derived from the gate's own cue lists.
FRESH_INSTRUCTIONS="$(node "$HERE/check-served-instructions.mjs" --sample fresh 2>/dev/null || true)"
STALE_INSTRUCTIONS="$(node "$HERE/check-served-instructions.mjs" --sample stale 2>/dev/null || true)"

TB_STUB_INSTRUCTIONS="$FRESH_INSTRUCTIONS" node "$STUB_DIR/stub.js" "$VH_BRAIN_PORT"       "$VH_BRAIN_PORT" & VH_P1=$!
TB_STUB_INSTRUCTIONS="$FRESH_INSTRUCTIONS" node "$STUB_DIR/stub.js" "$VH_PROXY_OK_PORT"    "$VH_BRAIN_PORT" & VH_P2=$!
TB_STUB_INSTRUCTIONS="$FRESH_INSTRUCTIONS" node "$STUB_DIR/stub.js" "$VH_PROXY_PROD_PORT"  7423             & VH_P3=$!
TB_STUB_INSTRUCTIONS="$FRESH_INSTRUCTIONS" node "$STUB_DIR/stub.js" "$VH_PROXY_OTHER_PORT" 19999            & VH_P4=$!
TB_STUB_INSTRUCTIONS="$FRESH_INSTRUCTIONS" node "$STUB_DIR/stub.js" "$VH_PROXY_BARE_PORT"  "$VH_BRAIN_PORT" no-tools & VH_P5=$!
TB_STUB_INSTRUCTIONS="$STALE_INSTRUCTIONS" node "$STUB_DIR/stub.js" "$VH_PROXY_STALE_PORT" "$VH_BRAIN_PORT" & VH_P8=$!
trap 'kill "$STUB_PID" "$VH_P1" "$VH_P2" "$VH_P3" "$VH_P4" "$VH_P5" "$VH_P8" 2>/dev/null; rm -rf "$STUB_DIR"' EXIT
sleep 1

# The committed MCP config declares this exact URL, and the launcher refuses to
# start if the URL the AGENT is given differs from the one the HOOK is given —
# so the tests use the real value and redirect only the PROBE.
VH_MCP_URL="http://host.docker.internal:7425/mcp"

run_vh() { # run_vh <extra env assignments...> -> prints argv, one per line
  # See run_vh_status below for why the host-headroom guard is disabled here:
  # a suite whose result depends on how many processes happen to be running on
  # the developer's machine is testing the machine, not the script.
  env TB_DRY_RUN=1 \
      TB_MAX_HOST_PROCESSES= \
      ANTHROPIC_BASE_URL="http://127.0.0.1:$VH_BRAIN_PORT" \
      ANTHROPIC_AUTH_TOKEN=stub \
      ANTHROPIC_MODEL=req/claude-sonnet-5 \
      TERRANSOUL_MCP_URL="$VH_MCP_URL" \
      TB_BENCH_BRAIN_PORT="$VH_BRAIN_PORT" \
      TB_BRAIN_PROBE_URL="http://127.0.0.1:$VH_BRAIN_PORT" \
      TB_PROXY_PROBE_URL="http://127.0.0.1:$VH_PROXY_OK_PORT" \
      "$@" bash "$VH_RUNNER" 2>/dev/null
}

run_vh_status() { # same, but returns the exit status and captures stderr
  # TB_MAX_HOST_PROCESSES= disables the host-headroom guard for every test that
  # is not about that guard. Without this, the whole suite becomes a function of
  # how many processes happen to be running on the developer's machine: the
  # guard fires before the assertion under test is ever reached, and four
  # unrelated cases (TB_ALLOW_NO_BRAIN, the production-brain refusal, ...) went
  # red the moment it was added at a moment when the host was at 1045
  # processes. A test that passes or fails on ambient load tests nothing. The
  # three cases that DO exercise the guard opt in with an explicit
  # TB_MAX_HOST_PROCESSES=1.
  env TB_DRY_RUN=1 \
      TB_MAX_HOST_PROCESSES= \
      ANTHROPIC_BASE_URL="http://127.0.0.1:$VH_BRAIN_PORT" \
      ANTHROPIC_AUTH_TOKEN=stub \
      ANTHROPIC_MODEL=req/claude-sonnet-5 \
      TERRANSOUL_MCP_URL="$VH_MCP_URL" \
      TB_BENCH_BRAIN_PORT="$VH_BRAIN_PORT" \
      TB_BRAIN_PROBE_URL="http://127.0.0.1:$VH_BRAIN_PORT" \
      TB_PROXY_PROBE_URL="http://127.0.0.1:$VH_PROXY_OK_PORT" \
      "$@" bash "$VH_RUNNER" 2>&1
}

# ── 7. The agent is actually handed the MCP server ──────────────────────────
#
# FAILS on the pre-change tree for a stated reason: its argv block (lines
# 130-141 at HEAD) contained no --mcp-config at all, so
# claude_code.py::_build_register_mcp_servers_command saw an empty server list
# and skipped writing mcpServers into the container's .claude.json entirely.
out="$(run_vh || true)"
printf '%s\n' "$out" | grep -qx -- "--mcp-config" && \
  printf '%s\n' "$out" | grep -A1 -x -- "--mcp-config" | grep -qx -- "$HERE/mcp-terransoul.json"
check "the agent is given the TerranSoul MCP server (--mcp-config)" \
      "argv contains --mcp-config $HERE/mcp-terransoul.json" $?

# ── 8. The task-agnostic instruction is actually attached ───────────────────
#
# FAILS pre-change: no --extra-instruction-path anywhere, and the resolved
# shakedown config.json has no `extra_instruction_paths` key. extra-instruction
# was an orphaned file on the submission path.
printf '%s\n' "$out" | grep -qx -- "--extra-instruction-path" && \
  printf '%s\n' "$out" | grep -A1 -x -- "--extra-instruction-path" | grep -qx -- "$HERE/extra-instruction-harness.md"
check "the task-agnostic instruction is attached (--extra-instruction-path)" \
      "argv contains --extra-instruction-path $HERE/extra-instruction-harness.md" $?

# ── 9. The WRITE-side instruction is NOT attached ───────────────────────────
#
# Guards the split. extra-instruction-memory.md describes brain_ingest_lesson /
# brain_append / brain_add_edge — every one of them refused by
# mcp-auth-proxy.mjs's default allowlist, and all of them cross-trial writes
# held pending a legitimacy ruling. Fails the moment someone wires it back in.
! printf '%s\n' "$out" | grep -q -- "extra-instruction-memory.md"
check "the held write-side instruction is NOT wired" \
      "argv free of extra-instruction-memory.md" $?

# ── 10. A model that is not the campaign's actor refuses ────────────────────
#
# FAILS pre-change with a precise consequence: the pre-change script defaulted
# TB_SETTINGS_JSON to settings.Terranimus.json (ANTHROPIC_MODEL
# req/claude-fable-5) and had no model check, so this invocation exited 0 and
# built a full argv. That is not a hypothetical — it is what the 2026-08-18
# shakedown did, for real money, and its own resolved config.json records
# "model": "req/claude-fable-5".
outc="$(run_vh_status ANTHROPIC_MODEL=req/claude-fable-5 || true)"
run_vh_status ANTHROPIC_MODEL=req/claude-fable-5 >/dev/null 2>&1
[ $? -eq 2 ] && printf '%s\n' "$outc" | grep -q "REFUSING: ANTHROPIC_MODEL is 'req/claude-fable-5'"
check "a model other than TB_EXPECT_MODEL refuses to start" \
      "exit 2 and a printed refusal naming the wrong model" $?

# ── 10b. A host with no process headroom refuses ────────────────────────────
#
# FAILS pre-change: there was no host-load check at all, so a sweep launched
# into an exhausted process table and DIED there. MEASURED
# (tsbroad-20260819-080345-63875): 19 of 20 trials returned 3221225794
# (0xC0000142, Windows "DLL initialization failed") because harbor could not
# spawn `docker compose` for build/cp/down/verify. The job produced a
# result.json and no measurement.
#
# The guard checks HEADROOM, not liveness, and these tests pin why: memory was
# fine (27 GB free) at the moment of collapse, and `docker compose version`
# still succeeded at the same process count -- so neither a memory check nor a
# spawn probe would have caught it.
outc="$(run_vh_status TB_MAX_HOST_PROCESSES=1 || true)"
run_vh_status TB_MAX_HOST_PROCESSES=1 >/dev/null 2>&1
[ $? -eq 2 ] && printf '%s
' "$outc" | grep -q "REFUSING: .* host processes"
check "a host over the process-headroom limit refuses to start"       "exit 2 and a printed refusal naming the process count" $?

# The escape hatch must proceed AND say so, matching TB_ALLOW_SKIP_GPU /
# TB_ALLOW_NO_BRAIN: a degraded run is allowed, never silent.
outc="$(run_vh_status TB_MAX_HOST_PROCESSES=1 TB_ALLOW_HIGH_LOAD=1 || true)"
printf '%s
' "$outc" | grep -q "WARNING: .* host processes" &&
  printf '%s
' "$outc" | grep -q "3221225794"
check "TB_ALLOW_HIGH_LOAD proceeds but warns, naming the failure code"       "a printed warning citing 0xC0000142" $?

# An explicitly empty value disables the guard entirely, so the check can never
# become an unbypassable blocker on a host whose process count is simply large.
outc="$(run_vh_status TB_MAX_HOST_PROCESSES= || true)"
printf '%s
' "$outc" | grep -qv "host processes"
check "an empty TB_MAX_HOST_PROCESSES disables the headroom guard"       "no host-process line at all" $?

# ── 11. No brain wired at all refuses ───────────────────────────────────────
#
# FAILS pre-change: an unset TERRANSOUL_MCP_URL simply skipped the --ae block
# and the job ran. The script's own comment already documented the effect
# ("the verify gate never fires") without ever refusing — a full sweep that
# measures stock Claude Code while reporting agent=claude-code-terransoul-hook.
env TB_DRY_RUN=1 \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$VH_BRAIN_PORT" \
    ANTHROPIC_AUTH_TOKEN=stub \
    ANTHROPIC_MODEL=req/claude-sonnet-5 \
    bash "$VH_RUNNER" >/dev/null 2>&1
[ $? -eq 2 ]
check "an unset TERRANSOUL_MCP_URL refuses to start" "exit 2" $?

# ── 12. ...unless the degradation is declared, and then it is on the receipt ─
env TB_DRY_RUN=1 \
    TB_MAX_HOST_PROCESSES= \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$VH_BRAIN_PORT" \
    ANTHROPIC_AUTH_TOKEN=stub \
    ANTHROPIC_MODEL=req/claude-sonnet-5 \
    TB_ALLOW_NO_BRAIN=1 \
    bash "$VH_RUNNER" >/dev/null 2>&1
s=$?
noBrainOut="$(env TB_DRY_RUN=1 \
    TB_MAX_HOST_PROCESSES= \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$VH_BRAIN_PORT" \
    ANTHROPIC_AUTH_TOKEN=stub \
    ANTHROPIC_MODEL=req/claude-sonnet-5 \
    TB_ALLOW_NO_BRAIN=1 \
    bash "$VH_RUNNER" 2>&1 || true)"
[ $s -eq 0 ] && printf '%s\n' "$noBrainOut" | grep -q "brain=NONE"
check "TB_ALLOW_NO_BRAIN runs, and the receipt says the brain is absent" \
      "exit 0 and a receipt line containing brain=NONE" $?

# ── 13. A proxy pointed at the PRODUCTION brain refuses ─────────────────────
#
# THE CONTAMINATION GUARD. mcp-auth-proxy.mjs's TB_PROXY_UPSTREAM_PORT USED TO
# DEFAULT to 7423 — the production brain, which holds task-specific
# TerminalBench lessons from earlier campaigns. That default is gone (test 21
# below pins the replacement), but this guard stays: it is what caught the
# 2026-08-19 proxy that had been started with no upstream set. Nothing in the
# pre-change tree looked at which store was behind the proxy; the check does
# not trust configuration, it reads the port the SERVING brain reports about
# itself through the very URL the container would use.
prodOut="$(run_vh_status TB_PROXY_PROBE_URL="http://127.0.0.1:$VH_PROXY_PROD_PORT" || true)"
run_vh TB_PROXY_PROBE_URL="http://127.0.0.1:$VH_PROXY_PROD_PORT" >/dev/null 2>&1
[ $? -eq 2 ] && printf '%s\n' "$prodOut" | grep -q "PRODUCTION brain"
check "a proxy serving the production brain refuses to start" \
      "exit 2 and a refusal naming the production brain" $?

# ── 14. A proxy serving some OTHER store refuses too ────────────────────────
#
# The guard must be an allowlist of one (the audited bench store), not merely a
# denylist of 7423 — otherwise any third, unaudited brain passes.
run_vh TB_PROXY_PROBE_URL="http://127.0.0.1:$VH_PROXY_OTHER_PORT" >/dev/null 2>&1
[ $? -eq 2 ]
check "a proxy serving an unaudited third store refuses to start" "exit 2" $?

# ── 15. The tools must be ON THE WIRE, not merely configured ────────────────
#
# A config file proves intent; tools/list proves service. This stub serves the
# right brain on the right port and advertises only brain_health.
run_vh TB_PROXY_PROBE_URL="http://127.0.0.1:$VH_PROXY_BARE_PORT" >/dev/null 2>&1
[ $? -eq 2 ]
check "a proxy that does not serve the expected tool set refuses to start" "exit 2" $?

# ── 16. Cross-trial writes are not switched on anywhere ─────────────────────
#
# TB_PROXY_MODE=learn admits brain_ingest_lesson / brain_append / brain_add_edge
# / brain_close_edge. Those are held pending a legitimacy ruling; the submission
# path must not enable them. Checks the committed submission-path files only —
# mcp-auth-proxy.mjs itself must keep READING the variable.
! grep -rn "TB_PROXY_MODE=learn" \
    "$VH_RUNNER" "$HERE/run-terransoul.sh" "$HERE/mcp-terransoul.json" \
    "$HERE/claude-settings-verifyhook.json" "$HERE/extra-instruction-harness.md" >/dev/null 2>&1
check "no submission-path file sets TB_PROXY_MODE=learn" "learn mode not enabled anywhere on the path" $?

# ── 17. PURITY: the shipped instruction names no benchmark task ─────────────
#
# Same standard as clean-bench-brain.mjs: THE ROSTER IS READ FROM THE DATASET,
# never hardcoded — a list compiled into a test is stale the day the benchmark
# adds a task, and it would put benchmark identity into our source
# (rules/bench-agi-purity.md). Case-insensitive, because a task name written in
# prose capitalisation is the same leak.
HARNESS_MD="$HERE/extra-instruction-harness.md"
if [ -d "$TASK_CACHE" ]; then
  named="$(TB_ROSTER="$TASK_CACHE" TB_DOC="$HARNESS_MD" node -e '
    const fs = require("node:fs");
    const roster = fs.readdirSync(process.env.TB_ROSTER).filter((n) => !n.startsWith("."));
    const doc = fs.readFileSync(process.env.TB_DOC, "utf8").toLowerCase();
    console.log(roster.filter((n) => doc.includes(n.toLowerCase())).join(" "));
  ')"
  [ -z "$named" ]
  check "the shipped instruction names no task from the dataset roster" \
        "no task name appears in extra-instruction-harness.md (found:${named:-none})" $?
else
  echo "  skip purity gate (no task cache at $TASK_CACHE)"
fi

# ── 17b. The shipped instruction does not suppress repeat consultation ──────
#
# FAILS on the pre-change file, per phrase, for reasons that were MEASURED
# rather than suspected. Across 6 trials the agent made exactly six
# brain_search calls -- one per trial, at the start -- then zero further memory
# calls for the remaining ~40 minutes of each task; campaign-wide the proxy log
# shows ~17 agent-initiated searches against 222 automatic Stop-hook
# brain_verify_completion calls. The instruction text was a verified
# contributing cause, and every literal below was present in it:
#
#   "default expectation"                   line 6-7  -- told the agent to hold
#       a prior of IRRELEVANCE before its first search, in the file's second
#       sentence. A bench-local addition with no counterpart in the product's
#       SERVER_INSTRUCTIONS.
#   "unsure about"                          line 32   -- the file's ONLY
#       consultation trigger, firing on an internal state a competent model
#       rarely reports to itself mid-task.
#   "do not let consulting memory delay you" line 38-39 -- singular ("a
#       search"), standalone, and the LAST sentence of the memory section, so
#       it licensed permanent abandonment after exactly one miss. That is
#       precisely the measured behaviour.
#   "move on and solve the task directly"    line 38   -- same sentence pair.
#   "<!--"                                  line 129  -- a 2252-byte maintainer
#       note, 25.7% of the file, whose own first line claimed it was "not shown
#       as a rule to the agent". Harbor does not parse Markdown: task.py does
#       read_text() then "\n\n".join(...) and claude_code.py pipes the result
#       into `claude --print`, so it shipped VERBATIM in the recency-strongest
#       final position -- including a passage stating that the prose the agent
#       had just read WAS the prior pre-seeded into the store, i.e. an in-prompt
#       argument that searching is redundant. It now lives in
#       DESIGN-extra-instruction-harness.md, which is not wired to anything.
#
# This is not a tautology check: the literals are asserted against a file this
# test does not write, and the same suite's test 8 pins that this exact file is
# the one attached to every trial.
#
# MATCHED IN NODE, NOT grep, AND DELIBERATELY SO. `grep -iF` ABORTS (SIGABRT,
# exit 134) on GNU grep 3.0 as shipped with Git for Windows — the host this
# suite is developed on. An absence check written as `grep -qiF "$p" && found=`
# therefore records NOTHING when grep dies and reports a clean file whatever it
# contains: measured, the pre-change file passed that version of this test. A
# check that cannot fail is worse than no check (rules/tests-must-be-able-to-
# fail.md), so every half runs through one substring matcher whose failure is
# loud — if it stops matching, the PRESENCE half below reports all four of its
# literals missing and goes red.
#
# WHITESPACE IS NORMALISED BEFORE MATCHING. The file is hand-wrapped at ~78
# columns, so a phrase routinely straddles a line break: "Do\nnot let consulting
# memory delay you" is one of the five, and a raw substring match MISSED it on
# the pre-change file while finding its four siblings. Re-wrapping a paragraph
# would then silently un-guard whatever the new wrap split. Collapsing every
# whitespace run to a single space makes the guard indifferent to layout.
PHRASE_CHECK='
const fs = require("node:fs");
const flat = (s) => s.replace(/\s+/g, " ").toLowerCase();
const doc = flat(fs.readFileSync(process.env.TB_DOC, "utf8"));
const want = JSON.parse(process.env.TB_PHRASES);
const hit = want.filter((p) => doc.includes(flat(p)));
const bad = process.env.TB_EXPECT === "absent" ? hit : want.filter((p) => !hit.includes(p));
if (want.length === 0) { process.stderr.write("no phrases supplied\n"); process.exit(2) }
process.stdout.write(bad.map((p) => "[" + p + "]").join(" "));
process.exit(bad.length === 0 ? 0 : 1);
'
found="$(TB_DOC="$HARNESS_MD" TB_EXPECT=absent TB_PHRASES='[
  "default expectation",
  "do not let consulting memory delay you",
  "move on and solve the task directly",
  "unsure about",
  "<!--"
]' node -e "$PHRASE_CHECK")"
st=$?
[ "$st" -eq 0 ]
check "the shipped instruction carries no memory-suppression phrasing" \
      "none of the five suppression literals appear (found:${found:-none})" $?

# The other half: removing the discouragement is not the same as telling the
# truth about the transport. These four literals pin the TRANSPORT DELTA -- the
# only thing this file can say that SERVER_INSTRUCTIONS cannot, because the
# server does not know it is being fronted by a rewriting proxy.
#
# AN EARLIER VERSION OF THIS HALF REQUIRED THE LITERAL `multihop` AND WAS WRONG
# TO. It pinned "set mode to multihop when your wording missed" into the shipped
# file as a remedy, and that remedy is INERT AT THIS TRANSPORT. Traced end to
# end:
#   mcp-auth-proxy.mjs (THINKING_MODE, default 'think'; THINKING_MODE_TOOLS =
#     {brain_search}) overwrites `thinking_mode` on EVERY brain_search before it
#     reaches the server
#   -> tools.rs parse_thinking_mode_arg -> Some(ChatMode::Think)
#   -> ladder_rung(Think) = LadderRung::Bridge
#   -> Bridge with `mode` absent rewrites the request to SearchMode::Multihop.
# So multihop is ALREADY the effective default here, and passing mode:multihop
# explicitly only sets mode_was_explicit=true on a request whose mode is that
# same value -- an identical query. An agent that followed the advice spent a
# turn to change nothing and, worse, read the unchanged result as proof the
# store had nothing. The presence check GUARDED that advice against removal,
# which is how a test pins a defect in place instead of a behaviour.
#
# The honest remedy at this transport is the one that does move the result:
# re-query with different WORDS. That is what these literals now pin, together
# with the correction to the schema's documented `rrf` default -- which is true
# of the product and false of this session.
#
# AND THE REPAIR ITSELF PINNED A FALSEHOOD, WHICH IS WHY THE THIRD LITERAL
# CHANGED ON 2026-08-20. It used to be `changes nothing about what comes back`,
# quoting a shipped sentence that generalised multihop's inertness to the WHOLE
# `mode` argument: "so choosing `mode` yourself -- `multihop` included --
# changes nothing about what comes back". False, and falsifiable in one read of
# the server:
#   tools.rs ~2142  LadderRung::Bridge rewrites the request ONLY when
#                   `mode_was_explicit` is false; the comment at ~2137 states
#                   the rule outright ("It must not override an explicit
#                   `mode`").
#   tools.rs ~117   the thinking_mode schema tells the MODEL the same thing on
#                   every request: "It upgrades the DEFAULT only -- pass 'mode'
#                   explicitly and your choice is honoured".
# So `hyde`, `hybrid`, `rrf_iterative` and an explicit `rrf` all reach the
# server intact. The shipped file was contradicting the tool description
# delivered beside it, and this presence check GUARDED the contradiction -- the
# same "the test pins the defect" shape the `multihop` literal above had to be
# undone for, one round earlier, in this very block.
#
# The replacement literal pins the TRUE, NARROW transport delta instead: an
# omitted `mode` already IS the bridge hop, so `multihop` -- and only
# `multihop` -- asks for what the session is already doing. That claim is a
# consequence of the proxy pin (17b-iv keeps the two connected), it does not
# contradict any schema, and correcting the surrounding prose no longer
# requires turning a gate red.
#
# FAILS ON THE PRE-CHANGE FILE: `git show HEAD:...` never mentions the `mode`
# argument at all (it describes only the thinking_mode ladder), and carries no
# re-query guidance of any kind. Measured against HEAD's copy: all four
# reported missing. Measured again 2026-08-20 against the immediately
# preceding on-disk file (the one carrying the false sentence): the three
# unchanged literals were found and `asks for the mode you are already getting`
# was reported missing, so this half is red on that tree too.
missing="$(TB_DOC="$HARNESS_MD" TB_EXPECT=present TB_PHRASES='[
  "documents `rrf` as its default",
  "already upgraded to the knowledge-graph bridge hop",
  "asks for the mode you are already getting",
  "ask again with the literal error text"
]' node -e "$PHRASE_CHECK")"
st=$?
[ "$st" -eq 0 ]
check "the shipped instruction states the transport delta and a working retry" \
      "all four literals appear (missing:${missing:-none})" $?

# ── 17b-iii. The file does NOT restate what SERVER_INSTRUCTIONS already says ─
#
# HONESTLY LABELLED, AND THE LABEL CHANGED ON 2026-08-20. The first four
# literals are a REGRESSION GUARD: they pass trivially on `git show HEAD:...`,
# because the duplication they forbid was never committed -- it was introduced
# and removed inside this same workstream. They are here because the mistake is
# a recurring one and cheap to make again.
#
# THE FIFTH LITERAL IS NOT A REGRESSION GUARD -- IT IS RED ON BOTH PRE-CHANGE
# TREES. "Keep `limit` small" was shipped verbatim, at HEAD (line 48) and in
# the immediately preceding on-disk file, and it is a near-verbatim copy of
# SERVER_INSTRUCTIONS (tools.rs ~1743: "Keep `limit` small (3-5): large results
# get truncated by tool-result budgets, and a tight limit returns something you
# can actually read"), which router.rs serves to EVERY client at `initialize`,
# this one included. It is a property of the SERVER, not of this proxy, so
# carrying it here contradicted the shipped file's own opening claim that "what
# follows is only what is different about THIS transport" -- an undeclared
# duplicate hiding inside a promise of no duplication. Deleted from the shipped
# file; DESIGN-extra-instruction-harness.md's keep-list, which wrongly listed
# it as a transport delta, was corrected in the same change.
#
# The three consultation triggers and the miss-is-not-a-verdict guidance now
# live in tools.rs::SERVER_INSTRUCTIONS ("WHEN TO SEARCH, AND WHEN TO SEARCH
# AGAIN"), which router.rs serves to EVERY client at `initialize` and which
# integration_tests.rs::initialize_instructions_require_recurring_memory_
# consultation pins. Restating them here buys nothing and costs a second copy
# that can drift out of agreement with the first -- and every duplicated token
# is paid in every trial's context window, on a run whose stated failure mode
# is context pressure. The first four literals below are the section headers of
# that product text and the fifth is a sentence out of its `brain_search`
# bullet; if any of them reappears in the shipped file, one of the two copies is
# about to become wrong.
dupes="$(TB_DOC="$HARNESS_MD" TB_EXPECT=absent TB_PHRASES='[
  "Before you commit to an approach",
  "After a result you did not predict",
  "Before you declare the task done",
  "one miss, not a verdict",
  "Keep `limit` small"
]' node -e "$PHRASE_CHECK")"
st=$?
[ "$st" -eq 0 ]
check "the shipped instruction does not duplicate SERVER_INSTRUCTIONS doctrine" \
      "no product-text doctrine restated (found:${dupes:-none})" $?

# ── 17b-iv. The shipped claim about `mode` stays TRUE of the proxy ──────────
#
# HONESTLY LABELLED: a REGRESSION GUARD. It passes on `git show HEAD:...` of
# the proxy, whose default was already 'think'. It is not evidence for this
# change; it exists so the change cannot silently rot.
#
# WHAT IT PROTECTS. The shipped file now asserts something about the SERVER
# that is only true because of the PROXY: that an omitted `mode` is already
# upgraded to the graph bridge hop. That holds because ladder_rung(Think) =
# LadderRung::Bridge and Bridge rewrites an absent `mode` to Multihop. It does
# NOT hold for any other rung -- ladder_rung(Research) and ladder_rung(Max)
# route to the orchestrators and leave `mode` alone, and ladder_rung(Chat)
# passes the request through byte-identically, in which case the schema's
# documented `rrf` default is once again the truth.
#
# So a one-word edit to the proxy's default silently converts a shipped
# instruction into a shipped falsehood, delivered to every trial, with nothing
# to notice it. That is exactly how the sentence this replaced became false in
# the first place: it stated the SCHEMA default while the proxy quietly moved
# the EFFECTIVE one, and no test connected the two files. This connects them.
pin="$(TB_PROXY="$HERE/mcp-auth-proxy.mjs" node -e '
const fs = require("node:fs");
const src = fs.readFileSync(process.env.TB_PROXY, "utf8");
const m = src.match(/const THINKING_MODE = \(process\.env\.TB_THINKING_MODE \|\| .([a-z]+).\)/);
if (!m) { process.stderr.write("could not read the proxy default\n"); process.exit(2) }
process.stdout.write(m[1]);
')"
[ "$pin" = "think" ]
check "the proxy still pins the rung the shipped instruction describes" \
      "mcp-auth-proxy.mjs default THINKING_MODE is 'think' (got:${pin:-unreadable}) — \
any other rung makes the file's '\`mode\` is already upgraded' claim false" $?

# ── 17c. The maintainer design note is NOT attached ─────────────────────────
#
# HONESTLY LABELLED: a REGRESSION GUARD, not evidence for this change. It
# passes on the pre-change tree trivially, because the file it names did not
# exist there -- the note was an HTML comment inside the shipped file, which is
# the defect test 17b's "<!--" literal covers. This guard exists because the
# fix relocated that note to a sibling .md, and the one mistake that would undo
# the fix is wiring the sibling back onto --extra-instruction-path. Same shape
# and same reasoning as test 9. `$out` is still the submission launcher's argv
# from test 7; nothing reassigns it in between.
! printf '%s\n' "$out" | grep -q -- "DESIGN-extra-instruction-harness.md"
check "the maintainer design note is NOT wired into the prompt" \
      "argv free of DESIGN-extra-instruction-harness.md" $?

# ════════════════════════════════════════════════════════════════════════════
# THE STACK ITSELF — start-bench-brain.mjs, mcp-auth-proxy.mjs,
# start-bench-stack.mjs (tests 18-23, added 2026-08-19)
# ════════════════════════════════════════════════════════════════════════════
#
# WHY THESE EXIST. Every defect below was hit for real on 2026-08-19, and each
# one produced a WRONG or DEAD benchmark run rather than an error:
#
#   * `start-bench-brain.mjs --port 7424` silently bound a DIFFERENT port when
#     7424 was still held by a launch that had not died — it bound 7425, the
#     AUTH PROXY's own port, and reported success. The launcher's own
#     contamination guard then reported the surreal "the proxy is serving a
#     brain that reports port 7425". Two brains, neither where anything
#     expected one.
#   * `mcp-auth-proxy.mjs` fell back to the PRODUCTION store's token
#     (`<cwd>/mcp-data/mcp-token.txt`) when its token variable was misspelt
#     (`TB_PROXY_TOKEN_FILE`, which nothing reads). It failed safe only by
#     luck: the bench brain has a different token, so the result was a 401.
#   * `TB_PROXY_UPSTREAM_PORT` defaulted to 7423 — the production brain, which
#     holds task-specific TerminalBench lessons from earlier campaigns.
#   * The stack had no owned lifecycle: the proxy was a harness-tracked
#     background task, was killed mid-sweep, and left trials running with no
#     MCP for ~12 minutes against a fail-open Stop hook.
#
# These tests are cheap and side-effect-free by construction: every refusal
# they exercise happens BEFORE anything is spawned or bound for real, the
# proxy cases bind only high test ports, and no case can reach
# target-mcp/release/terransoul.exe (the port-occupancy gate refuses ahead of
# the binary check — deliberately, so a test can never launch a real brain).

echo
echo "the bench MCP stack's own guards"

REPO="$(cd "$HERE/../.." && pwd)"
STACK_HOLD_PORT=18906   # a healthy stranger squatting on the requested port
STACK_WRONG_PORT=18907  # answers, but reports a DIFFERENT port than it listens on
STACK_PROXY_PORT=18908  # scratch listen port for the proxy cases

TB_STUB_INSTRUCTIONS="$FRESH_INSTRUCTIONS" node "$STUB_DIR/stub.js" "$STACK_HOLD_PORT"  "$STACK_HOLD_PORT" & VH_P6=$!
TB_STUB_INSTRUCTIONS="$FRESH_INSTRUCTIONS" node "$STUB_DIR/stub.js" "$STACK_WRONG_PORT" "$VH_BRAIN_PORT"   & VH_P7=$!
trap 'kill "$STUB_PID" "$VH_P1" "$VH_P2" "$VH_P3" "$VH_P4" "$VH_P5" "$VH_P6" "$VH_P7" "$VH_P8" 2>/dev/null; rm -rf "$STUB_DIR"' EXIT
sleep 1

BRAIN_TMP="$(mktemp -d)"

# ── 18. A taken port is a REFUSAL naming the holder, never a fallback ────────
#
# FAILS pre-change for a stated reason: the shipped script's first act was
# `if (await isHealthy(port)) { ... reusing it (not re-launching) ... exit(0) }`
# — anything that answered /health on that port was adopted sight unseen, so
# this exact invocation exited 0 and printed "something is already healthy on
# 18906; reusing it". It never asked WHO was there, which is why a stray second
# brain on the proxy's port read as success.
brainOut="$(node "$HERE/start-bench-brain.mjs" --port "$STACK_HOLD_PORT" --data-dir "$BRAIN_TMP" --wait 1 2>&1)"
brainStatus=$?
[ "$brainStatus" -ne 0 ] &&
  printf '%s\n' "$brainOut" | grep -q "REFUSING: port $STACK_HOLD_PORT is already held" &&
  printf '%s\n' "$brainOut" | grep -qE "held by (pid [0-9]+|an unidentified process)"
check "a bench brain refuses a port already held, naming the holder" \
      "non-zero exit and a refusal identifying the process on the port (got exit $brainStatus)" $?

# ── 19. --reuse does not launder a stranger, and the wrong-port shape is named ─
#
# FAILS pre-change: `--reuse` did not exist, and the unconditional
# already-healthy branch adopted this stub too — exit 0. The stub here reports
# a port OTHER than the one it listens on, which is the 2026-08-19 shape
# exactly (a brain serving 7425 while everything believed it was on 7424).
# Reuse is now granted only to an instance THIS launcher started, on THIS port,
# against THIS data dir, recorded in .stack/brain-<port>.json.
reuseOut="$(node "$HERE/start-bench-brain.mjs" --port "$STACK_WRONG_PORT" --data-dir "$BRAIN_TMP" --wait 1 --reuse 2>&1)"
reuseStatus=$?
[ "$reuseStatus" -ne 0 ] &&
  printf '%s\n' "$reuseOut" | grep -q "NOT the port requested here" &&
  printf '%s\n' "$reuseOut" | grep -q "no record of starting anything on that port"
check "--reuse still refuses an instance this launcher did not start" \
      "non-zero exit, the reported-port mismatch named, and the registry miss stated (got exit $reuseStatus)" $?

rm -rf "$BRAIN_TMP"

# ── 20. The proxy refuses a token belonging to a different store ─────────────
#
# FAILS pre-change: token resolution was
# `process.env.TERRANSOUL_MCP_TOKEN_FILE || path.join(process.cwd(), 'mcp-data', 'mcp-token.txt')`
# with no relationship to the upstream at all, so this invocation read the
# PRODUCTION token, bound its listen port and served happily until `timeout`
# killed it. The measured consequence on 2026-08-19 was a 401 mid-run — safe
# only because the two stores' tokens differ.
STORE_TMP="$(mktemp -d)"
tokOut="$(env TB_PROXY_PORT="$STACK_PROXY_PORT" \
              TB_PROXY_UPSTREAM_PORT="$VH_BRAIN_PORT" \
              TB_PROXY_UPSTREAM_DATA_DIR="$STORE_TMP" \
              TERRANSOUL_MCP_TOKEN_FILE="$REPO/mcp-data/mcp-token.txt" \
              timeout 10 node "$HERE/mcp-auth-proxy.mjs" 2>&1)"
tokStatus=$?
rm -rf "$STORE_TMP"
[ "$tokStatus" -eq 2 ] && printf '%s\n' "$tokOut" | grep -q "different store than the upstream"
check "the proxy refuses a token file from a different store than its upstream" \
      "exit 2 and a refusal naming the store mismatch (got exit $tokStatus)" $?

# ── 21. No production default is reachable — the upstream ────────────────────
#
# FAILS pre-change: with no TB_PROXY_UPSTREAM_PORT the proxy resolved 7423 and
# would have printed `listening on 0.0.0.0:$STACK_PROXY_PORT -> 127.0.0.1:7423`
# while reading mcp-data/mcp-token.txt. A bench-scoped proxy whose default is
# the production brain is the root cause; the downstream guard in
# run-terransoul-verifyhook.sh that caught it is a second line of defence, not
# a licence for the first to be wrong.
defOut="$(env TB_PROXY_PORT="$STACK_PROXY_PORT" timeout 8 node "$HERE/mcp-auth-proxy.mjs" 2>&1 || true)"
printf '%s\n' "$defOut" | grep -q "upstream=127.0.0.1:7424 store=mcp-data-tbench-clean" &&
  ! printf '%s\n' "$defOut" | grep -qE "127\.0\.0\.1:7423|mcp-data[\\/]mcp-token"
check "with no env set, the proxy defaults to the bench brain and its token, never production" \
      "a receipt naming upstream 7424 / mcp-data-tbench-clean, and no mention of 7423 or the production token" $?

# ── 22. ...and pointing it at production is an explicit, refused-by-default act ─
#
# FAILS pre-change: 7423 was simply the default, so an explicit 7423 was
# indistinguishable from silence and the proxy started normally.
prodProxyOut="$(env TB_PROXY_PORT="$STACK_PROXY_PORT" TB_PROXY_UPSTREAM_PORT=7423 \
                    timeout 8 node "$HERE/mcp-auth-proxy.mjs" 2>&1)"
prodProxyStatus=$?
[ "$prodProxyStatus" -eq 2 ] && printf '%s\n' "$prodProxyOut" | grep -q "REFUSING: upstream is the PRODUCTION brain"
check "an explicit production upstream refuses without TB_PROXY_ALLOW_PRODUCTION_UPSTREAM" \
      "exit 2 and a refusal naming the production brain (got exit $prodProxyStatus)" $?

# ── 23. The runner points at THE ONE COMMAND, and the stack verifies itself ──
#
# FAILS pre-change on both halves: the refusal listed the two hand-typed
# commands (start-bench-brain.mjs, then mcp-auth-proxy.mjs) whose ordering and
# three environment variables are precisely what nobody can get right silently,
# and start-bench-stack.mjs did not exist — `node` would have exited with
# "Cannot find module", printing no READY/NOT READY verdict at all.
stackHintOut="$(env TB_DRY_RUN=1 \
    TB_MAX_HOST_PROCESSES= \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$VH_BRAIN_PORT" \
    ANTHROPIC_AUTH_TOKEN=stub \
    ANTHROPIC_MODEL=req/claude-sonnet-5 \
    bash "$VH_RUNNER" 2>&1 || true)"
# --status must also REPORT rather than assume: the brain stub is healthy and
# reports its own port, the "proxy" here reports 7423, so the stack is NOT
# READY and must say so instead of handing over a URL.
stackStatusOut="$(node "$HERE/start-bench-stack.mjs" --status \
    --brain-port "$VH_BRAIN_PORT" --proxy-port "$VH_PROXY_PROD_PORT" 2>&1 || true)"
printf '%s\n' "$stackHintOut" | grep -q "start-bench-stack.mjs" &&
  printf '%s\n' "$stackStatusOut" | grep -q "NOT READY"
check "the runner's refusal names the stack launcher, and --status reports NOT READY honestly" \
      "the refusal cites start-bench-stack.mjs and --status prints NOT READY" $?

# ── 24. An inherited TB_PROXY_MODE=learn must NOT reach the stack's proxy ────
#
# FAILS pre-change for a measured reason: start-bench-stack.mjs spawned the
# proxy with `...process.env` and a comment claiming "Writes stay blocked.
# TB_PROXY_MODE is deliberately NOT set here." NOT SETTING IS NOT CLEARING -- a
# `TB_PROXY_MODE=learn` exported in the operator's shell hours earlier, for a
# research arm, rode into the detached proxy of a read-only submission run. The
# identical brain_ingest_lesson call was refused -32001 in one mode and proxied
# straight through in the other.
#
# Nothing else could catch it: test 15 greps FILES and cannot see an exported
# variable, tools/list is unfiltered and identical in both modes, and neither
# the READY receipt nor the registry recorded the mode. TB-3 requires 0 brain
# writes, so this voided the run's central claim with no artifact anywhere.
grep -q "TB_PROXY_MODE: proxyMode" "$HERE/start-bench-stack.mjs" &&
  grep -q "TB_STACK_PROXY_MODE" "$HERE/start-bench-stack.mjs" &&
  grep -q "proxyMode: proxyMode || 'read-only'" "$HERE/start-bench-stack.mjs" &&
  grep -q "mode=\${proxyMode || 'read-only'}" "$HERE/start-bench-stack.mjs"
check "the stack sets the proxy's write mode explicitly and records it"       "TB_PROXY_MODE set from TB_STACK_PROXY_MODE, and the mode on both receipt and registry" $?

# The mode variable must actually be load-bearing, or the assertion above is
# decoration: empty blocks writes, 'learn' opens exactly the curated set.
blockedOut="$(TB_PROXY_MODE= TB_PROXY_PORT=18912 TB_PROXY_UPSTREAM_PORT=7424 timeout 8 node "$HERE/mcp-auth-proxy.mjs" 2>&1 || true)"
printf '%s
' "$blockedOut" | grep -q "writes blocked"
check "an explicitly empty TB_PROXY_MODE really does block writes"       "the proxy reports (writes blocked)" $?

# ── 25. An explicit data dir that contradicts a KNOWN upstream port refuses ──
#
# FAILS pre-change: TB_PROXY_UPSTREAM_DATA_DIR was trusted outright, so naming
# it explicitly walked past the "production token for a non-production
# upstream" check (that check is reached only when the dir was DERIVED).
# Measured: TB_PROXY_UPSTREAM_PORT=7424 with the production data dir started and
# served -- the PRODUCTION token fronting the BENCH brain, the same shape as the
# original misspelt-variable incident, surviving to a 401 mid-run.
mismatchOut="$(TB_PROXY_PORT=18912 TB_PROXY_UPSTREAM_PORT=7424   TB_PROXY_UPSTREAM_DATA_DIR="$REPO/mcp-data" timeout 10 node "$HERE/mcp-auth-proxy.mjs" 2>&1 || true)"
printf '%s
' "$mismatchOut" | grep -q "REFUSING: TB_PROXY_UPSTREAM_DATA_DIR says the upstream"
check "a data dir contradicting a known upstream port refuses"       "a refusal naming both the claimed store and the port's real store" $?

# ════════════════════════════════════════════════════════════════════════════
# THE CALL LOG ITSELF — mcp-auth-proxy.mjs's observability (tests 26-29,
# added 2026-08-19)
# ════════════════════════════════════════════════════════════════════════════
#
# WHY THESE EXIST. The proxy call log is the ONLY host-side witness of how the
# agent used TerranSoul, and it recorded a tool NAME and a verdict — nothing
# about either side's content. Measured consequence: a whole campaign's log
# showed ~17 agent-initiated brain_search calls against 222 hook-fired
# brain_verify_completion calls, and could not say whether ANY of those searches
# returned anything. An empty search and a six-hit search were byte-identical
# lines, so "the agent stopped consulting memory" and "the agent consulted
# memory and the store had nothing for it" both survived the campaign
# unfalsified — and telling them apart afterwards meant re-running a bench,
# which is precisely what an artifact exists to avoid.
#
# The driver below owns its whole scenario in ONE process — stub upstream,
# proxy child, three requests, teardown — so a Ctrl-C cannot orphan a listener
# the way this suite's shell-backgrounded stubs can. It binds only 18913/18914
# and self-terminates after 30 s even if abandoned.

echo
echo "the proxy call log's observability"

OBS_TMP="$(mktemp -d)"
OBS_BRAIN_PORT=18913
OBS_PROXY_PORT=18914
trap 'kill "$STUB_PID" "$VH_P1" "$VH_P2" "$VH_P3" "$VH_P4" "$VH_P5" "$VH_P6" "$VH_P7" "$VH_P8" 2>/dev/null; rm -rf "$STUB_DIR" "$OBS_TMP"' EXIT

cat > "$STUB_DIR/obs-driver.js" <<'OBSDRIVER'
// Drives mcp-auth-proxy.mjs end-to-end and reports what its call log recorded.
//
// One process owns the whole scenario — stub upstream, proxy child, the three
// requests and the teardown — so a killed test run cannot orphan a listener the
// way a suite of shell-backgrounded stubs can. Every exit path goes through
// finish().
const http = require('node:http')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const [proxyPath, logPath, brainPortArg, proxyPortArg, proxyOutPath] = process.argv.slice(2)
const brainPort = Number(brainPortArg)
const proxyPort = Number(proxyPortArg)

// Three hits, so `results` cannot be confused with a boolean or a byte count.
const HITS = [
  { id: 101, content: 'first' },
  { id: 102, content: 'second' },
  { id: 103, content: 'third' },
]
const PAYLOAD_TEXT = JSON.stringify(HITS)
// 250 chars: longer than the proxy's 200-char query cap, so truncation is
// exercised rather than assumed.
const QUERY = 'obsprobe-' + 'q'.repeat(241)

let brain
let proxy
let done = false

function finish(code) {
  if (done) return
  done = true
  try {
    if (proxy && proxy.exitCode === null) proxy.kill()
  } catch { /* already gone */ }
  try {
    if (brain) brain.close()
  } catch { /* already closed */ }
  // A short delay lets the proxy die before the process exits, so nothing is
  // left holding a port.
  setTimeout(() => process.exit(code), 300)
}

process.on('uncaughtException', err => {
  console.log(`driver-error=${err.message}`)
  finish(1)
})
// A killed suite must not leave the proxy child listening. Known orphan class:
// this directory's earlier stub servers survived a Ctrl-C and held their ports.
process.on('SIGINT', () => finish(1))
process.on('SIGTERM', () => finish(1))
// Hard ceiling: this test must never be the thing that hangs a suite.
setTimeout(() => {
  console.log('driver-error=timed out')
  finish(1)
}, 30000).unref()

function post(port, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': String(payload.length),
          ...(extraHeaders || {}),
        },
      },
      res => {
        let text = ''
        res.on('data', c => (text += c.toString('utf8')))
        res.on('end', () => resolve({ status: res.statusCode, text }))
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function waitForPort(port, deadlineMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const probe = require('node:net').connect({ host: '127.0.0.1', port }, () => {
        probe.destroy()
        resolve()
      })
      probe.on('error', () => {
        probe.destroy()
        if (Date.now() - started > deadlineMs) return reject(new Error(`port ${port} never opened`))
        setTimeout(tick, 150)
      })
    }
    tick()
  })
}

// The upstream answers in the MCP streamable-HTTP shape the real router uses:
// an SSE frame, not bare JSON. Anything that only works on bare JSON would pass
// a test and fail the campaign.
const SSE_FRAME = rpc =>
  `event: message\ndata: ${JSON.stringify(rpc)}\n\n`

brain = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', () => {
    let rpc = {}
    try {
      rpc = JSON.parse(body)
    } catch { /* answer with a null id */ }
    const frame = SSE_FRAME({
      jsonrpc: '2.0',
      id: rpc.id ?? null,
      result:
        rpc.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: {} }
          : { content: [{ type: 'text', text: PAYLOAD_TEXT }] },
    })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(frame)
  })
})

async function main() {
  await new Promise((resolve, reject) => {
    brain.once('error', reject)
    brain.listen(brainPort, '127.0.0.1', resolve)
  })

  const out = fs.openSync(proxyOutPath, 'a')
  proxy = spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      TB_PROXY_PORT: String(proxyPort),
      TB_PROXY_UPSTREAM_HOST: '127.0.0.1',
      TB_PROXY_UPSTREAM_PORT: String(brainPort),
      TB_PROXY_UPSTREAM_DATA_DIR: '',
      TERRANSOUL_MCP_TOKEN: 'stub-token',
      TERRANSOUL_MCP_TOKEN_FILE: '',
      TB_PROXY_LOG: logPath,
      // Explicit, not inherited: an operator's exported TB_PROXY_MODE=learn
      // would otherwise change which calls this test sees blocked.
      TB_PROXY_MODE: '',
      TB_PROXY_ALLOW_WRITES: '',
      TB_DEFER_WRITES: '',
      TB_THINKING_MODE: 'think',
    },
    stdio: ['ignore', out, out],
  })
  await waitForPort(proxyPort, 15000)

  // 1. initialize, carrying clientInfo — the agent-vs-hook discriminator.
  await post(proxyPort, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'obs-probe-client', version: '9.9.9' } },
  })

  // 2. a search, with a query longer than the log's cap.
  const searchRes = await post(proxyPort, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'brain_search', arguments: { query: QUERY, limit: 7, mode: 'multihop' } },
  })

  // 3. a blocked write — a refusal is a request too.
  const blockedRes = await post(proxyPort, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'brain_ingest_lesson', arguments: { content: 'SECRET-LESSON-BODY' } },
  })

  // Give the outcome tee its 'end' event before reading the log.
  await new Promise(r => setTimeout(r, 400))

  const lines = fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const request = lines.find(l => l.tool === 'brain_search' && l.allowed === true)
  const verdict = lines.find(l => l.name === 'brain_search')
  const init = lines.find(l => l.method === 'initialize')
  const blocked = lines.find(l => l.tool === 'brain_ingest_lesson' && l.allowed === false)
  const raw = fs.readFileSync(logPath, 'utf8')

  // A field the proxy never wrote reads MISSING, never the JS spelling
  // `undefined` — the caller greps these, and "undefined" is a value.
  const say = (k, v) => console.log(`observed ${k}=${v === undefined || v === null ? 'MISSING' : v}`)

  say('lines', lines.length)
  // ── the new answer: did this search return anything useful? ──
  say('results', verdict ? verdict.results : 'MISSING')
  say('payloadChars', verdict ? verdict.payloadChars : 'MISSING')
  say('expectedPayloadChars', PAYLOAD_TEXT.length)
  say('envelopeChars', verdict ? verdict.envelopeChars : 'MISSING')
  say('verdict', verdict ? verdict.verdict : 'MISSING')
  // ── the new answer: what did it ask? ──
  say('queryChars', verdict ? verdict.queryChars : 'MISSING')
  say('queryLoggedChars', verdict && typeof verdict.query === 'string' ? verdict.query.length : 'MISSING')
  say('queryPrefix', verdict && typeof verdict.query === 'string' ? verdict.query.slice(0, 9) : 'MISSING')
  say('searchMode', verdict ? verdict.searchMode : 'MISSING')
  say('limit', verdict ? verdict.limit : 'MISSING')
  say('fullQueryLeaked', raw.includes(QUERY) ? 'yes' : 'no')
  say('lessonBodyLeaked', raw.includes('SECRET-LESSON-BODY') ? 'yes' : 'no')
  say('payloadTextLeaked', raw.includes(PAYLOAD_TEXT) ? 'yes' : 'no')
  // ── the new answer: who asked? ──
  say('requestConn', request ? request.conn : 'MISSING')
  say('verdictConn', verdict ? verdict.conn : 'MISSING')
  say('requestRpcId', request ? request.rpcId : 'MISSING')
  say('verdictRpcId', verdict ? verdict.rpcId : 'MISSING')
  say('initClient', init ? init.client : 'MISSING')
  say('blockedConn', blocked ? blocked.conn : 'MISSING')
  // ── the old shape must be untouched ──
  say('requestTool', request ? request.tool : 'MISSING')
  say('requestAllowed', request ? request.allowed : 'MISSING')
  say('requestThinkingMode', request ? request.thinkingMode : 'MISSING')
  say('requestThinkingModeWas', request && 'thinkingModeWas' in request ? String(request.thinkingModeWas) : 'MISSING')
  say('blockedReason', blocked ? blocked.reason : 'MISSING')
  say('initAllowed', init ? init.allowed : 'MISSING')
  // ── the wire must be untouched ──
  say('wireIntact', searchRes.text === SSE_FRAME({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: PAYLOAD_TEXT }] } }) ? 'yes' : 'no')
  say('searchStatus', searchRes.status)
  say('blockedStatus', blockedRes.status)
  say('blockedIsRpcError', (() => {
    try {
      return JSON.parse(blockedRes.text).error.code === -32001 ? 'yes' : 'no'
    } catch {
      return 'no'
    }
  })())

  finish(0)
}

main().catch(err => {
  console.log(`driver-error=${err.message}`)
  finish(1)
})
OBSDRIVER

obsOut="$(node "$STUB_DIR/obs-driver.js" "$HERE/mcp-auth-proxy.mjs" \
    "$OBS_TMP/calls.jsonl" "$OBS_BRAIN_PORT" "$OBS_PROXY_PORT" "$OBS_TMP/proxy.out" 2>&1 || true)"
obs() { printf '%s\n' "$obsOut" | grep -m1 "^observed $1=" | cut -d= -f2- ; }

# A driver that never reached its assertions fails every check below with an
# empty value, which reads as "the field is missing" when the real story is
# "the scenario never ran". Say which it was, and print the proxy's own output
# INLINE — $OBS_TMP is deleted before the suite ends, so a path is no help.
if printf '%s\n' "$obsOut" | grep -q "^driver-error="; then
  printf '  note %s\n' "$(printf '%s\n' "$obsOut" | grep -m1 '^driver-error=')"
  [ -f "$OBS_TMP/proxy.out" ] && sed 's/^/       proxy: /' "$OBS_TMP/proxy.out"
fi

# ── 26. The log says whether a search returned anything ─────────────────────
#
# FAILS pre-change, MEASURED not asserted: this exact driver run against
# `git show HEAD:benchmark/terminal-bench-3.0/mcp-auth-proxy.mjs` prints
#   results=MISSING  payloadChars=MISSING  envelopeChars=MISSING
# because the record builder wrote only {name, verdict, detail?, truncated?}.
# Post-change it prints results=3, payloadChars=89 (= the payload the stub
# served) and envelopeChars=203. An empty search is now `results:0` in the log
# rather than indistinguishable from a full one.
[ "$(obs results)" = "3" ] &&
  [ "$(obs payloadChars)" = "$(obs expectedPayloadChars)" ] &&
  [ "$(obs envelopeChars)" != "MISSING" ] &&
  [ "$(obs verdict)" = "accepted" ]
rc=$?
check "the call log records how many rows a search returned and how big the answer was" \
      "results=3 and payloadChars equal to the served payload (got results=$(obs results), payloadChars=$(obs payloadChars), envelopeChars=$(obs envelopeChars))" "$rc"

# ── 27. ...and what it asked for, bounded ───────────────────────────────────
#
# FAILS pre-change: query/queryChars/searchMode/limit all print MISSING — the
# old comment in noteCall said "never log argument CONTENT", so nothing anywhere
# recorded what a search was actually looking for. The 250-char query proves the
# 200-char cap is real (queryLoggedChars=200, queryChars=250, and the FULL query
# string appears nowhere in the file), and the two never-log rules still hold:
# no lesson body and no response payload text.
[ "$(obs queryChars)" = "250" ] &&
  [ "$(obs queryLoggedChars)" = "200" ] &&
  [ "$(obs queryPrefix)" = "obsprobe-" ] &&
  [ "$(obs searchMode)" = "multihop" ] &&
  [ "$(obs limit)" = "7" ] &&
  [ "$(obs fullQueryLeaked)" = "no" ] &&
  [ "$(obs lessonBodyLeaked)" = "no" ] &&
  [ "$(obs payloadTextLeaked)" = "no" ]
rc=$?
check "the call log records the query, truncated, and still never records a body or a payload" \
      "queryChars=250 with 200 logged, mode and limit present, no full query / lesson body / payload text in the file (got queryChars=$(obs queryChars), logged=$(obs queryLoggedChars), leaks=$(obs fullQueryLeaked)/$(obs lessonBodyLeaked)/$(obs payloadTextLeaked))" "$rc"

# ── 28. Every record carries who asked ──────────────────────────────────────
#
# FAILS pre-change: conn/rpcId/client all print MISSING. There is no MCP session
# id on this server to lean on (the router never issues Mcp-Session-Id, and
# brain_search's schema declares no session_id), so attribution rides on the TCP
# connection ordinal — which can only SPLIT a trial, never merge two. The
# request and verdict lines must join, and a REFUSED call must be attributable
# too, or "which trial kept trying to write" stays unanswerable.
[ "$(obs requestConn)" != "MISSING" ] &&
  [ "$(obs verdictConn)" = "$(obs requestConn)" ] &&
  [ "$(obs requestRpcId)" = "2" ] &&
  [ "$(obs verdictRpcId)" = "2" ] &&
  [ "$(obs blockedConn)" != "MISSING" ] &&
  [ "$(obs initClient)" = "obs-probe-client" ]
rc=$?
check "request, verdict and refusal lines all carry a joinable caller identity" \
      "conn on all three, matching rpcId on the request/verdict pair, and clientInfo on initialize (got conn=$(obs requestConn)/$(obs verdictConn)/$(obs blockedConn), rpcId=$(obs requestRpcId)/$(obs verdictRpcId), client=$(obs initClient))" "$rc"

# ── 29. The old record shape and the wire are untouched ─────────────────────
#
# A REGRESSION GUARD, and it passes on BOTH trees by design — that is the point.
# The new fields are a pure addition: existing analysis reads `tool`, `allowed`,
# `reason`, `thinkingMode`, `thinkingModeWas` and `method`, and the proxy is on
# the critical path of a live benchmark, so a logging change that altered a
# status code, a body or the refusal contract would be far worse than no logging
# at all. `wireIntact` compares the client's bytes to the stub's SSE frame
# exactly.
[ "$(obs requestTool)" = "brain_search" ] &&
  [ "$(obs requestAllowed)" = "true" ] &&
  [ "$(obs requestThinkingMode)" = "think" ] &&
  [ "$(obs requestThinkingModeWas)" = "null" ] &&
  [ "$(obs blockedReason)" = "blocked" ] &&
  [ "$(obs initAllowed)" = "true" ] &&
  [ "$(obs wireIntact)" = "yes" ] &&
  [ "$(obs searchStatus)" = "200" ] &&
  [ "$(obs blockedIsRpcError)" = "yes" ]
rc=$?
check "logging changed nothing about the existing record keys or the wire" \
      "tool/allowed/reason/thinkingMode/method unchanged, response bytes identical to the upstream frame, refusal still -32001 (wireIntact=$(obs wireIntact), thinkingMode=$(obs requestThinkingMode))" "$rc"

# ════════════════════════════════════════════════════════════════════════════
# BOTH RESPONSE TEES, AND WHO CALLED (tests 30-32, added 2026-08-19)
# ════════════════════════════════════════════════════════════════════════════
#
# WHY THESE EXIST — two defects an adversarial verify pass found in the logging
# work above, both of the same family: a fix that LOOKS applied.
#
#  1. mcp-auth-proxy.mjs has TWO places that copy an upstream response so it can
#     be classified — the live tee in the request handler and the deferred-flush
#     tee in flushDeferred(). The StringDecoder fix for split multi-byte UTF-8
#     was applied to the FIRST only. So the two tees disagreed about the size of
#     the identical body, and the deferred one over-counted by one character per
#     chunk boundary it split a character on. `payloadChars` is published as a
#     measurement, and half of it was wrong. Test 30 asserts the two tees agree
#     with each other AND with the byte-exact truth.
#
#  2. Attribution ("was this call the agent's or the Stop hook's") rested on the
#     TCP-connection ordinal, which only groups calls that shared a socket — it
#     cannot tell WHO that socket belonged to unless the client keeps exactly one
#     connection for the whole task, which nothing here verifies. Test 31 pins
#     the deterministic replacement: the caller DECLARES itself in a header, and
#     absence is recorded as the explicit string 'unknown' rather than as a
#     missing key. Test 32 pins that this stayed fail-open and additive.
#
# Same one-process discipline as the driver above: stub upstream, proxy child,
# every request and the teardown in ONE process on its own two ports, with a
# hard 40 s self-kill, so an abandoned run cannot orphan a listener.

echo
echo "both response tees, and who called"

OBS2_BRAIN_PORT=18915
OBS2_PROXY_PORT=18916

cat > "$STUB_DIR/obs2-driver.js" <<'OBS2DRIVER'
const http = require('node:http')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const [proxyPath, logPath, brainPortArg, proxyPortArg, proxyOutPath] = process.argv.slice(2)
const brainPort = Number(brainPortArg)
const proxyPort = Number(proxyPortArg)

// Multi-byte at THREE different UTF-8 widths (2, 3 and 4 bytes). A decoder that
// happens to cope with one width still fails the others, and the 4-byte case is
// also the one that is two JS characters rather than one — so a length that
// merely "looks about right" cannot pass.
const HITS = [
  { id: 1, t: 'café' },
  { id: 2, t: '漢字' },
  { id: 3, t: '\u{1f9e0} brain' },
]
const PAYLOAD_TEXT = JSON.stringify(HITS)
const SSE_FRAME = rpc => `event: message\ndata: ${JSON.stringify(rpc)}\n\n`

// Every index at which a UTF-8 CONTINUATION byte sits (0b10xxxxxx). Writing the
// body in pieces that begin at these offsets guarantees each boundary lands in
// the MIDDLE of a character — which is the entire premise of the bug. Chunking
// a body at arbitrary offsets would reproduce it only by luck.
function continuationOffsets(buf) {
  const out = []
  for (let i = 1; i < buf.length; i++) if ((buf[i] & 0xc0) === 0x80) out.push(i)
  return out
}

// Real chunk boundaries need real TCP segments: two back-to-back writes can be
// coalesced into one, and a coalesced body would never exercise the split at
// all — the test would then pass on the broken tree for the wrong reason. The
// delay makes the segmentation deterministic on loopback.
const CHUNK_GAP_MS = 40

function writeSplit(res, buf) {
  const bounds = [0, ...continuationOffsets(buf), buf.length]
  let i = 0
  const step = () => {
    if (i >= bounds.length - 1) return res.end()
    const piece = buf.subarray(bounds[i], bounds[i + 1])
    i += 1
    res.write(piece)
    setTimeout(step, CHUNK_GAP_MS)
  }
  step()
}

let brain
let proxy
let done = false

function finish(code) {
  if (done) return
  done = true
  try {
    if (proxy && proxy.exitCode === null) proxy.kill()
  } catch { /* already gone */ }
  try {
    if (brain) brain.close()
  } catch { /* already closed */ }
  setTimeout(() => process.exit(code), 300)
}

process.on('uncaughtException', err => {
  console.log(`driver-error=${err.message}`)
  finish(1)
})
process.on('SIGINT', () => finish(1))
process.on('SIGTERM', () => finish(1))
setTimeout(() => {
  console.log('driver-error=timed out')
  finish(1)
}, 40000).unref()

function post(port, body, extraHeaders, urlPath) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: urlPath || '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': String(payload.length),
          ...(extraHeaders || {}),
        },
      },
      res => {
        // COLLECT BYTES, DECODE ONCE. `text += c.toString('utf8')` here would
        // reproduce, in the test's own client, the exact defect under test —
        // and `wireIntact` would then read 'no' against a proxy that forwarded
        // the bytes perfectly. Measured: it did, on the first run of this
        // driver. The client must be provably innocent for the comparison it
        // performs to mean anything.
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function waitForPort(port, deadlineMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const probe = require('node:net').connect({ host: '127.0.0.1', port }, () => {
        probe.destroy()
        resolve()
      })
      probe.on('error', () => {
        probe.destroy()
        if (Date.now() - started > deadlineMs) return reject(new Error(`port ${port} never opened`))
        setTimeout(tick, 150)
      })
    }
    tick()
  })
}

brain = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', () => {
    let rpc = {}
    try {
      rpc = JSON.parse(body)
    } catch { /* answer with a null id */ }
    const frame = Buffer.from(
      SSE_FRAME({
        jsonrpc: '2.0',
        id: rpc.id ?? null,
        result:
          rpc.method === 'initialize'
            ? { protocolVersion: '2024-11-05', capabilities: {} }
            : { content: [{ type: 'text', text: PAYLOAD_TEXT }] },
      }),
      'utf8',
    )
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    writeSplit(res, frame)
  })
})

const CALLER_HEADER = 'x-terransoul-caller'
const HOOK = { [CALLER_HEADER]: 'stop-hook' }

async function main() {
  await new Promise((resolve, reject) => {
    brain.once('error', reject)
    brain.listen(brainPort, '127.0.0.1', resolve)
  })

  const out = fs.openSync(proxyOutPath, 'a')
  proxy = spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      TB_PROXY_PORT: String(proxyPort),
      TB_PROXY_UPSTREAM_HOST: '127.0.0.1',
      TB_PROXY_UPSTREAM_PORT: String(brainPort),
      TB_PROXY_UPSTREAM_DATA_DIR: '',
      TERRANSOUL_MCP_TOKEN: 'stub-token',
      TERRANSOUL_MCP_TOKEN_FILE: '',
      TB_PROXY_LOG: logPath,
      // learn + defer: the only configuration in which a lesson reaches the
      // DEFERRED tee at all, which is the tee under test.
      TB_PROXY_MODE: 'learn',
      TB_PROXY_ALLOW_WRITES: '',
      TB_DEFER_WRITES: '1',
      TB_THINKING_MODE: 'think',
    },
    stdio: ['ignore', out, out],
  })
  await waitForPort(proxyPort, 15000)

  // 1. initialize — no caller header, so it must read as the explicit default.
  await post(proxyPort, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'obs2-probe', version: '1.0.0' } },
  })

  // 2. a search that DECLARES itself as the Stop hook.
  const searchRes = await post(
    proxyPort,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brain_search', arguments: { query: 'declared' } } },
    HOOK,
  )

  // 3. the same call with NO header — an agent's own call, by construction.
  await post(proxyPort, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'brain_search', arguments: { query: 'undeclared' } },
  })

  // 4. a call blocked by the gate even in learn mode — a refusal is a request.
  await post(
    proxyPort,
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'brain_delete_memory', arguments: { id: 1 } } },
    HOOK,
  )

  // 5. a lesson: deferred here, flushed at 6, classified by the SECOND tee.
  await post(
    proxyPort,
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'brain_ingest_lesson', arguments: { content: 'OBS2-SECRET-BODY' } },
    },
    HOOK,
  )

  await new Promise(r => setTimeout(r, 400))
  const flushRes = await post(proxyPort, {}, {}, '/__flush')
  await new Promise(r => setTimeout(r, 400))

  const raw = fs.readFileSync(logPath, 'utf8')
  const lines = raw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const mainVerdict = lines.find(l => l.name === 'brain_search' && l.rpcId === 2)
  const undeclaredVerdict = lines.find(l => l.name === 'brain_search' && l.rpcId === 3)
  const deferredVerdict = lines.find(l => l.name === 'brain_ingest_lesson')
  const declaredReq = lines.find(l => l.tool === 'brain_search' && l.rpcId === 2)
  const undeclaredReq = lines.find(l => l.tool === 'brain_search' && l.rpcId === 3)
  const blocked = lines.find(l => l.tool === 'brain_delete_memory')
  const deferredReq = lines.find(l => l.tool === 'brain_ingest_lesson' && l.mode === 'deferred')
  const init = lines.find(l => l.method === 'initialize')

  const say = (k, v) => console.log(`observed ${k}=${v === undefined || v === null ? 'MISSING' : v}`)

  say('lines', lines.length)
  // ── the two tees must agree with each other AND with the truth ──
  say('expectedPayloadChars', PAYLOAD_TEXT.length)
  say('mainPayloadChars', mainVerdict ? mainVerdict.payloadChars : 'MISSING')
  say('deferredPayloadChars', deferredVerdict ? deferredVerdict.payloadChars : 'MISSING')
  say('deferredResults', deferredVerdict ? deferredVerdict.results : 'MISSING')
  say('deferredVerdict', deferredVerdict ? deferredVerdict.verdict : 'MISSING')
  say('replacementCharInLog', raw.includes('�') ? 'yes' : 'no')
  say(
    'splitPoints',
    continuationOffsets(
      Buffer.from(
        SSE_FRAME({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: PAYLOAD_TEXT }] } }),
        'utf8',
      ),
    ).length,
  )
  // ── who called, declared rather than inferred ──
  say('declaredReqCaller', declaredReq ? declaredReq.caller : 'MISSING')
  say('declaredVerdictCaller', mainVerdict ? mainVerdict.caller : 'MISSING')
  say('undeclaredReqCaller', undeclaredReq ? undeclaredReq.caller : 'MISSING')
  say('undeclaredVerdictCaller', undeclaredVerdict ? undeclaredVerdict.caller : 'MISSING')
  say('blockedCaller', blocked ? blocked.caller : 'MISSING')
  say('deferredReqCaller', deferredReq ? deferredReq.caller : 'MISSING')
  say('deferredVerdictCaller', deferredVerdict ? deferredVerdict.caller : 'MISSING')
  say('initCaller', init ? init.caller : 'MISSING')
  // ── nothing else moved ──
  say('lessonBodyLeaked', raw.includes('OBS2-SECRET-BODY') ? 'yes' : 'no')
  say('payloadTextLeaked', raw.includes(PAYLOAD_TEXT) ? 'yes' : 'no')
  say('blockedReason', blocked ? blocked.reason : 'MISSING')
  say('blockedAllowed', blocked ? blocked.allowed : 'MISSING')
  say('deferredMode', deferredReq ? deferredReq.mode : 'MISSING')
  say('searchStatus', searchRes.status)
  say(
    'wireIntact',
    searchRes.text ===
      SSE_FRAME({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: PAYLOAD_TEXT }] } })
      ? 'yes'
      : 'no',
  )
  say(
    'flushed',
    (() => {
      try {
        return JSON.parse(flushRes.text).flushed
      } catch {
        return 'MISSING'
      }
    })(),
  )

  finish(0)
}

main().catch(err => {
  console.log(`driver-error=${err.message}`)
  finish(1)
})
OBS2DRIVER

obs2Out="$(node "$STUB_DIR/obs2-driver.js" "$HERE/mcp-auth-proxy.mjs" \
    "$OBS_TMP/calls2.jsonl" "$OBS2_BRAIN_PORT" "$OBS2_PROXY_PORT" "$OBS_TMP/proxy2.out" 2>&1 || true)"
obs2() { printf '%s\n' "$obs2Out" | grep -m1 "^observed $1=" | cut -d= -f2- ; }

if printf '%s\n' "$obs2Out" | grep -q "^driver-error="; then
  printf '  note %s\n' "$(printf '%s\n' "$obs2Out" | grep -m1 '^driver-error=')"
  [ -f "$OBS_TMP/proxy2.out" ] && sed 's/^/       proxy: /' "$OBS_TMP/proxy2.out"
fi

# ── 30. BOTH tees decode UTF-8 across chunk boundaries ──────────────────────
#
# FAILS pre-change on BOTH trees, MEASURED not asserted (numbers in the report):
#   * git HEAD                  -> mainPayloadChars=MISSING, deferredPayloadChars=MISSING
#                                  (noteOutcome recorded no sizes at all)
#   * the tree that shipped the -> mainPayloadChars=<exact>, deferredPayloadChars=<exact+7>
#     ONE-SIDED StringDecoder      two tees disagreeing about ONE body is the whole
#     fix                          defect, and the deferred one is the wrong one
# Post-fix both equal expectedPayloadChars exactly.
#
# `splitPoints` is printed and asserted >0 so a run where the boundaries never
# happened is visible rather than passing vacuously — without it, a body that
# arrived in one TCP segment would "pass" while proving nothing about chunking.
# A payload with a 2-, a 3- and a 4-byte character means a decoder that
# mishandles any one width is caught, and the 4-byte case is also the one worth
# two JS characters rather than one.
[ "$(obs2 splitPoints)" -gt 0 ] 2>/dev/null &&
  [ "$(obs2 mainPayloadChars)" = "$(obs2 expectedPayloadChars)" ] &&
  [ "$(obs2 deferredPayloadChars)" = "$(obs2 expectedPayloadChars)" ] &&
  [ "$(obs2 deferredResults)" = "3" ] &&
  [ "$(obs2 deferredVerdict)" = "accepted" ] &&
  [ "$(obs2 replacementCharInLog)" = "no" ]
rc=$?
check "both response tees report the same, byte-exact size for a body split mid-character" \
      "main and deferred payloadChars both = $(obs2 expectedPayloadChars) over $(obs2 splitPoints) mid-character chunk boundaries (got main=$(obs2 mainPayloadChars), deferred=$(obs2 deferredPayloadChars), results=$(obs2 deferredResults), verdict=$(obs2 deferredVerdict))" "$rc"

# ── 31. The caller declares itself; absence is explicit ─────────────────────
#
# FAILS pre-change on BOTH trees: `caller` prints MISSING on every line, because
# neither tree read the header nor wrote the field. This is the remaining
# attribution risk closed — "was this the agent or the hook" stops depending on
# the unverified assumption that one MCP client holds one TCP connection for a
# whole task, and becomes a value the caller states on every single request.
#
# The absence case is asserted as hard as the presence case: 'unknown' must be
# WRITTEN, not omitted, or a log line from an agent is indistinguishable from a
# log line written by a proxy too old to have the field.
[ "$(obs2 declaredReqCaller)" = "stop-hook" ] &&
  [ "$(obs2 declaredVerdictCaller)" = "stop-hook" ] &&
  [ "$(obs2 blockedCaller)" = "stop-hook" ] &&
  [ "$(obs2 deferredReqCaller)" = "stop-hook" ] &&
  [ "$(obs2 undeclaredReqCaller)" = "unknown" ] &&
  [ "$(obs2 undeclaredVerdictCaller)" = "unknown" ] &&
  [ "$(obs2 initCaller)" = "unknown" ] &&
  [ "$(obs2 deferredVerdictCaller)" = "unknown" ]
rc=$?
check "every record says who called, declared by header, with an explicit default when absent" \
      "caller=stop-hook on the declared request/verdict/refusal/deferred lines and caller=unknown on the undeclared ones (got declared=$(obs2 declaredReqCaller)/$(obs2 declaredVerdictCaller)/$(obs2 blockedCaller)/$(obs2 deferredReqCaller), undeclared=$(obs2 undeclaredReqCaller)/$(obs2 undeclaredVerdictCaller)/$(obs2 initCaller)/$(obs2 deferredVerdictCaller))" "$rc"

# ── 32. The header changed nothing else ─────────────────────────────────────
#
# A REGRESSION GUARD that passes on the post-fix tree by construction — the
# point is that an unrecognised or absent header must be INERT. Nothing branches
# on `caller`: the gate still refuses the same tool, the deferred path still
# defers and still flushes, the response bytes are still the upstream frame
# verbatim, and neither never-log rule moved (no lesson body, no response
# payload text). A caller identity that could change what the proxy DOES would
# be a far worse bug than the ambiguity it was added to remove.
[ "$(obs2 blockedReason)" = "blocked" ] &&
  [ "$(obs2 blockedAllowed)" = "false" ] &&
  [ "$(obs2 deferredMode)" = "deferred" ] &&
  [ "$(obs2 flushed)" = "1" ] &&
  [ "$(obs2 searchStatus)" = "200" ] &&
  [ "$(obs2 wireIntact)" = "yes" ] &&
  [ "$(obs2 lessonBodyLeaked)" = "no" ] &&
  [ "$(obs2 payloadTextLeaked)" = "no" ]
rc=$?
check "declaring a caller changes no verdict, no deferral, no byte on the wire" \
      "gate/defer/flush/wire all unchanged and neither never-log rule broken (got blocked=$(obs2 blockedReason), mode=$(obs2 deferredMode), flushed=$(obs2 flushed), wireIntact=$(obs2 wireIntact), leaks=$(obs2 lessonBodyLeaked)/$(obs2 payloadTextLeaked))" "$rc"

rm -rf "$OBS_TMP"

# ════════════════════════════════════════════════════════════════════════════
# THE LAUNCH GATES — hook timeouts, the seed, and the SERVED instructions
# (tests 33-39, added 2026-08-19)
# ════════════════════════════════════════════════════════════════════════════
#
# WHY THESE EXIST. Three wiring defects, each of which turns a real sweep into
# a measurement of something other than what is being reported:
#
#   * NO HOOK TIMEOUT. MEASURED: a hook that blocked left `claude -p` stalled at
#     400 s on ONE failed Bash command (EXIT=124, empty result); the same run
#     with `"timeout": 5` finished in 18 s. Claude Code applies no usable
#     default and a hook's try/catch cannot cover a blocking syscall, so the
#     bound exists only if the settings file states it.
#   * THE SEED WAS NEVER APPLIED BY ANY LAUNCHER. extra-instruction-harness.md
#     was shrunk 72% on the argument that its deleted "How to work" guidance
#     lives in generic-technique-seed.json inside the store — but applying that
#     seed was a hand-typed `clean-bench-brain.mjs --seed --apply`. A launch
#     that skipped it shipped the guidance in NEITHER channel.
#   * THE DEPLOYED BINARY SERVED THE OLD INSTRUCTIONS. Grepped 2026-08-19
#     against target-mcp/release/terransoul.exe (Aug 18 20:49): "do not let
#     consulting memory delay you" 4 hits, "also searches derived sub-queries"
#     4 hits, "BEFORE YOU COMMIT TO AN APPROACH" 0 hits. The de-suppression
#     existed only in source, pinned by a cargo test that links the source and
#     can never see the shipped .exe.

echo
echo "the launch gates: hook timeouts, the seed, the served instructions"

# ── 33. Every hook the bench installs declares a bounded timeout ─────────────
#
# FAILS pre-change, MEASURED by running this exact node snippet against
# `git show HEAD:benchmark/terminal-bench-3.0/claude-settings-verifyhook.json`:
# `hooks=1 missingTimeouts=1 failure=null stop=null` (HEAD carried only the Stop
# hook, and it declared no timeout) versus `hooks=2 missingTimeouts=0 failure=5
# stop=240` here. Written as a PROPERTY over every hook in the file rather than
# as two literal lookups, so a third hook added later without a bound also fails.
SETTINGS_JSON="$HERE/claude-settings-verifyhook.json"
read -r hookCount missingCount failureTimeout stopTimeout <<< "$(TB_SETTINGS="$SETTINGS_JSON" node -e '
const fs = require("node:fs");
const j = JSON.parse(fs.readFileSync(process.env.TB_SETTINGS, "utf8"));
const rows = [];
for (const [event, groups] of Object.entries(j.hooks || {})) {
  for (const g of groups || []) for (const h of (g.hooks || [])) rows.push({ event, t: h.timeout });
}
const missing = rows.filter((r) => typeof r.t !== "number" || !(r.t > 0));
const pick = (e) => { const r = rows.find((x) => x.event === e); return r && typeof r.t === "number" ? r.t : "null"; };
console.log([rows.length, missing.length, pick("PostToolUseFailure"), pick("Stop")].join(" "));
' 2>/dev/null)"
[ "${hookCount:-0}" -ge 2 ] &&
  [ "${missingCount:-1}" -eq 0 ] &&
  [ "${failureTimeout:-null}" != "null" ] && [ "$failureTimeout" -le 10 ] &&
  [ "${stopTimeout:-null}" != "null" ] && [ "$stopTimeout" -ge 60 ] && [ "$stopTimeout" -le 600 ]
rc=$?
check "every installed hook declares a bounded timeout, sized for its regime" \
      "no hook without a positive timeout; PostToolUseFailure <= 10 s (critical path, no brain call), Stop 60-600 s (brain calls measured at 23.6 s / 37.9 s) — got hooks=${hookCount:-0} missing=${missingCount:-?} failure=${failureTimeout:-?} stop=${stopTimeout:-?}" "$rc"

# ── 34. A launch that cannot be seeded refuses BEFORE it spawns anything ─────
#
# FAILS pre-change for a stated reason: `--seed` was not a flag start-bench-stack.mjs
# knew, so it was ignored outright and the launcher walked straight on to the
# brain step — the refusal printed here was about the OCCUPIED PORT and never
# mentioned the seed at all. That is the defect in miniature: a launch with no
# seed was indistinguishable from a launch with one.
#
# Side-effect-free by construction, exactly like tests 18-25: the brain port
# given is one a stub is already squatting on, so even the pre-change tree
# cannot reach target-mcp/release/terransoul.exe.
SEED_TMP="$(mktemp -d)"
printf 'stub-token\n' > "$SEED_TMP/mcp-token.txt"
missingSeedOut="$(node "$HERE/start-bench-stack.mjs" \
    --seed "$SEED_TMP/not-a-real-seed.json" \
    --brain-port "$STACK_HOLD_PORT" --proxy-port "$STACK_PROXY_PORT" \
    --data-dir "$SEED_TMP" --wait 1 2>&1)"
missingSeedStatus=$?
[ "$missingSeedStatus" -ne 0 ] &&
  printf '%s\n' "$missingSeedOut" | grep -q "not-a-real-seed.json" &&
  printf '%s\n' "$missingSeedOut" | grep -q "REFUSING" &&
  ! printf '%s\n' "$missingSeedOut" | grep -q "\[stack\] brain: port"
rc=$?
check "a missing seed file refuses the launch, naming it, before the brain is touched" \
      "non-zero exit, the seed path in the refusal, and no brain step attempted (got exit $missingSeedStatus)" "$rc"

# ── 35. Seeding is idempotent, and the counts come from the SERVER ───────────
#
# FAILS pre-change: seed-bench-brain.mjs did not exist, so `node` exits with
# "Cannot find module" and prints no counts at all.
#
# The stub implements the gateway's own generic exact-content dedup gate
# (`SELECT id FROM memories WHERE TRIM(content) = ?1` -> `deduplicated:true`,
# gateway.rs:4006-4036), which is what makes re-launching safe WITHOUT any
# client-side record of what was written (rules/mcp-single-source-of-truth.md).
# The test asserts the honest half too: the second run must report the lessons
# as ALREADY PRESENT rather than as freshly written.
SEED_STUB_PORT=18914
SEED_REFUSE_PORT=18915
cat > "$STUB_DIR/brainstub.js" <<'BSTUB'
const { createServer } = require("node:http");
const [listen, mode] = process.argv.slice(2);
const store = new Map();
let nextId = 100;
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (o) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (req.url.startsWith("/__count")) return json({ stored: store.size });
    let rpc = {};
    try { rpc = JSON.parse(body); } catch { /* fall through */ }
    if (rpc.method === "tools/call" && rpc.params && rpc.params.name === "brain_ingest_lesson") {
      if (mode === "refuse") {
        return json({ jsonrpc: "2.0", id: rpc.id ?? null, result: {
          isError: true,
          content: [{ type: "text", text: "safe_write denied by the earned-autonomy gate (cooldown active)" }],
        } });
      }
      const content = String((rpc.params.arguments || {}).content ?? "").trim();
      const seen = store.has(content);
      if (!seen) store.set(content, ++nextId);
      return json({ jsonrpc: "2.0", id: rpc.id ?? null, result: {
        content: [{ type: "text", text: JSON.stringify({ memory_id: store.get(content), deduplicated: seen }) }],
      } });
    }
    return json({ jsonrpc: "2.0", id: rpc.id ?? null, result: {} });
  });
}).listen(Number(listen), "127.0.0.1");
BSTUB
node "$STUB_DIR/brainstub.js" "$SEED_STUB_PORT"          & VH_P9=$!
node "$STUB_DIR/brainstub.js" "$SEED_REFUSE_PORT" refuse & VH_P10=$!
trap 'kill "$STUB_PID" "$VH_P1" "$VH_P2" "$VH_P3" "$VH_P4" "$VH_P5" "$VH_P6" "$VH_P7" "$VH_P8" "$VH_P9" "$VH_P10" 2>/dev/null; rm -rf "$STUB_DIR" "$SEED_TMP"' EXIT
sleep 1

SEED_FILE="$HERE/generic-technique-seed.json"
# Read the expected count from the seed itself — a literal here would go stale
# the day a lesson is added, which is the same mistake as a hardcoded task list.
SEED_N="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).lessons.length)' "$SEED_FILE" 2>/dev/null || echo 0)"
seedRun1="$(node "$HERE/seed-bench-brain.mjs" --url "http://127.0.0.1:$SEED_STUB_PORT" \
    --token-file "$SEED_TMP/mcp-token.txt" --seed "$SEED_FILE" --tasks "$TASK_CACHE" 2>&1)"
seedRun2="$(node "$HERE/seed-bench-brain.mjs" --url "http://127.0.0.1:$SEED_STUB_PORT" \
    --token-file "$SEED_TMP/mcp-token.txt" --seed "$SEED_FILE" --tasks "$TASK_CACHE" 2>&1)"
seedStored="$(node -e 'fetch("http://127.0.0.1:" + process.argv[1] + "/__count").then((r) => r.json()).then((j) => console.log(j.stored))' "$SEED_STUB_PORT" 2>/dev/null || echo -1)"
[ "$SEED_N" -gt 0 ] &&
  printf '%s\n' "$seedRun1" | grep -q "$SEED_N new, 0 already present" &&
  printf '%s\n' "$seedRun2" | grep -q "0 new, $SEED_N already present" &&
  [ "$seedStored" = "$SEED_N" ]
rc=$?
check "applying the seed twice writes it once and says so" \
      "first run '$SEED_N new, 0 already present', second run '0 new, $SEED_N already present', store still holds $SEED_N (got stored=$seedStored)" "$rc"

# ── 36. A refused write is a REFUSAL, never a warning ────────────────────────
#
# FAILS pre-change: the module did not exist. The case is real — brain_ingest_lesson
# can be denied by the earned-autonomy `safe_write` gate on a store with no
# trust history, and a denied retry does not reset the cooldown. A launcher that
# logged that and carried on would produce precisely the unseeded run this whole
# gate exists to prevent, with a green receipt.
refuseOut="$(node "$HERE/seed-bench-brain.mjs" --url "http://127.0.0.1:$SEED_REFUSE_PORT" \
    --token-file "$SEED_TMP/mcp-token.txt" --seed "$SEED_FILE" --tasks "$TASK_CACHE" 2>&1)"
refuseStatus=$?
[ "$refuseStatus" -ne 0 ] &&
  printf '%s\n' "$refuseOut" | grep -q "REFUSING" &&
  printf '%s\n' "$refuseOut" | grep -q "REFUSED the write"
rc=$?
check "a brain that refuses a seed write stops the launch" \
      "non-zero exit and a refusal quoting the brain's own denial (got exit $refuseStatus)" "$rc"

# ── 37. PURITY: a seed lesson naming a dataset task refuses the WHOLE seed ───
#
# Same standard as test 17 and clean-bench-brain.mjs: the roster is read from
# the DATASET, never hardcoded. Behaviour change adopted deliberately from
# clean-bench-brain.mjs, which SKIPPED the offending lesson and wrote the rest —
# a partial seed is a third state that resembles neither a seeded store nor an
# unseeded one, and nothing downstream records which lessons made it.
if [ -d "$TASK_CACHE" ]; then
  ROSTER_TASK="$(node -e 'const n = require("node:fs").readdirSync(process.argv[1]).filter((x) => !x.startsWith(".")); console.log(n[0] || "")' "$TASK_CACHE")"
  node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ lessons: [{ category: "agent-workflow", content: "A lesson that looks generic but quietly names " + process.argv[2] + ", which makes it task-specific knowledge." }] }))' \
    "$STUB_DIR/impure-seed.json" "$ROSTER_TASK"
  storedBefore="$(node -e 'fetch("http://127.0.0.1:" + process.argv[1] + "/__count").then((r) => r.json()).then((j) => console.log(j.stored))' "$SEED_STUB_PORT" 2>/dev/null || echo -1)"
  impureOut="$(node "$HERE/seed-bench-brain.mjs" --url "http://127.0.0.1:$SEED_STUB_PORT" \
      --token-file "$SEED_TMP/mcp-token.txt" --seed "$STUB_DIR/impure-seed.json" --tasks "$TASK_CACHE" 2>&1)"
  impureStatus=$?
  storedAfter="$(node -e 'fetch("http://127.0.0.1:" + process.argv[1] + "/__count").then((r) => r.json()).then((j) => console.log(j.stored))' "$SEED_STUB_PORT" 2>/dev/null || echo -2)"
  [ "$impureStatus" -ne 0 ] &&
    printf '%s\n' "$impureOut" | grep -q "bench-agi-purity" &&
    printf '%s\n' "$impureOut" | grep -q "$ROSTER_TASK" &&
    [ "$storedBefore" = "$storedAfter" ]
  rc=$?
  check "a seed naming a benchmark task refuses, and writes nothing" \
        "non-zero exit, the purity rule and the task named, and the store unchanged (got exit $impureStatus, stored $storedBefore -> $storedAfter)" "$rc"
else
  echo "  skip seed purity gate (no task cache at $TASK_CACHE)"
fi

# ── 38. A brain serving the PRE-de-suppression instructions refuses the run ──
#
# FAILS pre-change: nothing anywhere read `initialize`'s `instructions`, so this
# stub — which serves the right store on the right port with the right tools and
# only the OLD text — passed every check and the dry run exited 0. That is the
# 2026-08-18 binary exactly.
staleOut="$(run_vh_status TB_PROXY_PROBE_URL="http://127.0.0.1:$VH_PROXY_STALE_PORT" || true)"
run_vh TB_PROXY_PROBE_URL="http://127.0.0.1:$VH_PROXY_STALE_PORT" >/dev/null 2>&1
staleStatus=$?
[ "$staleStatus" -eq 2 ] &&
  printf '%s\n' "$staleOut" | grep -q "STALE SERVER_INSTRUCTIONS" &&
  printf '%s\n' "$staleOut" | grep -q "do not let consulting memory delay you" &&
  printf '%s\n' "$staleOut" | grep -q "BEFORE YOU COMMIT TO AN APPROACH"
rc=$?
check "a stack serving the old SERVER_INSTRUCTIONS refuses to start a sweep" \
      "exit 2, the staleness named, and BOTH the surviving suppression literal and the missing trigger printed (got exit $staleStatus)" "$rc"

# ── 39. ...and on a rebuilt brain the check RUNS and passes ─────────────────
#
# The other half of test 38, and not a tautology: without it, a gate that
# refused everything would still pass 38. It also pins that the check is
# actually REACHED on the happy path rather than short-circuited — the failure
# mode of every guard that was ever added inside a branch nobody takes.
freshOut="$(run_vh_status || true)"
printf '%s\n' "$freshOut" | grep -q "\[instructions\] ok" &&
  ! printf '%s\n' "$freshOut" | grep -q "STALE SERVER_INSTRUCTIONS"
rc=$?
check "the served-instructions check runs on every launch and passes a rebuilt brain" \
      "an '[instructions] ok' receipt in the preflight output and no staleness refusal" "$rc"

# ════════════════════════════════════════════════════════════════════════════
# THE PROXY'S LIFECYCLE — a launcher must never report success over a process
# it did not start (tests 40-41, added 2026-08-20 after a graded run shipped
# with none of its instrumentation)
# ════════════════════════════════════════════════════════════════════════════
#
# THE INCIDENT, MEASURED. start-bench-stack.mjs printed both of these:
#   [stack] proxy: started as pid 137464 on 7425 -> 7424
#   [stack] verified: authenticated tools/list through the proxy served 49 tool(s)
# and both were false in the way that matters.
#   * The process actually serving 7425 was pid 32940, started 09:52:16 that
#     morning — ELEVEN HOURS before the run, and before mcp-auth-proxy.mjs's own
#     20:38 mtime, so it could not contain a line of the observability work that
#     had just been done.
#   * The child the launcher spawned, 137464, CRASHED at startup. Its log
#     (proxy-logs/stack-proxy-*.log) ends
#       Error: listen EADDRINUSE: address already in use 0.0.0.0:7425
#       Node.js v24.3.0
#     the bare tail of a Node crash. It is dead now; the registry still names it.
#   * "verified" then probed THE PORT, which the stale process answered.
#
# WHY THE GUARD THAT EXISTED DID NOT FIRE. The launcher DID check occupancy
# before spawning — with `net.createServer().listen(port, '127.0.0.1')`. The
# proxy listens on 0.0.0.0 on purpose (the container reaches it through
# host.docker.internal). Measured on this machine, one holder per row:
#
#     holder      probe 127.0.0.1   probe 0.0.0.0   probe ::
#     127.0.0.1   EADDRINUSE        FREE            FREE
#     0.0.0.0     FREE              EADDRINUSE      FREE
#     ::          FREE              FREE            EADDRINUSE
#
# A Windows bind probe sees a holder only at the SAME address, so no single
# probe can answer the question and the guard was blind by construction. The
# detector is now the OS's listener table (netstat/lsof), with the three probes
# as a fallback.
#
# CONSEQUENCE: a whole graded run went out with no caller attribution, no query
# logging and no payload sizes, while every line on the console said otherwise.
# The scores were fine. The instrumentation silently was not.

echo
echo "the stack launcher's proxy lifecycle"

# TB_STACK_LAUNCHER points tests 40-41 at a PRE-CHANGE copy of the launcher for
# falsification. The copy must live in THIS directory, so its `here`/repoRoot,
# its sibling start-bench-brain.mjs, and its .stack/ registry all resolve
# identically — same seam, same reason, as TB_RUNNER at the top of this file.
STACK_LAUNCHER_UT="${TB_STACK_LAUNCHER:-$HERE/start-bench-stack.mjs}"

STACK2_BRAIN_PORT=18917   # a brain stub the stack is permitted to adopt
STACK2_DECOY_PORT=18918   # a STALE listener squatting the proxy port, on 0.0.0.0
STACK2_FREE_PORT=18919    # a genuinely free proxy port, for the crash case
STACK2_LIVE_PORT=18920    # where test 42 starts a REAL proxy, and stops it again

# The data dir must be a path NODE resolves the way this shell does. A Git-Bash
# `/tmp/...` is "absolute" to path.isAbsolute() on Windows and resolves onto the
# CURRENT DRIVE, so the launcher would look for the token under D:\tmp\... and
# refuse for an unrelated reason — a test passing for the wrong reason.
STACK2_TMP="$(mktemp -d)"
if command -v cygpath >/dev/null 2>&1; then STACK2_DIR="$(cygpath -m "$STACK2_TMP")"; else STACK2_DIR="$STACK2_TMP"; fi
printf 'stub-token\n' > "$STACK2_TMP/mcp-token.txt"

# The brain half is NOT what these two tests are about, so it is satisfied
# rather than exercised: a stub on the brain port plus the registry record that
# start-bench-brain.mjs's --reuse gate requires. `pid` is deliberately ABSENT —
# the gate reads `!reg.pid || holder.pid === reg.pid || pidAlive(reg.pid)`, and
# a fabricated pid would be a guess about how MSYS bash numbers a native
# Windows process. Omitting it takes the first branch honestly.
mkdir -p "$HERE/.stack"
cat > "$HERE/.stack/brain-$STACK2_BRAIN_PORT.json" <<JSON
{
  "port": $STACK2_BRAIN_PORT,
  "dataDir": "$STACK2_DIR",
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

TB_STUB_INSTRUCTIONS="$FRESH_INSTRUCTIONS" node "$STUB_DIR/stub.js" \
  "$STACK2_BRAIN_PORT" "$STACK2_BRAIN_PORT" & VH_P9=$!
# THE DECOY BINDS 0.0.0.0, exactly as mcp-auth-proxy.mjs does, and answers every
# question the launcher knows how to ask: /health reports the right brain port,
# tools/list serves the required tools, initialize returns FRESH instructions.
# It is indistinguishable from a good proxy to everything except "which process
# is this?" — which is the whole point.
TB_STUB_BIND=0.0.0.0 TB_STUB_INSTRUCTIONS="$FRESH_INSTRUCTIONS" node "$STUB_DIR/stub.js" \
  "$STACK2_DECOY_PORT" "$STACK2_BRAIN_PORT" & VH_P10=$!
# Test 42 starts a REAL, DETACHED proxy. If the suite dies between that spawn
# and its own --stop, the process outlives this shell by design — an orphaned
# listener on a fixed port is a known hazard in this repo, so the trap stops it
# unconditionally rather than relying on the test body being reached.
trap 'node "$HERE/start-bench-stack.mjs" --stop --proxy-port "$STACK2_LIVE_PORT" --brain-port "$STACK2_BRAIN_PORT" --data-dir "$STACK2_DIR" >/dev/null 2>&1; kill "$STUB_PID" "$VH_P1" "$VH_P2" "$VH_P3" "$VH_P4" "$VH_P5" "$VH_P6" "$VH_P7" "$VH_P8" "$VH_P9" "$VH_P10" 2>/dev/null; rm -rf "$STUB_DIR" "$STACK2_TMP"; rm -f "$HERE/.stack/brain-$STACK2_BRAIN_PORT.json" "$HERE/.stack/proxy-$STACK2_DECOY_PORT.json" "$HERE/.stack/proxy-$STACK2_FREE_PORT.json" "$HERE/.stack/proxy-$STACK2_LIVE_PORT.json"' EXIT
sleep 1

# ── 40. A stranger on the proxy port is a refusal, never a spawn ─────────────
#
# FAILS pre-change, and not marginally. Measured on the pre-change tree with
# this exact fixture: the 127.0.0.1 probe reported the 0.0.0.0 decoy as FREE, the
# launcher spawned a real proxy that could not bind, printed
# "proxy: started as pid <n>", then health-probed the PORT — which the decoy
# answered — and finished with "[stack] READY", exit 0. All four assertions
# below invert on that tree.
rm -f "$HERE/.stack/proxy-$STACK2_DECOY_PORT.json"
# This tree never spawns here — but a PRE-change tree pointed at by
# TB_STACK_LAUNCHER does, and it leaves a crash log behind. The marker exists so
# the falsification run cleans up after itself too.
touch "$STACK2_TMP/before-stranger-run"
strangerOut="$(env TB_STACK_NO_SEED=1 node "$STACK_LAUNCHER_UT" \
    --brain-port "$STACK2_BRAIN_PORT" --proxy-port "$STACK2_DECOY_PORT" \
    --data-dir "$STACK2_DIR" --wait 5 --proxy-wait 6 2>&1)"
strangerStatus=$?
[ "$strangerStatus" -ne 0 ] &&
  printf '%s\n' "$strangerOut" | grep -q "REFUSING: port $STACK2_DECOY_PORT is occupied" &&
  printf '%s\n' "$strangerOut" | grep -qE "the OS shows pid [0-9]+" &&
  ! printf '%s\n' "$strangerOut" | grep -q "proxy: started as pid" &&
  ! printf '%s\n' "$strangerOut" | grep -q "\[stack\] READY"
rc=$?
check "a 0.0.0.0 listener already on the proxy port is refused, naming the holding pid" \
      "non-zero exit, the holder named from the OS listener table, and NEITHER a 'started as pid' line nor a READY receipt (got exit $strangerStatus)" "$rc"
find "$HERE/proxy-logs" -maxdepth 1 -name 'stack-proxy-*.log' -newer "$STACK2_TMP/before-stranger-run" -delete 2>/dev/null || true
rm -f "$HERE/.stack/proxy-$STACK2_DECOY_PORT.json"

# ── 41. A child that dies at startup is a failure, with its output shown ─────
#
# FAILS pre-change on two of the three assertions. The pre-change tree printed
# "proxy: started as pid <n>" the instant spawn() returned, waited out the full
# --proxy-wait for a process that was already dead, and then refused with "the
# proxy never became healthy" — the right verdict for the wrong reason, arrived
# at without ever noticing the child had exited. It never emits "DIED DURING
# STARTUP" because nothing watched the child.
#
# The crash is REAL, not mocked: a preload that throws inside the proxy process.
# NODE_OPTIONS reaches every node in the tree — this launcher and the brain
# launcher included — so the preload identifies its victim by argv rather than
# by its own presence. The third assertion (the crash text is surfaced) passes
# on BOTH trees, because the pre-change refusal did print a log tail; it is kept
# because "surface the child's output" is a requirement of the fix, and it is
# named here as non-discriminating rather than counted as evidence.
cat > "$STACK2_TMP/crash-preload.cjs" <<'PRELOAD'
if (process.argv.some((a) => a.includes("mcp-auth-proxy"))) {
  throw new Error("TB_TEST_FORCED_STARTUP_CRASH");
}
PRELOAD
rm -f "$HERE/.stack/proxy-$STACK2_FREE_PORT.json"
touch "$STACK2_TMP/before-crash-run"
crashOut="$(env TB_STACK_NO_SEED=1 NODE_OPTIONS="--require=\"$STACK2_DIR/crash-preload.cjs\"" \
    node "$STACK_LAUNCHER_UT" \
    --brain-port "$STACK2_BRAIN_PORT" --proxy-port "$STACK2_FREE_PORT" \
    --data-dir "$STACK2_DIR" --wait 5 --proxy-wait 6 2>&1)"
crashStatus=$?
[ "$crashStatus" -ne 0 ] &&
  printf '%s\n' "$crashOut" | grep -q "DIED DURING STARTUP" &&
  printf '%s\n' "$crashOut" | grep -q "TB_TEST_FORCED_STARTUP_CRASH" &&
  ! printf '%s\n' "$crashOut" | grep -q "proxy: started as pid"
rc=$?
check "a proxy that crashes on startup is reported as dead, never as started" \
      "non-zero exit, the child's death named, its own output surfaced, and NO 'started as pid' line (got exit $crashStatus)" "$rc"
# Only files this run created, matched by mtime against a marker taken just
# before it: the live campaign's own proxy log is older and is never touched.
find "$HERE/proxy-logs" -maxdepth 1 -name 'stack-proxy-*.log' -newer "$STACK2_TMP/before-crash-run" -delete 2>/dev/null || true
rm -f "$HERE/.stack/proxy-$STACK2_FREE_PORT.json"

# ── 42. ...and a GOOD stack still comes up, proven rather than assumed ───────
#
# The other half of 40 and 41, and the reason neither of them is a tautology: a
# gate that refused every proxy would pass both. This one starts a REAL
# mcp-auth-proxy.mjs against the stub brain on a free port and requires the full
# receipt. Six un-failable gates have already shipped in this campaign; a
# refusal-only pair would have been the seventh.
#
# Half of it is a regression guard that passes on BOTH trees (the pre-change
# tree also reached READY here, honestly, because nothing was wrong). The
# discriminating half is the pid-to-port confirmation: pre-change nothing ever
# asked which process held the port, so that clause cannot appear on that tree.
STACK2_LIVE_PORT=18920
rm -f "$HERE/.stack/proxy-$STACK2_LIVE_PORT.json"
touch "$STACK2_TMP/before-live-run"
liveOut="$(env TB_STACK_NO_SEED=1 node "$STACK_LAUNCHER_UT" \
    --brain-port "$STACK2_BRAIN_PORT" --proxy-port "$STACK2_LIVE_PORT" \
    --data-dir "$STACK2_DIR" --wait 5 --proxy-wait 25 2>&1)"
liveStatus=$?
[ "$liveStatus" -eq 0 ] &&
  printf '%s\n' "$liveOut" | grep -q "\[stack\] READY" &&
  printf '%s\n' "$liveOut" | grep -q "proxy: started as pid" &&
  printf '%s\n' "$liveOut" | grep -q "confirmed by the OS as the process bound to that port"
rc=$?
check "a genuinely free port still yields a started, pid-to-port-confirmed proxy" \
      "exit 0, a READY receipt, and the started pid confirmed by the OS as the holder of that port (got exit $liveStatus)" "$rc"
# This one really did start a detached proxy — stop it before anything else.
node "$STACK_LAUNCHER_UT" --stop --proxy-port "$STACK2_LIVE_PORT" \
    --brain-port "$STACK2_BRAIN_PORT" --data-dir "$STACK2_DIR" >/dev/null 2>&1 || true
find "$HERE/proxy-logs" -maxdepth 1 \( -name 'stack-proxy-*.log' -o -name 'proxy-stack-*.jsonl' \) \
    -newer "$STACK2_TMP/before-live-run" -delete 2>/dev/null || true
rm -f "$HERE/.stack/proxy-$STACK2_LIVE_PORT.json"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
