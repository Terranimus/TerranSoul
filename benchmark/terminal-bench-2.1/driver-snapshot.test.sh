#!/usr/bin/env bash
# A trial must execute a SNAPSHOT of run-dg.sh, never the repo file.
#
# WHY THIS FAILS ON THE PRE-CHANGE TREE: redo-task.sh ran `bash "$HERE/run-dg.sh"`
# directly, so there is no snapshot to assert.
#
# ⛔ THE DEFECT, which has now cost a trial TWICE in one session.
# Bash reads a script by BYTE OFFSET as it executes. Editing run-dg.sh while a
# trial is in flight makes the running shell resume mid-line at a shifted
# position. It does not fail at the moment of the edit — it fails minutes later:
#
#     run-dg.sh: line 1323: ncy: command not found       (exit 127)
#
# a fragment of "concurrency". Observed 2026-09-02 on a build-pmars canary: the
# trial itself graded (reward 1.0, 4/4) but run-dg.sh's tail was destroyed, so
# the outcome-crediting step never ran.
#
# The first occurrence was recorded in memory the same day. A note did not
# prevent the repeat, which is why this is a code guard and a test rather than
# another line of documentation.
#
# Hermetic: greps two repo files. No trial, no docker, no network.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REDO="$HERE/redo-task.sh"
fails=0
ok()  { echo "  ok   - $1"; }
bad() { echo "  FAIL - $1"; fails=$((fails + 1)); }

echo "driver-snapshot:"

if grep -q 'RUN_DG_SNAPSHOT="\$(mktemp' "$REDO"; then
  ok "a snapshot path is allocated with mktemp"
else
  bad "redo-task.sh must allocate a snapshot path"
fi

if grep -q 'cp "\$HERE/run-dg.sh" "\$RUN_DG_SNAPSHOT"' "$REDO"; then
  ok "run-dg.sh is copied to the snapshot before the run"
else
  bad "redo-task.sh must copy run-dg.sh to the snapshot"
fi

# The point of the whole exercise: the RUN must target the copy.
if grep -qE '^\s*bash "\$RUN_DG_SNAPSHOT"' "$REDO"; then
  ok "the trial executes the SNAPSHOT, not \$HERE/run-dg.sh"
else
  bad "the trial must execute \$RUN_DG_SNAPSHOT — executing the repo file is the bug"
fi

# And it must not leave temp copies behind on every redo.
if grep -q "trap 'rm -f \"\$RUN_DG_SNAPSHOT\"' EXIT" "$REDO"; then
  ok "the snapshot is removed on exit"
else
  bad "the snapshot must be cleaned up on exit"
fi

# ⛔ THE SNAPSHOT MUST CARRY THE REPO LOCATION WITH IT.
#    Running the copy from /tmp makes run-dg.sh's own
#    HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" resolve to /tmp,
#    breaking all 17 of its "$HERE/..." references. MEASURED the first time
#    this shipped: MODULE_NOT_FOUND on the purity checker, which then refused
#    the run outright (exit 2). The snapshot fix is only safe with this.
if grep -q 'export TB_DRIVER_HOME="\$HERE"' "$REDO"; then
  ok "the caller exports TB_DRIVER_HOME so the snapshot can find the repo"
else
  bad "redo-task.sh must export TB_DRIVER_HOME — without it the snapshot breaks \$HERE"
fi

if grep -q 'HERE="\${TB_DRIVER_HOME:-' "$HERE/run-dg.sh"; then
  ok "run-dg.sh prefers TB_DRIVER_HOME over its own BASH_SOURCE path"
else
  bad "run-dg.sh must prefer TB_DRIVER_HOME, or it resolves \$HERE into /tmp"
fi

# ⛔ THE ENV PREFIX MUST BE ONE CONTIGUOUS COMMAND.
#    It spans many backslash-continued lines ending in `bash "$RUN_DG_SNAPSHOT"`.
#    Inserting ANYTHING into the middle severs the continuation: the leading
#    assignments become plain shell variables and never reach the child.
#    MEASURED 2026-09-03 — the snapshot block was first inserted between
#    TB_JOB_PREFIX and TB_ATTEMPTS, so the child ran with an EMPTY task list
#    and died resolving "tasks//task.toml" with exit 2 and no message of its
#    own. Three runs were spent blaming contamination, $HERE and set -e first.
prefix_ok=1
in_prefix=0
while IFS= read -r line; do
  case "$line" in
    TB_TASKS=*) in_prefix=1 ;;
  esac
  if [ "$in_prefix" = "1" ]; then
    case "$line" in
      *"bash \"\$RUN_DG_SNAPSHOT\""*) in_prefix=0 ;;
      *"\\") : ;;
      *) prefix_ok=0 ;;
    esac
  fi
done < "$REDO"
if [ "$prefix_ok" = "1" ]; then
  ok "the env prefix is contiguous — every line continues to the bash invocation"
else
  bad "a non-continued line sits inside the env prefix — TB_TASKS will not reach the child"
fi

# ⛔ redo-task.sh MUST ALSO SNAPSHOT ITSELF.
#    The run-dg.sh snapshot protected the driver but left THIS file exposed —
#    and it is the one an operator actually edits between runs. Same defect:
#    bash reads by byte offset, so an edit mid-run resumes at a shifted
#    position. It could not be fixed earlier in the session because a trial
#    was always executing the file; it needed a gap between runs.
if grep -q 'if \[ -z "${TB_REDO_SNAPSHOT:-}" \]; then' "$REDO"; then
  ok "redo-task.sh re-execs from a snapshot of itself"
else
  bad "redo-task.sh must re-exec from its own snapshot"
fi
if grep -q 'HERE="${TB_REDO_HOME:-' "$REDO"; then
  ok "it forwards its own directory, since BASH_SOURCE points at /tmp after re-exec"
else
  bad "redo-task.sh must prefer TB_REDO_HOME — otherwise \$HERE resolves into /tmp"
fi

# ⛔ AN EMPTY TASK LIST MUST FAIL LOUDLY.
#    Cost two runs in one session from two unrelated causes (a severed env
#    prefix; a temp path Windows Python and Git Bash resolve differently).
#    Both produced the SAME uninformative symptom: exit 2 with no message,
#    directly beneath an unrelated but loud "[contamination] REFUSING" line —
#    so the visible message was not the cause, and three runs were spent on
#    innocent components.
if grep -q 'NO TASKS: TB_TASKS and TASK are both empty' "$HERE/run-dg.sh"; then
  ok "run-dg.sh refuses an empty task list with an explicit message"
else
  bad "run-dg.sh must validate TB_TASKS/TASK before use — the failure downstream is silent"
fi

# Regression guard: no path may still invoke the repo file directly.
if grep -qE '^\s*bash "\$HERE/run-dg\.sh"' "$REDO"; then
  bad "a direct 'bash \$HERE/run-dg.sh' invocation remains — the defect is still reachable"
else
  ok "no direct invocation of the repo driver remains"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "driver-snapshot: PASS (11/11)"
  exit 0
fi
echo "driver-snapshot: FAIL ($fails failing)"
exit 1
