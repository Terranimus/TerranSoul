#!/usr/bin/env bash
# Regression test for the 2026-08-29 "run that never happened" 401.
#
# WHY THIS FAILS ON THE PRE-CHANGE TREE (rules/tests-must-be-able-to-fail.md):
# before the fix, run-dg.sh's credential block was ONLY:
#     if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then : ; elif [ -s "$TOKEN_FILE" ];
#     then set -a; . "$TOKEN_FILE"; set +a; else exit 2; fi
# It never sourced token-refresh.sh, so a stale $TOKEN_FILE was passed to the
# container verbatim. Case 1 below writes a deliberately stale token file and
# asserts run-dg.sh REWRITES it to the live host credential; on the pre-change
# tree the file is returned byte-identical and the assertion fails. Case 2
# asserts an unusable credential is refused BEFORE any container starts; on the
# pre-change tree nothing checks validity at all, so nothing refuses it.
#
# Measured cost of the defect: 14m35s of container setup, then the agent lived
# 2.3 s and died on "401 OAuth access token has been revoked" with 0 input
# tokens, 0 cost and 0 MCP calls -- scored as a task failure.
# ── AND THE 2026-09-13 MID-TRIAL 401 (cases 3-6, TBENCH-TOKEN-CEILING-1) ────
# A token that is fresh ENOUGH is not the same as a token that will still be
# alive at the end of the trial. `sam-cell-seg__EXhTsdQ` launched at 07:34 on
# `[token-refresh] refreshed, 47 min of headroom` against a 7200 s (120-minute)
# ceiling, because the gate was the flat `TB_TOKEN_MIN_MINUTES:-40`. The
# credential died at ~08:16 with 98 model turns already produced, harbor retried
# by name twice, and the 430-line transcript came back 5 lines long.
#
# WHY CASES 3-6 FAIL ON THE PRE-CHANGE TREE: `_token_min_minutes` and
# `_token_wait_max_s` did not exist, and `_refresh_token_once` compared against
# 40 regardless of the task — so case 3 ACCEPTS the 47-minute token it is
# supposed to refuse (the exact admission measured above), and cases 5-6 raise
# `command not found`. Case 4 and case 6's floor row pin the other direction:
# the gate must not become a blanket raise that refuses tokens a short task can
# use.
#
# BOUNDED ON PURPOSE: on the pre-change tree TB_PREFLIGHT_ONLY does not exist,
# so run-dg.sh does not stop after the credential block -- it launches a real
# container and runs for 15+ min. The first red check proved that by timing out
# after 8 min with a live dna-insert container. `timeout 240` turns "did not stop
# at preflight" into a fast, deterministic failure instead of a hang.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
fails=0
TIMEOUT_S="${TB_TEST_TIMEOUT_S:-240}"
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; fails=$((fails+1)); }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# ⛔ HERMETIC FIRST. Cases 1-2 run the REAL run-dg.sh against the bench brain's port,
# reaching `docker run` and the host-headroom `docker rm -f` with no fake.
# hermetic-shims.sh puts logging shims for docker, netstat, ss and taskkill
# FIRST on PATH, and the guard ABORTS unless every one resolves inside this
# test's temp dir: on 2026-09-15 18:45 a real `docker rm -f` reached from
# two-workers.test.sh SIGKILLed two live trials of another sweep.
. "$HERE/hermetic-shims.sh" || { echo "ABORT: hermetic-shims.sh not found next to this test"; exit 2; }
hermetic_shims "$TMP" || { echo "ABORT: could not create the hermetic shims"; exit 2; }
hermetic_guard "$TMP" || exit 2

live_token() {
  node -e '
const fs=require("fs"),os=require("os"),path=require("path");
try{ console.log(JSON.parse(fs.readFileSync(path.join(os.homedir(),".claude",".credentials.json"),"utf8")).claudeAiOauth.accessToken) }
catch(e){ console.log("") }'
}

# ⛔ CASES 1-2 LAUNCH run-dg.sh, WHICH IS A BENCH ENTRY POINT: it starts the
# isolated brain on :7424 and, past preflight, containers. Running them beside a
# live bench breaks the ONE-bench / ONE-MCP rule
# (rules/bench-resource-discipline.md) and can restart the brain the running
# trial is talking to. They SKIP while a bench is up, loudly, and the summary
# says so — a skip is never counted as a pass.
_bench_is_live() {
  if command -v tasklist >/dev/null 2>&1; then
    tasklist -FI "IMAGENAME eq harbor.exe" -NH 2>/dev/null | grep -qi harbor.exe && return 0
  fi
  pgrep -f "harbor .*run" >/dev/null 2>&1 && return 0
  return 1
}

# A credential file with an exact remaining life, in a HOME of its own. node's
# os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so both are set.
fake_credential() {  # <dir> <minutes_left>
  mkdir -p "$1/.claude"
  node -e '
const fs=require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify({claudeAiOauth:{
  accessToken:"sk-ant-oat01-FAKE-CREDENTIAL-FOR-THE-GATE-TEST",
  refreshToken:"rt", subscriptionType:"max",
  expiresAt: Date.now() + Number(process.argv[2])*60000 }}));
' "$1/.claude/.credentials.json" "$2"
}

# `_refresh_token_once` ONLY -- never the full `refresh_token` ladder, which
# would poke the real CLI and sleep for as long as the token has left.
gate_probe() {  # <label> <ceiling_s> <minutes_left>
  local home="$TMP/gate-$1"
  fake_credential "$home" "$3"
  HOME="$home" USERPROFILE="$home" TB_TRIAL_CEILING_S="$2" TB_TOKEN_FILE="$home/out.env" \
    bash -c 'set -uo pipefail; . "$1"; _refresh_token_once' _ "$HERE/token-refresh.sh" \
    >"$home/log" 2>&1
  GATE_RC=$?
  GATE_OUT="$(cat "$home/log")"
  GATE_FILE="$home/out.env"
}

skipped=0
if [ "${TB_TEST_NO_DRIVER:-0}" = "1" ] || _bench_is_live; then
  echo "cases 1-2: SKIP (they launch run-dg.sh and a bench is live, or TB_TEST_NO_DRIVER=1)"
  skipped=2
else
echo "case 1: a stale token file is refreshed to the live host credential"
LIVE="$(live_token)"
if [ -z "$LIVE" ]; then
  echo "  SKIP  host credentials unreadable (no ~/.claude/.credentials.json)"
else
  printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "sk-ant-oat01-STALE-TOKEN-FROM-AN-EARLIER-ROTATION" > "$TMP/stale.env"
  before="$(cat "$TMP/stale.env")"
  TB_TOKEN_FILE="$TMP/stale.env" TB_PREFLIGHT_ONLY=1 TB_SKIP_TOKEN_PROBE=1 \
    TB_BRAIN_PORT="${TB_BRAIN_PORT:-7424}" TB_BRAIN_DATA="${TB_BRAIN_DATA:-$REPO/mcp-data-tbench-clean}" \
    timeout "$TIMEOUT_S" bash "$HERE/run-dg.sh" dna-insert >"$TMP/out1.txt" 2>&1
  rc=$?
  after="$(cat "$TMP/stale.env")"
  if [ "$before" = "$after" ]; then
    bad "stale token file was NOT refreshed (rc=$rc) -- this is the pre-change behaviour"
    sed -n '1,6p' "$TMP/out1.txt" | sed 's/^/        /'
  elif printf '%s' "$after" | grep -qF "$LIVE"; then
    ok "stale token file rewritten to the live host credential"
  else
    bad "token file changed but does not match the live host credential"
  fi
fi

echo "case 2: an unusable credential is refused before any container starts"
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "sk-ant-oat01-DEFINITELY-NOT-A-VALID-TOKEN" > "$TMP/bad.env"
TB_TOKEN_FILE="$TMP/bad.env" TB_PREFLIGHT_ONLY=1 TB_SKIP_TOKEN_REFRESH=1 TB_TOKEN_STATIC=1 \
  TB_BRAIN_PORT="${TB_BRAIN_PORT:-7424}" TB_BRAIN_DATA="${TB_BRAIN_DATA:-$REPO/mcp-data-tbench-clean}" \
  timeout "$TIMEOUT_S" bash "$HERE/run-dg.sh" dna-insert >"$TMP/out2.txt" 2>&1
rc2=$?
if [ "$rc2" -eq 2 ] && grep -q "REJECTED by the API" "$TMP/out2.txt"; then
  ok "bad credential refused with exit 2 before any container started"
elif grep -q "preflight-only: credential is live" "$TMP/out2.txt"; then
  bad "a known-bad credential was declared LIVE (rc=$rc2) -- validity is unchecked"
else
  bad "unexpected outcome rc=$rc2"
  sed -n '1,8p' "$TMP/out2.txt" | sed 's/^/        /'
fi
fi   # end of the run-dg-driven cases

echo "case 3: a 47-minute token is REFUSED for a 7200s (120-minute) trial"
gate_probe c3 7200 47
if [ "$GATE_RC" -eq 1 ] && printf '%s' "$GATE_OUT" | grep -q "below the 150-min gate"; then
  ok "refused against the derived 150-min gate (ceiling 120 min + 30)"
elif [ "$GATE_RC" -eq 0 ]; then
  bad "ACCEPTED a 47-minute token for a 120-minute trial -- the 2026-09-13 admission: $GATE_OUT"
else
  bad "unexpected outcome rc=$GATE_RC: $GATE_OUT"
fi

echo "case 4: a 200-minute token is ACCEPTED for the same trial"
gate_probe c4 7200 200
if [ "$GATE_RC" -eq 0 ] && [ -s "$GATE_FILE" ] \
   && grep -q "FAKE-CREDENTIAL-FOR-THE-GATE-TEST" "$GATE_FILE"; then
  ok "accepted and written through to the token file"
else
  bad "refused a token with 200 min for a 120-min trial (rc=$GATE_RC): $GATE_OUT"
fi

echo "case 5: with no ceiling published the 40-minute floor still applies"
gate_probe c5 "" 47
if [ "$GATE_RC" -eq 0 ]; then
  ok "not a blanket raise -- a short task still accepts 47 minutes"
else
  bad "the floor moved for callers that publish no ceiling (rc=$GATE_RC): $GATE_OUT"
fi

echo "case 6: the wait budget can still reach the gate it enforces"
# The ladder's one long wait is the token's remaining life + 45 s, and a token
# only needs the wait when its life is BELOW the gate. If max_wait cannot cover
# gate*60+45 the ladder can neither pass nor wait, which is a silent deadlock.
for ceiling in "" 900 1800 7200; do
  read -r gate budget <<EOF
$(TB_TRIAL_CEILING_S="$ceiling" bash -c 'set -uo pipefail; . "$1"; printf "%s %s" "$(_token_min_minutes)" "$(_token_wait_max_s)"' _ "$HERE/token-refresh.sh")
EOF
  need=$(( gate * 60 + 45 ))
  if [ -n "$gate" ] && [ -n "$budget" ] && [ "$budget" -ge "$need" ]; then
    ok "ceiling=${ceiling:-unset}: gate ${gate} min needs ${need}s, budget ${budget}s"
  else
    bad "ceiling=${ceiling:-unset}: gate ${gate} min needs ${need}s but the budget is ${budget}s"
  fi
done

echo
if [ "$skipped" -gt 0 ]; then
  echo "token-freshness: $skipped case(s) SKIPPED (bench live / TB_TEST_NO_DRIVER=1) -- re-run them when idle"
fi
if [ "$fails" -eq 0 ]; then echo "token-freshness: ALL PASS"; exit 0; fi
echo "token-freshness: $fails FAILURE(S)"; exit 1
