#!/usr/bin/env bash
# The rendered agent instruction must stay under the Windows command-line limit.
#
# WHY THIS FAILS ON THE PRE-CHANGE TREE: run-dg.sh had no size check at all, so
# tests 1-3 find no guard, and test 4 measures a 29200-byte file against a
# ceiling that did not exist.
#
# THE DEFECT IT EXISTS FOR, measured 2026-09-02 and it cost a trial:
# harbor ships the task prompt + extra-instruction.md into the container as an
# env var ON the `docker compose exec` command line. Windows caps a command line
# at 32767 characters. Cross it and CreateProcess raises
#
#     FileNotFoundError: [WinError 206] The filename or extension is too long
#
# which harbor records as a TRIAL ERROR -- no reward.txt, no verifier output. An
# errored trial scores 0 under leaderboard rules, so growing this file silently
# ZEROES tasks. Observed either side of the boundary on filter-js-from-html:
#     28500 bytes -> ran and graded
#     29358 bytes -> WinError 206, ungraded
#
# The failure is invisible at authoring time, which is exactly why it needs a
# test rather than a convention: nobody editing a prompt file expects to be
# spending a process-creation budget.
#
# Hermetic: greps two repo files and does arithmetic. No docker, no network.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DG="$HERE/run-dg.sh"
INSTR="$HERE/extra-instruction.md"
fails=0
ok()   { echo "  ok   - $1"; }
bad()  { echo "  FAIL - $1"; fails=$((fails + 1)); }

echo "instruction-size-ceiling:"

# 1. The guard exists and is wired to the rendered file, not the source template.
if grep -q '_instr_bytes=.*wc -c < "\$INSTRUCTION_FILE"' "$RUN_DG"; then
  ok "guard measures the RENDERED instruction (placeholders expanded)"
else
  bad "guard must measure \$INSTRUCTION_FILE, not the unrendered template"
fi

# 2. It refuses rather than warns. A warning on a 40-minute trial is a warning
#    nobody reads until the reward is already 0.
if grep -A6 '_instr_bytes.*-gt.*_instr_ceiling' "$RUN_DG" | grep -q 'exit 2'; then
  ok "over the ceiling it exits non-zero rather than continuing"
else
  bad "guard must exit non-zero when over the ceiling"
fi

# 3. ⛔ THE CEILING MUST BE DERIVED, NOT GUESSED.
#    The first version hardcoded 26500, chosen by picking a "generous" 6000-byte
#    reserve. Re-derived from the measurement it was 1185 bytes ABOVE the real
#    worst case (32767 - 4443 longest prompt - 3009 max overhead = 25315), so
#    the guard would have allowed a file that silently zeroes every trial on the
#    longest-prompt task while passing on short-prompt ones. A guard whose
#    constant is guessed is the very defect it exists to prevent.
if grep -q '_longest_prompt' "$RUN_DG" && grep -q '32767 - _longest_prompt' "$RUN_DG"; then
  ok "ceiling is derived from the longest prompt in the run, not a fixed constant"
else
  bad "ceiling must be computed from the run's longest task prompt"
fi
if grep -q 'if \[ "$_longest_prompt" -eq 0 \]; then _longest_prompt=4443; fi' "$RUN_DG"; then
  ok "the 4443 fallback fires only when the dataset scan finds nothing"
else
  bad "the fallback must not apply unconditionally — that discards the derivation"
fi

# 3c. ⛔ NO BARE `[ cond ] && action` IN THE CEILING BLOCK.
#     run-dg.sh runs under `set -euo pipefail`, where a FALSE test makes the
#     whole line return 1 and kills the script — silently, with no message.
#     MEASURED: the first version used `[ "$_longest_prompt" -eq 0 ] &&
#     _longest_prompt=4443`, which fails whenever the scan DID find a prompt
#     (i.e. the normal case), aborting the run right after the brain
#     preflight. It passed my hand-check only because I tested it in a
#     `bash -c` WITHOUT set -e.
if grep -nE '^\s*\[ .*\] && _longest_prompt' "$RUN_DG" >/dev/null; then
  bad "ceiling block uses [ cond ] && action — fatal under set -e when the test is false"
else
  ok "ceiling block has no set -e short-circuit hazard"
fi

# 4. ⛔ THE LIVE CANARY, in RENDERED bytes against the FULL-SWEEP ceiling.
#
#    TWO UNIT ERRORS lived here. (a) This measured the SOURCE file while the
#    guard measures the RENDERED one — placeholders ({{PRIOR_ATTEMPTS}},
#    {{TASK_BUDGET}}, {{DEFERRAL_NOTE}}, {{THINKING_MODE_COST}}) expand ~700
#    bytes, observed 24797 -> 25496. (b) The overhead constant was itself
#    derived from source sizes, overstating it by ~1380. The two errors partly
#    cancelled, which is why neither looked wrong.
#
#    A full sweep is the binding case because it includes the longest-prompt
#    task; passing only because today is a short-prompt redo is the blind spot
#    that caused the original bug.
bytes="$(wc -c < "$INSTR" | tr -d '[:space:]')"
# Measured placeholder expansion, with headroom for a longer {{PRIOR_ATTEMPTS}}
# on a retry (observed 699 on a first-attempt render).
EXPANSION=900
rendered=$((bytes + EXPANSION))
longest=0
TD="${TB_TASKS_DIR:-D:/Git/terminal-bench-2-1/tasks}"
if [ -d "$TD" ]; then
  for f in "$TD"/*/instruction.md "$TD"/*/README.md; do
    [ -f "$f" ] || continue
    b="$(wc -c < "$f" | tr -d '[:space:]')"
    [ "${b:-0}" -gt "$longest" ] && longest="$b"
  done
fi
[ "$longest" -eq 0 ] && longest=4443
worst=$((32767 - longest - 1629 - 500))
if [ "$rendered" -le "$worst" ]; then
  ok "rendered ~${rendered} bytes (source ${bytes} + ${EXPANSION} expansion), $((worst - rendered)) under the FULL-SWEEP ceiling (${worst})"
else
  bad "rendered ~${rendered} bytes is $((rendered - worst)) OVER the full-sweep ceiling (${worst}) — a sweep would zero the longest-prompt task"
fi

# 4b. The guard and this test must agree on the overhead constant, or the
#     canary measures a different cliff from the one that actually fires.
if grep -q -- "- 1629 - 500" "$RUN_DG"; then
  ok "run-dg.sh uses the same 1629 overhead this test assumes"
else
  bad "overhead constant drifted between run-dg.sh and this test"
fi
# 5. Maintainer prose must not ride along. Every byte here is charged to the
#    command line; a design note is not something the agent is told.
#
#    ⛔ Counted with awk over a PIPE, deliberately. The first version shelled out
#    to `python -c` with the path interpolated -- but $HERE is a Git Bash POSIX
#    path (/d/Git/...) that Windows Python cannot open, so it raised
#    FileNotFoundError, `2>/dev/null || echo 0` swallowed it, and the check
#    reported 0 bytes and PASSED. Real answer at the time: 232. A test that
#    cannot fail is worse than no test, so there is no fallback value here: if
#    the counter breaks, comment_bytes is empty and the assertion below fails.
comment_bytes="$(awk '
  { line = $0 }
  { while ((i = index(line, "<!--")) > 0) {
      rest = substr(line, i)
      j = index(rest, "-->")
      if (j > 0) { n += j + 2; line = substr(rest, j + 3) }
      else { n += length(rest); inblk = 1; line = "" }
    }
    if (inblk) { k = index(line, "-->"); if (k > 0) { n += k + 2; inblk = 0 } else n += length(line) }
  }
  END { print n + 0 }
' "$INSTR")"
if [ -n "$comment_bytes" ] && [ "$comment_bytes" -le 600 ]; then
  ok "maintainer comments total ${comment_bytes} bytes (design note lives in extra-instruction.DESIGN.md)"
else
  bad "${comment_bytes} bytes of HTML comments ship to the container — move them to extra-instruction.DESIGN.md"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "instruction-size-ceiling: PASS (9/9)"
  exit 0
fi
echo "instruction-size-ceiling: FAIL ($fails failing)"
exit 1
