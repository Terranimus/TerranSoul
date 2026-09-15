#!/usr/bin/env bash
# The TerranSoul agent must never run with its enforcement silently switched off.
#
# ⛔ THE DEFECT THIS PINS. `run-dg.sh` reads `${TB_STOP_HOOK:-0}` — the Stop hook
# and the PreToolUse wall-clock guards are OPT-IN. `redo-task.sh:324` opts in
# (`${TB_STOP_HOOK:-1}`), so every launcher that goes through it is fine; a
# launcher that calls run-dg.sh directly is not, and nothing said so.
#
# MEASURED 2026-09-04 over the whole corpus, using the marker that actually
# records the decision (`config.json` -> agents[0].kwargs.config, written only
# inside the TB_STOP_HOOK block): 57 of 335 jobs registered the hooks, ALL of
# them redo*. Every job of the six-prefix k=1 campaign — 65 measured tasks —
# ran with enforcement OFF while carrying the `terransoul-hook` identity. The
# retrieval half was live (memories served, lessons authored); the verification
# half never ran. caffe-cifar-10 then burned 45 minutes in `sleep` with no
# wall-clock guard installed and died on AgentTimeoutError.
#
# `run-dg.sh:1276-1283` already refuses TB_STOP_HOOK=1 without the TerranSoul
# agent. The CONVERSE was missing, and it is the direction that actually bit:
# claiming the identity while disabling the enforcement is the incoherent
# combination, and it is silent.
#
# WHY IT REFUSES ONLY WHEN UNSET. An explicit `TB_STOP_HOOK=0` is a legitimate
# control arm — measuring TerranSoul's memory without its enforcement is a real
# experiment. An UNSET variable is an accident. `${VAR+x}` distinguishes them;
# `${VAR:-0}` cannot, which is why the defect was invisible.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: expected [$2] got [$3]"; fails=$((fails+1)); fi; }

RUN_DG="$HERE/run-dg.sh"

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
# ⛔ HERMETIC FIRST. Cases 2 and 3 run the REAL run-dg.sh with TB_STOP_HOOK=0 and no
# fake of any kind: with the bench brain up they get past the brain check to
# the container network probe (`docker run`) and the host-headroom `docker rm
# -f` before the empty task list stops them.
# hermetic-shims.sh puts logging shims for docker, netstat, ss and taskkill
# FIRST on PATH, and the guard ABORTS unless every one resolves inside this
# test's temp dir: on 2026-09-15 18:45 a real `docker rm -f` reached from
# two-workers.test.sh SIGKILLed two live trials of another sweep.
. "$HERE/hermetic-shims.sh" || { echo "ABORT: hermetic-shims.sh not found next to this test"; exit 2; }
hermetic_shims "$SANDBOX" || { echo "ABORT: could not create the hermetic shims"; exit 2; }
hermetic_guard "$SANDBOX" || exit 2

echo "== the converse guard exists and refuses an unset TB_STOP_HOOK =="
# A REAL task name, so the empty-task guard cannot fire instead and make this
# look like it passed. The enforcement guard must be early enough to refuse
# before any expensive setup — that is the point of putting it near the top.
#
# ⛔ The first version of this test grepped for "REFUSING" and passed on the
# pre-change tree, because run-dg.sh already refuses an empty task list. A test
# that matches ANY refusal cannot tell the guard under test from an unrelated
# one, which is the tautology shape this repo keeps paying for.
out="$(cd "$HERE" && TB_AGENT="terransoul_hook:TerranSoulHook" TB_TASKS="hello-world" bash "$RUN_DG" "" 2>&1 | head -40)"
echo "$out" | grep -q "enforcement is OFF" && refused=1 || refused=0
check "refuses when TB_AGENT is TerranSoul and TB_STOP_HOOK is unset" "1" "$refused"
echo "$out" | grep -qi "TB_STOP_HOOK" && named=1 || named=0
check "the refusal names TB_STOP_HOOK so it is actionable" "1" "$named"

echo "== an EXPLICIT opt-out is allowed — it is a real control arm =="
# TB_STOP_HOOK=0 set deliberately must NOT trip the new guard. It may still
# fail later for having no tasks; what matters is which message comes out.
out0="$(cd "$HERE" && TB_AGENT="terransoul_hook:TerranSoulHook" TB_STOP_HOOK=0 TB_TASKS="" bash "$RUN_DG" "" 2>&1 | head -40)"
echo "$out0" | grep -q "enforcement" && tripped=1 || tripped=0
check "an explicit TB_STOP_HOOK=0 does not trip the enforcement guard" "0" "$tripped"

echo "== the baseline agent is unaffected =="
outb="$(cd "$HERE" && TB_AGENT="claude-code" TB_TASKS="" bash "$RUN_DG" "" 2>&1 | head -40)"
echo "$outb" | grep -q "enforcement" && btripped=1 || btripped=0
check "a non-TerranSoul agent never trips it" "0" "$btripped"

echo "== the launcher opts in explicitly, rather than relying on a default =="
grep -q 'TB_STOP_HOOK=1' "$HERE/run-two-workers.sh" && optin=1 || optin=0
check "run-two-workers.sh sets TB_STOP_HOOK=1" "1" "$optin"

echo
echo "== the answer-key guard is REGISTERED, not just implemented =="
# ⛔ THE DEFECT SHAPE THIS PINS. `runPreToolHook` returns null for every
# tool_name that is not matched by the settings file, so a WebFetch guard that
# is implemented but registered only for `Bash` is never invoked. That is the
# same "gate that cannot fire" class as the enforcement default above: the code
# is present, the tests pass, and the guard is unreachable in a real trial.
SETTINGS="$HERE/claude-settings-verifyhook.json"
matcher="$(node --input-type=module -e "
  import { readFileSync } from 'node:fs'
  const d = JSON.parse(readFileSync(process.argv[1], 'utf8'))
  const pre = d.hooks.PreToolUse || []
  process.stdout.write(pre.map((h) => h.matcher || '').join(','))
" "$SETTINGS" 2>&1)"
case "$matcher" in
  *WebFetch*) check "PreToolUse matcher covers WebFetch" "yes" "yes" ;;
  *)          check "PreToolUse matcher covers WebFetch" "yes" "no (matcher=[$matcher])" ;;
esac
case "$matcher" in
  *Bash*) check "PreToolUse matcher still covers Bash" "yes" "yes" ;;
  *)      check "PreToolUse matcher still covers Bash" "yes" "no (matcher=[$matcher])" ;;
esac
echo

if [ "$fails" -eq 0 ]; then echo "enforcement-wiring.test.sh: ALL PASS"; else echo "enforcement-wiring.test.sh: $fails FAILURE(S)"; fi
exit "$fails"
