#!/usr/bin/env bash
# launch-sweep-detached.sh must build the SAME hidden-console launch shape
# launch-detached.sh was measured with, around run-two-workers.sh.
#
# FAILS ON THE PRE-CHANGE TREE: launch-sweep-detached.sh did not exist, so every
# `bash "$LAUNCH" ...` below fails with "No such file or directory" and every
# assertion aborts. There was no way at all to start a two-worker sweep without
# it sharing a Windows console with the tool call that launched it -- the exact
# arrangement that killed a trial on 2026-09-11 18:53:25, except applied to 89
# tasks instead of one.
#
# THIS TEST NEVER EXECUTES THE LAUNCH. Unlike launch-detached.test.sh, which can
# afford to run a stub trial for 8 s, a stubbed sweep would still take the sweep
# lock, claim ports 7425/7426 and start a bench brain. So this asserts the exact
# PowerShell command the script BUILDS (TB_LAUNCH_SWEEP_PRINT_ONLY=1), plus the
# refusals that must happen before any command is built at all.
#
# Windows-only, like the script under test: SKIPs cleanly elsewhere.
set -uo pipefail
HERE_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$HERE_T/launch-sweep-detached.sh"
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }

if [ "${OS:-}" != "Windows_NT" ]; then
  echo "SKIP: launch-sweep-detached.sh is Windows-only; this host is not Windows_NT."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TASKS="$TMP/tasks.txt"
printf 'alpha\nbravo\ncharlie\n' > "$TASKS"
TASKS_ABS="$(cd "$(dirname "$TASKS")" && pwd)/$(basename "$TASKS")"
OUTLOG="$TMP/launcher.out"

STAMP="09141234"
TB_SWEEP_STAMP="$STAMP" TB_LOCK_FILE="$TMP/no-lock-here" TB_LAUNCH_SWEEP_PRINT_ONLY=1 \
  bash "$LAUNCH" "$TASKS" > "$OUTLOG" 2>&1
rc=$?
[ "$rc" -eq 0 ] || no "print_only_exits_zero" "rc=$rc :: $(cat "$OUTLOG")"

CMD="$(grep -m1 '^\[launch-sweep\] powershell: ' "$OUTLOG" | sed 's/^\[launch-sweep\] powershell: //')"

# ── the EXACT command, reconstructed independently from the same inputs ───────
# Not a substring check: the whole point of a launcher is the one command it
# builds, and a test that only greps for "Start-Process" passes with the
# redirects, the hidden window or the task list missing.
GIT_BASH_WIN="C:\\Program Files\\Git\\bin\\bash.exe"
if [ ! -f "$(cygpath -u "$GIT_BASH_WIN" 2>/dev/null)" ]; then
  GIT_BASH_WIN="$(cygpath -w "$(command -v bash)")"
fi
SCRIPT_WIN="$(cygpath -w "$HERE_T/run-two-workers.sh")"
OUT_WIN="$(cygpath -w "$HERE_T/detached-sweep-$STAMP.out")"
ERR_WIN="$(cygpath -w "$HERE_T/detached-sweep-$STAMP.err")"
WANT="Start-Process -FilePath '$GIT_BASH_WIN' -ArgumentList @('$SCRIPT_WIN','$TASKS_ABS') -WindowStyle Hidden -RedirectStandardOutput '$OUT_WIN' -RedirectStandardError '$ERR_WIN'"

if [ "$CMD" = "$WANT" ]; then
  ok "the exact PowerShell command is built"
else
  no "the exact PowerShell command is built" "got  [$CMD]
     want [$WANT]"
fi

# ── the announced prefixes are the ones the sweep will really use ────────────
# A launcher that stamped independently of run-two-workers.sh would name
# prefixes nobody can grep for whenever the launch crosses a minute boundary.
if grep -q "ts${STAMP}w0 (:7425)" "$OUTLOG" && grep -q "ts${STAMP}w1 (:7426)" "$OUTLOG"; then
  ok "the prefix pair is printed with its port"
else
  no "the prefix pair is printed with its port" "$(cat "$OUTLOG")"
fi
# run-two-workers.sh must HONOUR the stamp, or the line above is a lie.
if grep -q 'TB_SWEEP_STAMP' "$HERE_T/run-two-workers.sh"; then
  ok "run-two-workers.sh honours TB_SWEEP_STAMP"
else
  no "run-two-workers.sh honours TB_SWEEP_STAMP" "the announced prefixes would not match the sweep's own"
fi

# ── nothing was launched ──────────────────────────────────────────────────────
if [ -f "$HERE_T/detached-sweep-$STAMP.out" ]; then
  no "print-only launches nothing" "a detached log was created"
  rm -f "$HERE_T/detached-sweep-$STAMP.out" "$HERE_T/detached-sweep-$STAMP.err"
else
  ok "print-only launches nothing"
fi

# ── refusals, all of which must precede any launch ───────────────────────────
if TB_LOCK_FILE="$TMP/no-lock-here" bash "$LAUNCH" "$TMP/does-not-exist.txt" >"$TMP/a.log" 2>&1; then
  no "a missing tasks file is refused" "exited 0"
else
  ok "a missing tasks file is refused"
fi

: > "$TMP/empty.txt"
if TB_LOCK_FILE="$TMP/no-lock-here" bash "$LAUNCH" "$TMP/empty.txt" >"$TMP/b.log" 2>&1; then
  no "an empty tasks file is refused" "exited 0"
else
  grep -qi 'REFUSING' "$TMP/b.log" && ok "an empty tasks file is refused, with a reason" \
    || no "an empty tasks file is refused, with a reason" "$(cat "$TMP/b.log")"
fi

# A LIVE lock must stop the launch: two sweeps fight over 7425/7426 and both die.
LIVELOCK="$TMP/live.lock"
printf '%s\n' "$$" > "$LIVELOCK"
if TB_LOCK_FILE="$LIVELOCK" TB_LAUNCH_SWEEP_PRINT_ONLY=1 bash "$LAUNCH" "$TASKS" >"$TMP/c.log" 2>&1; then
  no "a live sweep lock is refused" "exited 0 :: $(cat "$TMP/c.log")"
else
  grep -qi 'REFUSING' "$TMP/c.log" && ok "a live sweep lock is refused, with a reason" \
    || no "a live sweep lock is refused, with a reason" "$(cat "$TMP/c.log")"
fi

# A STALE lock (dead pid) must NOT stop it -- an unattended campaign that cannot
# recover from its own crash debris stops at the first crash.
printf '%s\n' "999999" > "$TMP/stale.lock"
if TB_SWEEP_STAMP="$STAMP" TB_LOCK_FILE="$TMP/stale.lock" TB_LAUNCH_SWEEP_PRINT_ONLY=1 \
     bash "$LAUNCH" "$TASKS" >"$TMP/d.log" 2>&1; then
  ok "a stale sweep lock does not block the launch"
else
  no "a stale sweep lock does not block the launch" "$(cat "$TMP/d.log")"
fi

if TB_REDO_SNAPSHOT=1 bash "$LAUNCH" "$TASKS" >"$TMP/e.log" 2>&1; then
  no "a nested launch inside a redo is refused" "exited 0"
else
  grep -qi 'REFUSING' "$TMP/e.log" && ok "a nested launch inside a redo is refused" \
    || no "a nested launch inside a redo is refused" "$(cat "$TMP/e.log")"
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
