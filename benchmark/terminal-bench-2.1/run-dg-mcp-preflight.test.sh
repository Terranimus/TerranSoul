#!/usr/bin/env bash
# A SOURCE SCAN, not a behavioural test — run-dg.sh has no test harness at all
# (it drives a real harbor invocation end to end, with no seam to stub that
# out short of reimplementing the whole script) and none of its 2000+ lines
# are covered any other way. Per rules/tests-must-be-able-to-fail.md item 3,
# a source scan is the honest guard when a unit test cannot reach the thing it
# guards: this states plainly that it is one, and it pins TEXT, not behaviour.
#
# What it pins: run-dg.sh (fix F1, TBENCH-BRAIN-CONNECT-1) must actually call
# the in-container MCP initialize probe before invoking harbor, not merely
# define it — an unwired check that "exists" but is never reached is exactly
# the kind of defect this campaign's own lessons warn about (a writer with no
# reader, an advertised capability nothing exercises).
#
# FAILS ON THE PRE-CHANGE TREE: mcp-initialize-probe.mjs was not referenced by
# run-dg.sh at all (the file did not exist), and neither was
# container-mcp-probe.sh / probe_container_mcp_initialize. Every grep below
# returns nothing and every check fails.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/run-dg.sh"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

line_of() { grep -n "$1" "$SRC" 2>/dev/null | head -1 | cut -d: -f1; }

proxy_up_line="$(line_of '^echo "\[run-dg\] MCP auth proxy up on')"
init_probe_line="$(line_of 'mcp-initialize-probe\.mjs" --port "\$PROXY_PORT"')"
container_probe_source_line="$(line_of '\. "\$HERE/container-mcp-probe\.sh"')"
container_probe_call_line="$(line_of 'probe_container_mcp_initialize "\$PROXY_PORT"')"
job_dir_line="$(line_of '^JOB_DIR=')"

[ -n "$init_probe_line" ] && ok "run-dg.sh actually calls mcp-initialize-probe.mjs" \
  || no "run-dg.sh actually calls mcp-initialize-probe.mjs" "no call site found"
[ -n "$container_probe_source_line" ] && ok "run-dg.sh sources container-mcp-probe.sh" \
  || no "run-dg.sh sources container-mcp-probe.sh" "no source line found"
[ -n "$container_probe_call_line" ] && ok "run-dg.sh actually calls probe_container_mcp_initialize" \
  || no "run-dg.sh actually calls probe_container_mcp_initialize" "no call site found"

if [ -n "$proxy_up_line" ] && [ -n "$init_probe_line" ] && [ "$init_probe_line" -gt "$proxy_up_line" ]; then
  ok "the initialize probe runs AFTER the proxy is confirmed up (not before it can even answer)"
else
  no "the initialize probe runs after the proxy is up" "proxy_up=$proxy_up_line init_probe=$init_probe_line"
fi

if [ -n "$init_probe_line" ] && [ -n "$job_dir_line" ] && [ "$init_probe_line" -lt "$job_dir_line" ]; then
  ok "the initialize probe runs BEFORE the trial's own job dir exists (a real preflight, not an after-the-fact check)"
else
  no "the initialize probe precedes the trial" "init_probe=$init_probe_line job_dir=$job_dir_line"
fi
if [ -n "$container_probe_call_line" ] && [ -n "$job_dir_line" ] && [ "$container_probe_call_line" -lt "$job_dir_line" ]; then
  ok "the container-network probe runs BEFORE the trial's own job dir exists"
else
  no "the container-network probe precedes the trial" "container_probe=$container_probe_call_line job_dir=$job_dir_line"
fi

# A refusal here must actually stop the trial, not merely print a warning.
refuse_count="$(awk -v a="$init_probe_line" -v b="$job_dir_line" \
  'NR>=a && NR<=b && /exit 2/ {n++} END{print n+0}' "$SRC")"
[ "${refuse_count:-0}" -ge 2 ] && ok "both probes REFUSE (exit 2) on failure, not just log" \
  || no "both probes refuse on failure" "found $refuse_count exit-2 sites between the probe and the trial"

# The escape hatch must exist and gate BOTH probes, matching the
# TB_SKIP_NET_PREFLIGHT convention preflight-sweep.sh already established.
skip_gate_line="$(line_of 'TB_SKIP_MCP_INIT_PREFLIGHT')"
if [ -n "$skip_gate_line" ] && [ -n "$init_probe_line" ] && [ -n "$container_probe_call_line" ] \
   && [ "$skip_gate_line" -lt "$init_probe_line" ] && [ "$skip_gate_line" -lt "$container_probe_call_line" ]; then
  ok "TB_SKIP_MCP_INIT_PREFLIGHT gates both probes"
else
  no "TB_SKIP_MCP_INIT_PREFLIGHT gates both probes" "skip_gate=$skip_gate_line init=$init_probe_line container=$container_probe_call_line"
fi

echo "  ---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ]
