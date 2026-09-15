#!/usr/bin/env bash
# Tests for rate-limit-evidence.py -- the ONE judge of "is this failed trial a
# spent account" (run-two-workers.sh) and "when does it reset"
# (sweep-until-done.sh) -- and for merge-sweep.sh's disclosure of the k=2 that a
# requeued kill causes.
#
# ⛔ MEASURED 2026-09-15 18:45:47 (sweep ts09151819). pytorch-model-cli__2EgAX5d
# (16,125 output tokens) and winning-avg-corewars__KgGxXVD (11,402) were
# SIGKILLed in the same second. harbor labelled both `ApiRateLimitError:
# Command failed (exit 137)` because its first ERROR_PATTERN is `rate.?limit`
# over the whole stdout, and every stream-json transcript carries routine
# rate_limit_event records. run-two-workers.sh halted both workers as "QUOTA
# EXHAUSTED" on that label while the account's own last event said five_hour
# utilization 0.22, and sweep-until-done.sh then slept a blind 3600 s.
#
# FAILS ON THE PRE-CHANGE TREE: rate-limit-evidence.py did not exist, so every
# `python "$HELPER" ...` exits 2 ("can't open file") -- neither 0 nor 1 -- and
# every rc check below reads the wrong code; merge-sweep.sh had no REQUEUED
# section, so the disclosure checks find nothing. The BEHAVIOUR did not exist
# either: the only judge was `exc=='ApiRateLimitError'`, which calls every
# killed fixture below a quota.
#
# Fixture shapes are copied from the real trials on disk (field names, status
# strings, harbor's " ... [N chars truncated] ... " marker), trimmed to what
# the judge reads. Hermetic: no harbor, no docker, no brain.
set -uo pipefail
HERE_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$HERE_T/rate-limit-evidence.py"
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1
pass=0; fail=0
ok() { echo "  ok   $1"; pass=$((pass+1)); }
no() { echo "  FAIL $1 :: $2"; fail=$((fail+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "expected [$2] got [$3]"; fi; }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

# judge <cmd> <job-dir...> -> "rc|stdout"
judge() { local out rc; out="$(python "$HELPER" "$@" 2>/dev/null)"; rc=$?; printf '%s|%s' "$rc" "$out"; }
mkjob() { mkdir -p "$SANDBOX/$1/t__x/agent"; printf '%s' "$SANDBOX/$1"; }

EV_WARN_021='{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1789956000,"rateLimitType":"seven_day","utilization":0.67,"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.21,"resetsAt":1789476600},"seven_day":{"utilization":0.67,"resetsAt":1789956000}}},"session_id":"f7bc"}'
EV_WARN_022='{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1789956000,"rateLimitType":"seven_day","utilization":0.67,"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.22,"resetsAt":1789476600},"seven_day":{"utilization":0.67,"resetsAt":1789956000}}},"session_id":"f7bc"}'
# The 2026-09-15 02:35 real quota's last event, verbatim but for the ids.
EV_REJECTED_0915='{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1789404600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":1789404600},"seven_day":{"utilization":0.31,"resetsAt":1789956000}}},"session_id":"357d"}'
# The 2026-09-04 real quota's only event. Note seven_day resets EARLIER than
# five_hour here, so "the latest reset" and "the exhausted window" differ from
# "any window's reset".
EV_REJECTED_0904='{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788497400,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":1.04,"resetsAt":1788497400},"seven_day":{"utilization":0.73,"resetsAt":1788494400}}},"session_id":"f01e"}'
TOOL_OK='{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_014J","type":"tool_result","content":"CONTRACT FAILURES: NONE","is_error":false}]},"session_id":"f7bc"}'
TEXT_TURN='{"type":"assistant","message":{"model":"claude-opus-5","role":"assistant","content":[{"type":"text","text":"Running the contract check."}]},"session_id":"f7bc"}'

# ── 1. the 2026-09-15 18:45:47 kill ─────────────────────────────────────────
echo "== 1. an exit-137 kill with work and an allowed_warning event is NOT a quota =="
K="$(mkjob killed)"
cat > "$K/t__x/result.json" <<'JSON'
{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 137): export PATH=\"$HOME/.local/bin:$PATH\"; printf \"%s\" \"$i\" | claude --verbose --output-format=stream-json --settings /tmp/claude-code-settings/settings.json --permission-mode=bypassPermissions --print 2>&1 | tee /logs/agent/claude-code.txt\nstdout: {\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"/app\",\"session_id\":\"f7bc\"}\n{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed_warning\",\"resetsAt\":1789956000,\"rateLimitType\":\"seven_day\",\"utilization\":0.67,\"unifiedWindows\":{\"five_hour\":{\"utilization\":0.21,\"resetsAt\":1789476600},\"seven_day\":{\"utilization\":0.67,\"resetsAt\":1789956000}}}} ... [180492 chars truncated] ... l,\"session_id\":\"f7bc\",\"tool_use_result\":{\"stdout\":\"CONTRACT FAILURES: NONE\",\"stderr\":\"\"}}\n\nstderr: None","occurred_at":"2026-09-15T08:45:43Z"},"agent_result":{"n_input_tokens":899017,"n_cache_tokens":847490,"n_output_tokens":16125},"verifier_result":null}
JSON
printf '%s\n' '{"type":"system","subtype":"init","cwd":"/app"}' "$EV_WARN_021" "$TEXT_TURN" "$TOOL_OK" "$EV_WARN_022" "$TEXT_TURN" "$TOOL_OK" > "$K/t__x/agent/claude-code.txt"
check "the harbor label alone is not a quota" "1|" "$(judge quota "$K")"
check "it IS killed-with-work, with the work named" "0|t__x	16125 output tokens" "$(judge killed-with-work "$K")"
check "and it yields no reset epoch" "1|" "$(judge reset-epoch "$K")"

# ── 2. the 2026-09-04 real quota ────────────────────────────────────────────
echo "== 2. the 2026-09-04 shape (429 + session limit + zero tokens) IS a quota =="
Q4="$(mkjob quota0904)"
cat > "$Q4/t__x/result.json" <<'JSON'
{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 1): claude --verbose --output-format=stream-json --print 2>&1 | tee /logs/agent/claude-code.txt\nstdout: {\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"/app\"}\n{\"is_error\":true,\"num_turns\":1,\"subtype\":\"success\",\"api_error_status\":429,\"result\":\"You've hit your session limit - resets 4:50am (UTC)\",\"type\":\"result\",\"duration_ms\":525}\n\nstderr: None"},"agent_result":{"n_input_tokens":0,"n_cache_tokens":0,"n_output_tokens":0,"cost_usd":0.0}}
JSON
rmdir "$Q4/t__x/agent"
check "detected from the exception message with NO transcript on disk" "0|t__x	api_error_status 429 in exception_message" "$(judge quota "$Q4")"
check "never read as killed-with-work" "1|" "$(judge killed-with-work "$Q4")"
# The form the 2026-09-04 lesson recorded it in: plain lines, no JSON record.
Q4P="$(mkjob quota0904plain)"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"api_error_status: 429\nYou have hit your session limit - resets 4:50am (UTC)"},"agent_result":{"n_output_tokens":0}}' > "$Q4P/t__x/result.json"
check "the plain-line 429 form is a quota too" "0|t__x	api_error_status 429 in exception_message" "$(judge quota "$Q4P")"
Q4T="$(mkjob quota0904phrase)"
printf '%s' '{"exception_info":{"exception_type":"ApiUsageLimitError","exception_message":"Claude AI usage limit reached|1788497400"},"agent_result":{"n_output_tokens":0}}' > "$Q4T/t__x/result.json"
check "the CLI's limit wording alone is a quota, whatever harbor named it" \
  "0|t__x	CLI limit text 'usage limit' in exception_message" "$(judge quota "$Q4T")"
cp "$Q4/t__x/result.json" "$SANDBOX/q4.json"
Q4E="$(mkjob quota0904event)"
cp "$SANDBOX/q4.json" "$Q4E/t__x/result.json"
printf '%s\n' '{"type":"system","subtype":"init"}' "$EV_REJECTED_0904" > "$Q4E/t__x/agent/claude-code.txt"
check "its reset is the EXHAUSTED five_hour window's, not seven_day's earlier one" \
  "0|1788497400	t__x	five_hour" "$(judge reset-epoch "$Q4E")"

# ── 3. the 2026-09-15 02:35 real quota: tokens were NOT zero ────────────────
echo "== 3. a real quota with 673 output tokens is still a quota =="
Q15="$(mkjob quota0915)"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 1): claude --print\nstdout: {\"type\":\"system\",\"subtype\":\"init\"} ... [55000 chars truncated] ... \"is_error\":true,\"num_turns\":6,\"subtype\":\"success\",\"api_error_status\":429,\"result\":\"You'"'"'ve hit your session limit · resets 4:50pm (UTC)\",\"type\":\"result\"}\n\nstderr: None"},"agent_result":{"n_input_tokens":59416,"n_output_tokens":673}}' > "$Q15/t__x/result.json"
printf '%s\n' '{"type":"system","subtype":"init"}' "$EV_WARN_022" "$TEXT_TURN" "$EV_REJECTED_0915" > "$Q15/t__x/agent/claude-code.txt"
check "429 in a truncated result-record fragment counts" "0|t__x	api_error_status 429 in exception_message" "$(judge quota "$Q15")"
check "the structured reset is the rejected event's five_hour epoch" "0|1789404600	t__x	five_hour" "$(judge reset-epoch "$Q15")"

# ── 4. structured evidence ALONE ────────────────────────────────────────────
echo "== 4. a last rate_limit_event with an exhausted window IS a quota =="
S="$(mkjob structured)"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 137): claude --print"},"agent_result":{"n_output_tokens":16125}}' > "$S/t__x/result.json"
printf '%s\n' "$EV_WARN_021" "$TEXT_TURN" "$EV_REJECTED_0915" "$TOOL_OK" > "$S/t__x/agent/claude-code.txt"
check "no 429, no phrase -- the rejected event decides" \
  "0|t__x	last rate_limit_event: five_hour window at utilization 1" "$(judge quota "$S")"
check "a killed trial WITH quota evidence is not requeued as a kill" "1|" "$(judge killed-with-work "$S")"
U="$(mkjob utilization)"
cp "$S/t__x/result.json" "$U/t__x/result.json"
printf '%s\n' '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1789956000,"rateLimitType":"seven_day","utilization":1.0,"unifiedWindows":{"five_hour":{"utilization":0.5,"resetsAt":1789476600},"seven_day":{"utilization":1.0,"resetsAt":1789956000}}}}' > "$U/t__x/agent/claude-code.txt"
check "a window at utilization >= 1.0 is a quota even under allowed_warning" \
  "0|t__x	last rate_limit_event: seven_day window at utilization 1" "$(judge quota "$U")"
BOTH="$(mkjob bothspent)"
cp "$S/t__x/result.json" "$BOTH/t__x/result.json"
printf '%s\n' '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1789404600,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":1.0,"resetsAt":1789404600},"seven_day":{"utilization":1.02,"resetsAt":1789956000}}}}' > "$BOTH/t__x/agent/claude-code.txt"
check "two spent windows reset at the LATER one (nothing is served before both clear)" \
  "0|1789956000	t__x	seven_day" "$(judge reset-epoch "$BOTH")"

# ── 5. the LAST event wins ──────────────────────────────────────────────────
echo "== 5. only the LAST rate_limit_event counts =="
L1="$(mkjob cleared)"
cp "$S/t__x/result.json" "$L1/t__x/result.json"
printf '%s\n' "$EV_REJECTED_0915" "$TEXT_TURN" '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789422600,"rateLimitType":"five_hour","utilization":0.02,"unifiedWindows":{"five_hour":{"utilization":0.02,"resetsAt":1789422600}}}}' "$TOOL_OK" > "$L1/t__x/agent/claude-code.txt"
check "a rejection the account has since cleared is not a quota" "1|" "$(judge quota "$L1")"

# ── 6. text the CLI did not write ───────────────────────────────────────────
echo "== 6. limit wording inside TOOL output or model text is not evidence =="
C="$(mkjob contaminated)"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 137): claude --print\nstdout: {\"type\":\"system\",\"subtype\":\"init\"} ... [9000 chars truncated] ... \"tool_use_id\":\"toolu_9\",\"type\":\"tool_result\",\"content\":\"429 usage limit reached; api_error_status: 429\"}]}}\n\nstderr: None"},"agent_result":{"n_output_tokens":8100}}' > "$C/t__x/result.json"
printf '%s\n' "$EV_WARN_022" \
  '{"type":"assistant","message":{"model":"claude-opus-5","role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"grep -rn \"hit your session limit\" /app/server.py"}}]}}' \
  '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_9","type":"tool_result","content":"server.py:12: raise Quota(\"You have hit your session limit\")  # rate limit reached, api_error_status: 429"}]}}' \
  '{"type":"assistant","message":{"model":"claude-opus-5","role":"assistant","content":[{"type":"text","text":"The server answers rate limit reached once the session limit is hit."}]}}' \
  > "$C/t__x/agent/claude-code.txt"
check "a task that prints rate-limit text is not a quota" "1|" "$(judge quota "$C")"
check "and its kill is still recognised" "0|t__x	8100 output tokens" "$(judge killed-with-work "$C")"
SYN="$(mkjob synthetic)"
cp "$C/t__x/result.json" "$SYN/t__x/result.json"
sed -i 's/429 usage limit reached; api_error_status: 429/done/' "$SYN/t__x/result.json"
printf '%s\n' "$EV_WARN_022" '{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"You have hit your session limit"}]},"isApiErrorMessage":true}' > "$SYN/t__x/agent/claude-code.txt"
check "the CLI's own synthetic API-error message IS evidence" \
  "0|t__x	CLI limit text 'hit your session limit' in claude-code.txt tail" "$(judge quota "$SYN")"

# ── 7. the event far from the tail ──────────────────────────────────────────
echo "== 7. the last event is found BACKWARDS through a multi-megabyte transcript =="
# The CLI emits an event when a threshold is crossed, not per request: the
# killed pytorch trial's last one is line 88 of ~150. So the event sits before
# a 1.3 MiB single line (longer than one read chunk) and ~2.4 MiB of tool
# traffic, and neither a tail read nor a line split at a chunk edge may miss it.
BIG="$(mkjob bigtranscript)"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 137): claude --print"},"agent_result":{"n_output_tokens":42000}}' > "$BIG/t__x/result.json"
{
  printf '%s\n' '{"type":"system","subtype":"init"}' "$EV_REJECTED_0915"
  printf '%s' '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t","type":"tool_result","content":"'
  head -c 1400000 /dev/zero | tr '\0' 'x'
  printf '%s\n' '"}]}}'
  yes "$TOOL_OK" | head -n 20000
} > "$BIG/t__x/agent/claude-code.txt"
size="$(wc -c < "$BIG/t__x/agent/claude-code.txt" | tr -d ' ')"
if [ "$size" -gt 3000000 ]; then ok "the fixture really is larger than the tail window and several chunks ($size bytes)"
else no "the fixture really is larger than the tail window and several chunks" "$size bytes"; fi
check "the rejected event near the START is found" \
  "0|t__x	last rate_limit_event: five_hour window at utilization 1" "$(judge quota "$BIG")"
check "and its epoch is the reset" "0|1789404600	t__x	five_hour" "$(judge reset-epoch "$BIG")"

# ── 8. what counts as a kill, and as work ───────────────────────────────────
echo "== 8. killed-with-work needs exit 137, the label, and work =="
W1="$(mkjob turnsonly)"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 137): claude --print"},"agent_result":{"n_output_tokens":0}}' > "$W1/t__x/result.json"
printf '%s' '[{"return_code":137,"assistant_turns":21,"stdout_chars":158038}]' > "$W1/t__x/agent/.terransoul-exec-failure.json"
check "zero tokens but model turns in the host capture is work" "0|t__x	21 model turn(s) in the host-side capture" "$(judge killed-with-work "$W1")"
W2="$(mkjob nowork)"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 137): claude --print"},"agent_result":{"n_output_tokens":0}}' > "$W2/t__x/result.json"
check "a kill before any work is job_was_infra_failure's case, not this one" "1|" "$(judge killed-with-work "$W2")"
W3="$(mkjob trajectory)"
cp "$W2/t__x/result.json" "$W3/t__x/result.json"
printf '%s' '{"steps":[{"source":"user"},{"source":"agent"},{"source":"agent"},{"source":"agent"}]}' > "$W3/t__x/agent/trajectory.json"
check "agent steps in trajectory.json are work" "0|t__x	3 agent step(s) in trajectory.json" "$(judge killed-with-work "$W3")"
W4="$(mkjob exit1)"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 1): claude --print"},"agent_result":{"n_output_tokens":9000}}' > "$W4/t__x/result.json"
check "an exit-1 failure with work is not a KILL" "1|" "$(judge killed-with-work "$W4")"
W5="$(mkjob sidecar137)"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"agent command failed"},"agent_result":{"n_output_tokens":500}}' > "$W5/t__x/result.json"
printf '%s' '[{"return_code":137,"assistant_turns":4}]' > "$W5/t__x/agent/.terransoul-exec-failure.json"
check "exit 137 recorded only by the host-side capture still counts" "0|t__x	500 output tokens" "$(judge killed-with-work "$W5")"
W6="$(mkjob nonlabel)"
printf '%s' '{"exception_info":{"exception_type":"NonZeroAgentExitCodeError","exception_message":"Command failed (exit 137): claude --print"},"agent_result":{"n_output_tokens":500}}' > "$W6/t__x/result.json"
check "the branch is scoped to the ApiRateLimitError mislabel" "1|" "$(judge killed-with-work "$W6")"

# ── 9. a broken judge must not read as "no" ─────────────────────────────────
echo "== 9. an internal error exits 3, never 1 =="
# Python's own uncaught-exception exit code is 1, which a caller would read as
# "not a quota" and bank a spent session. run-two-workers.sh falls back to the
# conservative label on anything but 0/1.
E1="$(mkjob broken)"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":5},"agent_result":{"n_output_tokens":1}}' > "$E1/t__x/result.json"
check "quota on an unexpected shape exits 3" "3" "$(judge quota "$E1" | cut -d'|' -f1)"
E2="$(mkjob broken2)"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 137): x"},"agent_result":"garbage"}' > "$E2/t__x/result.json"
check "killed-with-work on an unexpected shape exits 3" "3" "$(judge killed-with-work "$E2" | cut -d'|' -f1)"
check "a trial without an exception is never a quota" "1|" "$(judge quota "$(mkjob clean)")"

# ── 10. reset-epoch reads the TRIPPING trial, newest first ──────────────────
echo "== 10. reset-epoch skips a killed sibling and reads the trial that tripped =="
check "the killed sibling (listed first) is skipped for the tripping trial" \
  "0|1789404600	t__x	five_hour" "$(judge reset-epoch "$K" "$Q15")"
check "no tripping trial at all yields nothing" "1|" "$(judge reset-epoch "$K" "$C")"

# ── 11. merge-sweep.sh discloses the k=2 a requeue causes ───────────────────
echo "== 11. merge-sweep.sh lists requeued tasks with their k =="
# FAILS ON THE PRE-CHANGE TREE: no reader of <prefix>.requeued existed, so the
# REQUEUED section below is absent and a k=2 task sat silently in a k=1 number.
JOBS="$SANDBOX/mjobs"
mkdir -p "$JOBS/zz09w0-20260915-184013/kill-me__a/agent" "$JOBS/zz09w0-20260915-200000/kill-me__b" \
         "$JOBS/zz09w0-20260915-190000/other__c"
printf '%s' '{"stats":{"n_completed_trials":1,"evals":{"terransoul-hook__claude-opus-5__tasks":{"n_trials":1,"exception_stats":{"ApiRateLimitError":["kill-me__a"]},"reward_stats":{"reward":{}}}}}}' \
  > "$JOBS/zz09w0-20260915-184013/result.json"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 137): claude"},"agent_result":{"n_output_tokens":16125}}' \
  > "$JOBS/zz09w0-20260915-184013/kill-me__a/result.json"
printf '%s' '{"stats":{"n_completed_trials":1,"evals":{"terransoul-hook__claude-opus-5__tasks":{"n_trials":1,"exception_stats":{},"reward_stats":{"reward":{"1.0":["kill-me__b"]}}}}}}' \
  > "$JOBS/zz09w0-20260915-200000/result.json"
printf '%s' '{"stats":{"n_completed_trials":1,"evals":{"terransoul-hook__claude-opus-5__tasks":{"n_trials":1,"exception_stats":{},"reward_stats":{"reward":{"1.0":["other__c"]}}}}}}' \
  > "$JOBS/zz09w0-20260915-190000/result.json"
printf 'kill-me\tkill-me__a\tzz09w0-20260915-184013\t16125 output tokens\n' > "$JOBS/zz09w0.requeued"
MOUT="$(TB_LAUNCH_REF="$SANDBOX/no-launch-file" TB_TASKS_EXPECTED=2 TB_QUARANTINE_FILE="$SANDBOX/no-quarantine" \
        bash "$HERE_T/merge-sweep.sh" "$JOBS" zz09w0 2>&1)"
case "$MOUT" in
  *"REQUEUED after an external kill (exit 137, no quota evidence): 1 task(s) -- UNEQUAL k, DISCLOSE"*)
    ok "the requeue section is printed" ;;
  *) no "the requeue section is printed" "$(printf '%s' "$MOUT" | tail -25)" ;;
esac
case "$MOUT" in
  *"kill-me: k=2 on disk -- killed trial kill-me__a (zz09w0-20260915-184013; 16125 output tokens) scores 0"*)
    ok "the task is named with its real k, its killed trial and its evidence" ;;
  *) no "the task is named with its real k, its killed trial and its evidence" "$(printf '%s' "$MOUT" | grep -A3 REQUEUED)" ;;
esac
case "$MOUT" in
  *"other: k="*) no "an unrequeued task is not listed" "$(printf '%s' "$MOUT" | grep 'other: k=')" ;;
  *) ok "an unrequeued task is not listed" ;;
esac
# And silent when nothing was requeued, so a clean sweep's report is unchanged.
rm -f "$JOBS/zz09w0.requeued"
MOUT2="$(TB_LAUNCH_REF="$SANDBOX/no-launch-file" TB_TASKS_EXPECTED=2 TB_QUARANTINE_FILE="$SANDBOX/no-quarantine" \
         bash "$HERE_T/merge-sweep.sh" "$JOBS" zz09w0 2>&1)"
check "no ledger, no section" "0" "$(printf '%s' "$MOUT2" | grep -c 'REQUEUED after an external kill')"

# ── 12. only the API-error system subtype is the CLI's verdict ──────────────
echo "== 12. a system record echoing limit text is evidence only for api_retry =="
# MEASURED 2026-09-15 over all 1,230 agent/claude-code.txt transcripts under
# jobs/: 142,056 system records in 12 subtypes (thinking_tokens 128,091,
# task_started 5,078, task_notification 5,060, background_tasks_changed 1,346,
# init 1,231, task_updated 771, notification 287, vcs_state_changed 79,
# model_refusal_fallback 45, api_retry 45, task_progress 22, permission_denied
# 1) and ZERO with limit or 429 wording; the 11 real quotas are all carried by
# result + synthetic assistant records. The judge accepted ANY non-init system
# record, so a hook_response echoing a stored lesson read as a spent account.
# FAILS ON af23a5a4: the hook case answers quota (0|...) and so is never
# killed-with-work (1|); the truncated task_notification fragment answers quota.
HK="$(mkjob hookecho)"
cp "$K/t__x/result.json" "$HK/t__x/result.json"
printf '%s\n' '{"type":"system","subtype":"init","cwd":"/app"}' "$EV_WARN_022" "$TEXT_TURN" \
  '{"type":"system","subtype":"hook_response","hook_name":"SessionStart:startup","exit_code":0,"output":"[terransoul] lesson 26660: when you have hit your session limit, stop -- api_error_status: 429 means the account is spent"}' \
  "$TOOL_OK" > "$HK/t__x/agent/claude-code.txt"
check "a hook_response carrying limit and 429 text is not a quota" "1|" "$(judge quota "$HK")"
check "... so the 18:45 kill under it is still killed-with-work" "0|t__x	16125 output tokens" "$(judge killed-with-work "$HK")"
HF="$(mkjob hookfragment)"
printf '%s' '{"exception_info":{"exception_type":"ApiRateLimitError","exception_message":"Command failed (exit 137): claude --print\nstdout: {\"type\":\"system\",\"subtype\":\"init\"} ... [9000 chars truncated] ... {\"type\":\"system\",\"subtype\":\"task_notification\",\"summary\":\"background job: You have hit your session limit - resets 4:50pm (UTC)\n\nstderr: None"},"agent_result":{"n_output_tokens":8100}}' > "$HF/t__x/result.json"
printf '%s\n' "$EV_WARN_022" > "$HF/t__x/agent/claude-code.txt"
check "a TRUNCATED non-API system record in the exception message is not a quota" "1|" "$(judge quota "$HF")"
check "... and its kill is still recognised" "0|t__x	8100 output tokens" "$(judge killed-with-work "$HF")"
# A GUARD (af23a5a4 answers the same): the one subtype whose fields ARE the
# API's error still counts. Killed by emptying CLI_API_ERROR_SUBTYPES.
AR="$(mkjob apiretry)"
cp "$K/t__x/result.json" "$AR/t__x/result.json"
printf '%s\n' "$EV_WARN_022" '{"type":"system","subtype":"api_retry","attempt":3,"max_retries":10,"retry_delay_ms":60000,"error_status":429,"error":"rate_limit_error: usage limit reached"}' > "$AR/t__x/agent/claude-code.txt"
check "an api_retry record carrying the CLI's limit wording IS a quota" \
  "0|t__x	CLI limit text 'usage limit' in claude-code.txt tail" "$(judge quota "$AR")"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
