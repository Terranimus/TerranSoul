#!/usr/bin/env bash
# Regression test for the 2026-09-15 "external rotation slept through" loss.
#
# THE DEFECT: refresh_token's expiry wait was a single blind `sleep "$secs"`
# (secs = minutes-left*60+45). On 2026-09-15 the credential was rotated
# EXTERNALLY (another session's CLI call) ~40 min into a 5067 s sleep and
# 75 min into a 7089 s one; both workers stayed asleep with 470 min of fresh
# headroom already sitting on disk, and the coordinator had to kill the two
# sleep processes by hand.
#
# WHY THIS FAILS ON THE PRE-CHANGE TREE (rules/tests-must-be-able-to-fail.md):
# the pre-change wait is `sleep "$secs"` in ONE call, so it never re-reads the
# credential file mid-wait. Case 1 below stubs `sleep` to rewrite the
# credential to 480 min of headroom on its 3rd invocation. Post-change,
# refresh_token polls in TB_TOKEN_POLL_S slices and re-checks after each one,
# so it notices the rotation after ~180s of (stubbed, instant) sleep and
# returns 0 with "rotated externally" logged. Pre-change, the single blind
# `sleep "$secs"` call means the stub's rewrite (armed for its 3rd call) never
# even fires — bash never invokes `sleep` a 3rd time because it only calls it
# ONCE — so the credential is never re-read mid-wait, the case's core
# assertion (rc=0, "rotated externally" in the log) goes red, and the total
# recorded sleep is the single 1245s call instead of ~180s.
#
# Case 2 pins the no-rotation path: the poll must still consume the FULL
# budget (same total as the old blind sleep) and still poke afterward,
# exactly as before -- so the fix cannot silently shorten the wait.
#
# No network, no real credential: HOME/USERPROFILE point at a temp dir and a
# stubbed `claude` on PATH replaces the real CLI, matching
# credential-refresh-poke.test.sh's pattern.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0
ok()  { echo "  ok   - $1"; pass=$((pass+1)); }
bad() { echo "  FAIL - $1" >&2; fail=$((fail+1)); }

echo "token-poll:"
command -v node >/dev/null 2>&1 || { echo "  SKIP - node not available"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

write_cred() {  # <file> <minutes_left>
  node -e '
const fs=require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify({claudeAiOauth:{
  accessToken:"sk-ant-oat01-STALE", refreshToken:"rt", subscriptionType:"max",
  expiresAt: Date.now() + Number(process.argv[2])*60000 }}));
' "$1" "$2"
}

BIN="$TMP/bin"; mkdir -p "$BIN"

# `claude` stub: logs a POKE event and does nothing else -- unlike
# credential-refresh-poke.test.sh's stub, this one never rotates the
# credential, so a poke alone can never resolve the gate and the ladder is
# forced into the wait/poll path under test.
cat > "$BIN/claude" <<'STUB'
#!/usr/bin/env bash
echo "POKE" >> "$TB_TEST_EVENTS"
echo ok
STUB
chmod +x "$BIN/claude"

# `sleep` stub: logs a SLEEP event with the requested duration, then returns
# immediately (no real waiting) instead of actually sleeping. On its
# TB_TEST_ROTATE_AT'th call it rewrites the credential file to 480 min of
# headroom, simulating an externally-triggered rotation landing mid-wait.
cat > "$BIN/sleep" <<'STUB'
#!/usr/bin/env bash
echo "SLEEP $1" >> "$TB_TEST_EVENTS"
n=$(grep -c '^SLEEP' "$TB_TEST_EVENTS")
if [ "${TB_TEST_ROTATE_AT:-0}" -gt 0 ] && [ "$n" -eq "$TB_TEST_ROTATE_AT" ]; then
  node -e '
const fs=require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify({claudeAiOauth:{
  accessToken:"sk-ant-oat01-ROTATED-EXTERNALLY", refreshToken:"rt", subscriptionType:"max",
  expiresAt: Date.now() + 480*60*1000 }}));
' "$TB_TEST_CRED_FILE"
fi
exit 0
STUB
chmod +x "$BIN/sleep"

# ── case 1: credential rotates externally mid-wait ──────────────────────────
echo "case 1: an external rotation mid-wait is noticed and resumes early"
HOME1="$TMP/home1"; mkdir -p "$HOME1/.claude"
CRED1="$HOME1/.claude/.credentials.json"
write_cred "$CRED1" 20        # 20 minutes from expiry
EVENTS1="$TMP/events1.log"; : > "$EVENTS1"

set +e
OUT1="$(
  HOME="$HOME1" USERPROFILE="$HOME1" PATH="$BIN:$PATH" \
  TB_TEST_EVENTS="$EVENTS1" TB_TEST_CRED_FILE="$CRED1" TB_TEST_ROTATE_AT=3 \
  TB_TOKEN_MIN_MINUTES=90 TB_TOKEN_POLL_S=60 TB_TOKEN_FILE="$TMP/out1.env" \
  timeout 20 bash -c '
    set -uo pipefail
    . "$1"
    refresh_token
    echo "REFRESH_RC=$?"
  ' _ "$HERE/token-refresh.sh" 2>&1
)"
set -e

if grep -q "REFRESH_RC=0" <<<"$OUT1"; then
  ok "refresh_token returned 0 after the externally-rotated credential was noticed"
else
  bad "refresh_token did not return 0: $(tail -5 <<<"$OUT1" | tr '\n' '|')"
fi

if grep -q "rotated externally" <<<"$OUT1"; then
  ok "the log names the external rotation"
else
  bad "log is missing the external-rotation message: $(tail -5 <<<"$OUT1" | tr '\n' '|')"
fi

sleeps1=$(grep -c '^SLEEP' "$EVENTS1" 2>/dev/null || echo 0)
slept_secs1=$(awk '/^SLEEP/{s+=$2} END{print s+0}' "$EVENTS1")
# Old blind wait for a 20-min-left / 90-min-gate credential is (20*60)+45 =
# 1245s in ONE call. The polling fix must resolve in far less -- it stops at
# the 3rd 60s slice (~180s), well under half the blind wait.
if [ "$sleeps1" -eq 3 ] && [ "$slept_secs1" -le 300 ]; then
  ok "resumed after $sleeps1 poll slice(s) totalling ${slept_secs1}s -- far below the 1245s blind wait"
else
  bad "expected 3 poll slices totalling <=300s, got $sleeps1 slice(s) totalling ${slept_secs1}s"
fi

# ── case 2: nothing rotates -- full budget still consumed, then still pokes ─
echo "case 2: with no rotation the poll consumes the full budget and still pokes"
HOME2="$TMP/home2"; mkdir -p "$HOME2/.claude"
CRED2="$HOME2/.claude/.credentials.json"
write_cred "$CRED2" 20        # 20 minutes from expiry, same as case 1
EVENTS2="$TMP/events2.log"; : > "$EVENTS2"

set +e
OUT2="$(
  HOME="$HOME2" USERPROFILE="$HOME2" PATH="$BIN:$PATH" \
  TB_TEST_EVENTS="$EVENTS2" TB_TEST_CRED_FILE="$CRED2" TB_TEST_ROTATE_AT=0 \
  TB_TOKEN_MIN_MINUTES=90 TB_TOKEN_POLL_S=60 TB_TOKEN_WAIT_MAX_S=1245 \
  TB_TOKEN_FILE="$TMP/out2.env" \
  timeout 20 bash -c '
    set -uo pipefail
    . "$1"
    refresh_token
    echo "REFRESH_RC=$?"
  ' _ "$HERE/token-refresh.sh" 2>&1
)"
set -e

if grep -q "rotated externally" <<<"$OUT2"; then
  bad "logged a rotation that never happened"
else
  ok "no false 'rotated externally' claim when nothing rotated"
fi

# Sum the SLEEP slices that fall between the 1st and 2nd POKE -- that is
# exactly the one poll cycle the wait branch runs (TB_TOKEN_WAIT_MAX_S=1245
# permits only one, so the ladder pokes, polls the full budget, pokes again,
# then falls through to its ordinary attempt/retry sleeps).
cycle_sum=$(awk '
  /^POKE/  { pokes++; next }
  /^SLEEP/ { if (pokes==1) { s+=$2 } }
  END { print s+0 }
' "$EVENTS2")
poke_count=$(grep -c '^POKE' "$EVENTS2" 2>/dev/null || echo 0)

if [ "$cycle_sum" -eq 1245 ]; then
  ok "the poll consumed the full 1245s budget before giving up -- unchanged from the blind wait"
else
  bad "expected the poll cycle to total 1245s, got ${cycle_sum}s"
fi

if [ "$poke_count" -ge 2 ]; then
  ok "poked both before and after the poll ($poke_count POKE events) -- unchanged from the pre-poll behaviour"
else
  bad "expected >=2 POKE events (pre-wait and post-poll), got $poke_count"
fi

echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
