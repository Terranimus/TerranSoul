#!/usr/bin/env bash
# The container network preflight must REFUSE a broken environment and must
# never block a run because the probe itself could not run.
#
# ⛔ WHAT IT PINS. MEASURED 2026-09-07: nine consecutive trials errored in
# `_install_stock_with_retry` with "curl: (60) SSL certificate problem" against
# downloads.claude.ai, ~40 minutes lost, and the wall of identical errors read
# like an adapter regression. A single probe with a clean image showed the host
# reached the same URL fine (200) while containers could not reach npmjs, pypi
# or claude.ai — a TLS-intercepting middlebox trusted by Windows and absent
# from the containers' CA bundle.
#
# Refusing (not warning) is deliberate: the same interception breaks apt-get,
# pip and npm INSIDE task containers, so a sweep run in that state depresses
# every task that installs anything and yields a misleading number.
#
# Hermetic: a fake `docker` on PATH decides the answer, so this needs no daemon
# and no network. Runs in ~1s.
#
# FAILS ON THE PRE-CHANGE TREE: run-dg.sh had no container network preflight, so
# the broken-network case reached the task-list guard and exited with a
# different message.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin"

# $1 = what the fake docker prints for the probe ("" = print nothing, exit 1)
make_docker() {
  cat > "$SANDBOX/bin/docker" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "run" ]; then
  [ -n "$1" ] && printf '%s' "$1" || exit 1
  exit 0
fi
exit 0
EOF
  chmod +x "$SANDBOX/bin/docker"
}

run_dg() { # -> stdout+stderr; TB_TASKS empty so it stops early either way
  PATH="$SANDBOX/bin:$PATH" TB_AGENT="terransoul_hook:TerranSoulHook" TB_STOP_HOOK=0 \
    bash "$HERE/run-dg.sh" "" 2>&1
}

echo "== a TLS-broken container network REFUSES the run =="
make_docker "000"
out="$(run_dg)"
if printf '%s' "$out" | grep -q "REFUSING: containers cannot reach"; then
  ok "a failed probe refuses"
else
  no "a failed probe refuses" "$(printf '%s' "$out" | tail -3)"
fi
if printf '%s' "$out" | grep -q "TLS-intercepting"; then
  ok "the refusal names the actual cause, not just the symptom"
else
  no "the refusal names the actual cause" "missing"
fi
if printf '%s' "$out" | grep -q "TB_SKIP_NET_PREFLIGHT=1"; then
  ok "the refusal names its own override"
else
  no "the refusal names its own override" "missing"
fi

echo "== a healthy container network does NOT refuse =="
make_docker "200"
out="$(run_dg)"
if printf '%s' "$out" | grep -q "REFUSING: containers cannot reach"; then
  no "a 200 must not refuse" "refused anyway"
else
  ok "a 200 does not refuse"
fi

echo "== the probe FAILS OPEN when it cannot run at all =="
# A preflight that blocks because it could not check is worse than none.
make_docker ""
out="$(run_dg)"
if printf '%s' "$out" | grep -q "REFUSING: containers cannot reach"; then
  no "an unrunnable probe must not refuse" "refused anyway"
else
  ok "an unrunnable probe fails open"
fi
if printf '%s' "$out" | grep -q "preflight: SKIPPED"; then
  ok "and says so, rather than staying silent"
else
  no "an unrunnable probe announces itself" "no SKIPPED line"
fi

echo "== the override switches it off entirely =="
make_docker "000"
out="$(PATH="$SANDBOX/bin:$PATH" TB_SKIP_NET_PREFLIGHT=1 TB_AGENT="terransoul_hook:TerranSoulHook" \
        TB_STOP_HOOK=0 bash "$HERE/run-dg.sh" "" 2>&1)"
if printf '%s' "$out" | grep -q "REFUSING: containers cannot reach"; then
  no "the override disables the gate" "still refused"
else
  ok "the override disables the gate"
fi

echo
echo "  ---- $pass passed, $fail failed ----"
exit $((fail > 0))
