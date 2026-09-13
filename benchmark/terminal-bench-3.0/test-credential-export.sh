#!/usr/bin/env bash
# Regression test for TBENCH-CREDS-EXPORT-1 (found 2026-08-18).
#
# `rules/tests-must-be-able-to-fail.md`: this test FAILS on the pre-fix tree
# and only that tree. Root cause: run-terransoul.sh / run-terransoul-verifyhook.sh
# both load ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_MODEL from
# ~/.claude/settings.Terranimus.json via `eval "$(node -e '...')"` emitting
# `: "${VAR:=$(printf %s '...')}"`. That assignment sets a plain SHELL
# variable, NOT an exported one. The preflight check spawns `node -e` as a
# CHILD PROCESS and forwards only `TB_PROBE_URL` explicitly — so on the
# pre-fix tree, `process.env.ANTHROPIC_AUTH_TOKEN` / `process.env.ANTHROPIC_MODEL`
# were always `undefined` inside that child, `fetch` sent the literal header
# value "undefined", and `JSON.stringify` silently dropped the `model` key.
# A REAL, WORKING credential loaded from the settings file was therefore
# reported as HTTP 401 "invalid/revoked" on every single invocation — 100%
# reproducible, independent of whether the key actually worked. Confirmed by
# hand during the 2026-08-18 verify-hook shakedown: the identical token
# succeeded on every direct/exported probe and failed on every probe that
# went through the scripts' own (pre-fix) credential-loading path.
#
# WHY THE EXISTING test-run-terransoul.sh NEVER CAUGHT THIS: its stub
# credentials are injected as `env ANTHROPIC_BASE_URL=... ANTHROPIC_AUTH_TOKEN=stub
# ... bash "$RUNNER"` — real OS environment variables from the start, already
# exported before the script's `:` "${VAR:=...}" line even runs (which then
# sees them non-empty and does nothing). That bypasses the settings-file
# `eval` branch entirely, so the bug never had a chance to manifest under that
# harness. This test instead forces credentials through the SETTINGS FILE
# path — the one real invocations actually use — with a stub server that
# checks the header it actually received rather than accepting anything.
#
#   bash benchmark/terminal-bench-3.0/test-credential-export.sh
#   TB_RUNNER=<path> bash benchmark/terminal-bench-3.0/test-credential-export.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0
fail=0
check() { # check <name> <expected-desc> <0|1 result>
  if [ "$3" -eq 0 ]; then
    printf '  ok   %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n       expected: %s\n' "$1" "$2"
    fail=$((fail + 1))
  fi
}

# A stub that VALIDATES what it received, unlike test-run-terransoul.sh's
# always-200 stub — it must be able to observe the exact bug (header value
# "undefined", or the request `model` field absent) rather than accept any
# request unconditionally.
STUB_PORT=18797
STUB_LOG="$(mktemp)"
node -e '
const { createServer } = require("http");
const fs = require("fs");
const logPath = process.argv[2];
createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    const key = req.headers["x-api-key"];
    let parsed = {};
    try { parsed = JSON.parse(b); } catch {}
    fs.writeFileSync(logPath, JSON.stringify({ key, hasModel: "model" in parsed }));
    if (!key || key === "undefined" || !("model" in parsed)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "missing/undefined credential reached the stub" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: parsed.model, content: [{ type: "text", text: "ok" }] }));
  });
}).listen(Number(process.argv[1]), "127.0.0.1");
' "$STUB_PORT" "$STUB_LOG" &
STUB_PID=$!
# Needs a real .json suffix: the runner's own credential loader does
# `require(process.argv[1])`, and Node's `require()` without a recognized
# extension falls back to parsing as JavaScript, not JSON — an extensionless
# mktemp file would fail for a reason unrelated to what this test checks.
SETTINGS_FILE="$(mktemp --suffix=.json)"
cleanup() { kill "$STUB_PID" 2>/dev/null; rm -f "$STUB_LOG" "$SETTINGS_FILE"; }
trap cleanup EXIT
sleep 1

cat > "$SETTINGS_FILE" <<JSON
{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:$STUB_PORT","ANTHROPIC_AUTH_TOKEN":"a-real-working-token","ANTHROPIC_MODEL":"stub-model"}}
JSON

run_via_settings_file() { # run_via_settings_file <runner-path>
  # Deliberately do NOT pre-export ANTHROPIC_*; force the script's own
  # settings-file-loading eval branch to be the ONLY source, exactly like a
  # real invocation with nothing already in the environment.
  env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL \
      TB_SETTINGS_JSON="$SETTINGS_FILE" \
      TB_DRY_RUN=1 \
      TB_TASK=terminal-bench/mvcc-lsm-compaction \
      bash "$1" >/dev/null 2>&1
}

echo "credential-export regression (TBENCH-CREDS-EXPORT-1)"
for RUNNER in "$HERE/run-terransoul.sh" "$HERE/run-terransoul-verifyhook.sh"; do
  name="$(basename "$RUNNER")"
  rm -f "$STUB_LOG"
  run_via_settings_file "$RUNNER"
  rc=$?
  received="$(cat "$STUB_LOG" 2>/dev/null || echo '{}')"
  check "$name: preflight reaches the stub with a real header + model field (not \"undefined\"/dropped)" \
        "exit 0 and stub log shows a real key + model field; got exit=$rc log=$received" \
        $([ "$rc" -eq 0 ] && printf '%s' "$received" | grep -q '"key":"a-real-working-token"' && printf '%s' "$received" | grep -q '"hasModel":true' && echo 0 || echo 1)
done

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
