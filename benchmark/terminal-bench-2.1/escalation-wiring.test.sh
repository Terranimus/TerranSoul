#!/usr/bin/env bash
# TBENCH-UNSOURCED-ESCALATION-1 must reach the container, and must stay OFF
# unless a run explicitly asks for it.
#
# ⛔ WHY THE FORWARDING IS THE WHOLE TEST. The Stop hook runs INSIDE the
# container as a bare `terransoul stop-hook` (claude-settings-verifyhook.json),
# so it sees only the container's environment. A host-side `TB_ESCALATE_UNSOURCED=1`
# that is not forwarded with `--ae` reads as unset inside the hook, which makes
# the hook inert while the launcher looks instrumented. That is the exact shape
# of the defect enforcement-wiring.test.sh exists for: a 66-task campaign ran
# with the TerranSoul identity wired and the gate silently off.
#
# ⛔ AND WHY DEFAULT-OFF IS PINNED. Measured over 94 graded trials, 88 of 90
# passes and ALL FIVE failures made zero external lookups, so this intervention
# fires on ~98% of trials. It is not a discriminating gate: switching it on
# perturbs 85 passing tasks to reach 4 failing ones, against a 95.5%
# never-regress floor. `default_is_off` is what keeps an experiment from
# silently becoming the default.
#
# Static, because the thing under test IS the text of the launcher: run-dg.sh
# cannot be executed to this point without a brain, a proxy and Docker.
#
# FAILS ON THE PRE-CHANGE TREE: run-dg.sh had no TB_ESCALATE_UNSOURCED wiring at
# all, so `flag_is_forwarded_to_the_container` and `forwarding_is_conditional`
# both fail.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNDG="$HERE/run-dg.sh"
fails=0
ok() { echo "  ok   $1"; }
no() { echo "  FAIL $1 :: $2"; fails=$((fails+1)); }

echo "unsourced-escalation wiring"

# ── 1. the flag is forwarded into the container ──────────────────────────────
if grep -q -- '--ae "TB_ESCALATE_UNSOURCED=1"' "$RUNDG"; then
  ok "flag_is_forwarded_to_the_container"
else
  no "flag_is_forwarded_to_the_container" "no --ae forwarding; the hook would read it as unset and stay inert"
fi

# ── 2. the forwarding is CONDITIONAL, not unconditional ──────────────────────
# An unconditional `--ae` would make the experiment the default, which is the
# regression risk this whole design is arranged around.
if grep -q 'if \[ "${TB_ESCALATE_UNSOURCED:-0}" = "1" \]; then' "$RUNDG"; then
  ok "forwarding_is_conditional"
else
  no "forwarding_is_conditional" "the --ae line is not guarded by an explicit opt-in test"
fi

# ── 3. the default is OFF ────────────────────────────────────────────────────
if grep -q 'TB_ESCALATE_UNSOURCED:-0' "$RUNDG"; then
  ok "default_is_off"
else
  no "default_is_off" "default is not 0 — an experiment must not ship as the default"
fi

# ── 4. the run log says which arm it is ──────────────────────────────────────
# A run whose artifacts cannot say whether the arm was on is not measurable.
if grep -q 'TBENCH-UNSOURCED-ESCALATION-1 is ON' "$RUNDG"; then
  ok "arm_is_disclosed_in_the_run_log"
else
  no "arm_is_disclosed_in_the_run_log" "nothing records which arm ran"
fi

# ── 5. the hook reads the SAME name the launcher forwards ────────────────────
# The two halves live in different languages and different repos-within-a-repo;
# a rename on one side is silent on the other.
HOOK="$HERE/../../packages/terransoul-cli/src/stop-hook.mjs"
if grep -q "env.TB_ESCALATE_UNSOURCED === '1'" "$HOOK"; then
  ok "hook_reads_the_same_env_name"
else
  no "hook_reads_the_same_env_name" "stop-hook.mjs does not read TB_ESCALATE_UNSOURCED"
fi

# ── 6. the hook keeps its own block budget ───────────────────────────────────
# A ledger block once spent the single stop-block allowance and the judge was
# never consulted (0 verdicts across 4 sessions). A third kind sharing that
# budget would rebuild that defect.
if grep -q "byKind.sourcing === 0" "$HOOK"; then
  ok "escalation_has_its_own_budget"
else
  no "escalation_has_its_own_budget" "the escalation does not gate on its own block kind"
fi

# ── 7. EVERY Stop-hook env the container needs is forwarded ──────────────
#
# THE SAME DEFECT, TWICE MORE. `stop-hook.mjs` reads TB_JUDGE_ANCHOR and
# TB_UNSEEN_INSTANCE inside the container as KILL SWITCHES (both ON unless set
# to 0). Neither was in the --ae list, so a host-side `TB_JUDGE_ANCHOR=0`
# control arm never reached the hook: the check stayed on and the run would
# have been labelled as the arm it was not. A forwarding gap is invisible in
# every artifact a sweep produces, which is why it is pinned in the launcher
# text rather than left to a reader's memory.
#
# FAILS ON THE PRE-CHANGE TREE: neither name appeared anywhere in run-dg.sh.
for _v in TB_JUDGE_ANCHOR TB_UNSEEN_INSTANCE; do
  if grep -q -- "--ae \"$_v=\$$_v\"" "$RUNDG"; then
    ok "${_v}_is_forwarded_to_the_container"
  else
    no "${_v}_is_forwarded_to_the_container" "the hook reads $_v inside the container and would see it unset"
  fi
  # Forwarded ONLY when set, so the default arm stays byte-identical.
  if grep -q -- "\[ -n \"\${$_v:-}\" \]" "$RUNDG"; then
    ok "${_v}_forwarding_is_conditional"
  else
    no "${_v}_forwarding_is_conditional" "the --ae line is unconditional; the experiment would become the default"
  fi
  if grep -q "env.$_v" "$HOOK"; then
    ok "${_v}_is_the_name_the_hook_reads"
  else
    no "${_v}_is_the_name_the_hook_reads" "stop-hook.mjs does not read $_v"
  fi
done

# ── 8. THE ONLINE REFUTATION WATCH'S OWN KILL SWITCH ─────────────────────
#
# ⛔ THE SAME SHAPE A THIRD TIME, AND THIS ONE GUARDS A WRITE. TB_REFUTE_WATCH
# is the only path by which the watch ever runs in a sweep, and the flag it
# turns into (`--refute-watch`) is read by credit-trial-outcome.mjs as a literal
# string. A rename on either side is SILENT: a watch that never fires and a
# watch that was never invoked produce byte-identical artifacts. That is
# project_enforcement_was_opt_in_and_silently_off exactly — TB_STOP_HOOK
# defaulted to 0 through a 66-task campaign with the identity wired.
#
# The observe state is pinned too: it is the arm that lets a sweep measure the
# detector without making its own trials non-independent.
CREDIT="$HERE/credit-trial-outcome.mjs"

if grep -q 'TB_REFUTE_WATCH:-1' "$RUNDG"; then
  ok "refute_watch_is_gated_by_TB_REFUTE_WATCH"
else
  no "refute_watch_is_gated_by_TB_REFUTE_WATCH" "the credit loop does not read TB_REFUTE_WATCH; the watch cannot be turned off"
fi

if grep -q -- '_refute_flag="--refute-watch"' "$RUNDG"; then
  ok "refute_watch_flag_is_forwarded_to_the_credit_step"
else
  no "refute_watch_flag_is_forwarded_to_the_credit_step" "run-dg.sh never passes --refute-watch; the watch would never run"
fi

if grep -q -- "rest.includes('--refute-watch')" "$CREDIT"; then
  ok "refute_watch_is_the_name_the_credit_step_reads"
else
  no "refute_watch_is_the_name_the_credit_step_reads" "credit-trial-outcome.mjs does not read --refute-watch"
fi

if grep -q -- 'observe) _refute_flag="--refute-watch --refute-observe"' "$RUNDG"; then
  ok "observe_only_arm_is_reachable_from_a_sweep"
else
  no "observe_only_arm_is_reachable_from_a_sweep" "TB_REFUTE_WATCH=observe does not reach the credit step"
fi

if grep -q -- "rest.includes('--refute-observe')" "$CREDIT"; then
  ok "observe_only_is_the_name_the_credit_step_reads"
else
  no "observe_only_is_the_name_the_credit_step_reads" "credit-trial-outcome.mjs does not read --refute-observe"
fi

# ⛔ THE WATCH ACTS ON THE BRAIN MID-SWEEP, so the sweep's own log must say the
# trials are not independent. A caveat that lives only in a design document is
# not available to whoever reads the artifacts.
if grep -q 'ONLINE REFUTATION WATCH is ON' "$RUNDG" && grep -q 'NOT independent' "$RUNDG"; then
  ok "non_independence_is_disclosed_in_the_run_log"
else
  no "non_independence_is_disclosed_in_the_run_log" "nothing in the launcher discloses that a watched sweep's trials are not independent"
fi

echo
if [ "$fails" -eq 0 ]; then echo "  all checks passed"; else echo "  $fails failed"; fi
[ "$fails" -eq 0 ]
