#!/usr/bin/env bash
# LAUNCH-DETACHED MUST SURVIVE THE LAUNCHING CONSOLE, NOT JUST THE CHILD.
#
# WHY THIS FAILS ON THE PRE-CHANGE TREE: launch-detached.sh does not exist at
# all, so `bash "$LAUNCH" ...` below fails with "No such file or directory"
# and every assertion aborts before running -- there was no script here that
# put redo-task.sh into its own hidden Windows console.
#
# WHAT THIS PINS. Measured 2026-09-11 18:53:25: a trial sharing this tool's
# console died when a CONCURRENT Bash-tool call hit the ~120s
# auto-background point, with no traceback and no result.json, while the
# task container it had started kept running healthily underneath. This test
# cannot reproduce that exact race (it needs two concurrent Claude-Code
# Bash-tool invocations racing a real console), so instead it pins the
# PROPERTY that makes the fix work: the launcher process returns long before
# its child finishes, and the child keeps running and completes on its own,
# unattended. A STUB stands in for redo-task.sh (via TB_LAUNCH_DETACHED_CMD)
# so this never touches harbor, docker, or a real trial.
#
# Windows-only, like the script under test: SKIPs cleanly elsewhere.
set -uo pipefail
HERE_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$HERE_T/launch-detached.sh"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

if [ "${OS:-}" != "Windows_NT" ]; then
  echo "SKIP: launch-detached.sh is Windows-only; this host is not Windows_NT."
  exit 0
fi

TMP="$(mktemp -d)"
# launch-detached.sh always writes its .out/.err next to itself (that is the
# documented, fixed location a human operator checks) -- so THIS test's fake
# run leaves real files in the repo dir too, briefly. FAKE_TASK is distinctive
# enough not to collide with any real task's log (a real trial running right
# now, per the coordinator's context, uses its own real task name), and the
# trap below removes them regardless of pass/fail.
FAKE_TASK="launch-detached-selftest-$$"
trap 'rm -rf "$TMP"; rm -f "$HERE_T"/detached-"$FAKE_TASK"-*.out "$HERE_T"/detached-"$FAKE_TASK"-*.err' EXIT
# ⛔ HERMETIC FIRST. launch-detached.sh starts redo-task.sh -> run-dg.sh (docker)
# unless TB_LAUNCH_DETACHED_CMD is honoured; the stub below is what normally
# runs. The detached child inherits this PATH; that inheritance is not asserted.
# hermetic-shims.sh puts logging shims for docker, netstat, ss and taskkill
# FIRST on PATH, and the guard ABORTS unless every one resolves inside this
# test's temp dir: on 2026-09-15 18:45 a real `docker rm -f` reached from
# two-workers.test.sh SIGKILLed two live trials of another sweep.
. "$HERE_T/hermetic-shims.sh" || { echo "ABORT: hermetic-shims.sh not found next to this test"; exit 2; }
hermetic_shims "$TMP" || { echo "ABORT: could not create the hermetic shims"; exit 2; }
hermetic_guard "$TMP" || exit 2

# The stub stands in for redo-task.sh end-to-end: same calling convention
# (task as $1, optional attempts as $2), the SAME "[redo] prefix : ..."
# announcement real callers grep for, printed immediately -- then 8s of
# sleep in place of a real trial, then a marker file in place of
# jobs/<prefix>*/result.json. The prefix line and the env-passthrough line
# are echoed BEFORE the sleep specifically so property (a)/(c)/(d) can be
# observed without waiting out the full 8s.
STUB="$TMP/stub-redo.sh"
MARKER="$TMP/child-done.marker"
cat > "$STUB" <<STUBEOF
#!/usr/bin/env bash
echo "[redo] prefix : stub123"
echo "ENV_MARKER_SEEN=\${TB_LAUNCH_DETACHED_TEST_MARKER:-<unset>}"
sleep 8
printf 'done %s %s\n' "\$1" "\$2" > "$MARKER"
STUBEOF
chmod +x "$STUB"

OUT_LOG="$TMP/launcher-stdout.log"
MARKER_ENV_VALUE="passthrough-$$-$RANDOM"

START_EPOCH=$(date +%s)
TB_LOCK_FILE="$TMP/no-lock-here" \
TB_LAUNCH_DETACHED_CMD="$STUB" \
TB_LAUNCH_DETACHED_TEST_MARKER="$MARKER_ENV_VALUE" \
bash "$LAUNCH" "$FAKE_TASK" 3 > "$OUT_LOG" 2>&1
rc=$?
END_EPOCH=$(date +%s)
LAUNCHER_ELAPSED=$((END_EPOCH - START_EPOCH))

# The launcher's OWN stdout ($OUT_LOG) only ever echoes the single matched
# "[redo] prefix" line it found -- the REAL child log (what the child itself
# wrote via -RedirectStandardOutput) is a separate file next to
# launch-detached.sh, named from the stamp this run actually used. Glob for
# it rather than recomputing the `date +%m%d%H%M` stamp independently, which
# would race a minute boundary between this test and the script under test.
CHILD_OUT="$(ls "$HERE_T"/detached-"$FAKE_TASK"-*.out 2>/dev/null | head -1)"

echo "  (launcher exit=$rc, elapsed=${LAUNCHER_ELAPSED}s)"

[ "$rc" -eq 0 ] || no "launcher exits 0 on a successful launch" "exit $rc: $(cat "$OUT_LOG")"

# ── (a) the launcher returns before the child finishes ──────────────────────
# A generous 6s cap: the stub's own sleep is 8s, so anything under 6s here
# could not possibly have waited for the child -- and this would FAIL if
# Start-Process were accidentally called with -Wait, or if this script fell
# back to a synchronous `bash "$STUB" ...` instead of detaching it.
if [ "$LAUNCHER_ELAPSED" -lt 6 ]; then
  ok "(a) the launcher returns before the child finishes (${LAUNCHER_ELAPSED}s < 8s child sleep)"
else
  no "(a) the launcher returns before the child finishes" "took ${LAUNCHER_ELAPSED}s -- looks like it blocked on the child"
fi

# ── (c) the prefix line was surfaced ────────────────────────────────────────
if grep -q '^\[redo\] prefix' "$OUT_LOG"; then
  ok "(c) the [redo] prefix line was surfaced to the caller"
else
  no "(c) the [redo] prefix line was surfaced to the caller" "$(cat "$OUT_LOG")"
fi

# ── (d) an env var set before launch reached the DETACHED child ─────────────
# Proves Start-Process's default environment inheritance end-to-end rather
# than assuming it -- this is the actual measurement the header comment
# documents, not a restatement of it. Checked against the CHILD's own log
# (CHILD_OUT), not the launcher's stdout, which never sees this line at all.
if [ -n "$CHILD_OUT" ] && grep -q "ENV_MARKER_SEEN=$MARKER_ENV_VALUE" "$CHILD_OUT"; then
  ok "(d) an env var set before launch was inherited by the detached child"
else
  no "(d) an env var set before launch was inherited by the detached child" "CHILD_OUT='$CHILD_OUT' content: $(cat "$CHILD_OUT" 2>/dev/null || echo '<missing>')"
fi

# ── (b) THE SURVIVAL PROPERTY, part 1: not finished yet ─────────────────────
# The marker must NOT exist at the moment the launcher already exited --
# it only appears after the stub's 8s sleep. If it existed here, the
# launcher was not actually detached; it ran the child inline.
if [ -f "$MARKER" ]; then
  no "(b) the child had not finished when the launcher exited" "marker already existed at launcher-exit time"
else
  ok "(b) the child had not finished when the launcher exited (still running, detached)"
fi

# ── (b) THE SURVIVAL PROPERTY, part 2: it finishes anyway, unattended ───────
# This shell does nothing between the launcher exiting and this wait -- no
# process of ours is "keeping the child alive"; a bounded poll here only
# OBSERVES completion, it does not cause it.
for _ in $(seq 1 20); do
  [ -f "$MARKER" ] && break
  sleep 1
done
if [ -f "$MARKER" ]; then
  ok "(b) the child completed on its own, after this shell had already moved on"
else
  no "(b) the child completed on its own" "marker never appeared within 20s of launcher exit"
fi

# ── (e) TB_REDO_SNAPSHOT set -> refusal, never nesting ──────────────────────
NEST_OUT="$TMP/nest-attempt.log"
if TB_REDO_SNAPSHOT=1 bash "$LAUNCH" my-fake-task > "$NEST_OUT" 2>&1; then
  no "(e) TB_REDO_SNAPSHOT set refuses to launch" "exited 0 -- should have refused: $(cat "$NEST_OUT")"
else
  if grep -qi "REFUSING" "$NEST_OUT"; then
    ok "(e) TB_REDO_SNAPSHOT set refuses to launch, with a stated reason"
  else
    no "(e) TB_REDO_SNAPSHOT set refuses to launch, with a stated reason" "non-zero exit but no REFUSING message: $(cat "$NEST_OUT")"
  fi
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
