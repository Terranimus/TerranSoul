#!/usr/bin/env bash
# Refresh CLAUDE_CODE_OAUTH_TOKEN from the host's live Claude Code credentials,
# into a token file every bench entry point shares.
#
#   usage: source token-refresh.sh; refresh_token
#          (needs $REPO in scope; honours $TB_TOKEN_FILE, default
#           $REPO/mcp-data/.tb-token.env, and $TB_TOKEN_STATIC=1)
#
# WHY THIS IS ITS OWN FILE, not copy-pasted into every driver. Until
# 2026-08-12 this exact function lived independently inside run-sweep.next.sh
# AND run-sweep.par.sh — two copies to keep in sync — and `redo-task.sh` /
# `iterate.sh` / `iterate-until-change.sh` had NO refresh logic AT ALL: they
# only read whatever `run-dg.sh` found in $TB_TOKEN_FILE, with no verification
# and no refresh. Measured the same day: `.tb-token.env` was 2 days 8 hours
# stale, and three consecutive single-task redo attempts (dna-insert) all died
# on "401 OAuth access token has been revoked" with 0 completion tokens —
# an entirely avoidable, already-solved problem that simply wasn't wired into
# the single-task path. Every entry point now sources this ONE file.
set -uo pipefail

# Minutes of life left on the host credential, or the literal "unreadable".
_token_mins_left() {
  node -e '
const fs=require("fs"),os=require("os"),path=require("path");
try{
  const o=JSON.parse(fs.readFileSync(path.join(os.homedir(),".claude",".credentials.json"),"utf8")).claudeAiOauth;
  if(!o||!o.expiresAt) throw new Error("incomplete");
  console.log(((o.expiresAt-Date.now())/60000).toFixed(1));
}catch(e){ console.log("unreadable"); }
' 2>/dev/null || echo unreadable
}

# ── TBENCH-TOKEN-CEILING-1: the headroom gate must cover the TRIAL, not a
#    constant ────────────────────────────────────────────────────────────────
#
# ⛔ MEASURED 2026-09-13 on sam-cell-seg, whose ceiling is 7200 s = 120 min.
# The launch gate was a flat 40 minutes, so `[token-refresh] refreshed, 47 min
# of headroom` ADMITTED the run at 07:34 — and the credential died at ~08:16,
# 42 minutes in, after the agent had produced 98 model turns and a 430-line
# transcript. harbor then retried by name twice and the transcript came back 5
# lines long (terransoul_hook.py, TBENCH-LATE-API-RETRY-2). The task's observed
# durations across this campaign are 60-95 minutes, so a 40-minute gate could
# not have covered it under ANY circumstances: 40 was a number for a 900 s
# task, and 48 of the 89 tasks here are 900 s, which is why it went unnoticed.
#
# THE REQUIREMENT IS THE TASK'S OWN CEILING. The driver that knows it exports
# `TB_TRIAL_CEILING_S` (run-dg.sh, from the same `[agent] timeout_sec` it hands
# the agent as its wall-clock budget), and the gate becomes
# max(40, ceiling_minutes + 30). The 30 minutes cover what the ceiling does
# not: the environment build, the ~300 s agent install, verification, and the
# fact that a token accepted at this gate is already older by the time the
# container reaches its first API call.
#
# TB_TOKEN_MIN_MINUTES still overrides all of it, explicitly.
_token_min_minutes() {
  local floor=40 ceiling want
  ceiling="${TB_TRIAL_CEILING_S:-}"
  ceiling="${ceiling%%.*}"                   # a ceiling of `7200.0` is still 7200
  case "$ceiling" in ''|*[!0-9]*) ceiling="" ;; esac
  if [ -n "$ceiling" ] && [ "$ceiling" -gt 0 ]; then
    want=$(( ceiling / 60 + 30 ))
    [ "$want" -gt "$floor" ] && floor="$want"
  fi
  printf '%s' "$floor"
}

# THE LADDER MUST BE ABLE TO REACH THE GATE IT ENFORCES.
# The one long wait in `refresh_token` is "wait for a LIVE token to reach
# expiry, then poke" — the host CLI rotates on expiry and nothing else — and
# that wait is the token's own remaining life, which is below the gate exactly
# when the gate refuses it. A flat 3000 s covered the old 40-minute gate
# (40*60+45 = 2445 s) and silently CANNOT cover a 150-minute one: every token
# between ~50 and 150 minutes would neither pass nor wait, and the ladder would
# spend six 30 s attempts and give up. So the default scales with the gate.
# Still bounded: at most one long wait, after which the rotated token holds
# ~473 min (measured 2026-08-07) and passes.
_token_wait_max_s() {
  local gate floor
  gate="${TB_TOKEN_MIN_MINUTES:-$(_token_min_minutes)}"
  floor=$(( gate * 60 + 120 ))
  [ "$floor" -lt 3000 ] && floor=3000
  printf '%s' "$floor"
}

# ⛔ THE ROTATION IS LAZY AND CLI-TRIGGERED. THE CALLER MUST CAUSE IT.
#
# The host CLI does NOT refresh ~/.claude/.credentials.json on a timer. It
# refreshes when it is INVOKED and finds the token it holds has expired.
# Measured 2026-08-07 on this host, decisively:
#
#   at T-19min : `claude -p` succeeded, file mtime UNCHANGED, still 18 min left
#   at T+90s   : `claude -p` succeeded, file mtime CHANGED, 473 min left
#
# So waiting for a rotation nothing is triggering never resolves. A caller
# that merely sleeps is waiting for something only a poke produces.
_poke_host_cli() {
  # Cheapest possible call: it exists to make the CLI notice an expired token
  # and exchange its refresh token, not to produce output.
  timeout 120 claude -p "ok" >/dev/null 2>&1 || true
}

# Exit 1 = below the headroom gate (a human must re-authenticate if poking and
#          waiting don't clear it — retrying is pointless past that).
# Exit 2 = TRANSIENT (unreadable or half-written file; retrying is the fix).
_refresh_token_once() {
  local token_file="${TB_TOKEN_FILE:-$REPO/mcp-data/.tb-token.env}"
  # DERIVED FROM THE TRIAL CEILING, not a constant — see TBENCH-TOKEN-CEILING-1.
  local min_minutes="${TB_TOKEN_MIN_MINUTES:-$(_token_min_minutes)}"
  # A LONG-LIVED TOKEN OPTS OUT OF REFRESHING. `claude setup-token` mints a
  # token that lasts ~a year, which is what a bench actually wants: the
  # 7-hour OAuth access token forces a stop every few hours, and on 2026-08-07
  # the host CLI stopped rotating it at all — `claude -p` kept working while
  # ~/.claude/.credentials.json sat unchanged for hours, so a caller trusting
  # only that file starved on a file nothing was updating.
  #
  # With TB_TOKEN_STATIC=1 the caller trusts $token_file and never overwrites
  # it from .credentials.json. Without this guard the refresh CLOBBERS the
  # long-lived token with a short-lived one on the very next cycle.
  if [ "${TB_TOKEN_STATIC:-0}" = "1" ]; then
    if [ -s "$token_file" ]; then return 0; fi
    echo "[token-refresh] TB_TOKEN_STATIC=1 but $token_file is empty — refusing to guess" >&2
    return 1
  fi
  node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const p=path.join(os.homedir(),".claude",".credentials.json");
let o;
try{
  o=JSON.parse(fs.readFileSync(p,"utf8")).claudeAiOauth;
  if(!o||!o.accessToken||!o.expiresAt) throw new Error("credentials present but incomplete");
}catch(e){
  console.error("[token-refresh] credentials unreadable ("+e.message+") — transient, will retry");
  process.exit(2);
}
const mins=(o.expiresAt-Date.now())/60000;
if(mins<Number(process.argv[2])){
  console.error("[token-refresh] token has "+mins.toFixed(0)+" min left — below the "+process.argv[2]+"-min gate");
  process.exit(1);
}
// Write via a temp file + rename so a reader can never observe a
// half-written token — the same failure this function just suffered, one
// layer down.
const tmp=process.argv[1]+".tmp";
fs.writeFileSync(tmp,"CLAUDE_CODE_OAUTH_TOKEN="+o.accessToken+"\n");
fs.renameSync(tmp,process.argv[1]);
console.log("[token-refresh] refreshed, "+mins.toFixed(0)+" min of headroom");
' "$token_file" "$min_minutes"
}

# The full retry/poke/wait ladder. Call this, not _refresh_token_once directly.
refresh_token() {
  local attempt rc mins secs waited max_wait min_minutes
  min_minutes="${TB_TOKEN_MIN_MINUTES:-$(_token_min_minutes)}"
  # Scales with the gate (TBENCH-TOKEN-CEILING-1); floor 3000 s = one expiry
  # cycle, which is what the 40-minute gate needed.
  max_wait="${TB_TOKEN_WAIT_MAX_S:-$(_token_wait_max_s)}"
  waited=0
  # DISCLOSE A GATE THAT IS NOT THE FLOOR. The 2026-09-13 loss is invisible in
  # a log that only ever says "refreshed, N min of headroom": nothing recorded
  # what N was being compared against.
  if [ "$min_minutes" -gt 40 ]; then
    echo "[token-refresh] headroom gate ${min_minutes} min (trial ceiling ${TB_TRIAL_CEILING_S:-?}s + 30 min), wait budget ${max_wait}s" >&2
  fi
  # A TRANSIENT failure gets a long, patient retry budget: the host CLI rewrites
  # this file periodically and the unreadable window is short, so waiting is
  # strictly better than abandoning a run that may be hours in.
  for attempt in 1 2 3 4 5 6; do
    _refresh_token_once
    rc=$?
    [ "$rc" -eq 0 ] && return 0
    if [ "$rc" -eq 1 ]; then
      # BELOW THE HEADROOM GATE. Not necessarily expired — just too close to
      # expiry to safely start a task that may run 40 minutes.
      mins="$(_token_mins_left)"
      # 1. Poke first. If the token is ALREADY past expiry this rotates it now
      #    and costs one trivial API call.
      echo "[token-refresh] credential at ${mins} min — poking the host CLI to force a refresh (attempt $attempt/6)" >&2
      _poke_host_cli
      _refresh_token_once && return 0
      # 2. Still short, and the token is still alive: the CLI will not rotate
      #    until it actually expires, so wait for that moment and poke again.
      #    Bounded by the token's own remaining life, never open-ended.
      if [ "$mins" != "unreadable" ]; then
        secs="$(awk -v m="$mins" 'BEGIN{ s=(m*60)+45; if (s<45) s=45; printf "%d", s }')"
        if [ "$((waited + secs))" -le "$max_wait" ]; then
          echo "[token-refresh] waiting ${secs}s for the credential to reach expiry, then re-poking" >&2
          sleep "$secs"
          waited=$((waited + secs))
          _poke_host_cli
          _refresh_token_once && return 0
        fi
      fi
      if [ "$attempt" -lt 6 ]; then
        sleep 30
        continue
      fi
      echo "[token-refresh] credential still below the headroom gate after poking and waiting ${waited}s." >&2
      echo "[token-refresh] The host CLI refreshes only when INVOKED and only once the token has expired," >&2
      echo "[token-refresh] so if this persists the refresh token itself is dead: run 'claude setup-token'," >&2
      echo "[token-refresh] write it to mcp-data/.tb-token.env, and relaunch with TB_TOKEN_STATIC=1." >&2
      return 1
    fi
    [ "$attempt" -lt 6 ] && {
      echo "[token-refresh] credential unreadable (attempt $attempt/6) — retrying in 10s" >&2
      sleep 10
    }
  done
  echo "[token-refresh] credentials stayed unreadable for 60s — giving up" >&2
  return 1
}
